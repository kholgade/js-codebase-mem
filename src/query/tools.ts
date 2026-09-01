import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { Store } from '../sql/store.ts';
import type { NodeLabel, EdgeType } from '../core/types.ts';

// ─── 1. searchGraph ──────────────────────────────────────────────────────────

export interface SearchGraphParams {
  name_pattern?: string;
  label?: string;
  file_pattern?: string;
  min_degree?: number;
  max_degree?: number;
  limit?: number;
  offset?: number;
}

export function searchGraph(store: Store, project: string, params: SearchGraphParams): Record<string, any>[] {
  const conditions: string[] = ['n.project = ?'];
  const sqlParams: any[] = [project];

  if (params.label) {
    conditions.push('n.label = ?');
    sqlParams.push(params.label);
  }
  if (params.name_pattern) {
    const like = globToLike(params.name_pattern);
    conditions.push('n.name LIKE ?');
    sqlParams.push(like);
  }
  if (params.file_pattern) {
    const like = globToLike(params.file_pattern);
    conditions.push('n.file LIKE ?');
    sqlParams.push(like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;

  // Fetch base nodes
  const baseSql = `SELECT n.id, n.label, n.name, n.qualified, n.file, n.start_line FROM nodes n ${where} ORDER BY n.qualified LIMIT ? OFFSET ?`;
  const rows = store.queryNodes(baseSql, [...sqlParams, limit, offset]);

  // Compute degree and optionally filter
  const result: Record<string, any>[] = [];
  for (const row of rows) {
    const degreeRow = store.queryOne(
      `SELECT (SELECT COUNT(*) FROM edges WHERE src = ?) + (SELECT COUNT(*) FROM edges WHERE dst = ?) AS degree`,
      [row.id, row.id],
    );
    const degree = (degreeRow as any)?.degree ?? 0;
    if (params.min_degree !== undefined && degree < params.min_degree) continue;
    if (params.max_degree !== undefined && degree > params.max_degree) continue;
    result.push({ id: row.id, label: row.label, name: row.name, qualified: row.qualified, file: row.file, start_line: row.start_line, degree });
  }
  return result;
}

// ─── 2. traceCallPath ────────────────────────────────────────────────────────

interface Hop {
  depth: number;
  from: string;
  to: string;
  type: string;
  confidence: string;
  file: string;
  site_line: number;
}

export function traceCallPath(
  store: Store,
  project: string,
  functionName: string,
  direction: 'inbound' | 'outbound' | 'both',
  maxDepth: number = 3,
): Hop[] {
  const clampedDepth = Math.min(Math.max(maxDepth, 1), 5);

  // Find the starting node
  const startNode = store.queryOne(
    'SELECT id, name, qualified FROM nodes WHERE project = ? AND (qualified = ? OR name = ?) LIMIT 1',
    [project, functionName, functionName],
  );
  if (!startNode) return [];

  const visited = new Set<number>();
  const hops: Hop[] = [];
  const queue: Array<{ nodeId: number; depth: number }> = [{ nodeId: startNode.id, depth: 0 }];
  visited.add(startNode.id);

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    if (depth >= clampedDepth) continue;

    const edgeTypes = ['CALLS', 'CALL_REFERENCE', 'USAGE'];

    if (direction === 'outbound' || direction === 'both') {
      for (const et of edgeTypes) {
        const edges = store.queryNodes(
          `SELECT e.*, dst.name AS dst_name, dst.qualified AS dst_qualified, dst.file AS dst_file,
                  src.name AS src_name, src.qualified AS src_qualified
           FROM edges e
           JOIN nodes src ON e.src = src.id
           LEFT JOIN nodes dst ON e.dst = dst.id
           WHERE e.src = ? AND e.type = ? AND e.project = ?`,
          [nodeId, et, project],
        );
        for (const edge of edges) {
          hops.push({
            depth: depth + 1,
            from: edge.src_qualified ?? edge.src_name ?? String(nodeId),
            to: edge.dst_qualified ?? edge.dst_name ?? '?',
            type: edge.type,
            confidence: edge.confidence,
            file: edge.src_file ?? '',
            site_line: edge.site_line ?? 0,
          });
          if (edge.dst && !visited.has(edge.dst)) {
            visited.add(edge.dst);
            queue.push({ nodeId: edge.dst, depth: depth + 1 });
          }
        }
      }
    }

    if (direction === 'inbound' || direction === 'both') {
      for (const et of edgeTypes) {
        const edges = store.queryNodes(
          `SELECT e.*, src.name AS src_name, src.qualified AS src_qualified, src.file AS src_file,
                  dst.name AS dst_name, dst.qualified AS dst_qualified
           FROM edges e
           JOIN nodes dst ON e.dst = dst.id
           LEFT JOIN nodes src ON e.src = src.id
           WHERE e.dst = ? AND e.type = ? AND e.project = ?`,
          [nodeId, et, project],
        );
        for (const edge of edges) {
          hops.push({
            depth: depth + 1,
            from: edge.src_qualified ?? edge.src_name ?? '?',
            to: edge.dst_qualified ?? edge.dst_name ?? String(nodeId),
            type: edge.type,
            confidence: edge.confidence,
            file: edge.src_file ?? '',
            site_line: edge.site_line ?? 0,
          });
          if (edge.src && !visited.has(edge.src)) {
            visited.add(edge.src);
            queue.push({ nodeId: edge.src, depth: depth + 1 });
          }
        }
      }
    }
  }

  return hops;
}

// ─── 3. queryGraph (minimal openCypher subset) ───────────────────────────────

interface CypherParseResult {
  patterns: Array<{ alias: string; label?: string; edgeType?: string; targetAlias: string; targetLabel?: string; optional?: boolean }>;
  wheres: Array<{ alias: string; prop: string; op: string; value: string }>;
  returns: string[];
  limit?: number;
}

function parseCypher(query: string): CypherParseResult {
  const q = query.trim().replace(/;$/, '');
  const result: CypherParseResult = { patterns: [], wheres: [], returns: [] };

  // Extract MATCH
  const matchM = q.match(/MATCH\s+(.+)/i);
  if (!matchM) throw new Error('Cypher: MATCH clause required');

  const rest = matchM[1];

  // Split on WHERE / RETURN / LIMIT
  const whereM = rest.match(/\bWHERE\b\s+(.+?)(?=\bRETURN\b|\bLIMIT\b|$)/is);
  const returnM = rest.match(/\bRETURN\b\s+(.+?)(?=\bLIMIT\b|$)/is);
  const limitM = rest.match(/\bLIMIT\b\s+(\d+)/i);

  if (returnM) {
    result.returns = returnM[1].split(',').map(s => s.trim().replace(/^.*?\./, ''));
  }
  if (limitM) {
    result.limit = parseInt(limitM[1], 10);
  }
  if (whereM) {
    const whereStr = whereM[1].replace(/\bRETURN\b.*$/is, '').trim();
    const whereParts = whereStr.split(/\bAND\b/i);
    for (const wp of whereParts) {
      const wm = wp.trim().match(/(\w+)\.(\w+)\s*(=|CONTAINS|STARTS\s*WITH|ENDS\s*WITH|LIKE)\s*'([^']*)'/i);
      if (wm) {
        result.wheres.push({ alias: wm[1], prop: wm[2], op: wm[3].toUpperCase(), value: wm[4] });
      }
    }
  }

  // Extract patterns: (a:Label)-[:EDGE]->(b:Label) or (a)-[:EDGE]->(b) or (a) [OPTIONAL (b:Label)]
  const patternRegex = /\((\w+)(?::(\w+))?\)\s*(?:\[?\s*(?:OPTIONAL\s+)?(?:-\[:(\w+)\]->|\s*-\s*->)\s*\]?\s*)?\((\w+)(?::(\w+))?\)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = patternRegex.exec(q)) !== null) {
    const optional = /\bOPTIONAL\b/i.test(q.substring(Math.max(0, pm.index - 20), pm.index));
    result.patterns.push({
      alias: pm[1],
      label: pm[2],
      edgeType: pm[3],
      targetAlias: pm[4],
      targetLabel: pm[5],
      optional,
    });
  }

  // Also handle single-node MATCH: (a:Label) with no edge
  if (result.patterns.length === 0) {
    const singleM = q.match(/\((\w+)(?::(\w+))?\)/g);
    if (singleM) {
      for (const s of singleM) {
        const sm = s.match(/\((\w+)(?::(\w+))?\)/);
        if (sm && !result.patterns.find(p => p.alias === sm[1])) {
          result.patterns.push({ alias: sm[1], label: sm[2], targetAlias: sm[1] });
        }
      }
    }
  }

  if (result.patterns.length === 0) throw new Error('Cypher: could not parse MATCH pattern');
  return result;
}

export function queryGraph(store: Store, project: string, cypher: string): Record<string, any>[] {
  const parsed = parseCypher(cypher);
  const { patterns, wheres, returns, limit } = parsed;
  const requestedProps = returns.length > 0 ? returns : ['name', 'label'];

  // Build SQL from patterns
  const joins: string[] = [];
  const conditions: string[] = ['n0.project = ?'];
  const sqlParams: any[] = [project];
  let paramIdx = 1;

  // First pattern node
  const p0 = patterns[0];
  if (p0.label) {
    conditions.push(`n0.label = ?`);
    sqlParams.push(p0.label);
  }

  // Process edges and target nodes
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const nIdx = i + 1;
    if (p.edgeType && p.alias !== p.targetAlias) {
      joins.push(
        `JOIN nodes n${nIdx} ON n${nIdx}.id = (SELECT ${p.optional ? 'e.dst' : 'e.dst'} FROM edges e WHERE e.src = n${i}.id AND e.type = ? AND e.project = ? LIMIT 1)`,
      );
      sqlParams.push(p.edgeType, project);
      if (p.targetLabel) {
        conditions.push(`n${nIdx}.label = ?`);
        sqlParams.push(p.targetLabel);
      }
    }
  }

  // WHERE conditions
  for (const w of wheres) {
    // Find the alias index
    const aliasIdx = patterns.findIndex(p => p.alias === w.alias);
    const nIdx = aliasIdx >= 0 ? aliasIdx : 0;
    const col = w.prop === 'name' ? 'name' : w.prop === 'qualified' ? 'qualified' : w.prop === 'label' ? 'label' : w.prop;
    if (w.op === '=') {
      conditions.push(`n${nIdx}.${col} = ?`);
      sqlParams.push(w.value);
    } else if (w.op === 'LIKE' || w.op === 'CONTAINS') {
      conditions.push(`n${nIdx}.${col} LIKE ?`);
      sqlParams.push(`%${w.value}%`);
    } else if (w.op === 'STARTS WITH') {
      conditions.push(`n${nIdx}.${col} LIKE ?`);
      sqlParams.push(`${w.value}%`);
    } else if (w.op === 'ENDS WITH') {
      conditions.push(`n${nIdx}.${col} LIKE ?`);
      sqlParams.push(`%${w.value}`);
    }
  }

  const selectCols = requestedProps.map((p, i) => `n0.${p} AS ${p}`).join(', ');
  const sql = `SELECT DISTINCT ${selectCols} FROM nodes n0 ${joins.join(' ')} WHERE ${conditions.join(' AND ')} LIMIT ?`;
  sqlParams.push(limit ?? 50);

  const rows = store.queryNodes(sql, sqlParams);
  return rows.map(r => {
    const out: Record<string, any> = {};
    for (const p of requestedProps) {
      out[p] = r[p];
    }
    return out;
  });
}

// ─── 4. getCodeSnippet ───────────────────────────────────────────────────────

export function getCodeSnippet(
  store: Store,
  project: string,
  qualifiedName: string,
): Record<string, any> | null {
  const node = store.queryOne(
    'SELECT * FROM nodes WHERE project = ? AND (qualified = ? OR name = ?) LIMIT 1',
    [project, qualifiedName, qualifiedName],
  );
  if (!node) return null;

  const proj = store.queryOne('SELECT root FROM projects WHERE name = ?', [project]);
  const result: Record<string, any> = {
    name: node.name,
    qualified: node.qualified,
    file: node.file,
    start_line: node.start_line,
    end_line: node.end_line,
    signature: node.signature ?? null,
    doc: node.doc ?? null,
  };

  if (proj?.root && node.file) {
    try {
      const fullPath = `${proj.root}/${node.file}`;
      const src = readFileSync(fullPath, 'utf8');
      const lines = src.split('\n');
      const start = Math.max(0, (node.start_line ?? 1) - 1);
      const end = Math.min(lines.length, node.end_line ?? lines.length);
      result.code = lines.slice(start, end).join('\n');
    } catch {
      result.code = null;
    }
  }

  return result;
}

// ─── 5. searchCode ───────────────────────────────────────────────────────────

export function searchCode(
  store: Store,
  project: string,
  pattern: string,
): Record<string, any>[] {
  const rows = store.queryNodes(
    `SELECT id, project, file, start_line, end_line, label, name, qualified, signature
     FROM nodes
     WHERE project = ? AND (name LIKE ? OR qualified LIKE ? OR signature LIKE ?)
     LIMIT 50`,
    [project, `%${pattern}%`, `%${pattern}%`, `%${pattern}%`],
  );
  return rows;
}

// ─── 6. detectChanges ────────────────────────────────────────────────────────

interface ChangedFile { path: string; status: string; }
interface AffectedNode { id: number; name: string; qualified: string; file: string; label: string; }

export function detectChanges(
  store: Store,
  project: string,
  repoPath: string,
): { changedFiles: ChangedFile[]; affectedNodes: AffectedNode[]; risk: 'low' | 'medium' | 'high' } {
  let changedFiles: ChangedFile[] = [];
  try {
    const output = execSync(`git -C ${repoPath} diff --name-only HEAD`, { encoding: 'utf8', timeout: 5000 });
    const files = output.trim().split('\n').filter(Boolean);
    changedFiles = files.map(f => ({ path: f, status: 'modified' }));

    // Also check untracked
    const untracked = execSync(`git -C ${repoPath} ls-files --others --exclude-standard`, { encoding: 'utf8', timeout: 5000 });
    for (const f of untracked.trim().split('\n').filter(Boolean)) {
      if (!changedFiles.find(c => c.path === f)) {
        changedFiles.push({ path: f, status: 'untracked' });
      }
    }
  } catch {
    return { changedFiles: [], affectedNodes: [], risk: 'low' };
  }

  // Find nodes in changed files
  const affectedNodes: AffectedNode[] = [];
  const nodeIds = new Set<number>();

  for (const cf of changedFiles) {
    const nodes = store.queryNodes(
      'SELECT id, name, qualified, file, label FROM nodes WHERE project = ? AND file = ?',
      [project, cf.path],
    );
    for (const n of nodes) {
      nodeIds.add(n.id);
      affectedNodes.push({ id: n.id, name: n.name, qualified: n.qualified, file: n.file, label: n.label });
    }
  }

  // Blast radius: nodes that call or are called by changed nodes
  const blastRadius = new Set<number>();
  for (const nid of nodeIds) {
    // Outbound: who does this node call?
    const outEdges = store.queryNodes(
      'SELECT dst FROM edges WHERE src = ? AND project = ? AND dst IS NOT NULL',
      [nid, project],
    );
    for (const e of outEdges) {
      if (!nodeIds.has(e.dst)) blastRadius.add(e.dst);
    }
    // Inbound: who calls this node?
    const inEdges = store.queryNodes(
      'SELECT src FROM edges WHERE dst = ? AND project = ?',
      [nid, project],
    );
    for (const e of inEdges) {
      if (!nodeIds.has(e.src)) blastRadius.add(e.src);
    }
  }

  // Add blast radius nodes (one level)
  for (const bid of blastRadius) {
    if (!affectedNodes.find(n => n.id === bid)) {
      const n = store.queryOne('SELECT id, name, qualified, file, label FROM nodes WHERE id = ?', [bid]);
      if (n) affectedNodes.push({ id: n.id, name: n.name, qualified: n.qualified, file: n.file, label: n.label });
    }
  }

  // Risk assessment
  let risk: 'low' | 'medium' | 'high' = 'low';
  if (affectedNodes.length > 20) risk = 'high';
  else if (affectedNodes.length > 5) risk = 'medium';

  return { changedFiles, affectedNodes, risk };
}

// ─── 7. getArchitecture ──────────────────────────────────────────────────────

interface ArchResult {
  languages: Record<string, number>;
  packages: string[];
  entryPoints: Array<{ id: number; name: string; qualified: string; file: string }>;
  hotspots: Array<{ id: number; name: string; qualified: string; degree: number }>;
  routes: Array<{ id: number; name: string; qualified: string }>;
  clusters: Record<string, string[]>;
}

export function getArchitecture(store: Store, project: string): ArchResult {
  const nodes = store.getNodesByProject(project);
  const edges = store.getEdgesByProject(project);

  // Languages: aggregate by file extension
  const languages: Record<string, number> = {};
  for (const n of nodes) {
    const ext = (n.file ?? '').split('.').pop() ?? 'unknown';
    languages[ext] = (languages[ext] ?? 0) + 1;
  }

  // Packages: derive from qualified name prefix
  const pkgSet = new Set<string>();
  for (const n of nodes) {
    const parts = (n.qualified ?? '').split('.');
    if (parts.length > 1) {
      pkgSet.add(parts.slice(0, -1).join('.'));
    }
  }
  const packages = [...pkgSet].sort();

  // Entry points: Functions with no inbound CALLS
  const inboundTargets = new Set<number>();
  for (const e of edges) {
    if (e.type === 'CALLS' && e.dst) inboundTargets.add(e.dst);
  }
  const entryPoints = nodes
    .filter(n => n.label === 'Function' && !inboundTargets.has(n.id))
    .map(n => ({ id: n.id, name: n.name, qualified: n.qualified, file: n.file }));

  // Hotspots: highest degree (in + out)
  const degreeMap = new Map<number, number>();
  for (const e of edges) {
    degreeMap.set(e.src, (degreeMap.get(e.src) ?? 0) + 1);
    if (e.dst) degreeMap.set(e.dst, (degreeMap.get(e.dst) ?? 0) + 1);
  }
  const hotspots = nodes
    .map(n => ({ id: n.id, name: n.name, qualified: n.qualified, degree: degreeMap.get(n.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 10);

  // Routes
  const routes = nodes
    .filter(n => n.label === 'Route')
    .map(n => ({ id: n.id, name: n.name, qualified: n.qualified }));

  // Clusters: group by top-level package
  const clusters: Record<string, string[]> = {};
  for (const n of nodes) {
    const parts = (n.qualified ?? '').split('.');
    const pkg = parts.length > 2 ? parts[0] + '.' + parts[1] : parts[0] ?? 'root';
    if (!clusters[pkg]) clusters[pkg] = [];
    clusters[pkg].push(n.name);
  }

  return { languages, packages, entryPoints, hotspots, routes, clusters };
}

// ─── 8. deadCode ─────────────────────────────────────────────────────────────

export function deadCode(
  store: Store,
  project: string,
): Array<{ id: number; name: string; qualified: string; file: string; line: number }> {
  const arch = getArchitecture(store, project);
  const entryPointIds = new Set(arch.entryPoints.map(ep => ep.id));

  const candidates = store.queryNodes(
    `SELECT id, name, qualified, file, start_line AS line FROM nodes
     WHERE project = ? AND label IN ('Function', 'Method', 'Class')`,
    [project],
  );

  const result: Array<{ id: number; name: string; qualified: string; file: string; line: number }> = [];
  for (const c of candidates) {
    if (entryPointIds.has(c.id)) continue;
    // Check for incoming CALLS or CALL_REFERENCE edges
    const incoming = store.queryOne(
      `SELECT COUNT(*) AS cnt FROM edges WHERE dst = ? AND type IN ('CALLS', 'CALL_REFERENCE')`,
      [c.id],
    );
    if ((incoming as any)?.cnt === 0) {
      result.push({ id: c.id, name: c.name, qualified: c.qualified, file: c.file, line: c.line });
    }
  }
  return result;
}

// ─── 9. getGraphSchema ───────────────────────────────────────────────────────

export function getGraphSchema(
  store: Store,
  project: string,
): { nodeLabels: Record<string, number>; edgeTypes: Record<string, number> } {
  const nodes = store.getNodesByProject(project);
  const edges = store.getEdgesByProject(project);

  const nodeLabels: Record<string, number> = {};
  for (const n of nodes) {
    nodeLabels[n.label] = (nodeLabels[n.label] ?? 0) + 1;
  }

  const edgeTypes: Record<string, number> = {};
  for (const e of edges) {
    edgeTypes[e.type] = (edgeTypes[e.type] ?? 0) + 1;
  }

  return { nodeLabels, edgeTypes };
}

// ─── 10. indexStatus ─────────────────────────────────────────────────────────

export function indexStatus(store: Store, project: string): Record<string, any> | null {
  const proj = store.queryOne('SELECT * FROM projects WHERE name = ?', [project]);
  if (!proj) return null;
  const fileCount = (store.queryOne('SELECT COUNT(*) AS c FROM files WHERE project = ?', [project]) as any)?.c ?? 0;
  return {
    name: proj.name,
    root: proj.root,
    node_count: proj.node_count,
    edge_count: proj.edge_count,
    file_count: fileCount,
    created_at: proj.created_at,
    updated_at: proj.updated_at,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function globToLike(pattern: string): string {
  // Convert glob-ish pattern to SQL LIKE
  // .* -> %, * -> %, ? -> _
  return pattern.replace(/\.\*/g, '%').replace(/\*/g, '%').replace(/\?/g, '_');
}
