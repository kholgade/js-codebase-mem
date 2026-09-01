# Architecture

`js-codebase-mem` is a Node.js code-intelligence engine. It parses a codebase with
[tree-sitter](https://tree-sitter.github.io/) (via `web-tree-sitter`, compiled to
WASM — no native compilation), builds a **knowledge graph** of symbols and their
relationships, stores that graph in a **SQLite database** (`node:sqlite`, built
into Node ≥ 22.5), and exposes it through an **MCP server**, a **CLI**, and a
**web UI** — with full-text (FTS5) and vector semantic search.

It is a TypeScript/ESM port of the algorithms from
[DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp),
scoped to 8 languages with an extensible per-language plugin contract.

```
                  ┌─────────────────────────────────────────────┐
   on disk repo   │                Indexer layer                │
   (JS/TS/Python/ │  indexRepository  +  ProjectWatcher (live)  │
   Java/Go/Rust/  │  walk + gitignore → parse → extract → write │
   C++/C#)        └──────────────────────┬──────────────────────┘
                                         │ writes
                                         ▼
                  ┌─────────────────────────────────────────────┐
                  │            Store layer  (node:sqlite)       │
                  │   projects · nodes · edges · files ·         │
                  │   node_embeddings · nodes_fts · traces · adr │
                  └──────────────┬─────────────────┬─────────────┘
                                 │                 │
              read queries      │                 │  read queries
                                 ▼                 ▼
        ┌────────────────────┐      ┌──────────────────────────┐
        │   Query/Resolver   │      │      Search layer        │
        │  tools.ts (search  │      │  service / fts / semantic│
        │  graph, trace path,│      │  / signals / tokenize    │
        │  openCypher subset)│      └──────────────────┬───────┘
        │  resolver/* scope  │                         │
        └─────────┬──────────┘                         │
                  │                                    │
                  ▼                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │              Server / interface layer                │
        │  server/mcp.ts (MCP over stdio) · server/http.ts (UI)│
        │  server/install.ts (agent config wiring) · cli/index │
        └──────────────────────────────────────────────────────┘
```

## Component overview

### 1. Indexer (`src/indexer/`)

- **`indexRepository`** (`src/indexer/index.ts`) walks a repository, ignores
  common build/vendor directories and `.gitignore`/`.cbm-ignore` patterns,
  parses supported files with tree-sitter, extracts structured `Emit` facts, and
  writes the graph (nodes + edges) into the store inside a single transaction.
  - File freshness is tracked by SHA‑1 hash; unchanged files are skipped
    (`skippedUpToDate`).
  - `wasmPath`/`queryByExt`/`wasmByExt` from each `LanguagePlugin` select the
    grammar and the `.scm` query used for extraction.
- **`ProjectWatcher`** (`src/indexer/watcher.ts`) re-indexes a project as files
  change. It uses a **polling loop** (compare on-disk SHA‑1 hashes against the
  `files` table every 2 s) as the source of truth, with a best-effort
  `fs.watch` recursive fast-path as an optional trigger (falls back to pure
  polling where recursive watch is unsupported). Changes are debounced
  (default 300 ms) and re-indexed. Stale nodes for changed/deleted files are
  pruned before re-indexing so the graph is replaced rather than duplicated.
- **`ParserPool`** (`src/indexer/parser-pool.ts`) lazily initializes the shared
  `web-tree-sitter` runtime and reuses one `Parser` per `(plugin, wasm)` pair.

### 2. Languages (`src/languages/`)

A `LanguagePlugin` is the extension point. See
[`language-support.md`](language-support.md) for the full contract and a
plugin-development guide.

### 3. Store (`src/sql/store.ts`)

A thin typed wrapper around a synchronous `DatabaseSync` handle. It owns the
schema, indexes, FTS triggers, and the CRUD used by the indexer and queries.
The DB file defaults to `~/.cache/js-codebase-mem/graphs.db` (override with
`CBM_CACHE_DIR`). All connections open with `PRAGMA journal_mode = WAL` and
`PRAGMA synchronous = NORMAL`.

The `adr` table is **not** part of the base schema; it is created on demand by
`src/query/adr.ts` (and by artifact import).

### 4. Query & resolvers (`src/query/`, `src/resolver/`)

- `src/query/tools.ts` implements the graph operations used by MCP/CLI:
  `searchGraph`, `traceCallPath`, `queryGraph` (a runnable openCypher subset),
  `getCodeSnippet`, `searchCode`, `detectChanges`, `getArchitecture`,
  `deadCode`, `getGraphSchema`, `indexStatus`.
- `src/resolver/` implements the optional per-language deep-resolution tier
  (`Resolver` interface). Each language may ship a resolver that turns a syntax
  node into a qualified target. When absent, `buildLanguage` falls back to a
  passthrough resolver. Scopes are modeled with a lexical scope chain
  (`src/resolver/scope.ts`).

### 5. Search (`src/search/`)

- Full-text search over an **FTS5** virtual table (`nodes_fts`) with BM25
  ranking, kept in sync with `nodes` via triggers.
- Semantic (vector) search over 256-dim embeddings stored int8-quantized in
  `node_embeddings`. Embeddings come from a deterministic zero-dependency
  hashing embedder by default, or from an optional Transformers.js model
  (see [`usage.md`](usage.md)).
- `src/search/signals.ts` implements an optional richer scoring ensemble
  (TF‑IDF, module proximity, signature overlap, AST profile).

### 6. Server & interfaces (`src/server/`, `src/cli/`)

- **MCP server** (`src/server/mcp.ts`) exposes the tools over `stdio`.
- **HTTP graph UI** (`src/server/http.ts`) serves a single-page 3D-style
  force-directed graph visualizer with a small JSON API.
- **CLI** (`src/cli/index.ts`) wraps index, watch, serve, and all tools.
- **install** (`src/server/install.ts`) detects installed coding agents and
  wires the MCP server into their config files.

## Data flow (indexing)

1. `indexRepository` resolves the repo root, `upsertProject`s the metadata row.
2. `walk` collects candidate files, applying the default ignore set, then
   `.gitignore` and `.cbm-ignore` patterns loaded per-directory (with negation
   `!` and directory-only `/` support).
3. For each file with a registered `LanguagePlugin` (by extension, longest
   suffix wins): read source, compute SHA‑1 hash, skip if unchanged.
4. `extract` selects `wasmByExt`/`queryByExt` overrides, parses with the pool,
   runs the language `.scm` query, and converts captures into `Emit` facts via
   `emitsFromQuery` (`src/languages/base.ts`).
5. `contextualize` attributes qualified names / module scope to each emit.
6. `writeFileGraph` (all inside one `BEGIN`/`COMMIT` transaction):
   - Inserts a `File` node, then one node per `define` emit, mapping qualified
     name → node id in a cross-file `symbolToId` table.
   - Emits `DEFINES` (file → symbol) edges; classifies node labels via
     `labelForNode`.
   - For `call`/`inherit`/`http-route` emits, resolves targets against local
     names and inserts `CALLS`/`INHERITS`/`HANDLES` (`Route` node) edges.
7. `setProjectCounts` updates aggregate counts on the `projects` row.

## SQLite schema

Created by `src/sql/store.ts` (`SCHEMA`):

```sql
CREATE TABLE projects (
  name TEXT PRIMARY KEY, root TEXT NOT NULL,
  node_count INTEGER DEFAULT 0, edge_count INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, file TEXT NOT NULL,
  start_line INTEGER, start_col INTEGER, end_line INTEGER, end_col INTEGER,
  label TEXT NOT NULL, name TEXT NOT NULL, qualified TEXT NOT NULL,
  signature TEXT, doc TEXT
);
CREATE INDEX idx_nodes_proj_label ON nodes(project, label);
CREATE INDEX idx_nodes_proj_qual  ON nodes(project, qualified);

CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  src INTEGER NOT NULL, dst INTEGER,
  type TEXT NOT NULL,
  confidence TEXT NOT NULL,          -- 'exact' | 'reference' | 'usage'
  site_line INTEGER,
  trace_hits INTEGER DEFAULT 0       -- added by idempotent migration
);
CREATE INDEX idx_edges_src ON edges(src);
CREATE INDEX idx_edges_dst ON edges(dst);
CREATE INDEX idx_edges_proj_type ON edges(project, type);
CREATE INDEX idx_edges_src_type ON edges(src, type);

CREATE TABLE files (
  path TEXT PRIMARY KEY, project TEXT NOT NULL, lang TEXT NOT NULL,
  hash TEXT NOT NULL, mtime INTEGER, indexed_at INTEGER
);

CREATE TABLE node_embeddings (
  node_id INTEGER PRIMARY KEY, project TEXT NOT NULL, vec BLOB
);                                   -- int8-quantized 256-dim vectors

CREATE TABLE traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, name TEXT, root TEXT,
  calls TEXT NOT NULL,               -- JSON array of call-site strings
  created_at INTEGER
);

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name, qualified, signature, doc, content='nodes', content_rowid='id'
);
-- triggers nodes_ai / nodes_ad / nodes_au keep nodes_fts in sync on insert/delete/update
```

The `adr` table is created lazily (`src/query/adr.ts`):

```sql
CREATE TABLE IF NOT EXISTS adr (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT, created_at INTEGER, updated_at INTEGER
);
```

### Node labels

Defined in `src/core/types.ts`:

```
Project  Package  Folder  File  Module
Class  Function  Method  Interface  Enum  Type
Route  Resource
```

Which labels are actually emitted depends on the grammar queries; the most
commonly produced are `Function`, `Class`, `Method`, `Interface`, `Enum`,
`Type`, `File`, `Module`, and `Route`.

### Edge types

```
CONTAINS_PACKAGE  CONTAINS_FOLDER  CONTAINS_FILE
DEFINES  DEFINES_METHOD  IMPORTS
CALLS  CALL_REFERENCE  USAGE
HTTP_CALLS  ASYNC_CALLS  IMPLEMENTS  INHERITS
HANDLES  CONFIGURES  WRITES  MEMBER_OF  TESTS
USES_TYPE  FILE_CHANGES_WITH  EMITS  LISTENS_ON
DATA_FLOWS  SIMILAR_TO  SEMANTICALLY_RELATED
```

The type union includes edge kinds designed for future/dynamic use
(e.g. `SIMILAR_TO`, `SEMANTICALLY_RELATED`, `DATA_FLOWS`). The indexer as it
exists today emits a concrete subset through `writeFileGraph`:

| Edge | Production |
|------|------------|
| `DEFINES` | File node → each defined symbol node |
| `CALLS` | caller → callee (confidence `exact` when resolved, else `usage` with `dst = NULL`) |
| `IMPORTS` | File node → `NULL` (import targets are not joined) |
| `INHERITS` | subclass/interface → base |
| `HANDLES` | File → `Route` node |
| `CALL_REFERENCE` | `Route` → cross-module handler (reference) |

## Concurrency & watcher model

- **Single-process SQLite with WAL** allows concurrent readers during a
  writer's transaction. All writes by the indexer happen inside explicit
  `BEGIN`/`COMMIT` blocks so a crash rolls back cleanly.
- **`ProjectWatcher`** (`src/indexer/watcher.ts`):
  - A `pollIntervalMs` (2 s) timer calls `scanChanges()`, which walks the tree
    and compares each supported file's SHA‑1 against the `files` table.
  - A debounce timer (default `debounceMs` = 300 ms) coalesces bursts.
  - A recursive `fs.watch` fast-path signals `scheduleReindex` early; it is
    non-authoritative (errors ignored) and skipped entirely when unsupported —
    polling remains the source of truth.
  - `indexing` guards against re-entrancy: if a reindex is already in progress,
    a `pendingReindex` flag queues one more pass.
  - Changed files are pruned (`pruneFile`) before re-indexing so their subgraph
    is replaced, not duplicated; `pruneMissingFiles` removes graph rows for
    files that no longer exist on disk.
- The **daemon lifecycle**: `watch` keeps the process alive; shutdown is handled
  via `SIGINT`/`SIGTERM`. `src/indexer/watcher.ts#stopWatch` is a retained no-op
  for API symmetry.
