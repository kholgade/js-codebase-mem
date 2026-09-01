# js-codebase-mem

<p align="center">
  <a href="https://github.com/kholgade/js-codebase-mem"><img alt="type" src="https://img.shields.io/badge/type-knowledge%20graph-teal?style=for-the-badge"></a>
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen?style=for-the-badge">
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-orange">
  <a href="skills/memory-graph/SKILL.md"><img alt="agent skill" src="https://img.shields.io/badge/agent_skill-ready-green"></a>
  <a href="docs/agent-integration.md"><img alt="mcp" src="https://img.shields.io/badge/MCP-5_agents-blueviolet"></a>
  <a href="#usage-for-ai-agents-mcp--skill"><img alt="languages" src="https://img.shields.io/badge/languages-8-lightgrey"></a>
</p>

**Understand a codebase in seconds — not by re-reading every file.**

js-codebase-mem turns any repository into a living knowledge graph: what
symbols exist, what calls what, what imports what, and how your web routes
wire up. Ingest once, then answer "how does this work?", "who depends on
this?", or "what breaks if I change that?" instantly — with zero context,
zero full-file scans, and no huge context windows burned.

It's built for **you and your AI coding agents**. The same graph powers a human
CLI, a click-through 3D web UI, and a standard MCP server that Claude, Codex,
Kiro, Droid, and opencode can plug into straight away.

> A zero-native-compile TypeScript/ESM implementation of the ideas behind
> [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp),
> covering **8 languages** out of the box and extensible to more.

---

## Why you'll like it

| Pain point | What js-codebase-mem does |
| --- | --- |
| **"Why are my agents slow?"** | Agents ask the graph instead of scanning files. This repo indexed in **~50 ms** — 64 files → 611 symbols → 1,168 relationships. |
| **"I lose the big picture"** | One command gives you project structure, call flows, and architecture overview. |
| **"Every change feels risky"** | `detect_changes` tells you the blast radius — who depends on what you're touching. |
| **"I don't know where things are"** | Search by name, semantic meaning, or raw graph query. `get_code_snippet` returns the exact source, not a needle in a haystack. |
| **"My context window fills up"** | Queries return structured answers (symbols, call paths, files) — not hundreds of file dumps. |
| **"Tools are siloed"** | One graph, four surfaces: CLI for humans, web UI for browsing, MCP for agents, and a portable *skill* any agent can load. |

### Who it's for
- **Developers** landing in an unfamiliar or long-forgotten repo.
- **Teams** that want shared architectural memory, not tribal knowledge.
- **AI coding agents** that should reason about a codebase instead of brute-forcing it.

---

## Highlights

- **Persistent memory** — index once, query for weeks; incremental re-indexes keep it fresh.
- **8 languages** — JavaScript/TypeScript, Python, Java, Go, Rust, C++, C#, C.
- **Agent-ready** — ships a portable **skill** (`skills/memory-graph`) plus MCP wiring for `opencode`, `Claude Code`, `Codex`, `Kiro`, and `Droid`.
- **MCP server** — 16 tools for graph, call-path, semantic, and architecture queries.
- **3D web UI** — spin up a clickable graph with node details, edge labels, and PNG/SVG export.
- **Multi-signal search** — FTS + TF-IDF + AST/signature overlap + optional real embeddings.
- **Team-shared artifacts** — export/import the graph with versioned, compressed, merge-ready files.
- **Smart delta** — detect changes and get impacted-code blast radius, not a blind diff.

---

## Getting started

**Requirement:** Node.js ≥ 22.5 (uses the built-in `node:sqlite` — no native compilation).

```bash
npm install
npm run build          # compiles the CLI, MCP server, and web UI
npm link               # optional: exposes the short `jcbm` command on your PATH
```

> Keep grammars fresh:
> `npm run build:grammars` downloads the tree-sitter `.wasm` files.

### Usage for humans (CLI)

After `npm link`, everything is the short `jcbm` command — no long paths:

```bash
# Index a repository once (fast, idempotent, incremental)
jcbm index /path/to/repo --project team-service

# What does the project look like? (languages, packages, modules)
jcbm cli get_architecture --project team-service

# Find a symbol and get its exact source
jcbm cli search_code --project team-service --pattern "getUser"
jcbm cli get_code_snippet --project team-service --qualified-name "src/auth.getUser"

# Who calls a function? (its blast radius / impact)
jcbm cli trace_path --project team-service --function-name getUser --direction inbound

# "What breaks if I change a file?" — impact analysis, not a blind diff
jcbm cli detect_changes --project team-service --repo-path /path/to/repo

# Semantic search — "the thing that connects to the payment provider"
jcbm cli build_index --project team-service       # one-time
jcbm cli semantic_query --project team-service --query "payment integration"
```

(Without `npm link`, prefix each with `node dist/cli/index.js`, e.g.
`node dist/cli/index.js index ...`.)

### Usage for browsers (web UI)

```bash
jcbm serve-ui 4173
# open http://localhost:4173 — browse the graph, click any node for its details,
# follow edge labels, flip between layouts, and export a PNG/SVG of your architecture.
```

### Usage for AI agents (MCP + skill)

Agents plug in through a standard MCP server plus a portable skill — nothing to
hand-wire:

```bash
# Auto-detect installed agents (Claude Code, Cursor, Cline, VS Code, Codex,
# OpenCode) and register js-codebase-mem as an MCP server in their config.
# Prefers the short `jcbm serve` command when the bin is on PATH:
jcbm install       # what got wired
jcbm uninstall     # remove it again

# Or copy the portable skill + print per-agent snippets for the rest
# (opencode, Claude, Codex, Kiro, Droid):
node scripts/install-skill.mjs            # copies the skill to auto-loaded dirs
node scripts/install-skill.mjs --opencode # ...and registers the MCP server in opencode
```

Then just ask your agent:

> *"Using the memory-graph, who calls `getUser`, and what happens to it if I change the auth module?"*

The agent answers from the graph — no slow per-file scan, tiny context cost.
Full recipes and per-agent setup (including Codex TOML, Kiro `env.PATH`, Droid
frontmatter) live in **[docs/agent-integration.md](docs/agent-integration.md)**.

### Sharing the graph with your team

```bash
jcbm export_artifact --project team-service --dest team-service.cbm
jcbm import_artifact --src team-service.cbm --project team-service
```

Versioned, compressed artifacts can be diffed and merged — so an onboarding
teammate gets your team's architectural memory in a single file.

---

## The 16 MCP tools at a glance

| Tool | Ask it to… |
| --- | --- |
| `index_repository` / `index_status` | build & monitor the graph |
| `get_architecture` / `get_graph_schema` | summarize the project |
| `search_graph` / `search_code` | find a symbol by name/pattern |
| `query_graph` | run a Cypher-like query (variable-length paths, aggregates) |
| `trace_path` / `detect_changes` | map call flows & blast radius |
| `get_code_snippet` | pull exact source without a scan |
| `semantic_query` / `build_index` | meaning-based search |
| `ingest_traces` / `manage_adr` | record runtime behavior & decisions |

See **[docs/api-reference.md](docs/api-reference.md)** for every tool and command.

---

## Add a language (plugin)

Adding a language is one module — the schema, query engine, and MCP surface
don't change. See **[docs/language-support.md](docs/language-support.md)**:

```ts
const plugin: LanguagePlugin = {
  id: 'rust',
  extensions: ['.rs'],
  wasmPath: '.../rust.wasm',
  query: '...',                 // tree-sitter query -> Emit[]
  contextualize(ctx, emits) {}, // qualify names, module scope
};
registry.register(plugin);      // done
```

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, schema, data flow
- [docs/query-language.md](docs/query-language.md) — the supported openCypher subset
- [docs/agent-integration.md](docs/agent-integration.md) — skill + MCP for every agent
- [docs/language-support.md](docs/language-support.md) — how to add languages/grammars
- [docs/usage.md](docs/usage.md) — deep dive, embedding setup, troubleshooting

---

## License

MIT