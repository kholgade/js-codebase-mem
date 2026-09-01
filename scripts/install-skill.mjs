#!/usr/bin/env node
// Install the memory-graph skill + MCP server for coding agents.
//
// Usage:
//   node scripts/install-skill.mjs                # copy skill + print MCP snippets
//   node scripts/install-skill.mjs --opencode     # also register MCP in ~/.config/opencode/opencode.json
//   node scripts/install-skill.mjs --no-skill     # only print MCP snippets (skip skill copy)
//
// Copies skills/memory-graph to the auto-loaded skill dirs:
//   ~/.config/opencode/skills/memory-graph
//   ~/.claude/skills/memory-graph
//   ~/.agents/skills/memory-graph

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const skillSrc = join(repoRoot, 'skills', 'memory-graph');
const cli = join(repoRoot, 'dist', 'cli', 'index.js');

const args = process.argv.slice(2);
const wantSkill = !args.includes('--no-skill');
const wantOpenCodeMcp = args.includes('--opencode');

const home = homedir();

if (!existsSync(cli)) {
  console.error('dist/cli/index.js not found. Run `npm run build` first.');
  process.exit(1);
}

function copySkill(dest) {
  try {
    mkdirSync(dest, { recursive: true });
    cpSync(skillSrc, join(dest, 'memory-graph'), { recursive: true });
    console.log(`skill -> ${join(dest, 'memory-graph')}`);
  } catch (e) {
    console.warn(`skip ${dest}: ${e.message}`);
  }
}

if (wantSkill) {
  console.log('Installing skill "memory-graph" into auto-loaded skill directories...');
  copySkill(join(home, '.config', 'opencode', 'skills'));
  copySkill(join(home, '.claude', 'skills'));
  copySkill(join(home, '.agents', 'skills'));
  console.log('');
}

const server = `node ${cli} mcp`;
const snippet = `Launch command: ${server}`;
console.log('─'.repeat(72));
console.log('MCP server snippets (replace /ABSOLUTE/PATH with your repo root):');
console.log('');

console.log('## opencode  -> ~/.config/opencode/opencode.json  (mcp block)');
console.log(JSON.stringify(
  {
    mcp: {
      'memory-graph': {
        type: 'local',
        command: ['node', cli, 'mcp'],
        enabled: true,
        environment: {},
      },
    },
  },
  null,
  2,
));
console.log('');

console.log('## Claude Code -> ~/.claude/settings.json  (mcpServers block)');
console.log(JSON.stringify({
  mcpServers: { 'memory-graph': { command: 'node', args: [cli, 'mcp'] } },
}, null, 2));
console.log('');

console.log('## OpenAI Codex -> ~/.codex/config.toml');
console.log(`[mcp_servers."memory-graph"]
command = "node"
args = [${JSON.stringify(cli)}, "mcp"]
enabled = true
startup_timeout_sec = 30
`);
console.log('## Kiro -> ~/.kiro/settings/mcp.json');
console.log(JSON.stringify({
  mcpServers: { 'memory-graph': { command: 'node', args: [cli, 'mcp'], disabled: false } },
}, null, 2));
console.log('');

console.log('## Factory Droid');
console.log(`droid mcp add memory-graph --type stdio -- ${server}`);
console.log('');
console.log(snippet);

if (wantOpenCodeMcp) {
  const cfgPath = join(home, '.config', 'opencode', 'opencode.json');
  let cfg = {};
  const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  if (existing.trim()) {
    try {
      cfg = JSON.parse(existing);
    } catch {
      console.error(`Could not parse ${cfgPath}; not modifying it.`);
      process.exit(1);
    }
  }
  cfg.$schema = cfg.$schema ?? 'https://opencode.ai/config.json';
  cfg.mcp = cfg.mcp ?? {};
  if (cfg.mcp['memory-graph']) {
    console.log(`mcp["memory-graph"] already configured in ${cfgPath}`);
  } else {
    cfg.mcp['memory-graph'] = { type: 'local', command: ['node', cli, 'mcp'], enabled: true, environment: {} };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    console.log(`Wrote mcp["memory-graph"] to ${cfgPath}`);
    console.log('Restart opencode for the change to take effect.');
  }
}