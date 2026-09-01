import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/sql/store.ts';
import {
  searchGraph,
  traceCallPath,
  queryGraph,
  getCodeSnippet,
  searchCode,
  deadCode,
  getArchitecture,
  getGraphSchema,
  indexStatus,
} from '../src/query/tools.ts';

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-test-'));
  const dbPath = join(dir, 'test.db');
  const store = new Store(dbPath);
  return { store, dir };
}

function seedGraph(store: Store): void {
  const project = 'test-proj';
  const root = '/tmp/test-repo';
  store.upsertProject(project, root);

  // Create nodes
  const fileA = store.insertNode(
    { id: 0, project, file: 'src/a.ts', label: 'File', name: 'a.ts', qualified: 'test.src.a' },
    { sl: 1, sc: 0, el: 10, ec: 0 },
  );
  const fileB = store.insertNode(
    { id: 0, project, file: 'src/b.ts', label: 'File', name: 'b.ts', qualified: 'test.src.b' },
    { sl: 1, sc: 0, el: 15, ec: 0 },
  );
  const funcMain = store.insertNode(
    { id: 0, project, file: 'src/a.ts', label: 'Function', name: 'main', qualified: 'test.src.a.main', signature: 'function main()' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  const funcHelper = store.insertNode(
    { id: 0, project, file: 'src/b.ts', label: 'Function', name: 'helper', qualified: 'test.src.b.helper', signature: 'function helper()' },
    { sl: 1, sc: 0, el: 3, ec: 0 },
  );
  const funcUtil = store.insertNode(
    { id: 0, project, file: 'src/b.ts', label: 'Function', name: 'util', qualified: 'test.src.b.util' },
    { sl: 5, sc: 0, el: 8, ec: 0 },
  );
  const clsFoo = store.insertNode(
    { id: 0, project, file: 'src/a.ts', label: 'Class', name: 'Foo', qualified: 'test.src.a.Foo' },
    { sl: 8, sc: 0, el: 20, ec: 0 },
  );

  // Edges
  store.insertEdge({ project, srcId: funcMain, dstId: funcHelper, type: 'CALLS', confidence: 'exact', siteLine: 3 });
  store.insertEdge({ project, srcId: funcMain, dstId: funcUtil, type: 'CALLS', confidence: 'reference', siteLine: 4 });
  store.insertEdge({ project, srcId: funcHelper, dstId: funcUtil, type: 'CALLS', confidence: 'exact', siteLine: 2 });
  store.insertEdge({ project, srcId: fileA, dstId: funcMain, type: 'DEFINES', confidence: 'exact', siteLine: 1 });
  store.insertEdge({ project, srcId: fileB, dstId: funcHelper, type: 'DEFINES', confidence: 'exact', siteLine: 1 });
  store.insertEdge({ project, srcId: fileB, dstId: funcUtil, type: 'DEFINES', confidence: 'exact', siteLine: 5 });
  store.insertEdge({ project, srcId: fileA, dstId: clsFoo, type: 'DEFINES', confidence: 'exact', siteLine: 8 });

  store.setProjectCounts(project);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('searchGraph returns matching nodes', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const results = searchGraph(store, 'test-proj', { name_pattern: 'main' });
    assert.ok(results.length >= 1);
    assert.equal(results[0].name, 'main');
    assert.equal(results[0].label, 'Function');
    assert.ok(typeof results[0].degree === 'number');
  } finally {
    store.close();
  }
});

test('searchGraph filters by label', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const results = searchGraph(store, 'test-proj', { label: 'Function' });
    assert.ok(results.length === 3);
    assert.ok(results.every(r => r.label === 'Function'));
  } finally {
    store.close();
  }
});

test('traceCallPath outbound from main', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const hops = traceCallPath(store, 'test-proj', 'main', 'outbound', 2);
    assert.ok(hops.length >= 2);
    const tos = hops.map(h => h.to);
    assert.ok(tos.some(t => t.includes('helper')));
    assert.ok(tos.some(t => t.includes('util')));
  } finally {
    store.close();
  }
});

test('traceCallPath inbound to util', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const hops = traceCallPath(store, 'test-proj', 'util', 'inbound', 2);
    assert.ok(hops.length >= 2);
    const froms = hops.map(h => h.from);
    assert.ok(froms.some(f => f.includes('main')));
    assert.ok(froms.some(f => f.includes('helper')));
  } finally {
    store.close();
  }
});

test('queryGraph basic pattern', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const result = queryGraph(store, 'test-proj', "MATCH (a:Function) RETURN a.name, a.label");
    assert.ok(result.length === 3);
    assert.ok(result.every(r => r.name && r.label === 'Function'));
  } finally {
    store.close();
  }
});

test('queryGraph with WHERE', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const result = queryGraph(store, 'test-proj', "MATCH (a:Function) WHERE a.name = 'main' RETURN a.name");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'main');
  } finally {
    store.close();
  }
});

test('getCodeSnippet returns node data', () => {
  const { store, dir } = makeStore();
  try {
    seedGraph(store);
    // Create the actual file so code can be read
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'function main() {\n  helper();\n}\n\nclass Foo {\n}\n');
    // Update project root to temp dir
    store.upsertProject('test-proj', dir);
    const snippet = getCodeSnippet(store, 'test-proj', 'test.src.a.main');
    assert.ok(snippet);
    assert.equal(snippet.name, 'main');
    assert.equal(snippet.file, 'src/a.ts');
    assert.ok(snippet.code.includes('function main'));
  } finally {
    store.close();
  }
});

test('searchCode finds by pattern', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const results = searchCode(store, 'test-proj', 'helper');
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.name === 'helper'));
  } finally {
    store.close();
  }
});

test('deadCode finds unreferenced nodes', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const dead = deadCode(store, 'test-proj');
    // funcUtil has inbound CALLS, so it should NOT be dead
    // clsFoo has no incoming CALLS - it IS dead
    assert.ok(dead.some(d => d.name === 'Foo'));
    assert.ok(!dead.some(d => d.name === 'main'));
    assert.ok(!dead.some(d => d.name === 'helper'));
  } finally {
    store.close();
  }
});

test('getArchitecture returns structured data', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const arch = getArchitecture(store, 'test-proj');
    assert.ok(arch.languages);
    assert.ok(arch.packages.length > 0);
    assert.ok(Array.isArray(arch.entryPoints));
    assert.ok(Array.isArray(arch.hotspots));
    assert.ok(Array.isArray(arch.routes));
    assert.ok(arch.clusters);
  } finally {
    store.close();
  }
});

test('getGraphSchema returns label and edge counts', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const schema = getGraphSchema(store, 'test-proj');
    assert.ok(schema.nodeLabels['Function'] >= 3);
    assert.ok(schema.nodeLabels['File'] >= 2);
    assert.ok(schema.edgeTypes['CALLS'] >= 3);
  } finally {
    store.close();
  }
});

test('indexStatus returns project info', () => {
  const { store } = makeStore();
  try {
    seedGraph(store);
    const status = indexStatus(store, 'test-proj');
    assert.ok(status);
    assert.equal(status.name, 'test-proj');
    assert.equal(status.root, '/tmp/test-repo');
    assert.ok(typeof status.node_count === 'number');
  } finally {
    store.close();
  }
});

test('indexStatus returns null for unknown project', () => {
  const { store } = makeStore();
  try {
    const status = indexStatus(store, 'nonexistent');
    assert.equal(status, null);
  } finally {
    store.close();
  }
});
