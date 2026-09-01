import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { backup } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './sql/store.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ArtifactExportResult {
  project: string;
  nodes: number;
  edges: number;
  dest: string;
}

export interface ArtifactImportResult {
  project: string;
  nodes: number;
  edges: number;
}

/**
 * Dump the whole store to a compressed graph artifact.
 *
 * The DB is backed up to a temp file via node:sqlite's `backup()`, then gzipped
 * with the built-in node:zlib and written to `destPath`. The artifact therefore
 * contains every project's data; the returned counts describe the named project.
 */
export async function exportArtifact(store: Store, project: string, destPath: string): Promise<ArtifactExportResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-art-'));
  const tmpDb = join(tmpDir, 'graph.db');
  try {
    await backup(store.underlying, tmpDb);
    const raw = await gzipAsync(await readFile(tmpDb));
    writeFileSync(destPath, raw);
    const nodes = store.countNodes(project);
    const edges = store.countEdges(project);
    return { project, nodes, edges, dest: destPath };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Import a compressed graph artifact into the current store.
 *
 * The gzipped artifact is decompressed to a temp DB, then its projects, nodes and
 * edges are copied into this store via parameterized ATTACH + INSERT OR IGNORE.
 */
export async function importArtifact(store: Store, srcPath: string, projectOverride?: string): Promise<ArtifactImportResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-art-'));
  const tmpDb = join(tmpDir, 'graph.db');
  try {
    const compressed = await readFile(srcPath);
    const raw = await gunzipAsync(compressed);
    writeFileSync(tmpDb, raw);

    const db = store.underlying;
    // NOTE: SQLite does NOT allow ATTACH to take its DB filename as a bound
    // parameter (the file path must be a literal in the SQL text); the earlier
    // `ATTACH DATABASE ?` form silently misbehaved and could corrupt the store.
    const A = `cbm_art_${Date.now()}`;
    const escapedPath = tmpDb.replaceAll("'", "''");
    db.exec(`ATTACH DATABASE '${escapedPath}' AS ${A}`);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS adr (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, content TEXT, created_at INTEGER, updated_at INTEGER)');

      const rows = db.prepare(`SELECT * FROM ${A}.projects`).all() as any[];
      const sourceProject = rows[0]?.name;
      const project = projectOverride ?? sourceProject ?? 'unknown';

      // When overriding, rewrite the project column so all copied rows belong
      // to the new project name. Source and target differ in the overridden case,
      // which projects.id is the PRIMARY KEY for the projects table.
      const srcName = sourceProject ?? project;
      const useSrc = srcName === project;

      if (useSrc) {
        db.exec(`INSERT OR IGNORE INTO main.projects SELECT * FROM ${A}.projects`);
        db.exec(`INSERT OR IGNORE INTO main.nodes (id, project, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc) SELECT id, project, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc FROM ${A}.nodes`);
        db.exec(`INSERT OR IGNORE INTO main.edges (id, project, src, dst, type, confidence, site_line) SELECT id, project, src, dst, type, confidence, site_line FROM ${A}.edges`);
        db.exec(`INSERT OR IGNORE INTO main.files (path, project, lang, hash, mtime, indexed_at) SELECT path, project, lang, hash, mtime, indexed_at FROM ${A}.files`);
      } else {
        db.prepare(`INSERT OR IGNORE INTO main.projects (name, root, node_count, edge_count, created_at, updated_at) SELECT ?, root, node_count, edge_count, created_at, updated_at FROM ${A}.projects WHERE name = ?`).run(project, srcName);
        db.prepare(`INSERT OR IGNORE INTO main.nodes (id, project, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc) SELECT id, ?, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc FROM ${A}.nodes`).run(project);
        db.prepare(`INSERT OR IGNORE INTO main.edges (id, project, src, dst, type, confidence, site_line) SELECT id, ?, src, dst, type, confidence, site_line FROM ${A}.edges`).run(project);
        db.prepare(`INSERT OR IGNORE INTO main.files (path, project, lang, hash, mtime, indexed_at) SELECT path, ?, lang, hash, mtime, indexed_at FROM ${A}.files`).run(project);
      }

      const nodes = (db.prepare('SELECT COUNT(*) AS c FROM main.nodes WHERE project = ?').get(project) as any).c;
      const edges = (db.prepare('SELECT COUNT(*) AS c FROM main.edges WHERE project = ?').get(project) as any).c;
      return { project, nodes, edges };
    } finally {
      db.exec(`DETACH DATABASE ${A}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
