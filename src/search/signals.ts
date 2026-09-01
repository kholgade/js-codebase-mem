import { Store } from '../sql/store.ts';
import { normalizeIdent, splitIdentifier } from './tokenize.ts';

/**
 * Additional semantic search signals beyond vector+fts.
 * Implements the richer scoring ensemble described in DESIGN.md:
 *  - TF-IDF term weighting
 *  - module proximity (files sharing a package rank higher)
 *  - API/type signature overlap
 *  - AST profile similarity (imports/defines distribution)
 */

export interface SignalScores {
  tfidf: number;
  moduleProximity: number;
  signature: number;
  astProfile: number;
}

export interface SignalWeights {
  tfidf: number;
  moduleProximity: number;
  signature: number;
  astProfile: number;
}

export const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
  tfidf: 0.30,
  moduleProximity: 0.15,
  signature: 0.10,
  astProfile: 0.05,
};

export interface Document {
  id: number;
  name: string;
  qualified: string;
  file: string;
  signature?: string;
  doc?: string;
  tokens: string[];
}

/** Build a corpus of tokenized documents from the store for a project. */
export function buildCorpus(store: Store, project: string, limit = 5000): Document[] {
  const rows = store.queryNodes(
    `SELECT id, name, qualified, file, signature, doc FROM nodes WHERE project = ? LIMIT ${limit}`,
    [project],
  ) as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? ''),
    qualified: String(r.qualified ?? ''),
    file: String(r.file ?? ''),
    signature: r.signature ? String(r.signature) : undefined,
    doc: r.doc ? String(r.doc) : undefined,
    tokens: docTokens(r),
  }));
}

function docTokens(r: Record<string, any>): string[] {
  const text = [
    String(r.name ?? ''),
    String(r.qualified ?? ''),
    r.signature ? String(r.signature) : '',
    r.doc ? String(r.doc) : '',
  ].join(' ');
  return splitIdentifier(text).filter((t) => t.length > 1);
}

/** Inverted index: token -> set of doc ids. */
export function buildInvertedIndex(corpus: Document[]): Map<string, Set<number>> {
  const idx = new Map<string, Set<number>>();
  for (const doc of corpus) {
    const seen = new Set<string>();
    for (const t of doc.tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      let s = idx.get(t);
      if (!s) {
        s = new Set();
        idx.set(t, s);
      }
      s.add(doc.id);
    }
  }
  return idx;
}

/** Compute TF-IDF similarity between a query and a document. */
export function tfidfScore(
  queryTokens: string[],
  doc: Document,
  idf: Map<string, number>,
): number {
  let score = 0;
  const docFreq = new Map<string, number>();
  for (const t of doc.tokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const maxFreq = Math.max(1, ...docFreq.values());
  for (const qt of queryTokens) {
    const idfVal = idf.get(qt) ?? 0;
    const tf = docFreq.get(qt) ?? 0;
    const normTf = tf / maxFreq;
    score += normTf * idfVal;
  }
  return score;
}

/** Build idf map: log(N / df). */
export function buildIdf(corpus: Document[], invertedIndex: Map<string, Set<number>>): Map<string, number> {
  const N = Math.max(1, corpus.length);
  const idf = new Map<string, number>();
  for (const [token, docs] of invertedIndex) {
    const df = docs.size;
    idf.set(token, Math.log((N + 1) / (df + 1)) + 1);
  }
  return idf;
}

/**
 * Module proximity: documents whose qualified path shares more leading
 * segments with the query's module context score higher.
 */
export function moduleProximity(
  docs: Document[],
  queryModule: string,
): Map<number, number> {
  const qSegs = queryModule.split('.').filter(Boolean);
  const scores = new Map<number, number>();
  for (const doc of docs) {
    const dSegs = doc.qualified.split('.').filter(Boolean);
    let common = 0;
    const maxLen = Math.min(qSegs.length, dSegs.length - 1);
    for (let i = 0; i < maxLen; i++) {
      // compare leading segments, skipping the node's own name
      if (dSegs[i] === qSegs[i]) common++;
      else break;
    }
    scores.set(doc.id, common / Math.max(1, maxLen));
  }
  return scores;
}

/** Signature overlap: Jaccard on tokenized signatures. */
export function signatureOverlap(
  docs: Document[],
  querySignature: string,
): Map<number, number> {
  const qt = new Set(splitIdentifier(querySignature));
  const scores = new Map<number, number>();
  for (const doc of docs) {
    if (!doc.signature) {
      scores.set(doc.id, 0);
      continue;
    }
    const dt = new Set(splitIdentifier(doc.signature));
    let inter = 0;
    for (const x of qt) if (dt.has(x)) inter++;
    const union = qt.size + dt.size - inter;
    scores.set(doc.id, union === 0 ? 0 : inter / union);
  }
  return scores;
}

/** AST profile similarity: base token histogram (name+docs) overlap. */
export function astProfile(
  docs: Document[],
  query: string,
): Map<number, number> {
  const qt = new Set(splitIdentifier(query));
  const scores = new Map<number, number>();
  for (const doc of docs) {
    const dt = new Set(doc.tokens);
    let inter = 0;
    for (const x of qt) if (dt.has(x)) inter++;
    const union = qt.size + dt.size - inter;
    scores.set(doc.id, union === 0 ? 0 : inter / Math.max(1, Math.min(qt.size, dt.size)));
  }
  return scores;
}

export interface CombinedSignalResult {
  perDoc: Map<number, SignalScores>;
  weights: SignalWeights;
}

/**
 * Compute all additional signals for a project's corpus against a query.
 */
export function computeSignals(
  store: Store,
  project: string,
  query: string,
  weights: SignalWeights = DEFAULT_SIGNAL_WEIGHTS,
): CombinedSignalResult {
  const corpus = buildCorpus(store, project);
  if (corpus.length === 0) {
    return { perDoc: new Map(), weights };
  }
  const index = buildInvertedIndex(corpus);
  const idf = buildIdf(corpus, index);
  const qtokens = splitIdentifier(query).filter((t) => t.length > 1);

  const tfidf = new Map<number, number>();
  for (const doc of corpus) tfidf.set(doc.id, tfidfScore(qtokens, doc, idf));

  // Module context from the query: use the first path segment as best guess
  const module = project;
  const modProx = moduleProximity(corpus, module);
  const sig = signatureOverlap(corpus, query);
  const profile = astProfile(corpus, query);

  const perDoc = new Map<number, SignalScores>();
  for (const doc of corpus) {
    perDoc.set(doc.id, {
      tfidf: tfidf.get(doc.id) ?? 0,
      moduleProximity: modProx.get(doc.id) ?? 0,
      signature: sig.get(doc.id) ?? 0,
      astProfile: profile.get(doc.id) ?? 0,
    });
  }

  return { perDoc, weights };
}

export function normalizeSignals(result: CombinedSignalResult): void {
  // Normalize each signal to [0,1] across docs.
  for (const key of ['tfidf', 'moduleProximity', 'signature', 'astProfile'] as const) {
    let min = Infinity;
    let max = -Infinity;
    for (const s of result.perDoc.values()) {
      if (s[key] < min) min = s[key];
      if (s[key] > max) max = s[key];
    }
    const span = max - min || 1;
    for (const s of result.perDoc.values()) {
      (s as any)[key] = (s[key] - min) / span;
    }
  }
}

/** Combine the additional signal scores into a single weighted score. */
export function combinedSignalScore(
  s: SignalScores,
  q: SignalScores,
  weights: SignalWeights,
): number {
  return (
    weights.tfidf * s.tfidf +
    weights.moduleProximity * s.moduleProximity +
    weights.signature * s.signature +
    weights.astProfile * s.astProfile
  );
}
