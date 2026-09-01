import { Store } from '../sql/store.ts';
import { normalizeIdent, splitIdentifier } from './tokenize.ts';
import { searchFts } from './fts.ts';

export const EMBEDDING_DIM = 256;

const CODE_LABELS = new Set([
  'Function', 'Method', 'Class', 'Interface', 'Enum', 'Type',
]);

// Implement FNV-1a 32-bit hash (deterministic, no Math.random).
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

export interface EmbeddingStrategy {
  name: string;
  embed(text: string): number[];
}

// ---------------------------------------------------------------------------
// Deterministic bag-of-tokens hashing embedder (zero-dependency fallback).
// 256-dim vector from hashed n-grams with TF weighting, then L2-normalized.
// ---------------------------------------------------------------------------
export class HashingEmbedder implements EmbeddingStrategy {
  readonly name = 'hashing';
  readonly dim = EMBEDDING_DIM;

  embed(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    if (!text) return vec;
    const tokens = splitIdentifier(text).filter((t) => t.length > 0);
    for (const token of tokens) {
      const t = token.toLowerCase();
      let w = 1 + Math.min(t.length, 4); // slight weight on longer tokens
      const hashed = hash32(t) >>> 0;
      const idx = hashed % this.dim;
      const sign = (hashed & 1) === 0 ? 1 : -1;
      // Note: standard hashing trick would double-count via separate sign bucket; keep simple.
      vec[idx] += sign * w;
      // Add character 2-grams with low weight.
      if (t.length > 1) {
        for (let i = 0; i < t.length - 1; i++) {
          const g = t.slice(i, i + 2);
          const gh = hash32(g) >>> 0;
          vec[gh % this.dim] += (gh & 1) === 0 ? 0.5 : -0.5;
        }
      }
    }
    return l2Normalize(vec);
  }
}

function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// ---------------------------------------------------------------------------
// Optional Transformers.js strategy (loaded lazily, guarded by CBM_MODEL off).
// Browsers of this interface: this path is async; the default synchronous
// embedText() below always uses the deterministic hashing embedder.
// ---------------------------------------------------------------------------
const TRANSFORMERS_MODELS = [
  '@huggingface/transformers',
  '@xenova/transformers',
];

export type AsyncEmbedFn = (text: string) => Promise<number[]>;

async function tryLoadTransformers(): Promise<AsyncEmbedFn | null> {
  if (process.env.CBM_MODEL === 'off') return null;
  for (const pkg of TRANSFORMERS_MODELS) {
    try {
      const mod = await import(pkg);
      return async (text: string): Promise<number[]> => {
        const { pipeline } = mod;
        const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        const out = await extractor(normalizeIdent(text), { pooling: 'mean', normalize: true });
        return Array.from(out.data as Float32Array);
      };
    } catch {
      // try next package
    }
  }
  return null;
}

let transformersEmbed: AsyncEmbedFn | null | undefined;

// Default to the deterministic hashing embedder. Transformers is enabled only
// if the package is installed AND not disabled via CBM_MODEL=off.
export function getEmbeddingStrategy(): EmbeddingStrategy {
  return new HashingEmbedder();
}

export async function ensureModelStrategy(): Promise<AsyncEmbedFn | null> {
  if (transformersEmbed === undefined) {
    transformersEmbed = await tryLoadTransformers();
  }
  return transformersEmbed;
}

export function embedText(text: string): number[] {
  return getEmbeddingStrategy().embed(text);
}

export function embedNodeText(node: Record<string, any>): string {
  const parts: string[] = [
    normalizeIdent(String(node.name ?? '')),
    normalizeIdent(String(node.qualified ?? '')),
  ];
  if (node.signature) parts.push(normalizeIdent(String(node.signature)));
  if (node.doc) parts.push(normalizeIdent(String(node.doc)));
  // symbol tokens: split each identifier word so camelCase surfaces.
  for (const k of ['name', 'qualified']) {
    if (node[k] != null) parts.push(splitIdentifier(String(node[k])).join(' '));
  }
  return parts.filter(Boolean).join(' ');
}

export function embedNode(node: Record<string, any>): number[] {
  return embedText(embedNodeText(node));
}

// ---------------------------------------------------------------------------
// int8 quantization
// ---------------------------------------------------------------------------
export function quantizeToInt8(vec: number[]): Int8Array {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    let v = Math.round(vec[i] * 127);
    if (v > 127) v = 127;
    if (v < -128) v = -128;
    out[i] = v;
  }
  return out;
}

export function dequantizeFromInt8(bytes: Uint8Array | ArrayBuffer): number[] {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let v = (arr[i] > 127 ? arr[i] - 256 : arr[i]) / 127; // signed decode
    out[i] = v;
  }
  return out;
}

export interface VecInfo {
  node_id: number;
  vec: Int8Array;
}

export interface BuildEmbeddingsResult {
  project: string;
  embedded: number;
  skipped: number;
}

const EMBEDDABLE_LABELS = CODE_LABELS;

let embeddingCache = new Map<string, Map<number, number[]>>();

export function buildEmbeddings(store: Store, project: string): BuildEmbeddingsResult {
  const nodes = store.getNodesByProject(project);
  let embedded = 0;
  let skipped = 0;
  const db = store.underlying;
  db.exec('BEGIN');
  try {
    const upsert = db.prepare(
      `INSERT INTO node_embeddings (node_id, project, vec) VALUES (?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET vec = excluded.vec`,
    );
    db.prepare('DELETE FROM node_embeddings WHERE project = ?').run(project);
    const map = new Map<number, number[]>();
    for (const node of nodes) {
      const label = String(node.label ?? '');
      const name = String(node.name ?? '');
      if (!EMBEDDABLE_LABELS.has(label) || !name.trim()) {
        skipped++;
        continue;
      }
      const vec = embedNode(node);
      const quant = quantizeToInt8(vec);
      upsert.run(Number(node.id), project, Buffer.from(quant.buffer));
      map.set(Number(node.id), vec);
      embedded++;
    }
    db.exec('COMMIT');
    embeddingCache.set(project, map);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { project, embedded, skipped };
}

export function loadEmbeddingCache(store: Store, project: string): Map<number, number[]> {
  const cached = embeddingCache.get(project);
  if (cached) return cached;
  const rows = store.underlying
    .prepare('SELECT node_id, vec FROM node_embeddings WHERE project = ?')
    .all(project) as any[];
  const map = new Map<number, number[]>();
  for (const r of rows) {
    map.set(Number(r.node_id), dequantizeFromInt8(r.vec as Buffer));
  }
  embeddingCache.set(project, map);
  return map;
}

export interface SemanticHit {
  node_id: number;
  label: string;
  name: string;
  qualified: string;
  file: string;
  signature?: string;
  doc?: string;
  score: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function hasEmbeddingsForProject(store: Store, project: string): boolean {
  const row = store.queryOne(
    'SELECT COUNT(*) AS c FROM node_embeddings WHERE project = ?',
    [project],
  );
  return !!(row && Number(row.c) > 0);
}

export interface SemanticSearchOptions {
  limit?: number;
  topK?: number;
  vecWeight?: number;
  ftsWeight?: number;
}

export function semanticSearch(
  store: Store,
  project: string,
  query: string,
  limit = 10,
  opts: SemanticSearchOptions = {},
): SemanticHit[] {
  const vecWeight = opts.vecWeight ?? 0.6;
  const ftsWeight = opts.ftsWeight ?? 0.4;
  const topK = opts.topK ?? Math.max(limit * 10, 20);

  if (!hasEmbeddingsForProject(store, project)) {
    const msg =
      `No embeddings found for project "${project}". ` +
      `Run 'js-codebase-mem build_index --project ${project}' first.`;
    throw new Error(msg);
  }

  const cache = loadEmbeddingCache(store, project);
  if (cache.size === 0) {
    throw new Error(`No embeddings built for project "${project}". Run 'build_index' first.`);
  }

  const qvec = embedText(query);

  // FTS scores normalized to [0,1].
  let ftsScores = new Map<number, number>();
  try {
    const ftsHits = searchFts(store, project, query, topK);
    if (ftsHits.length > 0) {
      let min = Infinity;
      let max = -Infinity;
      for (const h of ftsHits) {
        if (h.rank < min) min = h.rank;
        if (h.rank > max) max = h.rank;
      }
      const span = max - min || 1;
      for (const h of ftsHits) {
        ftsScores.set(h.id, 1 - (h.rank - min) / span);
      }
    }
  } catch {
    ftsScores = new Map();
  }

  const scored: Array<{ node_id: number; combinedScore: number }> = [];
  for (const [id, vec] of cache) {
    const vecScore = cosine(qvec, vec);
    const fts = ftsScores.get(id) ?? 0;
    const combined = vecWeight * vecScore + ftsWeight * fts;
    scored.push({ node_id: id, combinedScore: combined });
  }

  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  const top = scored.slice(0, limit);

  // Attach node metadata.
  const ids = top.map((t) => t.node_id);
  const meta = new Map<number, Record<string, any>>();
  if (ids.length > 0) {
    const rows = store.queryNodes(
      `SELECT id, label, name, qualified, file, signature, doc FROM nodes WHERE id IN (${ids.join(',')})`,
    );
    for (const r of rows) meta.set(Number(r.id), r);
  }

  return top.map((t) => {
    const m = meta.get(t.node_id) ?? {};
    return {
      node_id: t.node_id,
      label: String(m.label ?? ''),
      name: String(m.name ?? ''),
      qualified: String(m.qualified ?? ''),
      file: String(m.file ?? ''),
      signature: m.signature,
      doc: m.doc,
      score: round(t.combinedScore),
    };
  });
}

function round(n: number, dp = 4): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

export function clearSearchCache(): void {
  embeddingCache = new Map();
}
