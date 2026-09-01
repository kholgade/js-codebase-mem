# js-codebase-mem — Design

A Node.js code intelligence engine: parses a codebase with tree-sitter into a persistent
knowledge graph (functions, classes, call chains, routes), stores it in SQLite (built-in
`node:sqlite`), and exposes it over MCP + CLI with vector semantic search.

This project takes the **literal algorithms and logic** of
[DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (itself
"pure C, no runtime") and re-expresses them in TypeScript/ESM on Node 22+. The original
justifies C for 162 languages and sub-ms performance. This port scopes to **8 languages**
and prioritizes portability (zero native compile) and an extensible plugin contract over
matching the original's raw C performance.

---

## 1. Decisions (locked)

| Concern | Choice | Rationale |
|---|---|---|
| **Languages (8)** | Python, JavaScript, TypeScript, Java, C++, C#, Go, Rust | The 5 families you named + Go/Rust; every one has a mature tree-sitter grammar AND meaningful type-resolution requirements |
| **Runtime** | Node.js ≥ 22.5, TypeScript, ESM | `node:sqlite` is built-in (no native dep); TS for the plugin contract and static safety |
| **Parsing** | [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding/web) (WASM in-binary) | No node-gyp compilation; grammars load from WASM `.wasm` files shipped in `grammars/`. Matches "compiled into the binary" spirit |
| **Storage** | `node:sqlite` (built-in synchronous SQLite) | Zero-dependency; synchronous API suits the RAM-first single-pass index model |
| **Semantic search** | Bundled, in-process | Include vector search now (phase 1), mirroring the original's "no API key, no service" stance |

---

## 2. Directory layout

```
js-codebase-mem/
├── package.json
├── tsconfig.json
├── grammars/                     # vendored tree-sitter WASM per language + language.json
│   ├── python/  python.wasm  language.json
│   ├── javascript/ ...
│   └── rust/ ...
├── scripts/
│   ├── build-grammars.mjs        # download/pin WASM grammars, emit manifest
│   └── fetch-models.mjs          # download embedding model (phase 1)
├── src/
│   ├── core/
│   │   ├── types.ts              # shared domain types (Node, Edge, GraphProject, ...)
│   │   ├── registry.ts           # LanguageRegistry: grammar -> extractor -> resolver
│   │   └── utils.ts
│   ├── indexer/
│   │   ├── index.ts              # top-level orchestration (RAM-first, then persist)
│   │   ├── walk.ts               # file discovery, ignore rules, binary detection
│   │   ├── parser-pool.ts        # web-tree-sitter instance/parser caching
│   │   └── emit.ts               # staged node/edge emission
│   ├── languages/
│   │   ├── contract.ts           # LanguagePlugin interface (THE extension point)
│   │   ├── base.ts               # shared query helpers (query-by-pattern over tree-sitter)
│   │   └── {python,javascript,typescript,java,cpp,csharp,go,rust}/index.ts
│   ├── resolver/                 # type resolution ("Hybrid LSP" analog)
│   │   ├── interface.ts          # Resolver<T> contract
│   │   ├── scope.ts              # lexical/import scope resolution
│   │   └── {python,js-ts,java,cpp,csharp,go,rust}/resolver.ts
│   ├── search/
│   │   ├── embeddings.ts         # in-process embedding (ONNX/nn-backed)
│   │   ├── vector.ts             # vector storage + cosine search
│   │   ├── bm25.ts               # FTS5 + camelCase/snake_case tokenizer
│   │   └── semantic.ts           # 11-signal combined scoring (approx ports)
│   ├── sql/
│   │   ├── schema.ts             # DDL (tables, indexes, FTS5, vector tables)
│   │   ├── store.ts              # thin node:sqlite wrapper (prepared stmts)
│   │   └── migrations.ts
│   ├── server/
│   │   ├── mcp.ts                # MCP stdio transport + tool definitions (15 tools)
│   │   └── http.ts               # optional 3D graph UI (phase 2)
│   ├── cli/
│   │   ├── index.ts              # argv parsing, subcommands (mirror cbm cli)
│   │   └── commands.ts
```

---

## 3. The language plugin contract (the extension point)

The core promise from the earlier discussion: **a new language is a config addition, not a
refactor.** Every language is a `LanguagePlugin` that answers one question —
"given a tree-sitter `SyntaxNode`, what graph entities does it produce and how do identifiers
resolve?" The graph schema and query engine never change.

```ts
// src/languages/contract.ts
import type { Parser } from 'web-tree-sitter';

/** A single intended graph fact produced by extraction. */
export type Emit =
  | { kind: 'define'; name: string; qualified: string; label: NodeLabel;
      range: Range; signature: string; doc?: string }
  | { kind: 'call'; targetName: string; targetQualified?: string;
      confidence: 'exact' | 'reference' | 'usage'; range: Range }
  | { kind: 'import'; source: string; range: Range }
  | { kind: 'http-route'; method: string; path: string; handler: string }
  | { kind: 'inherit'; base: string; range: Range };

/** What a language contributes back to the indexer. */
export interface LanguagePlugin {
  readonly id: string;                 // 'python', 'typescript', ...
  readonly extensions: string[];        // ['.py'], ['.ts','.tsx'] ...
  readonly wasmPath: string;            // './grammars/python/python.wasm'

  /** Tree-sitter query source mapping AST node kinds -> semantic graph facts. */
  readonly query: string;

  /** Attribute the emitted facts (qualified names, module/package context). */
  contextualize(ctx: FileContext, emits: Emit[]): Emit[];

  /** Optional deep type resolution. Absent => syntactic-tier fallback only. */
  readonly resolver?: Resolver;
}

export interface FileContext {
  path: string;
  language: LanguagePlugin;
  moduleSpec: string;              // 'github.com/foo/bar', 'my.pkg.mod', ...
  imports: ImportRecord[];
}

/** The registry — single source of truth; adding a language = one register() call. */
export class LanguageRegistry {
  register(p: LanguagePlugin): void;
  forPath(p: string): LanguagePlugin | undefined;   // by extension
  all(): LanguagePlugin[];
}
```

### Hierarchical resolution (mirrors the original's two-tier model)

```ts
// src/resolver/interface.ts
export interface Resolver {
  /** Resolve a call/identifier to a qualified target, or undefined if unprovable. */
  resolve(node: SyntaxNode, scope: Scope, ctx: FileContext): Resolved | undefined;
}

export type Resolved =
  | { kind: 'exact'; qualified: string }        // fits graph CALLS edge
  | { kind: 'reference'; qualified: string }    // CALL_REFERENCE
  | { kind: 'usage'; qualified?: string };      // USAGE (ambiguous)
```

- **Every language** gets the syntactic tier (defines, imports, syntactic call edges via
  tree-sitter query patterns).
- **A language with a `resolver`** additionally refines call edges using lexical scope +
  import graph + cross-file definition registry — the "IDE go-to-definition"-grade
  resolution. All 8 target languages intend to carry a resolver (they're the hard ones),
  but the contract lets a future language ship syntactic-only and still be useful.

---

## 4. SQLite schema (`node:sqlite`, RAM-first then persist)

Phase model matches the original: **parse → stage in memory → single dump**. Emitted facts
accumulate in memory (offset vectors for speed), then hit disk once.

```sql
-- Core graph
CREATE TABLE nodes (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  file          TEXT NOT NULL,
  start_line    INTEGER, start_col INTEGER,
  end_line      INTEGER, end_col INTEGER,
  label         TEXT NOT NULL,            -- Function|Class|Method|Interface|Enum|Type|Route|Resource|File|Module|Package
  name          TEXT NOT NULL,
  qualified     TEXT NOT NULL,            -- <project>.<path>.<name>
  signature     TEXT,
  doc           TEXT,
  embedding     BLOB,                     -- int8 quantized 768d (semantic search)
  fts_tokens    TEXT                      -- camelCase/snake split for FTS5
);

CREATE TABLE edges (
  id         INTEGER PRIMARY KEY,
  project    TEXT NOT NULL,
  src        INTEGER NOT NULL REFERENCES nodes(id),
  dst        INTEGER,                     -- NULL for unresolved usage
  type       TEXT NOT NULL,               -- CALLS|CALL_REFERENCE|USAGE|IMPORTS|DEFINES|INHERITS|HTTP_CALLS|...
  confidence TEXT NOT NULL,               -- exact|reference|usage
  site_line  INTEGER
);

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  lang TEXT NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER,
  indexed_at INTEGER
);

-- Full-text (BM25-class)
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name, qualified, signature, doc,
  tokenize = 'unicode61'                  -- extended by a custom camel_case tokenizer (phase 1)
);

-- Vector search
CREATE TABLE node_embeddings (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
  project TEXT NOT NULL,
  vec BLOB                                -- packed 768 * int8
);
CREATE INDEX idx_emb_project ON node_embeddings(project);

-- Per-project metadata
CREATE TABLE projects (
  name TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  node_count INTEGER, edge_count INTEGER,
  created_at INTEGER, updated_at INTEGER
);
```

Indexes: `nodes(project,label)`, `nodes(qualified)`, `edges(src)`, `edges(dst)`,
`edges(project,type)`.

---

## 5. Indexing pipeline (port of cbm's RAM-first model)

1. **Walk** — discover files by extension (fast, respects `.gitignore`/`.cbm-ignore`),
   binary/encoding sniff, dedupe by content hash.
2. **Parse** — a bounded pool of `web-tree-sitter` `Parser` instances (WASM, reusable).
   Each file → AST → run the language's `query` → `Emit[]`.
3. **Contextualize** — `contextualize()` assigns qualified names & module scope from
   import/manifest scanning (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`,
   `pom.xml`, `.csproj`, `CMakeLists`/`compile_commands.json`).
4. **Resolve** (optional) — run the `resolver` to upgrade `usage` → `reference`/`exact`
   using import graph + cross-file definition map. This is the only pass that touches
   multiple files.
5. **Embeds** — for each Function/Class/Method node, run the in-process embedding model →
   quantized vector (semantic search).
6. **Emit** — open one SQLite transaction, insert nodes/edges/FTS/embeddings, then commit.
   Auto-sync: a watcher re-indexes changed files incrementally (phase 1 implements full
   re-index + hash-based skip; incremental is phase 1b).

---

## 6. Semantic search (11-signal, in-process)

The original bundles `nomic-embed-code` (40K tokens, 768d int8). Plan:

- **Embedding**: bundle a small open code-embedding model running fully in-process
  (`@xenova/transformers` / onnxruntime-node with a code model like `nomic-embed-text-v1.5`
  or `jina-embeddings-v2-base-code`) — no API key, no service, no Docker.
- **Storage**: quantized int8 blobs in `node_embeddings`; cosine via a small WASM/native
  SIMD-free JS kernel (acceptable for 8-language scope at typical repo sizes).
- **Scoring**: combined ranking across shared signals (ports, not byte-identical):
  - vector similarity, TF-IDF, camel/snake-aware FTS (BM25), API/Type/Decorator signature
    match, AST profile similarity, data-flow adjacency, MinHash clone similarity, module
    proximity, graph diffusion (PageRank/community).
- `semantic_query` returns ranked nodes + snippets, mirroring the original's tool semantics.

> Scope note: exact parity of the original's 11-signal weighting is not a goal; the goal is
> the same *kind* of single-call ranked semantic lookup. Weights are data-driven config.

---

## 7. MCP server + CLI (15 tools)

Both share the same query core; the MCP server is a thin stdio transport over
`@modelcontextprotocol/sdk`.

| Category | Tools |
|---|---|
| Indexing | `index_repository`, `list_projects`, `delete_project`, `index_status` |
| Querying | `search_graph`, `trace_path` (alias `trace_call_path`), `detect_changes`, `query_graph` (openCypher subset), `get_graph_schema` |
| Search | `semantic_query`, `search_code`, `get_code_snippet` |
| Analysis | `get_architecture`, `manage_adr` |
| Advanced | `ingest_traces` |

Cypher subset (`query_graph`): read-only `MATCH (n:Label)-[:EDGE]->(m) WHERE … RETURN …`
with LIMIT — parse via a minimal hand-written parser + parameter binding.

CLI mirrors `cbm cli ...` one-shot commands (`cli search_graph …`, `cli index_repository …`),
no lingering daemon.

---

## 8. Roadmap

**Phase 1 — vertical slice**
- Scaffold, `node:sqlite` store, schema, migrations, FTS5 + camel tokenizer.
- `web-tree-sitter` grammar pipeline for **Python + TypeScript** end-to-end.
- `LanguagePlugin` contract + `LanguageRegistry` + base query helpers.
- `index_repository`, `search_graph`, `trace_path`, `query_graph`, `get_code_snippet`,
  `search_code`, CLI mode. Node/edge/edge-count correctness tests (port of cbm's test ethos).

**Phase 1b — breadth**
- Remaining 6 languages (JS, Java, C++, C#, Go, Rust).
- Incremental re-index / watcher; `detect_changes`; `get_architecture` (language/package/
  entry/hotspot/cluster); dead-code detection (the `search_graph` degree filter + zero-caller).

**Phase 2 — depth**
- `Resolver` implementations per language (type resolution start: Python, JS/TS first).
- Semantic search: in-process embedding model + 11-signal scorer.
- API/FTS + cross-service HTTP route linking.

**Phase 3**
- Optional `http.ts` 3D graph UI (localhost UI), team-shared compressed graph artifact
  (`graph.db.zst`), deeper Cypher, ADR persistence.

---

## 9. Extensibility guarantees

- **Add a language** = write a `LanguagePlugin` (grammar wasm + query + contextualize,
  optional resolver) + `registry.register(...)`. No changes to schema, query engine, MCP
  tools, or indexer.
- **Add an edge type** = additive schema migration; tools that traverse edges are generic.
- **New resolver tiers** = provide a richer `Resolver` for one language without affecting
  others (syntactic-tier fallback is always present).
- The tree-sitter WASM grammar set is vendored and pinned in `scripts/build-grammars.mjs`;
  adding a grammar is a scripted download + manifest entry, not a build-system change.

---

## 10. Explicit non-goals (parity boundaries)

- **Not** matching C-level sub-millisecond latency across 162 languages; target is
  sub-second interactive queries at typical repo sizes for 8 languages.
- **Not** byte-identical 11-signal weights or identical benchmarks to cbm.
- **Not** 45-agent auto-install; ship MCP config for the main agents (installer detects a
  few, not the full surface) in phase 3.
- **Not** a full VirusTotal/signing release pipeline; supply checksums + SBOM.
