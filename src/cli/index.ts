import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRegistry } from '../languages/index.ts';
import { Store } from '../sql/store.ts';
import { indexRepository } from '../indexer/index.ts';
import {
  searchGraph,
  traceCallPath,
  queryGraph,
  getCodeSnippet,
  searchCode,
  detectChanges,
  getArchitecture,
  deadCode,
  getGraphSchema,
  indexStatus,
} from '../query/tools.ts';
import { buildIndex, semanticQuery, searchCode as searchCodeFts } from '../search/service.ts';
import { exportArtifact, importArtifact } from '../artifact.ts';
import { listAdr, getAdr, updateAdr } from '../query/adr.ts';

const CACHE_DIR = process.env.CBM_CACHE_DIR ?? `${process.env.HOME}/.cache/js-codebase-mem`;
const DB_PATH = `${CACHE_DIR}/graphs.db`;

mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(dirname(DB_PATH), { recursive: true });

const HELP = `
js-codebase-mem - Node.js code intelligence engine (MCP + CLI)

Usage:
  js-codebase-mem index <repoPath> [--project <name>]
  js-codebase-mem watch <repoPath> [--project <name>] [--interval <ms>] [--json]
  js-codebase-mem daemon stop                 Stop the watch daemon
  js-codebase-mem cli <tool> [flags]
  js-codebase-mem install [--binary <path>]
  js-codebase-mem uninstall
  js-codebase-mem export_artifact --project <name> --dest <path.gz>
  js-codebase-mem import_artifact --src <path.gz> [--project override]
  js-codebase-mem serve                        Start MCP stdio server
  js-codebase-mem --version
  js-codebase-mem --help

CLI tools:
  list_projects
  index_status --project <name>
  search_graph --project <name> [--name-pattern <glob>] [--label <Label>] [--file-pattern <glob>]
  trace_path --project <name> --function-name <name> [--direction both] [--depth 3]
  query_graph --project <name> --query '<cypher>'
  get_code_snippet --project <name> --qualified-name <name>
  search_code --project <name> --pattern <str>
  detect_changes --project <name> --repo-path <path>
  get_architecture --project <name>
  dead_code --project <name>
  get_graph_schema --project <name>
  build_index --project <name>
  semantic_query --project <name> --query '<text>' [--limit 10]
  search_code --project <name> --pattern <str> [--fts]
  get_graph_schema --project <name>
  adr --project <name> --mode list|get|update --id <id> [--content <text>]
`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    } else if (!out._) {
      out._ = a;
    }
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (cmd === '--version') {
    console.log('0.1.0');
    return;
  }
  if (cmd === '--help' || cmd === '-h' || !cmd) {
    console.log(HELP);
    return;
  }

  if (cmd === 'serve' || cmd === 'mcp') {
    const { startServer } = await import('../server/mcp.ts');
    await startServer();
    return;
  }

  if (cmd === 'serve-ui' || cmd === 'ui') {
    const { startGraphServer } = await import('../server/http.ts');
    const portArg = rest[0];
    const port = portArg ? Number(portArg) : 9779;
    const store = new Store(DB_PATH);
    const graph = await startGraphServer(store, port);
    console.error(`Graph UI at ${graph.url}`);
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      graph.close().finally(() => {
        store.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise<void>((resolve) => {
      graph.server.on('close', resolve);
    });
    store.close();
    return;
  }

  if (cmd === 'install') {
    const { autoInstall } = await import('../server/install.ts');
    const args = parseArgs(rest);
    const binary = args.binary ?? process.argv[1] ?? 'js-codebase-mem';
    const result = await autoInstall(binary);
    for (const w of result.wired) console.log(`wired: ${w}`);
    for (const s of result.skipped) console.log(`skipped: ${s}`);
    if (result.wired.length === 0 && result.skipped.length === 0) {
      console.log('No supported coding-agent config files found.');
    }
    return;
  }

  if (cmd === 'uninstall') {
    const { uninstallForAgent } = await import('../server/install.ts');
    const result = await uninstallForAgent();
    for (const w of result.wired) console.log(`uninstalled: ${w}`);
    for (const s of result.skipped) console.log(`skipped: ${s}`);
    return;
  }

  const store = new Store(DB_PATH);
  const registry = createRegistry();

  if (cmd === 'export_artifact') {
    const args = parseArgs(rest);
    const project = args.project;
    const dest = args.dest;
    if (!project || !dest) throw new Error('export_artifact requires --project and --dest');
    const result = await exportArtifact(store, project, dest);
    console.log(JSON.stringify(result, null, 2));
    store.close();
    return;
  }

  if (cmd === 'import_artifact') {
    const args = parseArgs(rest);
    const src = args.src;
    if (!src) throw new Error('import_artifact requires --src');
    const result = await importArtifact(store, src, args.project);
    console.log(JSON.stringify(result, null, 2));
    store.close();
    return;
  }

  if (cmd === 'index') {
    const args = parseArgs(rest);
    const repoPath = args._;
    if (!repoPath) throw new Error('index requires a repo path');
    const project = args.project ?? repoPath.split('/').filter(Boolean).pop() ?? 'repo';
    const res = await indexRepository({ project, repoPath, store, registry });
    store.setProjectCounts(project);
    console.log(`Indexed ${res.files} files -> ${res.nodes} nodes, ${res.edges} edges (project "${project}")`);
    store.close();
    return;
  }

  if (cmd === 'watch') {
    const args = parseArgs(rest);
    const repoPath = args._;
    if (!repoPath) throw new Error('watch requires a repo path');
    const project = args.project ?? repoPath.split('/').filter(Boolean).pop() ?? 'repo';
    const { ProjectWatcher } = await import('../indexer/watcher.ts');
    const asJson = args.json === 'true';
    const interval = args.interval ? parseInt(args.interval) : 2000;

    const watcher = new ProjectWatcher({
      project,
      repoPath,
      store,
      registry,
      onIndex: (r) => {
        if (asJson) {
          console.log(JSON.stringify(r));
        } else {
          console.error(`reindexed ${r.indexedFiles} file(s) -> ${r.nodes} nodes, ${r.edges} edges (${r.durationMs}ms)`);
        }
      },
    });

    process.stderr.write(`watching ${repoPath} (project ${project})\n`);
    await watcher.reindex();
    watcher.start();

    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      watcher.stop();
      store.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise<void>(() => {
      // keep the process alive indefinitely
    });
    return;
  }

  if (cmd === 'daemon') {
    const { stopWatch } = await import('../indexer/watcher.ts');
    stopWatch();
    console.error('watch daemon is embedded in the watch command; stop it with SIGINT/SIGTERM');
    store.close();
    return;
  }

  if (cmd === 'cli') {
    const tool = rest[0];
    const args = parseArgs(rest.slice(1));

    if (tool === 'list_projects') {
      console.log(JSON.stringify(store.listProjects(), null, 2));
      store.close();
      return;
    }

    if (tool === 'index_status') {
      const project = args.project;
      if (!project) throw new Error('--project is required');
      const result = indexStatus(store, project);
      console.log(JSON.stringify(result ?? { error: 'project not found' }, null, 2));
      store.close();
      return;
    }

    if (tool === 'search_graph') {
      const project = args.project;
      if (!project) throw new Error('--project is required');
      const result = searchGraph(store, project, {
        name_pattern: args['name-pattern'],
        label: args.label,
        file_pattern: args['file-pattern'],
        min_degree: args['min-degree'] ? parseInt(args['min-degree']) : undefined,
        max_degree: args['max-degree'] ? parseInt(args['max-degree']) : undefined,
        limit: args.limit ? parseInt(args.limit) : undefined,
        offset: args.offset ? parseInt(args.offset) : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'trace_path') {
      const project = args.project;
      const functionName = args['function-name'];
      if (!project || !functionName) throw new Error('--project and --function-name are required');
      const direction = (args.direction ?? 'both') as 'inbound' | 'outbound' | 'both';
      const depth = args.depth ? parseInt(args.depth) : 3;
      const result = traceCallPath(store, project, functionName, direction, depth);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'query_graph') {
      const project = args.project;
      const query = args.query;
      if (!project || !query) throw new Error('--project and --query are required');
      const result = queryGraph(store, project, query);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'get_code_snippet') {
      const project = args.project;
      const qualifiedName = args['qualified-name'];
      if (!project || !qualifiedName) throw new Error('--project and --qualified-name are required');
      const result = getCodeSnippet(store, project, qualifiedName);
      console.log(JSON.stringify(result ?? { error: 'not found' }, null, 2));
      store.close();
      return;
    }

    if (tool === 'search_code') {
      const project = args.project;
      const pattern = args.pattern;
      if (!project || !pattern) throw new Error('--project and --pattern are required');
      const result = searchCode(store, project, pattern);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'detect_changes') {
      const project = args.project;
      const repoPath = args['repo-path'];
      if (!project || !repoPath) throw new Error('--project and --repo-path are required');
      const result = detectChanges(store, project, repoPath);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'get_architecture') {
      const project = args.project;
      if (!project) throw new Error('--project is required');
      const result = getArchitecture(store, project);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'dead_code') {
      const project = args.project;
      if (!project) throw new Error('--project is required');
      const result = deadCode(store, project);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'get_graph_schema') {
      const project = args.project;
      if (!project) throw new Error('--project is required');
      const result = getGraphSchema(store, project);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'build_index') {
      const project = args.project;
      if (!project) throw new Error('--project is required');
      const result = buildIndex(store, project);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'semantic_query') {
      const project = args.project;
      const query = args.query;
      if (!project || !query) throw new Error('--project and --query are required');
      const limit = args.limit ? Number(args.limit) : 10;
      const result = semanticQuery(store, project, query, limit);
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    if (tool === 'adr') {
      const project = args.project;
      const mode = args.mode;
      if (!project || !mode) throw new Error('adr requires --project and --mode (list|get|update)');
      let result: unknown;
      if (mode === 'list') {
        result = listAdr(store, project);
      } else if (mode === 'get') {
        if (!args.id) throw new Error('adr get requires --id');
        result = getAdr(store, project, args.id) ?? { error: 'not found' };
      } else if (mode === 'update') {
        if (!args.id) throw new Error('adr update requires --id');
        result = updateAdr(store, project, args.id, args.content ?? '');
      } else {
        throw new Error(`unknown adr mode: ${mode}`);
      }
      console.log(JSON.stringify(result, null, 2));
      store.close();
      return;
    }

    store.close();
    throw new Error(`cli tool "${tool}" not recognized. Use --help for available tools.`);
  }

  store.close();
  throw new Error(`unknown command: ${cmd}\n${HELP}`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
