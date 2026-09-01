# js-codebase-mem

Node.js code intelligence engine: parse a codebase with tree-sitter into a persistent
knowledge graph, store it in SQLite (`node:sqlite`, built-in), and query it over MCP + CLI
with vector semantic search.

A TypeScript/ESM port of the algorithms and logic of
[DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) ("pure C"),
scoped to **8 languages** with **zero native compilation** and an extensible per-language
plugin contract.

## Status

Phase 0 scaffold — runnable vertical slice of the pipeline:

- ✅ Project skeleton, `node:sqlite` store, schema, migrations
- ✅ `LanguagePlugin` contract + `LanguageRegistry` (8 languages registered)
- ✅ File walking + ignore rules + File-node indexing
- ✅ `index` and `cli list_projects` commands
- 🔜 tree-sitter WASM parse (web-tree-sitter) + extraction
- 🔜 MCP server (15 tools), semantic search, resolvers

See [DESIGN.md](DESIGN.md) for the full architecture.

## Requirements

- Node.js ≥ 22.5 (uses built-in `node:sqlite`)

## Setup

```bash
npm install
node scripts/build-grammars.mjs   # writes grammars/manifest.json (then download .wasm files)
npm run build
```

## Usage

```bash
# Index a repository into the graph
node dist/cli/index.js index /path/to/repo --project my-project

# List projects
node dist/cli/index.js cli list_projects
```

The graph persists to `~/.cache/js-codebase-mem/graphs.db` (override with `CBM_CACHE_DIR`).

## Language plugin contract

A new language is a single module implementing `LanguagePlugin`
(`src/languages/contract.ts`):

```ts
const plugin: LanguagePlugin = {
  id: 'rust',
  extensions: ['.rs'],
  wasmPath: '.../rust.wasm',
  query: '...',                 // tree-sitter query -> Emit[]
  contextualize(ctx, emits) {}, // qualify names, module scope
  resolver,                     // optional deep type resolution
};
registry.register(plugin);      // that's it — schema/query engine/MCP unchanged
```

## License

MIT
