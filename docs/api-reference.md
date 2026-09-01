# API reference

`js-codebase-mem` exposes two interfaces: a **CLI** (commands + tools) and an
**MCP server** (tools over stdio). The CLI and MCP tools are thin wrappers
around the same functions in `src/query/tools.ts`, `src/search/service.ts`, and
`src/query/adr.ts`.

Both share a single SQLite database. The DB path is:

- `$CBM_CACHE_DIR/graphs.db` if `CBM_CACHE_DIR` is set, else
- `~/.cache/js-codebase-mem/graphs.db`

## MCP tools

The MCP server (`src/server/mcp.ts`) registers 16 tools. Every tool returns a
text/JSON result. `project` names are required by the graph-querying tools.

| # | Tool | Params | Returns |
|---|------|--------|---------|
| 1 | `index_repository` | `repo_path: string`, `project?: string` | `IndexResult` JSON |
| 2 | `list_projects` | — | list of `{name, root, node_count, edge_count}` |
| 3 | `delete_project` | `project: string` | `{deleted: string}` |
| 4 | `index_status` | `project: string` | status object or `{error}` |
| 5 | `search_graph` | `project`, `name_pattern?`, `label?`, `file_pattern?`, `min_degree?`, `max_degree?`, `limit?`, `offset?` | matching nodes |
| 6 | `trace_path` | `project`, `function_name`, `direction?` (`inbound`/`outbound`/`both`, default `both`), `depth?` (1–5, default 3) | call-path `Hop[]` |
| 7 | `detect_changes` | `project`, `repo_path` | changed files, affected nodes, risk |
| 8 | `query_graph` | `project`, `query` (openCypher subset) | result rows |
| 9 | `get_graph_schema` | `project` | `{nodeLabels, edgeTypes}` counts |
| 10 | `get_code_snippet` | `project`, `qualified_name` | node metadata + source lines |
| 11 | `get_architecture` | `project` | languages/packages/entry points/hotspots/routes/clusters |
| 12 | `search_code` | `project`, `pattern` | matching nodes |
| 13 | `semantic_query` | `project`, `query`, `limit?`, `signals?`, `vec_weight?`, `fts_weight?` | semantic hits |
| 14 | `build_index` | `project`, `use_model?` | FTS + embedding build result |
| 15 | `manage_adr` | `project`, `mode` (`list`/`get`/`update`), `id?`, `content?` | ADR rows |
| 16 | `ingest_traces` | `project`, `traces?` | `{ingested: n}` (stub) |

### Detailed tool reference

#### 1. `index_repository`

Index a repository into the knowledge graph.

- Params: `repo_path: string` (required), `project: string` (optional; defaults
  to the last path segment of `repo_path`).
- Returns: `IndexResult` JSON — `{project, files, indexedFiles, skippedUpToDate, nodes, edges, durationMs}`.

#### 2. `list_projects`

List all indexed projects.

- Params: none.
- Returns: array of `{name, root, node_count, edge_count}`.

#### 3. `delete_project`

Delete a project and all its data (edges, embeddings, nodes, files, traces,
project row).

- Params: `project: string`.
- Returns: `{deleted: string}`.

#### 4. `index_status`

Get indexing status for a project.

- Params: `project: string`.
- Returns: `{name, root, node_count, edge_count, file_count, created_at, updated_at}`
  or `{error: "project not found"}`.

#### 5. `search_graph`

Search nodes in the knowledge graph.

- Params: `project` (required); `name_pattern`, `label`, `file_pattern`
  (glob-ish, converted to `LIKE`); `min_degree`, `max_degree` (filter by
  in+out degree); `limit` (default 100), `offset` (default 0).
- Returns: array of `{id, label, name, qualified, file, start_line, degree}`.

#### 6. `trace_path`

Trace call paths from/to a function.

- Params: `project`, `function_name` (matched against `qualified` or `name`);
  `direction` (`inbound`, `outbound`, or `both`, default `both`);
  `depth` (1–5, default 3; internally clamped to ≤ 5).
- Returns: array of hops `{depth, from, to, type, confidence, file, site_line}`
  across `CALLS`, `CALL_REFERENCE`, and `USAGE` edges.

#### 7. `detect_changes`

Detect changed files (via `git diff --name-only HEAD` and `git ls-files
--others --exclude-standard`) and their blast radius (one level of callers /
callees).

- Params: `project`, `repo_path`.
- Returns: `{changedFiles: [{path, status}], affectedNodes, risk}` where
  `risk` is `low`/`medium`/`high` (high when > 20 affected nodes, medium when
  > 5).

#### 8. `query_graph`

Query the graph with a minimal Cypher-like query. See
[`query-language.md`](query-language.md) for the supported subset.

- Params: `project`, `query` (openCypher subset).
- Returns: array of result rows (each row has the requested `RETURN` columns).

#### 9. `get_graph_schema`

Get counts of node labels and edge types.

- Params: `project`.
- Returns: `{nodeLabels: {Label: count}, edgeTypes: {Type: count}}`.

#### 10. `get_code_snippet`

Get a code snippet by qualified name (reads the source file from disk).

- Params: `project`, `qualified_name` (matched against `qualified` or `name`).
- Returns: `{name, qualified, file, start_line, end_line, signature, doc, code}`
  or `{error: "not found"}`.

#### 11. `get_architecture`

Get an architecture overview for a project.

- Params: `project`.
- Returns: `{languages: {ext: count}, packages: string[], entryPoints, hotspots, routes, clusters}`.
  `entryPoints` are `Function` nodes with no inbound `CALLS`; `hotspots` are the
  top-10 highest-degree nodes; `clusters` group nodes by top-level package.

#### 12. `search_code`

Search code by pattern in names, qualified names, and signatures.

- Params: `project`, `pattern`.
- Returns: up to 50 nodes matching `name`, `qualified`, or `signature` via
  `LIKE`.

#### 13. `semantic_query`

Semantic search over the knowledge graph. Requires that `build_index` has been
run for the project first (see the error message otherwise).

- Params: `project`, `query` (free text); `limit` (default 10); `signals`
  (boolean — enable additional TF‑IDF/module/signature/AST signals);
  `vec_weight` (default 0.55); `fts_weight` (default 0.30). The remaining
  weight (`1 − vec − fts`) is reserved for signals when enabled.
- Returns: array of `{node_id, label, name, qualified, file, signature, doc, score}`.

#### 14. `build_index`

Populate the FTS and semantic (embedding) index for a project.

- Params: `project` (required), `use_model` (optional boolean). When `true`,
  uses the Transformers.js model (if available and not disabled via
  `CBM_MODEL=off`); otherwise (and always when no model loads) uses the
  deterministic hashing embedder.
- Returns: `{project, embedded, skipped, ftsBuilt, usedModel}`.

#### 15. `manage_adr`

Manage Architecture Decision Records in the lazily-created `adr` table.

- Params: `project` (required), `mode` — `list`, `get`, or `update` — `id`
  (optional, required for `get`/`update`), `content` (optional, used by
  `update`).
- Returns: for `list`, an array of `{id, title, created_at}`; for `get`, the
  full ADR row or `{error: "not found"}`; for `update`, `{updated: id}`.

#### 16. `ingest_traces`

Ingest execution traces.

- Params: `project` (required), `traces` (optional array of arbitrary JSON).
- Returns: `{ingested: <count>}`. This is currently a **stub** — it only counts
  the trace objects and does not persist them. (The underlying `traces` table
  exists in the schema with `ingestTrace`/`getTraces` in `src/sql/store.ts`, but
  the MCP tool does not call them.)

## CLI reference

The CLI is `dist/cli/index.js` (bin name `js-codebase-mem`). Run `--help` for
the usage summary, `--version` for `0.1.0`.

Invocation forms:

```
js-codebase-mem index <repoPath> [--project <name>]
js-codebase-mem watch <repoPath> [--project <name>] [--interval <ms>] [--json]
js-codebase-mem daemon stop
js-codebase-mem cli <tool> [flags]
js-codebase-mem serve | mcp
js-codebase-mem serve-ui | ui [port]
js-codebase-mem install [--binary <path>]
js-codebase-mem uninstall
js-codebase-mem export_artifact --project <name> --dest <path>
js-codebase-mem import_artifact --src <path> [--project override]
js-codebase-mem --version | --help
```

### Top-level commands

| Command | Description |
|---------|-------------|
| `index <repoPath>` | Full index of a repository (`--project` defaults to the folder name). |
| `watch <repoPath>` | Watch and incrementally re-index. `--interval <ms>` (default 2000) sets the poll interval; `--json` emits JSON index results. |
| `daemon stop` | No-op stub; the watcher daemon is embedded in `watch` and stopped via `SIGINT`/`SIGTERM`. |
| `cli <tool>` | Run a single tool (below). |
| `serve` / `mcp` | Start the MCP server over stdio. |
| `serve-ui` / `ui [port]` | Start the HTTP graph UI (default port 9779, bound to `127.0.0.1`). |
| `install` | Wire the MCP server into detected coding-agent config files (Claude Code, VS Code, Cursor, Cline, OpenCode, Codex). `--binary <path>` overrides the binary path. |
| `uninstall` | Remove the MCP entry from those config files. |
| `export_artifact` | Export the store to a gzipped SQLite artifact. Requires `--project` and `--dest`. |
| `import_artifact` | Import an artifact into the store. Requires `--src`; optional `--project` renames the imported project. Import is **merge** by default (see artifact docs). |
| `--version` / `--help` | Print version / usage. |

### CLI tools (`cli <tool>`)

Flag syntax is `--key value`; boolean flags are given as `--flag true` or just
`--flag` (which parses as `'true'`).

| Tool | Flags | Notes |
|------|-------|-------|
| `list_projects` | — | List projects. |
| `index_status` | `--project <name>` | Status of a project. |
| `search_graph` | `--project`, `--name-pattern`, `--label`, `--file-pattern`, `--min-degree`, `--max-degree`, `--limit`, `--offset` | Search nodes. |
| `trace_path` | `--project`, `--function-name`, `--direction` (default `both`), `--depth` (default 3) | Trace call path. |
| `query_graph` | `--project`, `--query '<cypher>'` | Run an openCypher query. |
| `get_code_snippet` | `--project`, `--qualified-name` | Get a code snippet. |
| `search_code` | `--project`, `--pattern` | Search nodes by name/qualified/signature. |
| `detect_changes` | `--project`, `--repo-path` | Detect changes + blast radius. |
| `get_architecture` | `--project` | Architecture overview. |
| `dead_code` | `--project` | List functions/methods/classes with no incoming calls. |
| `get_graph_schema` | `--project` | Node/edge type counts. |
| `build_index` | `--project`, `--use-model` (`--use-model true`) | Build FTS + embeddings. |
| `semantic_query` | `--project`, `--query`, `--limit` (default 10), `--signals` | Semantic search. |
| `adr` | `--project`, `--mode list\|get\|update`, `--id`, `--content` | Manage ADRs. |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CBM_CACHE_DIR` | `~/.cache/js-codebase-mem` | Directory holding `graphs.db` (both CLI and MCP use it). |
| `CBM_MODEL` | unset | Set to `off` to disable the optional Transformers.js embedding model. |
| `CBM_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | Transformers.js model name used for embeddings. |
| `CODX_HOME` | `~/.codex` | Codex config dir used by `install`/`uninstall`. |
| `npm_package_version` | `0.1.0` | Version stamped into exported artifact headers. |

## Programmatic API

The modules export the functions used by MCP/CLI; useful for embedding:

- `src/indexer/index.ts`: `indexRepository`, `detectModuleSpec`, `walk`,
  `isSupportedFile`, and gitignore helpers (`parseGitignorePatterns`,
  `matchesGitignore`, `loadGitignorePatterns`).
- `src/indexer/watcher.ts`: `ProjectWatcher`, `pruneMissingFiles`.
- `src/languages/index.ts`: `createRegistry()` → `LanguageRegistry`.
- `src/sql/store.ts`: `Store` (typed thin wrapper over `node:sqlite`).
- `src/query/tools.ts`: `searchGraph`, `traceCallPath`, `queryGraph`,
  `getCodeSnippet`, `searchCode`, `detectChanges`, `getArchitecture`,
  `deadCode`, `getGraphSchema`, `indexStatus`.
- `src/search/service.ts`: `buildIndex`, `buildIndexAsync`, `searchCode`,
  `semanticQuery`, `detectEmbeddingModel`.
- `src/search/semantic.ts`: `embedText`, `embedNode`, `HashingEmbedder`,
  `quantizeToInt8`, `dequantizeFromInt8`, `buildEmbeddings`,
  `buildEmbeddingsAsync`, `SEMANTIC_HIT` helpers.
- `src/artifact.ts`: `exportArtifact`, `importArtifact`, `diffArtifacts` plus
  format constants/options types.
- `src/query/adr.ts`: `listAdr`, `getAdr`, `updateAdr`.
