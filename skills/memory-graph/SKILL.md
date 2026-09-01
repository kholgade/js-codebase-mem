---
name: memory-graph
description: Use the js-codebase-mem knowledge-graph MCP server to understand a codebase through its persisted graph (symbols, imports, call paths, routes, architecture) without scanning every file. Use when asked to explore, navigate, or understand a repository, find where a symbol is defined or used, trace a call flow, assess blast radius of a change, or answer "how does X work / who depends on Y". Speed up any coding task by resolving symbols and relationships up front.
---

# memory-graph

A persistent in-memory knowledge graph of indexed repositories, served over MCP.
Repositories are indexed once (`index_repository`) into a graph of nodes
(Project/Package/Folder/File/Module/Class/Function/Method/Interface/Enum/Type/
Route/Resource) and edges (CALLS, CALL_REFERENCE, IMPORTS, DEFINES, HANDLES,
HTTP_CALLS, INHERITS, USES_TYPE, ...). Every query is read-only and returns
structured JSON — agents should use these tools **instead of scanning files
one by one**.

## Assumptions

- The `memory-graph` MCP server is registered with this agent (see the agent
  integration guide for opencode, Claude Code, Codex, Kiro, Droid setup).
  Tool names may be prefixed by the MCP server name depending on the client
  (e.g. opencode calls them `memory-graph_query_graph`).
- The working directory's repo has already been indexed. If not, index first
  (below). Indexing is incremental and fast.
- Search is per `project`. Use the project name shown by `index_status` /
  returned by `index_repository`. Common convention: the repo directory name.

## Workflow

1. **Make sure the repo is indexed** (one-time, fast):
   - `index_status { project }` — if it returns counts, skip to step 3.
   - Else `index_repository { repo_path: <cwd>, project: <name> }`. It returns
     `{ files, indexedFiles, nodes, edges, durationMs }`.
2. **Orient**: `get_graph_schema { project }` (label/edge-type counts) and
   `get_architecture { project }` (languages, packages, modules overview).
3. **Answer with the graph** (pick tools from the table below), only opening a
   file via `get_code_snippet` or the editor when you actually need the body.
4. When changes are planned, run `detect_changes { project, repo_path }` to get
   the blast radius (changed files + affected nodes) instead of diff-scanning.

## Tool reference

| Tool | Inputs | Returns / purpose |
| --- | --- | --- |
| `index_repository` | `repo_path`, `project?` | Index a repo. Idempotent + incremental. **Write once.** |
| `index_status` | `project` | Node/edge/file counts, last updated. |
| `list_projects` | — | Projects present in the shared graph. |
| `delete_project` | `project` | Remove a project's nodes/edges. |
| `get_graph_schema` | `project` | Counts per node label and edge type. |
| `get_architecture` | `project` | Language → package → module overview with counts. |
| `search_graph` | `project`, `name_pattern`, `label?`, `file_pattern?`, `min_degree?`, `max_degree?`, `limit?`, `offset?` | Nodes matching name/file/degree filters. |
| `search_code` | `project`, `pattern` | LIKE search over names, qualified names, signatures. |
| `query_graph` | `project`, `query` | Minimal openCypher — see Cypher reference below. |
| `trace_path` | `project`, `function_name`, `direction` (`inbound`/`outbound`/`both`), `depth?` (1–5) | Call-path hops to/from a function/method. |
| `get_code_snippet` | `project`, `qualified_name` | Source of a symbol (from the index; no file scan). |
| `detect_changes` | `project`, `repo_path` | Changed files since last index and impacted nodes. |
| `semantic_query` | `project`, `query`, `limit?`, `signals?`, `vec_weight?`, `fts_weight?` | Ranked semantic/FTS results with scores (run `build_index` first). |
| `build_index` | `project`, `use_model?` | Build FTS + (optionally) embeddings. `use_model: true` needs the optional model installed; omit for local FTS. |
| `ingest_traces` | `project`, `traces[]`, `boost?` | Persist execution traces and upgrade CALLS edges to exact. |
| `manage_adr` | `project`, `mode` (`list`/`get`/`update`), `id?`, `content?` | Store architecture decision records. |

## Cypher reference (query_graph)

`MATCH (a:Label)-[:EDGE_TYPE]->(b:Label)` ... `WHERE a.prop = 'x'` or ops
`=`, `LIKE`, `CONTAINS`, `STARTS WITH`, `ENDS WITH` ... `RETURN a.prop, b.prop`
... optional `LIMIT n`. Also supported:
- **Variable-length paths**: `(a)-[:CALLS*1..3]->(b)` — multi-hop reachability.
- **OPTIONAL MATCH**: left-join semantics (keeps rows with no match).
- **Aggregations**: `RETURN COUNT(*) AS n`, `COUNT(a.name)`, `COLLECT`, `SUM`,
  `MIN`, `MAX` with `AS alias`.

Examples:

```cypher
// find a symbol and what it calls
MATCH (a:Function)-[:CALLS]->(b) WHERE a.name = 'bootstrap' RETURN b.name, b.file

// who calls this function (upstream)
MATCH (a)-[:CALLS]->(b:Function) WHERE b.name = 'setState' RETURN a.name, a.file

// HTTP route -> handler wiring
MATCH (r:Route)-[:HANDLES]->(h:Function) WHERE r.path CONTAINS 'users' RETURN r.path, h.file

// transitively reachable code (2–4 call hops)
MATCH (a:Function)-[:CALLS*2..4]->(b) WHERE a.name = 'main' RETURN DISTINCT b.name

// footprint of a change: functions depending on a type
MATCH (a)-[:USES_TYPE]->(t) WHERE t.name = 'Config' RETURN DISTINCT a.file
```

## Recipes

- **"Where is X defined and used?"** → `search_graph` name_pattern X →
  `get_code_snippet` for the definition; `search_graph` for usages, or
  `query_graph` `MATCH (a)-[*1..2]->(b) WHERE b.qualified = '<x>' RETURN a`.
- **"How does feature F flow?"** → `trace_path` from the entry function
  (`outbound`, depth 3–4); or variable-length `CALLS` query.
- **"What breaks if I change file Foo?"** → `detect_changes`, then inbound
  `CALLS`/`USES_TYPE`/`IMPORTS` queries on `Foo`'s symbols.
- **"What does the project look like?"** → `get_architecture` +
  `get_graph_schema`, then drill in with `query_graph`.

## When NOT to use

- Byte-exact logic, formatting, or file layout questions — read the file.
- Projects never indexed (scan locally first, then `index_repository`).

## Troubleshooting

- `index_status` returns null / no project → run `index_repository` first.
- `semantic_query` says "No embeddings found" → run `build_index` (omit
  `use_model` for FTS-only; it's fast and needs no model download).
- Graph looks stale after edits → `index_repository` again (incremental) or
  `detect_changes` to see deltas.