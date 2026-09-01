import { DatabaseSync } from 'node:sqlite';
import type { EdgeType, NodeLabel, Confidence } from '../core/types.ts';

export interface LocatedNode {
  id: number;
  project: string;
  file: string;
  label: NodeLabel;
  name: string;
  qualified: string;
  signature?: string;
  doc?: string;
}

export interface LocatedEdge {
  project: string;
  srcId: number;
  dstId: number | null;
  type: EdgeType;
  confidence: Confidence;
  siteLine: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  node_count INTEGER DEFAULT 0,
  edge_count INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER, start_col INTEGER,
  end_line INTEGER, end_col INTEGER,
  label TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified TEXT NOT NULL,
  signature TEXT,
  doc TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_proj_label ON nodes(project, label);
CREATE INDEX IF NOT EXISTS idx_nodes_proj_qual ON nodes(project, qualified);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  src INTEGER NOT NULL,
  dst INTEGER,
  type TEXT NOT NULL,
  confidence TEXT NOT NULL,
  site_line INTEGER,
  trace_hits INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_proj_type ON edges(project, type);
CREATE INDEX IF NOT EXISTS idx_edges_src_type ON edges(src, type);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  lang TEXT NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER,
  indexed_at INTEGER
);
CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  vec BLOB
);
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  name TEXT,
  root TEXT,
  calls TEXT NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_traces_proj ON traces(project);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qualified, signature, doc,
  content='nodes',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified, signature, doc)
  VALUES (new.id, new.name, new.qualified, new.signature, new.doc);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc)
  VALUES ('delete', old.id, old.name, old.qualified, old.signature, old.doc);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc)
  VALUES ('delete', old.id, old.name, old.qualified, old.signature, old.doc);
  INSERT INTO nodes_fts(rowid, name, qualified, signature, doc)
  VALUES (new.id, new.name, new.qualified, new.signature, new.doc);
END;
`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    // Idempotent migration for existing DBs created before trace_hits existed.
    try {
      this.db.exec('ALTER TABLE edges ADD COLUMN trace_hits INTEGER DEFAULT 0');
    } catch {
      // column already present
    }
  }

  get underlying(): DatabaseSync {
    return this.db;
  }

  upsertProject(project: string, root: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO projects (name, root, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET root=excluded.root, updated_at=excluded.updated_at`,
      )
      .run(project, root, now, now);
  }

  deleteProject(project: string): void {
    this.db.prepare('DELETE FROM edges WHERE project = ?').run(project);
    this.db.prepare('DELETE FROM node_embeddings WHERE project = ?').run(project);
    this.db.prepare('DELETE FROM nodes WHERE project = ?').run(project);
    this.db.prepare('DELETE FROM files WHERE project = ?').run(project);
    this.db.prepare('DELETE FROM traces WHERE project = ?').run(project);
    this.db.prepare('DELETE FROM projects WHERE name = ?').run(project);
  }

  listProjects(): Array<{ name: string; root: string; node_count: number; edge_count: number }> {
    return this.db
      .prepare('SELECT name, root, node_count, edge_count FROM projects ORDER BY name')
      .all() as any;
  }

  insertNode(n: LocatedNode, r: { sl: number; sc: number; el: number; ec: number }): number {
    const res = this.db
      .prepare(
        `INSERT INTO nodes (project, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(n.project, n.file, r.sl, r.sc, r.el, r.ec, n.label, n.name, n.qualified, n.signature ?? null, n.doc ?? null);
    return Number(res.lastInsertRowid);
  }

  insertEdge(e: LocatedEdge): void {
    this.db
      .prepare(
        `INSERT INTO edges (project, src, dst, type, confidence, site_line)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.project, e.srcId, e.dstId, e.type, e.confidence, e.siteLine);
  }

  countNodes(project: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(project) as any).c;
  }

  countEdges(project: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM edges WHERE project = ?').get(project) as any).c;
  }

  setProjectCounts(project: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE projects
         SET node_count = (SELECT COUNT(*) FROM nodes WHERE project = ?),
             edge_count = (SELECT COUNT(*) FROM edges WHERE project = ?),
             updated_at = ?
         WHERE name = ?`,
      )
      .run(project, project, now, project);
  }

  upsertFile(f: { path: string; project: string; lang: string; hash: string; mtime: number; indexedAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO files (path, project, lang, hash, mtime, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           project=excluded.project, lang=excluded.lang, hash=excluded.hash,
           mtime=excluded.mtime, indexed_at=excluded.indexed_at`,
      )
      .run(f.path, f.project, f.lang, f.hash, f.mtime, f.indexedAt);
  }

  getFile(project: string, path: string): { path: string; hash: string } | undefined {
    return this.db
      .prepare('SELECT path, hash FROM files WHERE project = ? AND path = ?')
      .get(project, path) as any;
  }

  getNodesByProject(project: string): Array<Record<string, any>> {
    return this.db.prepare('SELECT * FROM nodes WHERE project = ? ORDER BY qualified').all(project) as any;
  }

  getNodeById(id: number): Record<string, any> | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as any;
  }

  hasEmbeddings(project: string): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM node_embeddings WHERE project = ?').get(project) as any;
    return row ? Number(row.c) > 0 : false;
  }

  getEdgesByProject(project: string): Array<Record<string, any>> {
    return this.db.prepare('SELECT * FROM edges WHERE project = ?').all(project) as any;
  }

  queryNodes(sql: string, params: any[] = []): Array<Record<string, any>> {
    return this.db.prepare(sql).all(...params) as any;
  }

  queryOne(sql: string, params: any[] = []): Record<string, any> | undefined {
    return this.db.prepare(sql).get(...params) as any;
  }

  ingestTrace(project: string, trace: { name?: string; root?: string; calls: string[] }): number {
    const res = this.db
      .prepare(`INSERT INTO traces (project, name, root, calls, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(project, trace.name ?? null, trace.root ?? trace.calls[0] ?? null, JSON.stringify(trace.calls), Date.now());
    return Number(res.lastInsertRowid);
  }

  getTraces(project: string): Array<{ id: number; name: string | null; root: string | null; calls: string[]; created_at: number }> {
    const rows = this.db.prepare('SELECT * FROM traces WHERE project = ? ORDER BY id').all(project) as any[];
    return rows.map((r) => ({ ...r, calls: JSON.parse(r.calls ?? '[]') }));
  }

  close(): void {
    this.db.close();
  }
}
