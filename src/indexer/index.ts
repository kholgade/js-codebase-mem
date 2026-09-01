import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { LanguageRegistry, LanguagePlugin, FileContext, Emit } from '../languages/contract.ts';
import { emitsFromQuery } from '../languages/base.ts';
import { ParserPool } from './parser-pool.ts';
import { Store } from '../sql/store.ts';
import { Query } from 'web-tree-sitter';

export interface IndexOptions {
  project: string;
  repoPath: string;
  ignore?: string[];
  store: Store;
  registry: LanguageRegistry;
  pool?: ParserPool;
}

export interface IndexResult {
  project: string;
  files: number;
  indexedFiles: number;
  skippedUpToDate: number;
  nodes: number;
  edges: number;
  durationMs: number;
}

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target', 'out', 'venv', '.venv',
  '__pycache__', '.next', '.nuxt', '.cache', 'bin', 'obj', '.gradle', '.idea', '.vscode',
  '.gitignore', 'coverage', '.tox', '.mypy_cache', '.pytest_cache', 'vendor', '.terraform',
]);

type ParsedFile = {
  plugin: LanguagePlugin;
  rel: string;
  hash: string;
  moduleSpec: string;
  emits: Emit[];
};

export async function indexRepository(opts: IndexOptions): Promise<IndexResult> {
  const { project, repoPath, store, registry, ignore = [] } = opts;
  const pool = opts.pool ?? new ParserPool();
  const ignoreSet = new Set([...DEFAULT_IGNORE, ...ignore]);
  const root = resolve(repoPath);
  store.upsertProject(project, root);

  const fileList: string[] = [];
  await walk(root, ignoreSet, fileList);

  const queryCache = new Map<string, Query>();
  const parsed: ParsedFile[] = [];
  let skipped = 0;

  for (const file of fileList) {
    const plugin = registry.forPath(file);
    if (!plugin) continue;

    const src = await readFile(file, 'utf8');
    const rel = relative(root, file);
    const hash = createHash('sha1').update(src).digest('hex');

    if (isFresh(store, project, rel, hash)) {
      skipped++;
      continue;
    }

    const moduleSpec = detectModuleSpec(plugin.id, src, rel);
    const emits = await extract(plugin, pool, queryCache, file, src);
    parsed.push({ plugin, rel, hash, moduleSpec, emits });
  }

  // Cross-file symbol table: qualifiedName -> node id (assigned during write).
  const symbolToId = new Map<string, number>();
  // call target site (per resolution) tracked below.

  const t0 = Date.now();
  const db = store.underlying;
  db.exec('BEGIN');
  let nodes = 0;
  let edges = 0;
  try {
    for (const pf of parsed) {
      const ctx: FileContext = {
        path: pf.rel,
        language: pf.plugin,
        moduleSpec: pf.moduleSpec,
        imports: pf.emits.filter((e) => e.kind === 'import').map((e) => ({ source: e.source ?? '', raw: e.source ?? '' })),
        source: '',
      };
      const res = writeFileGraph(store, db, project, pf.rel, pf.hash, pf.plugin.id, pf.moduleSpec, ctx, pf.emits, symbolToId);
      nodes += res.nodes;
      edges += res.edges;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  store.setProjectCounts(project);
  return {
    project,
    files: fileList.length,
    indexedFiles: parsed.length,
    skippedUpToDate: skipped,
    nodes,
    edges,
    durationMs: Date.now() - t0,
  };
}

interface WriteResult { nodes: number; edges: number; }

function writeFileGraph(
  store: Store,
  db: import('node:sqlite').DatabaseSync,
  project: string,
  rel: string,
  hash: string,
  langId: string,
  moduleSpec: string,
  ctx: FileContext,
  emits: Emit[],
  symbolToId: Map<string, number>,
): WriteResult {
  const fileBase = basename(rel);
  // File node
  const fileNodeId = store.insertNode(
    { id: 0, project, file: rel, label: 'File', name: fileBase, qualified: `${project}${rel.replace(/\//g, '.')}` },
    { sl: 1, sc: 0, el: 1, ec: 0 },
  );
  markIndexed(store, project, rel, hash, langId);

  let nodes = 1;
  let edges = 0;

  // First: register all define nodes so calls can resolve to them.
  type DefEntry = { id: number; sl: number; sc: number; el: number; ec: number };
  const defs: DefEntry[] = [];
  const localNameToQualified = new Map<string, string>();
  for (const e of emits) {
    if (e.kind !== 'define') continue;
    const qual = resolveQualified(moduleSpec, e);
    const id = store.insertNode(
      { id: 0, project, file: rel, label: e.label ?? 'Function', name: e.name ?? '', qualified: qual, signature: e.signature, doc: e.doc },
      rangeTo(e.range),
    );
    defs.push({ id, sl: e.range.start.line, sc: e.range.start.col, el: e.range.end.line, ec: e.range.end.col });
    if (e.name) localNameToQualified.set(e.name, qual);
    symbolToId.set(qual, id);
    // DEFINES edge file -> symbol
    db.prepare(`INSERT INTO edges (project, src, dst, type, confidence, site_line) VALUES (?,?,?,?,?,?)`)
      .run(project, fileNodeId, id, 'DEFINES', 'exact', e.range.start.line + 1);
    edges++;
    nodes++;
  }

  // Find the innermost define node containing a given range (source line/col 0-based).
  const enclosing = (line: number, col: number): number | undefined => {
    let best: number | undefined;
    for (const d of defs) {
      const inside =
        (line > d.sl || (line === d.sl && col >= d.sc)) &&
        (line < d.el || (line === d.el && col <= d.ec));
      if (inside) best = d.id;
    }
    return best;
  };

  // Second: process calls, imports, inherit, routes. Attach calls to enclosing define.
  const insertEdge = (src: number, dst: number | null, type: string, conf: string, line: number) => {
    db.prepare(`INSERT INTO edges (project, src, dst, type, confidence, site_line) VALUES (?,?,?,?,?,?)`)
      .run(project, src, dst, type, conf, line);
    edges++;
  };

  for (const e of emits) {
    if (e.kind === 'call') {
      const qual = resolveCall(e.targetName ?? '', localNameToQualified);
      const srcId = enclosing(e.range.start.line, e.range.start.col) ?? fileNodeId;
      if (qual) {
        const dstId = symbolToId.get(qual);
        const conf: 'exact' | 'reference' | 'usage' = dstId ? 'exact' : 'usage';
        insertEdge(srcId, dstId ?? null, 'CALLS', conf, e.range.start.line + 1);
      }
    } else if (e.kind === 'import') {
      insertEdge(fileNodeId, null, 'IMPORTS', 'exact', e.range.start.line + 1);
    } else if (e.kind === 'inherit' && e.base) {
      const srcId = enclosing(e.range.start.line, e.range.start.col) ?? fileNodeId;
      const dstId = symbolToId.get(e.base) ?? null;
      insertEdge(srcId, dstId, 'INHERITS', 'exact', e.range.start.line + 1);
    } else if (e.kind === 'http-route' && e.path) {
      const id = store.insertNode(
        { id: 0, project, file: rel, label: 'Route', name: `${e.method} ${e.path}`, qualified: `${moduleSpec}.route.${e.path}`, signature: e.handler },
        { sl: e.range.start.line, sc: e.range.start.col, el: e.range.end.line, ec: e.range.end.col },
      );
      insertEdge(fileNodeId, id, 'HANDLES', 'exact', e.range.start.line + 1);
      nodes++;
    }
  }

  return { nodes, edges };
}

function resolveQualified(moduleSpec: string, e: Emit): string {
  if (e.qualified) return e.qualified;
  return `${moduleSpec}.${e.name ?? 'anon'}`;
}

function resolveCall(targetName: string, localNames: Map<string, string>): string | undefined {
  // full qualified already? else look up local
  if (targetName.includes('.')) return targetName;
  return localNames.get(targetName);
}

function rangeTo(r: { start: { line: number; col: number }; end: { line: number; col: number } }) {
  return { sl: r.start.line + 1, sc: r.start.col, el: r.end.line + 1, ec: r.end.col };
}

async function extract(
  plugin: LanguagePlugin,
  pool: ParserPool,
  queryCache: Map<string, Query>,
  file: string,
  src: string,
): Promise<Emit[]> {
  const parser = await pool.parserFor(plugin, file);
  const tree = parser.parse(src);
  if (!tree) return [];
  let q = queryCache.get(plugin.id);
  if (!q) {
    // load query source from plugin.query file
    const querySrc = await readFile(new URL(plugin.query, import.meta.url), 'utf8');
    q = new Query(parser.language!, querySrc);
    queryCache.set(plugin.id, q);
  }
  const matches = q.matches(tree.rootNode);
  return emitsFromQuery(matches);
}

export function detectModuleSpec(langId: string, src: string, rel: string): string {
  // Stripped manifest scanning; simple heuristic per language.
  const noExt = rel.replace(/\.[a-zA-Z0-9]+$/, '');
  const parts = noExt.split(/[/\\]/);
  if (langId === 'python') return parts.join('');
  if (langId === 'go') {
    // package declaration
    const m = src.match(/^package\s+([\w.]+)/m);
    return parts.slice(0, -1).join('/') + (m ? '/' + m[1] : '');
  }
  return `${langId}.${parts.join('.')}`;
}

function isFresh(store: Store, project: string, rel: string, hash: string): boolean {
  const row = store.getFile(project, rel);
  return !!row && row.hash === hash;
}

function markIndexed(store: Store, project: string, rel: string, hash: string, langId: string): void {
  store.upsertFile({ path: rel, project, lang: langId, hash, mtime: Date.now(), indexedAt: Date.now() });
}

export async function walk(dir: string, ignore: Set<string>, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (ignore.has(ent.name)) continue;
      await walk(join(dir, ent.name), ignore, out);
    } else if (ent.isFile()) {
      out.push(join(dir, ent.name));
    }
  }
}

const SUPPORTED = new Set([
  '.py', '.js', '.jsx', '.mjs', '.cjs', '.es6',
  '.ts', '.tsx', '.mts', '.cts',
  '.java', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.c', '.h',
  '.cs', '.go', '.rs',
]);

export function isSupportedFile(path: string): boolean {
  return SUPPORTED.has(extname(path));
}
