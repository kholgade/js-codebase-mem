import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/sql/store.ts';
import { startGraphServer } from '../src/server/http.ts';

function makeStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-http-'));
  const store = new Store(join(dir, 'test.db'));
  return store;
}

function seed(store: Store): void {
  const project = 'test-proj';
  store.upsertProject(project, '/tmp/test-repo');

  const fileA = store.insertNode(
    { id: 0, project, file: 'src/a.ts', label: 'File', name: 'a.ts', qualified: 'test.src.a' },
    { sl: 1, sc: 0, el: 10, ec: 0 },
  );
  const funcMain = store.insertNode(
    { id: 0, project, file: 'src/a.ts', label: 'Function', name: 'main', qualified: 'test.src.a.main' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  const clsFoo = store.insertNode(
    { id: 0, project, file: 'src/a.ts', label: 'Class', name: 'Foo', qualified: 'test.src.a.Foo' },
    { sl: 8, sc: 0, el: 20, ec: 0 },
  );

  store.insertEdge({ project, srcId: fileA, dstId: funcMain, type: 'DEFINES', confidence: 'exact', siteLine: 1 });
  store.insertEdge({ project, srcId: fileA, dstId: clsFoo, type: 'DEFINES', confidence: 'exact', siteLine: 8 });
  store.setProjectCounts(project);
}

const store = makeStore();
seed(store);

const graph = await startGraphServer(store, 0);
const base = graph.url;

after(async () => {
  await graph.close();
  store.close();
});

test('GET / returns HTML page', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const body = await res.text();
  assert.match(body, /<canvas/);
  assert.match(body, /Graph Explorer/);
});

test('GET /api/projects returns project list', async () => {
  const res = await fetch(base + '/api/projects');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.some((p) => p.name === 'test-proj'));
});

test('GET /api/nodes?project=X returns nodes', async () => {
  const res = await fetch(base + '/api/nodes?project=test-proj');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.equal(data.length, 3);
  assert.ok(data.every((n) => n.id != null && n.name && n.label && n.qualified && n.file));
});

test('GET /api/nodes filters dangling edges and returns edges', async () => {
  const res = await fetch(base + '/api/edges?project=test-proj');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.equal(data.length, 2);
  assert.ok(data.every((e) => e.src != null && e.dst != null && e.type));
});

test('GET /api/node/:id returns node detail', async () => {
  const nodes = await (await fetch(base + '/api/nodes?project=test-proj')).json();
  const id = nodes[0].id;
  const detail = await fetch(base + '/api/node/' + id);
  assert.equal(detail.status, 200);
  const node = await detail.json();
  assert.equal(node.id, id);
  assert.ok(node.name);
});

test('GET unknown route returns 404', async () => {
  const res = await fetch(base + '/api/nope');
  assert.equal(res.status, 404);
});
