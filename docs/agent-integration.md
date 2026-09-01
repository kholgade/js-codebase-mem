# Enabling js-codebase-mem as an agent skill

js-codebase-mem ships a stdio MCP server that exposes **16 read/write tools**
for querying the persisted code knowledge graph. Once registered with any
MCP-capable coding agent, the agent can understand a repository through the
graph — `index_repository` once, then `query_graph` / `trace_path` /
`search_graph` / `get_code_snippet` / `semantic_query` etc. — instead of
scanning every file.

Two parts are involved:

1. **MCP server registration** — tells the agent how to launch the server.
2. **The skill** — `skills/memory-graph/SKILL.md` — instructions that teach the
   agent when and how to use the tools. It is a plain markdown skill in the
   Anthropic/opencode skill format, so it is portable across agents that
   support skills, and can be dropped into a `CLAUDE.md`/`AGENTS.md` where
   skills are not supported.

## Prerequisite

Build the CLI and expose the short `jcbm` command:

```bash
npm install
npm run build    # produces dist/cli/index.js + makes it executable
npm link         # optional: puts `jcbm` on your PATH
```

Every MCP config below launches the server with `jcbm serve`. If you did not
`npm link`, use `node /ABSOLUTE/PATH/js-codebase-mem/dist/cli/index.js serve`
in place of `jcbm serve`.

The graph DB lives at `~/.cache/js-codebase-mem/graphs.db` (override with the
`CBM_CACHE_DIR` env var if you want each agent to share or isolate data).

## opencode

Skill: copy the folder so opencode auto-loads it.

```bash
mkdir -p ~/.config/opencode/skills
cp -R skills/memory-graph ~/.config/opencode/skills/
# or project-scoped:
# cp -R skills/memory-graph .opencode/skills/
```

MCP server — add an `mcp` block to `~/.config/opencode/opencode.json` (or the
project's `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "memory-graph": {
      "type": "local",
      "command": ["jcbm", "serve"],
      "enabled": true,
      "environment": {}
    }
  }
}
```

Restart opencode after saving. Tools appear namespaced, e.g.
`memory-graph_query_graph`.

## Claude Code

Skill: copy to the auto-loaded external skills directory.

```bash
mkdir -p ~/.claude/skills
cp -R skills/memory-graph ~/.claude/skills/
```

MCP server — add to `~/.claude/settings.json` (user) or `.mcp.json` (project):

```json
{
  "mcpServers": {
    "memory-graph": {
      "command": "jcbm",
      "args": ["serve"]
    }
  }
}
```

Approve the server when Claude Code prompts (`claude mcp add` is retained for
existing servers; the settings file applies on next launch).

## OpenAI Codex

MCP server — in `~/.codex/config.toml` (user) or `.codex/config.toml`
(project):

```toml
[mcp_servers.memory-graph]
command = "jcbm"
args = ["serve"]
enabled = true
startup_timeout_sec = 30
# optional: forward your cache dir
# env_vars = ["CBM_CACHE_DIR"]
```

or via the CLI:

```bash
codex mcp add memory-graph -- jcbm serve
```

Skills are not first-class in Codex; encode the workflow by appending the body
of `skills/memory-graph/SKILL.md` (frontmatter stripped) to the repo's
`AGENTS.md`, or to `~/.codex/AGENTS.md` for all repos.

## Kiro

MCP server — in `~/.kiro/settings/mcp.json` (user) or `.kiro/settings/mcp.json`
(workspace). Kiro does not inherit your shell PATH, so use the absolute `node`
executable and an explicit `env.PATH`:

```json
{
  "mcpServers": {
    "memory-graph": {
      "command": "/path/to/node",
      "args": ["/ABSOLUTE/PATH/js-codebase-mem/dist/cli/index.js", "serve"],
      "env": {
        "PATH": "/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin"
      },
      "disabled": false,
      "autoApprove": ["memory-graph_query_graph", "memory-graph_search_graph", "memory-graph_semantic_query", "memory-graph_trace_path"]
    }
  }
}
```

Find node with `which node` and `dirname $(which node)`. Config hot-reloads on
save. For the agent guidance, drop the skill body into a steering file, e.g.
`.kiro/steering/memory-graph.md`, or an agent definition under `.kiro/agents/`.

## Factory Droid

Add the server from the CLI or the `/mcp` manager:

```bash
droid mcp add memory-graph --type stdio -- jcbm serve
# if jcbm is not on PATH, give the full node path:
# droid mcp add memory-graph --type stdio -- node /ABSOLUTE/PATH/js-codebase-mem/dist/cli/index.js serve
# optional: droid mcp add memory-graph --type stdio --env CBM_CACHE_DIR=/path -- jcbm serve
```

Give a custom droid access via its frontmatter:

```markdown
---
mcpServers: ["memory-graph"]
---
```

## Any other MCP client

Standard `mcpServers`-style config (Claude Code / Kiro shape) or
`droid`/`codex` CLI `add` all work the same: spawn `jcbm serve` over stdio. For
clients without MCP, the CLI provides equivalent commands:

```bash
jcbm index <repo_path> --project <name>
jcbm cli get_architecture --project <name>
jcbm cli query_graph --project <name> --query "MATCH (a:Function) RETURN a.name LIMIT 5"
```

Run `jcbm --help` to list available commands.

## Verifying the wiring

```bash
# 1. index once (needs the server running, or via CLI)
jcbm index /path/to/some/repo --project demo
# 2. then ask your agent:
#    "using the memory-graph, what are the 5 most-called functions in project demo?"
```

You should see the agent call `query_graph` / `trace_path` rather than opening
files individually.