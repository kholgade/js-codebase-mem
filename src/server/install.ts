import { existsSync } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NAME = 'js-codebase-mem';

/**
 * Return the MCP server config JSON snippet for the given binary path.
 * Just the JSON object; callers embed it in their own config files.
 */
export function installForAgent(command: string): object {
  return {
    mcpServers: {
      [NAME]: {
        command,
        args: ['serve'],
      },
    },
  };
}

export interface AutoInstallResult {
  wired: string[];
  skipped: string[];
}

/**
 * Pick a short command to launch the MCP server, avoiding long absolute paths in
 * agent configs. Prefers `jcbm` when it's on PATH (npm link / install -g),
 * otherwise falls back to `node <abs>/dist/cli/index.js serve`.
 */
export function preferredLaunchCommand(argv1?: string): { command: string } {
  const home = homedir();
  const jcbmOnPath = ['/usr/local/bin', '/opt/homebrew/bin', join(home, 'bin'), '/usr/bin'].some((p) =>
    existsSync(join(p, 'jcbm')),
  );
  if (jcbmOnPath) return { command: 'jcbm' };
  return { command: argv1 ?? 'js-codebase-mem' };
}

interface Target {
  key: string;
  path: string;
  kind: 'json' | 'toml';
  /** JSON-path where the mcpServer map lives. e.g. 'mcpServers' or 'mcp'. */
  jsonRoot: string;
}

function targets(): Target[] {
  const home = homedir();
  return [
    { key: 'Claude Code', path: join(home, '.claude.json'), kind: 'json', jsonRoot: 'mcpServers' },
    { key: 'VS Code', path: join(home, '.config', 'Code', 'User', 'mcp.json'), kind: 'json', jsonRoot: 'mcpServers' },
    { key: 'Cursor', path: join(home, '.cursor', 'mcp.json'), kind: 'json', jsonRoot: 'mcpServers' },
    { key: 'Cline', path: join(home, '.cline', 'mcp.json'), kind: 'json', jsonRoot: 'mcpServers' },
    { key: 'OpenCode', path: join(home, '.config', 'opencode', 'opencode.json'), kind: 'json', jsonRoot: 'mcp' },
    { key: 'Codex', path: join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'), kind: 'toml', jsonRoot: '' },
  ];
}

/**
 * Detect installed coding agents by config-file existence and inject the
 * `js-codebase-mem` MCP server entry, merging non-destructively.
 */
export async function autoInstall(command: string, options: { skipConfig?: boolean } = {}): Promise<AutoInstallResult> {
  const result: AutoInstallResult = { wired: [], skipped: [] };

  for (const t of targets()) {
    if (!existsSync(t.path)) continue;

    if (t.kind === 'json') {
      let obj: any;
      try {
        const raw = readFileSync(t.path, 'utf8');
        obj = JSON.parse(raw);
      } catch {
        result.skipped.push(t.key);
        continue;
      }
      if (typeof obj !== 'object' || obj === null) {
        result.skipped.push(t.key);
        continue;
      }
      if (!options.skipConfig) {
        const root = obj[t.jsonRoot] ?? (obj[t.jsonRoot] = {});
        if (typeof root !== 'object' || root === null) {
          result.skipped.push(t.key);
          continue;
        }
        root[NAME] = { command, args: ['serve'] };
        writeFileSync(t.path, JSON.stringify(obj, null, 2) + '\n');
        result.wired.push(t.key);
      }
      continue;
    }

    if (t.kind === 'toml') {
      if (options.skipConfig) continue;
      try {
        let raw = readFileSync(t.path, 'utf8');
        if (!raw.includes(`${NAME}`)) {
          raw += `\n# ${NAME}: MCP server entry (managed by js-codebase-mem install)\n# command = "${command}", args = ["serve"]\n`;
          writeFileSync(t.path, raw);
        }
        result.wired.push(t.key);
      } catch {
        result.skipped.push(t.key);
      }
    }
  }

  return result;
}

/**
 * Best-effort removal of the `js-codebase-mem` MCP entry from detected config
 * files. Returns which agents were uninstalled and which were skipped.
 */
export async function uninstallForAgent(): Promise<AutoInstallResult> {
  const result: AutoInstallResult = { wired: [], skipped: [] };

  for (const t of targets()) {
    if (!existsSync(t.path)) continue;

    if (t.kind === 'json') {
      let obj: any;
      try {
        obj = JSON.parse(readFileSync(t.path, 'utf8'));
      } catch {
        result.skipped.push(t.key);
        continue;
      }
      const root = obj?.[t.jsonRoot];
      if (root && typeof root === 'object' && NAME in root) {
        delete root[NAME];
        writeFileSync(t.path, JSON.stringify(obj, null, 2) + '\n');
        result.wired.push(t.key);
      }
      continue;
    }

    if (t.kind === 'toml') {
      try {
        let raw = readFileSync(t.path, 'utf8');
        const lines = raw.split('\n').filter((l) => !l.includes(`# ${NAME}: MCP server entry`));
        if (lines.length !== raw.split('\n').length) {
          writeFileSync(t.path, lines.join('\n'));
          result.wired.push(t.key);
        }
      } catch {
        result.skipped.push(t.key);
      }
    }
  }

  return result;
}
