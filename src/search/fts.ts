import { Store } from '../sql/store.ts';
import { splitIdentifier } from './tokenize.ts';

export interface FtsRow {
  id: number;
  label: string;
  name: string;
  qualified: string;
  file: string;
  signature?: string;
  doc?: string;
  rank: number;
}

const FTS_CREATE = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qualified, signature, doc,
  content='nodes',
  content_rowid='id'
)`;
const FTS_TRIGGER_INSERT = `
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified, signature, doc)
  VALUES (new.id, new.name, new.qualified, new.signature, new.doc);
END`;
const FTS_TRIGGER_DELETE = `
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc)
  VALUES ('delete', old.id, old.name, old.qualified, old.signature, old.doc);
END`;
const FTS_TRIGGER_UPDATE = `
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc)
  VALUES ('delete', old.id, old.name, old.qualified, old.signature, old.doc);
  INSERT INTO nodes_fts(rowid, name, qualified, signature, doc)
  VALUES (new.id, new.name, new.qualified, new.signature, new.doc);
END`;

export function ensureFts(store: Store): void {
  const db = store.underlying;
  db.exec(FTS_CREATE);
  db.exec(FTS_TRIGGER_INSERT);
  db.exec(FTS_TRIGGER_DELETE);
  db.exec(FTS_TRIGGER_UPDATE);
}

export function rebuildFts(store: Store, project: string): void {
  ensureFts(store);
  const db = store.underlying;
  const ids = store
    .queryNodes('SELECT id FROM nodes WHERE project = ?', [project])
    .map((r: Record<string, any>) => Number(r.id));
  db.exec('BEGIN');
  try {
    const del = db.prepare(
      `INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc)
       VALUES ('delete', ?, ?, ?, ?, ?)`,
    );
    for (const id of ids) del.run(id, '', '', '', '');
    const ins = db.prepare(
      `INSERT INTO nodes_fts(rowid, name, qualified, signature, doc)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const rows = store.getNodesByProject(project);
    for (const r of rows) {
      ins.run(Number(r.id), r.name ?? '', r.qualified ?? '', r.signature ?? '', r.doc ?? '');
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface FtsSearchResult extends FtsRow {}

export function buildMatchQuery(pattern: string): string {  const tokens = pattern
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => escapeFtsPhrase(t));
  if (tokens.length === 0) return '';
  return tokens.join(' AND ');
}

function escapeFtsPhrase(token: string): string {
  const cleaned = token.replace(/["\\()[\]*^:+\-]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '""';
  return `"${words.join(' ')}"*`;
}

export function searchFts(store: Store, project: string, query: string, limit: number): FtsSearchResult[] {
  ensureFts(store);
  const match = buildMatchQuery(query);
  const results: FtsSearchResult[] = [];
  if (match) {
    const db = store.underlying;
    const rows = db
      .prepare(
        `SELECT n.id, n.label, n.name, n.qualified, n.file, n.signature, n.doc,
                bm25(nodes_fts) AS rank
         FROM nodes_fts
         JOIN nodes n ON n.id = nodes_fts.rowid
         WHERE nodes_fts MATCH ? AND n.project = ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, project, limit);
    for (const r of rows as any[]) {
      results.push({
        id: Number(r.id),
        label: r.label,
        name: r.name,
        qualified: r.qualified,
        file: r.file,
        signature: r.signature,
        doc: r.doc,
        rank: Number(r.rank),
      });
    }
  }

  // Fallback: LIKE over case-insensitive identifier-normalized names.
  if (results.length < limit) {
    const normTokens = splitIdentifier(query).map((t) => t.toLowerCase());
    const nameTokens = splitIdentifier(query);
    const joinedName = nameTokens.join(' ');
    const likePattern = `%${query.toLowerCase().replace(/\s+/g, '%')}%`;
    const rows = store
      .queryNodes(
        `SELECT id, label, name, qualified, file, signature, doc
         FROM nodes
         WHERE project = ? AND (
           lower(name) LIKE ? OR lower(qualified) LIKE ? OR lower(signature) LIKE ?
         )`,
        [project, likePattern, likePattern, likePattern],
      )
      .map((r: Record<string, any>) => {
        const tokens = splitIdentifier(`${r.name} ${r.qualified}`);
        let score = 0;
        for (const t of tokens) {
          if (nameTokens.includes(t)) score += 3;
          else if (normTokens.includes(t)) score += 2;
        }
        if (joinedName && String(r.name).toLowerCase().includes(joinedName.toLowerCase())) score += 5;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score);

    const seen = new Set(results.map((x) => x.id));
    for (const { r, score } of rows) {
      if (results.length >= limit) break;
      if (seen.has(Number(r.id))) continue;
      seen.add(Number(r.id));
      results.push({
        id: Number(r.id),
        label: r.label,
        name: r.name,
        qualified: r.qualified,
        file: r.file,
        signature: r.signature,
        doc: r.doc,
        rank: -score,
      });
    }
  }

  return results.slice(0, limit);
}

export function searchCodeFts(store: Store, project: string, pattern: string, limit = 10): FtsSearchResult[] {
  return searchFts(store, project, pattern, limit);
}
