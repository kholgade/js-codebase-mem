import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './sql/store.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const ARTIFACT_FORMAT = 'codebase-mem-artifact';
export const ARTIFACT_VERSION = 1;
const MAGIC = 'CBMART1';
const TOOL_VERSION = process.env.npm_package_version ?? '0.1.0';

export type ArtifactCompression = 'gzip' | 'none';
export type ArtifactScope = 'project' | 'full';
export type ImportMode = 'merge' | 'replace';

export interface ArtifactHeader {
  format: string;
  version: number;
  createdAt: string;
  toolVersion: string;
  projects: string[];
}

export interface ArtifactExportOptions {
  compression?: ArtifactCompression;
  scope?: ArtifactScope;
}

export interface ArtifactImportOptions {
  mode?: ImportMode;
  project?: string;
}

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

export interface ArtifactDiffReport {
  project: string;
  source: string;
  formatVersion?: number;
  /** node counts (by label) present in the artifact */
  nodeCounts: Record<string, number>;
  /** node counts (by label) present in the live store */
  liveNodeCounts: Record<string, number>;
  /** edge types present in the artifact */
  edgeTypesPresent: string[];
  /** edge types present in the live store */
  liveEdgeTypes: string[];
  /** files tracked by the live store that are absent from the artifact */
  missingFiles: string[];
  artifactHasEmbeddings: boolean;
  storeHasEmbeddings: boolean;
}

interface BuiltPayload {
  payloadPath: string;
  projects: string[];
}

/**
 * Serialize the header as `MAGIC + uint32(jsonLen) + jsonHeader + payload`.
 */
function composeArtifact(payload: Buffer, header: ArtifactHeader, compression: ArtifactCompression): Promise<Buffer> {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  const body = Buffer.concat([Buffer.from(MAGIC, 'latin1'), len, json, payload]);
  if (compression === 'gzip') return gzipAsync(body);
  return Promise.resolve(body);
}

/**
 * Locate and parse the header at the head of a decompressed artifact. Returns
 * null for legacy payloads that have no header (raw SQLite DB bytes).
 */
function parseHeader(buf: Buffer): { header: ArtifactHeader; payload: Buffer } | null {
  const magic = Buffer.from(MAGIC, 'latin1');
  if (buf.length < magic.length + 4) return null;
  if (!buf.subarray(0, magic.length).equals(magic)) return null;
  const len = buf.readUInt32BE(magic.length);
  const start = magic.length + 4;
  const end = start + len;
  if (buf.length < end) return null;
  let header: ArtifactHeader;
  try {
    header = JSON.parse(buf.subarray(start, end).toString('utf8')) as ArtifactHeader;
  } catch {
    return null;
  }
  return { header, payload: buf.subarray(end) };
}

/**
 * Normalize raw file bytes into { payload, header }. Handles the new
 * self-describing format (gzip or raw) and the legacy raw-gzip form.
 */
async function resolvePayload(bytes: Buffer): Promise<{ payload: Buffer; header: ArtifactHeader | null }> {
  let buffer: Buffer;
  try {
    buffer = await gunzipAsync(bytes);
  } catch {
    buffer = bytes;
  }
  const parsed = parseHeader(buffer);
  if (parsed) return { payload: parsed.payload, header: parsed.header };
  return { payload: buffer, header: null };
}

const SCOPE_TABLE_COL: Record<string, string> = {
  projects: 'name',
  nodes: 'project',
  edges: 'project',
  files: 'project',
  node_embeddings: 'project',
  traces: 'project',
};

/**
 * Build the SQLite payload that becomes the artifact body. For 'full' scope the
 * whole DB backup is returned; for 'project' scope only the named project's rows
 * are copied into a fresh temp DB.
 */
async function buildPayload(store: Store, project: string, scope: ArtifactScope, tmpDir: string): Promise<BuiltPayload> {
  const backupDb = join(tmpDir, 'backup.db');
  await backup(store.underlying, backupDb);

  if (scope === 'full') {
    const db = new DatabaseSync(backupDb);
    try {
      const projects = (db.prepare('SELECT name FROM projects ORDER BY name').all() as any[]).map((r) => r.name);
      return { payloadPath: backupDb, projects };
    } finally {
      db.close();
    }
  }

  const scopeDb = join(tmpDir, 'scope.db');
  const db = new DatabaseSync(scopeDb);
  const B = `cbm_backup_${Date.now()}`;
  db.exec('PRAGMA journal_mode = OFF');
  db.exec(`ATTACH DATABASE '${backupDb.replaceAll("'", "''")}' AS ${B}`);
  try {
    for (const table of Object.keys(SCOPE_TABLE_COL)) {
      db.exec(`CREATE TABLE main.${table} AS SELECT * FROM ${B}.${table} WHERE 0`);
    }
    for (const [table, col] of Object.entries(SCOPE_TABLE_COL)) {
      db.prepare(`INSERT INTO main.${table} SELECT * FROM ${B}.${table} WHERE ${col} = ?`).run(project);
    }
    return { payloadPath: scopeDb, projects: [project] };
  } finally {
    db.exec(`DETACH DATABASE ${B}`);
    db.close();
  }
}

/**
 * Dump all or part of the store to a self-describing graph artifact.
 *
 * The DB is backed up to a temp file via node:sqlite's `backup()`, wrapped in a
 * JSON header (format/version/projects), and compressed with the built-in
 * node:zlib. `scope: 'project'` limits the payload to the given project's rows.
 */
export async function exportArtifact(
  store: Store,
  project: string,
  destPath: string,
  opts: ArtifactExportOptions = {},
): Promise<ArtifactExportResult> {
  const compression = opts.compression ?? 'gzip';
  const scope = opts.scope ?? 'full';
  const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-art-'));
  try {
    const { payloadPath, projects } = await buildPayload(store, project, scope, tmpDir);
    const payload = await readFile(payloadPath);
    const header: ArtifactHeader = {
      format: ARTIFACT_FORMAT,
      version: ARTIFACT_VERSION,
      createdAt: new Date().toISOString(),
      toolVersion: TOOL_VERSION,
      projects,
    };
    const artifact = await composeArtifact(payload, header, compression);
    writeFileSync(destPath, artifact);
    const nodes = store.countNodes(project);
    const edges = store.countEdges(project);
    return { project, nodes, edges, dest: destPath };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Import a graph artifact into the current store.
 *
 * The artifact (new self-describing or legacy raw-gzip) is decompressed to a
 * temp DB and its projects/nodes/edges/files are copied into this store via
 * parameterized ATTACH + INSERT OR IGNORE. `mode: 'replace'` deletes the target
 * project first; the `project` option renames the imported project.
 */
export async function importArtifact(
  store: Store,
  srcPath: string,
  opts: string | ArtifactImportOptions = {},
): Promise<ArtifactImportResult> {
  const finalOpts: ArtifactImportOptions = typeof opts === 'string' ? { project: opts } : opts;
  const mode = finalOpts.mode ?? 'merge';
  const projectOverride = finalOpts.project;

  const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-art-'));
  const tmpDb = join(tmpDir, 'graph.db');
  try {
    const bytes = await readFile(srcPath);
    const { payload } = await resolvePayload(bytes);
    writeFileSync(tmpDb, payload);

    let sourceProject: string | undefined;
    {
      const src = new DatabaseSync(tmpDb);
      try {
        const row = src.prepare('SELECT name FROM projects ORDER BY name LIMIT 1').get() as any;
        sourceProject = row?.name;
      } finally {
        src.close();
      }
    }
    const project = projectOverride ?? sourceProject ?? 'unknown';

    if (mode === 'replace') {
      store.deleteProject(project);
    }

    const db = store.underlying;
    // NOTE: SQLite does NOT allow ATTACH to take its DB filename as a bound
    // parameter (the file path must be a literal in the SQL text); the earlier
    // `ATTACH DATABASE ?` form silently misbehaved and could corrupt the store.
    const A = `cbm_art_${Date.now()}`;
    const escapedPath = tmpDb.replaceAll("'", "''");
    db.exec(`ATTACH DATABASE '${escapedPath}' AS ${A}`);
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS adr (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, content TEXT, created_at INTEGER, updated_at INTEGER)',
      );

      const srcName = sourceProject ?? project;
      const useSrc = srcName === project;

      if (useSrc) {
        db.exec(`INSERT OR IGNORE INTO main.projects SELECT * FROM ${A}.projects`);
        db.exec(
          `INSERT OR IGNORE INTO main.nodes (id, project, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc) SELECT id, project, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc FROM ${A}.nodes`,
        );
        db.exec(
          `INSERT OR IGNORE INTO main.edges (id, project, src, dst, type, confidence, site_line, trace_hits) SELECT id, project, src, dst, type, confidence, site_line, trace_hits FROM ${A}.edges`,
        );
        db.exec(
          `INSERT OR IGNORE INTO main.files (path, project, lang, hash, mtime, indexed_at) SELECT path, project, lang, hash, mtime, indexed_at FROM ${A}.files`,
        );
        db.exec(`INSERT OR IGNORE INTO main.node_embeddings SELECT * FROM ${A}.node_embeddings`);
        db.exec(`INSERT OR IGNORE INTO main.traces SELECT * FROM ${A}.traces`);
      } else {
        db.prepare(
          `INSERT OR IGNORE INTO main.projects (name, root, node_count, edge_count, created_at, updated_at) SELECT ?, root, node_count, edge_count, created_at, updated_at FROM ${A}.projects WHERE name = ?`,
        ).run(project, srcName);
        db.prepare(
          `INSERT OR IGNORE INTO main.nodes (id, project, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc) SELECT id, ?, file, start_line, start_col, end_line, end_col, label, name, qualified, signature, doc FROM ${A}.nodes`,
        ).run(project);
        db.prepare(
          `INSERT OR IGNORE INTO main.edges (id, project, src, dst, type, confidence, site_line, trace_hits) SELECT id, ?, src, dst, type, confidence, site_line, trace_hits FROM ${A}.edges`,
        ).run(project);
        db.prepare(
          `INSERT OR IGNORE INTO main.files (path, project, lang, hash, mtime, indexed_at) SELECT path, ?, lang, hash, mtime, indexed_at FROM ${A}.files`,
        ).run(project);
        db.prepare(
          `INSERT OR IGNORE INTO main.node_embeddings (node_id, project, vec) SELECT node_id, ?, vec FROM ${A}.node_embeddings WHERE project = ?`,
        ).run(project, srcName);
        db.prepare(
          `INSERT OR IGNORE INTO main.traces (id, project, name, root, calls, created_at) SELECT id, ?, name, root, calls, created_at FROM ${A}.traces WHERE project = ?`,
        ).run(project, srcName);
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

function labelCounts(db: DatabaseSync, project: string): Record<string, number> {
  const rows = db.prepare('SELECT label AS l, COUNT(*) AS c FROM nodes WHERE project = ? GROUP BY label').all(project) as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.l] = Number(r.c);
  return out;
}

function edgeTypes(db: DatabaseSync, project: string): string[] {
  return (db.prepare('SELECT DISTINCT type AS t FROM edges WHERE project = ?').all(project) as any[]).map((r) => r.t);
}

function filePaths(db: DatabaseSync, project: string): Set<string> {
  return new Set((db.prepare('SELECT path AS p FROM files WHERE project = ?').all(project) as any[]).map((r) => r.p));
}

function hasEmbeddings(db: DatabaseSync, project: string): boolean {
  return !!db.prepare('SELECT 1 AS x FROM node_embeddings WHERE project = ? LIMIT 1').get(project);
}

/**
 * Compare an artifact against the live store for a project and return a
 * lightweight structured diff. Never modifies the store.
 */
export async function diffArtifacts(store: Store, srcPath: string, project?: string): Promise<ArtifactDiffReport> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-art-'));
  const tmpDb = join(tmpDir, 'graph.db');
  try {
    const bytes = await readFile(srcPath);
    const { payload, header } = await resolvePayload(bytes);
    writeFileSync(tmpDb, payload);

    let compareProject = project ?? header?.projects?.[0];
    const src = new DatabaseSync(tmpDb);
    try {
      if (!compareProject) {
        const row = src.prepare('SELECT name FROM projects ORDER BY name LIMIT 1').get() as any;
        compareProject = (row?.name as string | undefined) ?? 'unknown';
      }
      const target = compareProject;
      const storeDb = store.underlying;
      const artifactFiles = filePaths(src, target);
      const storeFiles = filePaths(storeDb, target);
      const missingFiles = [...storeFiles].filter((p) => !artifactFiles.has(p));
      return {
        project: target,
        source: srcPath,
        formatVersion: header?.version,
        nodeCounts: labelCounts(src, target),
        liveNodeCounts: labelCounts(storeDb, target),
        edgeTypesPresent: edgeTypes(src, target),
        liveEdgeTypes: edgeTypes(storeDb, target),
        missingFiles,
        artifactHasEmbeddings: hasEmbeddings(src, target),
        storeHasEmbeddings: hasEmbeddings(storeDb, target),
      };
    } finally {
      src.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
