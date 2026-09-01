import type { Store } from '../sql/store.ts';

interface AdrRow {
  id: string;
  project: string;
  title: string;
  content?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
}

function ensureAdrTable(store: Store): void {
  store.underlying.exec(`CREATE TABLE IF NOT EXISTS adr (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    created_at INTEGER,
    updated_at INTEGER
  )`);
}

/** List ADRs for a project (without full content). */
export function listAdr(store: Store, project: string): Array<{ id: string; title: string; created_at?: number | null }> {
  ensureAdrTable(store);
  return store.queryNodes('SELECT id, title, created_at FROM adr WHERE project = ? ORDER BY id', [project]) as Array<{ id: string; title: string; created_at?: number | null }>;
}

/** Get a single ADR by id, or undefined if not found. */
export function getAdr(store: Store, project: string, id: string): AdrRow | undefined {
  ensureAdrTable(store);
  return store.queryOne('SELECT * FROM adr WHERE project = ? AND id = ?', [project, id]) as AdrRow | undefined;
}

/** Create or update an ADR's content. Returns { updated } with the id. */
export function updateAdr(store: Store, project: string, id: string, content: string): { updated: string } {
  ensureAdrTable(store);
  const now = Date.now();
  store.underlying
    .prepare(
      `INSERT INTO adr (id, project, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
    )
    .run(id, project, id, content, now, now);
  return { updated: id };
}
