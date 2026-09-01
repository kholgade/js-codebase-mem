import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../sql/store.ts';
import type { LanguageRegistry } from '../languages/contract.ts';
import { indexRepository, walk, isSupportedFile, type IndexResult } from './index.ts';

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target', 'out', 'venv', '.venv',
  '__pycache__', '.next', '.nuxt', '.cache', 'bin', 'obj', '.gradle', '.idea', '.vscode',
  '.gitignore', 'coverage', '.tox', '.mypy_cache', '.pytest_cache', 'vendor', '.terraform',
]);

export interface ProjectWatcherOptions {
  project: string;
  repoPath: string;
  store: Store;
  registry: LanguageRegistry;
  debounceMs?: number;
  onIndex?: (r: IndexResult) => void;
}

/**
 * Watches a project directory and incrementally re-indexes it when files change.
 * Uses a lightweight polling loop (compare content hashes against the files table)
 * with an `fs.watch` recursive fast-path as an optional trigger. When recursive
 * watching is unsupported it falls back to pure polling.
 */
export class ProjectWatcher {
  private readonly project: string;
  private readonly repoPath: string;
  private readonly store: Store;
  private readonly registry: LanguageRegistry;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly onIndex?: (r: IndexResult) => void;

  private running = false;
  private dirty = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fsWatcher: FSWatcher | null = null;
  private indexing = false;
  private pendingReindex = false;
  private _lastIndex: IndexResult | undefined;

  constructor(opts: ProjectWatcherOptions) {
    this.project = opts.project;
    this.repoPath = opts.repoPath;
    this.store = opts.store;
    this.registry = opts.registry;
    this.debounceMs = opts.debounceMs ?? 300;
    this.pollIntervalMs = 2000;
    this.onIndex = opts.onIndex;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tryFsWatch();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  get lastIndex(): IndexResult | undefined {
    return this._lastIndex;
  }

  /**
   * Diff the working tree against the files table and re-index anything that
   * changed. Stale nodes for edited files are pruned first so re-indexing a
   * file replaces rather than duplicates its graph.
   */
  async reindex(): Promise<IndexResult> {
    if (this.indexing) {
      this.pendingReindex = true;
      return this._lastIndex as IndexResult;
    }
    this.indexing = true;
    try {
      const changes = await this.scanChanges();
      for (const rel of changes) this.pruneFile(rel);

      const result = await indexRepository({
        project: this.project,
        repoPath: this.repoPath,
        store: this.store,
        registry: this.registry,
      });
      this._lastIndex = result;
      pruneMissingFiles(this.store, this.project, this.repoPath);
      this.dirty = false;
      this.onIndex?.(result);
      return result;
    } finally {
      this.indexing = false;
      if (this.pendingReindex) {
        this.pendingReindex = false;
        void this.reindex();
      }
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || this.indexing) return;
    const changes = await this.scanChanges();
    if (changes.size > 0) this.scheduleReindex();
  }

  /** Walk the tree and return rel paths whose on-disk hash differs from the files table. */
  private async scanChanges(): Promise<Set<string>> {
    const ignore = new Set<string>(DEFAULT_IGNORE);
    const root = resolve(this.repoPath);
    const files: string[] = [];
    await walk(root, ignore, files);

    const changed = new Set<string>();
    for (const file of files) {
      if (!isSupportedFile(file)) continue;
      const rel = relative(root, file);
      let src: string;
      try {
        src = await readFile(file, 'utf8');
      } catch {
        changed.add(rel);
        continue;
      }
      const hash = createHash('sha1').update(src).digest('hex');
      const row = this.store.getFile(this.project, rel);
      if (!row || row.hash !== hash) changed.add(rel);
    }
    return changed;
  }

  private scheduleReindex(): void {
    if (!this.running) return;
    this.dirty = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reindex();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  /** Remove graph rows for a single file so re-indexing replaces it. */
  private pruneFile(rel: string): void {
    const db = this.store.underlying;
    const ids = this.store.queryNodes(
      'SELECT id FROM nodes WHERE project = ? AND file = ?',
      [this.project, rel],
    );
    for (const row of ids) {
      db.prepare('DELETE FROM edges WHERE src = ? OR dst = ?').run(row.id, row.id);
    }
    db.prepare('DELETE FROM nodes WHERE project = ? AND file = ?').run(this.project, rel);
    db.prepare('DELETE FROM files WHERE project = ? AND path = ?').run(this.project, rel);
  }

  private tryFsWatch(): void {
    try {
      this.fsWatcher = watch(this.repoPath, { recursive: true }, () => {
        if (!this.running) return;
        this.scheduleReindex();
      });
      this.fsWatcher.on?.('error', () => {
        /* ignore fs.watch errors; polling is the source of truth */
      });
    } catch {
      // Recursive watch unsupported on this platform; rely on polling.
      this.fsWatcher = null;
    }
  }
}

/** Delete nodes/edges (and their files rows) for tracked files that no longer exist under repoPath. */
export function pruneMissingFiles(store: Store, project: string, repoPath: string): void {
  const root = resolve(repoPath);
  const tracked = store.queryNodes(
    'SELECT DISTINCT file FROM nodes WHERE project = ?',
    [project],
  ) as Array<{ file: string }>;

  const missing: string[] = [];
  for (const t of tracked) {
    if (!t.file) continue;
    const abs = join(root, t.file);
    if (!existsSync(abs)) missing.push(t.file);
  }
  if (missing.length === 0) return;

  const db = store.underlying;
  db.exec('BEGIN');
  try {
    for (const rel of missing) {
      const ids = store.queryNodes('SELECT id FROM nodes WHERE project = ? AND file = ?', [project, rel]);
      for (const row of ids) {
        db.prepare('DELETE FROM edges WHERE src = ? OR dst = ?').run(row.id, row.id);
      }
      db.prepare('DELETE FROM node_embeddings WHERE project = ? AND node_id NOT IN (SELECT id FROM nodes WHERE project = ?)')
        .run(project, project);
      db.prepare('DELETE FROM nodes WHERE project = ? AND file = ?').run(project, rel);
      db.prepare('DELETE FROM files WHERE project = ? AND path = ?').run(project, rel);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  store.setProjectCounts(project);
}

/** No-op retained for API symmetry; daemon shutdown is handled via process signals. */
export function stopWatch(): void {
  /* no-op */
}
