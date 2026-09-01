import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/sql/store.ts';
import { applyTraceConfidence } from '../src/query/traces.ts';

function makeStore(): { store: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-traces-'));
  return { store: new Store(join(dir, 'g.db')) };
}

function seed(store: Store, project: string): void {
  store.upsertProject(project, '/tmp');
  const a = store.insertNode(
    { id: 0, project, file: 'a.ts', label: 'Function', name: 'a', qualified: 'demo.a' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  const b = store.insertNode(
    { id: 0, project, file: 'b.ts', label: 'Function', name: 'b', qualified: 'demo.b' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  const c = store.insertNode(
    { id: 0, project, file: 'c.ts', label: 'Function', name: 'c', qualified: 'demo.c' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  store.insertEdge({ project, srcId: a, dstId: b, type: 'CALLS', confidence: 'reference', siteLine: 2 });
  store.setProjectCounts(project);
  return { a, b, c };
}

test('ingestTrace persists and getTraces returns it', () => {
  const { store } = makeStore();
  try {
    store.upsertProject('p', '/tmp');
    store.ingestTrace('p', { name: 't1', calls: ['demo.a', 'demo.b'] });
    const traces = store.getTraces('p');
    assert.equal(traces.length, 1);
    assert.deepEqual(traces[0].calls, ['demo.a', 'demo.b']);
    assert.equal(traces[0].name, 't1');
  } finally {
    store.close();
  }
});

test('applyTraceConfidence boosts existing CALLS edge and creates missing one', () => {
  const { store } = makeStore();
  try {
    const { a, b, c } = seed(store, 'demo');
    store.ingestTrace('demo', { calls: ['demo.a', 'demo.b', 'demo.c'] });

    const result = applyTraceConfidence(store, 'demo');
    assert.equal(result.traces, 1);
    // a->b already existed (boosted); b->c newly created.
    assert.equal(result.edges_boosted, 1);
    assert.equal(result.edges_created, 1);

    const aToB = store.queryOne(
      `SELECT confidence, trace_hits FROM edges WHERE project = 'demo' AND src = ? AND dst = ? AND type = 'CALLS'`,
      [a, b],
    ) as any;
    assert.equal(aToB.confidence, 'exact');
    assert.equal(aToB.trace_hits, 1);

    const bToC = store.queryOne(
      `SELECT confidence, trace_hits FROM edges WHERE project = 'demo' AND src = ? AND dst = ? AND type = 'CALLS'`,
      [b, c],
    ) as any;
    assert.equal(bToC.confidence, 'exact');
    assert.equal(bToC.trace_hits, 1);
  } finally {
    store.close();
  }
});

test('applyTraceConfidence skips frames that do not resolve to nodes', () => {
  const { store } = makeStore();
  try {
    seed(store, 'demo');
    store.ingestTrace('demo', { calls: ['demo.a', 'no.such.symbol', 'demo.b'] });
    const result = applyTraceConfidence(store, 'demo');
    assert.equal(result.edges_boosted, 0);
    assert.equal(result.edges_created, 0);
  } finally {
    store.close();
  }
});