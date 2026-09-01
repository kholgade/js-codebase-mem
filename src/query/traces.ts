import type { Store } from '../sql/store.ts';

export interface IngestTraceInput {
  name?: string;
  root?: string;
  /** ordered list of qualified names (or node names) observed during execution */
  calls: string[];
}

export interface ApplyTraceResult {
  traces: number;
  edges_boosted: number;
  edges_created: number;
}

function resolveNodeId(store: Store, project: string, frame: string): number | null {
  const row = store.queryOne(
    `SELECT id FROM nodes WHERE project = ? AND (qualified = ? OR name = ?) ORDER BY qualified = ? DESC LIMIT 1`,
    [project, frame, frame, frame],
  ) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

/**
 * Use persisted execution traces to strengthen the call graph: every consecutive
 * (a, b) frame pair that resolves to two nodes upgrades an existing CALLS edge to
 * 'exact' confidence and bumps trace_hits; if no edge exists, one is created.
 */
export function applyTraceConfidence(store: Store, project: string): ApplyTraceResult {
  const traces = store.getTraces(project);
  let edgesBoosted = 0;
  let edgesCreated = 0;

  for (const trace of traces) {
    for (let i = 0; i + 1 < trace.calls.length; i++) {
      const srcId = resolveNodeId(store, project, trace.calls[i]);
      const dstId = resolveNodeId(store, project, trace.calls[i + 1]);
      if (srcId === null || dstId === null) continue;

      const res = store.queryOne(
        `UPDATE edges SET confidence = 'exact', trace_hits = trace_hits + 1 WHERE project = ? AND src = ? AND dst = ? AND type = 'CALLS' RETURNING id`,
        [project, srcId, dstId],
      );
      if (res) {
        edgesBoosted++;
        continue;
      }

      store.underlying
        .prepare(`INSERT INTO edges (project, src, dst, type, confidence, site_line, trace_hits) VALUES (?, ?, ?, 'CALLS', 'exact', NULL, 1)`)
        .run(project, srcId, dstId);
      edgesCreated++;
    }
  }

  store.setProjectCounts(project);
  return { traces: traces.length, edges_boosted: edgesBoosted, edges_created: edgesCreated };
}