import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from '../sql/store.ts';
import { indexRepository } from '../indexer/index.ts';
import { createRegistry } from '../languages/index.ts';
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
import { semanticQuery, buildIndex, buildIndexAsync } from '../search/service.ts';
import { listAdr, getAdr, updateAdr } from '../query/adr.ts';
import { applyTraceConfidence } from '../query/traces.ts';

const DB_PATH = process.env.CBM_CACHE_DIR
  ? `${process.env.CBM_CACHE_DIR}/graphs.db`
  : `${process.env.HOME}/.cache/js-codebase-mem/graphs.db`;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'js-codebase-mem', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // 1. index_repository
  server.tool(
    'index_repository',
    'Index a repository into the knowledge graph',
    { repo_path: z.string(), project: z.string().optional() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const registry = createRegistry();
        const project = args.project ?? args.repo_path.split('/').filter(Boolean).pop() ?? 'repo';
        const result = await indexRepository({ project, repoPath: args.repo_path, store, registry });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } finally {
        store.close();
      }
    },
  );

  // 2. list_projects
  server.tool('list_projects', 'List all indexed projects', {}, async () => {
    const store = new Store(DB_PATH);
    try {
      const projects = store.listProjects();
      return { content: [{ type: 'text', text: JSON.stringify(projects) }] };
    } finally {
      store.close();
    }
  });

  // 3. delete_project
  server.tool(
    'delete_project',
    'Delete a project and all its data',
    { project: z.string() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        store.deleteProject(args.project);
        return { content: [{ type: 'text', text: JSON.stringify({ deleted: args.project }) }] };
      } finally {
        store.close();
      }
    },
  );

  // 4. index_status
  server.tool(
    'index_status',
    'Get indexing status for a project',
    { project: z.string() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const status = indexStatus(store, args.project);
        return { content: [{ type: 'text', text: JSON.stringify(status ?? { error: 'project not found' }) }] };
      } finally {
        store.close();
      }
    },
  );

  // 5. search_graph
  server.tool(
    'search_graph',
    'Search nodes in the knowledge graph',
    {
      project: z.string(),
      name_pattern: z.string().optional(),
      label: z.string().optional(),
      file_pattern: z.string().optional(),
      min_degree: z.number().optional(),
      max_degree: z.number().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const results = searchGraph(store, args.project, {
          name_pattern: args.name_pattern,
          label: args.label,
          file_pattern: args.file_pattern,
          min_degree: args.min_degree,
          max_degree: args.max_degree,
          limit: args.limit,
          offset: args.offset,
        });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } finally {
        store.close();
      }
    },
  );

  // 6. trace_path
  server.tool(
    'trace_path',
    'Trace call paths from/to a function',
    {
      project: z.string(),
      function_name: z.string(),
      direction: z.enum(['inbound', 'outbound', 'both']).default('both'),
      depth: z.number().min(1).max(5).default(3),
    },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const hops = traceCallPath(store, args.project, args.function_name, args.direction, args.depth);
        return { content: [{ type: 'text', text: JSON.stringify(hops) }] };
      } finally {
        store.close();
      }
    },
  );

  // 7. detect_changes
  server.tool(
    'detect_changes',
    'Detect changed files and blast radius',
    { project: z.string(), repo_path: z.string() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const result = detectChanges(store, args.project, args.repo_path);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } finally {
        store.close();
      }
    },
  );

  // 8. query_graph
  server.tool(
    'query_graph',
    'Query the graph with a minimal Cypher-like query',
    { project: z.string(), query: z.string() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const results = queryGraph(store, args.project, args.query);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } finally {
        store.close();
      }
    },
  );

  // 9. get_graph_schema
  server.tool(
    'get_graph_schema',
    'Get counts of node labels and edge types',
    { project: z.string() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const schema = getGraphSchema(store, args.project);
        return { content: [{ type: 'text', text: JSON.stringify(schema) }] };
      } finally {
        store.close();
      }
    },
  );

  // 10. get_code_snippet
  server.tool(
    'get_code_snippet',
    'Get code snippet by qualified name',
    { project: z.string(), qualified_name: z.string() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const snippet = getCodeSnippet(store, args.project, args.qualified_name);
        return { content: [{ type: 'text', text: JSON.stringify(snippet ?? { error: 'not found' }) }] };
      } finally {
        store.close();
      }
    },
  );

  // 11. get_architecture
  server.tool(
    'get_architecture',
    'Get architecture overview for a project',
    { project: z.string() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const arch = getArchitecture(store, args.project);
        return { content: [{ type: 'text', text: JSON.stringify(arch) }] };
      } finally {
        store.close();
      }
    },
  );

  // 12. search_code
  server.tool(
    'search_code',
    'Search code by pattern in names, qualified names, and signatures',
    { project: z.string(), pattern: z.string() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const results = searchCode(store, args.project, args.pattern);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } finally {
        store.close();
      }
    },
  );

  // 13. semantic_query
  server.tool(
    'semantic_query',
    'Semantic search over the knowledge graph. Run build_index for the project first to populate embeddings.',
    { project: z.string(), query: z.string(), limit: z.number().optional(), signals: z.boolean().optional(), vec_weight: z.number().optional(), fts_weight: z.number().optional() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const result = semanticQuery(store, args.project, args.query, args.limit ?? 10, {
          signals: args.signals,
          vecWeight: args.vec_weight,
          ftsWeight: args.fts_weight,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } finally {
        store.close();
      }
    },
  );

  // 13b. build_index (populate FTS + embeddings for a project)
  server.tool(
    'build_index',
    'Populate the FTS and semantic (embedding) index for a project',
    { project: z.string(), use_model: z.boolean().optional() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        if (args.use_model) {
          const result = await buildIndexAsync(store, args.project);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        const result = buildIndex(store, args.project);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } finally {
        store.close();
      }
    },
  );

  // 14. manage_adr
  server.tool(
    'manage_adr',
    'Manage Architecture Decision Records',
    { project: z.string(), mode: z.enum(['list', 'get', 'update']), id: z.string().optional(), content: z.string().optional() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        if (args.mode === 'list') {
          const rows = listAdr(store, args.project);
          return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
        }
        if (args.mode === 'get' && args.id) {
          const row = getAdr(store, args.project, args.id);
          return { content: [{ type: 'text', text: JSON.stringify(row ?? { error: 'not found' }) }] };
        }
        if (args.mode === 'update' && args.id) {
          const row = updateAdr(store, args.project, args.id, args.content ?? '');
          return { content: [{ type: 'text', text: JSON.stringify(row) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid mode or missing id' }) }] };
      } finally {
        store.close();
      }
    },
  );

  // 15. ingest_traces
  server.tool(
    'ingest_traces',
    'Persist execution traces (ordered lists of function qualified names) and optionally boost CALLS edge confidence from them',
    { project: z.string(), traces: z.array(z.object({ name: z.string().optional(), calls: z.array(z.string()) })).optional(), boost: z.boolean().optional() },
    async (args) => {
      const store = new Store(DB_PATH);
      try {
        const traces = args.traces ?? [];
        for (const t of traces) {
          store.ingestTrace(args.project, t);
        }
        if (args.boost !== false && traces.length > 0) {
          const applied = applyTraceConfidence(store, args.project);
          return { content: [{ type: 'text', text: JSON.stringify({ ingested: traces.length, ...applied }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ingested: traces.length }) }] };
      } finally {
        store.close();
      }
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
