import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/sql/store.ts';
import { indexRepository } from '../src/indexer/index.ts';
import { createRegistry } from '../src/languages/index.ts';

test('indexer links HTTP routes to their handler functions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-route-'));
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'server.ts'), `
    import express from 'express';
    const app = express();
    export function pingHandler(req: any, res: any) { res.send('pong'); }
    app.get('/ping', pingHandler);
    app.post('/users', (req, res) => res.status(201).send('created'));
  `);

  const store = new Store(join(dir, 'g.db'));
  const registry = createRegistry();
  const result = await indexRepository({
    project: 'demo',
    repoPath: dir,
    store,
    registry,
  });
  assert.ok(result.nodes > 0, 'should index nodes');

  // Find route nodes
  const routes = store.queryNodes(
    "SELECT * FROM nodes WHERE project = 'demo' AND label = 'Route'",
  ) as any[];
  assert.ok(routes.length >= 2, `expected at least 2 routes, got ${routes.length}`);

  // Verify at least one route is linked (HANDLES) to the file
  const file = store.queryOne("SELECT id FROM nodes WHERE project = 'demo' AND label = 'File'");
  const handles = store.queryOne(
    'SELECT COUNT(*) AS c FROM edges WHERE type = ? AND src = ?',
    ['HANDLES', (file as any).id],
  );
  assert.ok(Number((handles as any).c) >= 2, 'routes should be HANDLED by the file');

  // Find the pingHandler function node
  const handler = store.queryOne(
    "SELECT id FROM nodes WHERE project = 'demo' AND name = 'pingHandler'",
  ) as any;
  assert.ok(handler, 'pingHandler should be indexed');

  // A route node should now have a CALLS edge to pingHandler
  const routeHandlerCalls = store.queryNodes(
    'SELECT e.* FROM edges e INNER JOIN nodes n ON e.src = n.id WHERE n.label = ? AND e.type = ? AND e.dst = ?',
    ['Route', 'CALLS', handler.id],
  ) as any[];
  assert.ok(routeHandlerCalls.length >= 1, 'a route should CALL the pingHandler');
  store.close();
});
