# Usage

`js-codebase-mem` is a Node.js code intelligent engine: it parses a codebase
into a persistent knowledge graph in SQLite, then lets you query it over MCP,
CLI, or a web UI — with full-text and vector semantic search.

## Requirements

- **Node.js ≥ 22.5** — the engine relies on the built-in `node:sqlite` module
  and `node:test`, so no native compilation or native modules are needed.
- No other install-time native toolchain.

## Install and build

```bash
npm install
npm run build              # tsc → dist/ (+ makes the CLI executable)
npm link                   # optional: exposes the short `jcbm` command on PATH
```

(Optional) regenerate/download grammar manifests:

```bash
npm run build:grammars     # writes grammars/manifest.json
```

The examples below use the `jcbm` command. If you didn't `npm link`, prefix
every `jcbm` with `node dist/cli/index.js`.

Development mode (watch + re-run):

```bash
npm run dev                # tsx watch src/cli/index.ts
```

## Index a project

```bash
jcbm index /path/to/repo --project my-project
```

- `--project` defaults to the last path segment of the repo path if omitted.
- Output: `Indexed <files> files -> <nodes> nodes, <edges> edges (project "..."`).

The indexer respects `.gitignore` and `.cbm-ignore` files (negation `!`,
directory-only `/` patterns) plus a built-in default ignore set
(`node_modules`, `.git`, `dist`, `build`, `target`, `venv`, caches, etc.).

The database is stored at:

- `$CBM_CACHE_DIR/graphs.db` if `CBM_CACHE_DIR` is set, otherwise
- `~/.cache/js-codebase-mem/graphs.db`

## Watch and continuously re-index

```bash
jcbm watch /path/to/repo --project my-project
```

- Polls every 2 s (override with `--interval <ms>`) comparing file hashes; an
  `fs.watch` recursive fast-path triggers earlier when supported.
- `--json` prints index results as JSON lines.
- Stop with `Ctrl-C`/`SIGTERM`.

## Run the MCP server

```bash
jcbm serve      # also accepts: mcp
```

This starts the MCP server on **stdio**, suitable for connecting an MCP client
(Claude Code, VS Code, Cursor, Cline, OpenCode, Codex, ...).

To wire it into an installed coding agent automatically:

```bash
jcbm install        # detects config files and injects the server
jcbm uninstall      # removes it
```

`install` scans `~/.claude.json`, VS Code `mcp.json`, Cursor `mcp.json`,
Cline `mcp.json`, OpenCode `opencode.json`, and Codex `config.toml`. Use
`--binary <path>` to point at a different binary path.

See [`api-reference.md`](api-reference.md) for the full list of MCP tools.

## Run the HTTP graph UI

```bash
jcbm serve-ui       # or: ui; default port 9779
jcbm serve-ui 9000  # custom port
```

Opens a force-directed graph visualizer at `http://127.0.0.1:<port>` with:

- A project selector and a name search box.
- Node coloring by label (with legend), hover tooltips (name, label, file), and
  interactive pan/zoom and node dragging.
- A simulation loop with repulsion + neighbor attraction.
- Edges filtered to nodes currently in view.

JSON API endpoints (all `GET`, `Access-Control-Allow-Origin: *`):

| Endpoint | Purpose |
|----------|---------|
| `/api/projects` | List projects. |
| `/api/nodes?project=` | Nodes for a project (id, label, name, qualified, file, start_line). |
| `/api/edges?project=` | Edges for a project with both endpoints present (src, dst, type, confidence, site_line). |
| `/api/node/<id>` | A single node by id. |

## Use the CLI tools

Run any query tool through `cli <tool>`:

```bash
jcbm cli list_projects
jcbm cli search_graph --project my-project --label Function --limit 20
jcbm cli trace_path --project my-project --function-name handleRequest --direction both --depth 3
jcbm cli query_graph --project my-project --query "MATCH (n:Function) RETURN n.name, n.qualified LIMIT 10"
jcbm cli get_architecture --project my-project
jcbm cli dead_code --project my-project
jcbm cli get_code_snippet --project my-project --qualified-name auth.login
jcbm cli detect_changes --project my-project --repo-path /path/to/repo
jcbm cli get_graph_schema --project my-project
```

See [`query-language.md`](query-language.md) for the Cypher subset and
[`api-reference.md`](api-reference.md) for the full tool/flag reference.

## Semantic search and the embedding index

Semantic search needs an embedding index, built per project:

```bash
jcbm cli build_index --project my-project
# or use the optional model:
jcbm cli build_index --project my-project --use-model true
```

Then query:

```bash
jcbm cli semantic_query --project my-project --query "database connection pooling" --limit 10
```

### Optional model setup (`CBM_MODEL`, `CBM_EMBED_MODEL`)

- **Default (no model):** a deterministic, zero-dependency **hashing embedder**
  produces 256-dim vectors (FNV‑1a hashing of identifier tokens + 2-grams with
  TF weighting, L2-normalized). Embeddings are int8-quantized for storage. This
  always works and needs no network or extra packages.
- **Transformers.js model (optional):** if the `@huggingface/transformers`
  package (the optional peer dependency) is installed, the engine can use a real
  embedding model. The eagerly-loaded default strategy still uses the hashing
  embedder; the async model path is used when `buildIndexAsync`/`used_model`
  is requested.
  - `CBM_EMBED_MODEL` selects the model (default `Xenova/all-MiniLM-L6-v2`).
  - Set `CBM_MODEL=off` to **disable** the model entirely (forces the hashing
    embedder even if the package is installed).
- `semantic_query`'s ensemble is a weighted blend: vector cosine similarity
  (weight 0.55) + FTS/BM25 (weight 0.30) + optional signal score
  (TF‑IDF, module proximity, signature overlap, AST profile) for the remaining
  weight. `signals`, `vec_weight`, and `fts_weight` are exposed via the MCP
  `semantic_query` tool.

## Artifacts (export / import / diff)

The store can be snapshotted into a self-describing, compressed artifact.

```bash
jcbm export_artifact --project my-project --dest graph.art.gz
jcbm import_artifact --src graph.art.gz
jcbm import_artifact --src graph.art.gz --project renamed-project
```

Artifact details (see `src/artifact.ts`):

- Format `codebase-mem-artifact`, version `1`, wrapped as
  `MAGIC("CBMART1") + uint32(headerLen) + JSON header + SQLite payload`.
- Compression is `gzip` by default (`none` supported programmatically via
  `exportArtifact` options). The **legacy** raw-gzip form is also readable on
  import.
- Scope is `full` (whole DB) by default; `project` scope is available
  programmatically.
- Import mode is **merge** by default (only new rows inserted via
  `INSERT OR IGNORE`); `replace` deletes the target project first.
  `--project` renames the imported project.
- Embeddings and traces are copied on import. A lightweight non-destructive
  `diffArtifacts` compares an artifact against the live store.

> The CLI's `export_artifact`/`import_artifact` use defaults (gzip, full scope,
> merge mode). The full option set (`compression`, `scope`, `mode`) is available
> via the programmatic `src/artifact.ts` API.

## Embeddable programmatic API

The engine can be embedded directly. Key exports:

```ts
import { Store } from './src/sql/store.ts';
import { createRegistry } from './src/languages/index.ts';
import { indexRepository } from './src/indexer/index.ts';
import { buildIndex, semanticQuery } from './src/search/service.ts';
import { queryGraph, searchGraph, traceCallPath } from './src/query/tools.ts';

const store = new Store('/tmp/graphs.db');
const registry = createRegistry();

await indexRepository({ project: 'demo', repoPath: '/path/to/repo', store, registry });
buildIndex(store, 'demo');
const hits = semanticQuery(store, 'demo', 'auth token validation');
const rows  = queryGraph(store, 'demo', 'MATCH (n:Function) RETURN n.name');
```

See [`api-reference.md`](api-reference.md) for the full function list.

## Troubleshooting

- **`No embeddings found for project "..."` / "Run 'build_index' first".**
  Semantic queries require embeddings. Run
  `cli build_index --project <name>` (with `--use-model true` to use the
  model) before `semantic_query`.
- **Missing grammar / wasm.** Ensure `grammars/*.wasm` exist in the package
  (the `files` field ships them). Run `npm run build:grammars` and download the
  `.wasm` files referenced by `grammars/manifest.json` if missing.
- **No languages detected.** Confirm the extensions are in the supported list
  (see [`language-support.md`](language-support.md)) and that the files aren't
  ignored by `.gitignore`/`.cbm-ignore` or the default ignore set.
- **`query_graph` fails to parse.** The Cypher subset is small and regex-based.
  Check `docs/query-language.md`: use `MATCH (...)-[:TYPE]->(...)`, single-quoted
  `WHERE` values combined with `AND`, and only the supported aggregations.
- **Node should be ≥ 22.5.** Start with a newer Node if you hit a
  `node:sqlite` import error.
- **Changing embedding models doesn't take effect.** Set `CBM_MODEL=off` to
  force the hashing embedder, or set `CBM_EMBED_MODEL` to a different model and
  re-run `build_index --use-model true`.
- **Watcher re-indexes slowly.** The default poll interval is 2 s; raise it
  with `watch --interval <ms>` for very large trees.
