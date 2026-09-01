import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/sql/store.ts';
import { exportArtifact, importArtifact } from '../src/artifact.ts';
import { installForAgent, autoInstall, uninstallForAgent } from '../src/server/install.ts';

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-art-test-'));
  const dbPath = join(dir, 'test.db');
  const store = new Store(dbPath);
  return { store, dir };
}

function seed(store: Store): void {
  store.upsertProject('proj', '/tmp/repo');
  const a = store.insertNode(
    { id: 0, project: 'proj', file: 'a.ts', label: 'Function', name: 'foo', qualified: 'proj.a.foo' },
    { sl: 1, sc: 0, el: 3, ec: 0 },
  );
  const b = store.insertNode(
    { id: 0, project: 'proj', file: 'b.ts', label: 'Function', name: 'bar', qualified: 'proj.b.bar' },
    { sl: 1, sc: 0, el: 2, ec: 0 },
  );
  store.insertEdge({ project: 'proj', srcId: a, dstId: b, type: 'CALLS', confidence: 'exact', siteLine: 2 });
  store.setProjectCounts('proj');
}

test('exportArtifact produces a gzipped file with project counts', async () => {
  const { store, dir } = makeStore();
  const dest = join(dir, 'graph.db.gz');
  try {
    seed(store);
    const result = await exportArtifact(store, 'proj', dest);
    assert.equal(result.project, 'proj');
    assert.equal(result.nodes, 2);
    assert.equal(result.edges, 1);
    assert.equal(result.dest, dest);
    assert.ok(existsSync(dest));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importArtifact round-trips nodes/edges/projects into a fresh store', async () => {
  const { store, dir } = makeStore();
  const dest = join(dir, 'graph.db.gz');
  try {
    seed(store);
    await exportArtifact(store, 'proj', dest);
  } finally {
    store.close();
  }

  const fresh = new Store(join(dir, 'fresh.db'));
  try {
    const result = await importArtifact(fresh, dest);
    assert.equal(result.project, 'proj');
    assert.equal(result.nodes, 2);
    assert.equal(result.edges, 1);

    const projects = fresh.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'proj');

    const nodes = fresh.getNodesByProject('proj');
    assert.equal(nodes.length, 2);
    const edges = fresh.getEdgesByProject('proj');
    assert.equal(edges.length, 1);
  } finally {
    fresh.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importArtifact respects project override', async () => {
  const { store, dir } = makeStore();
  const dest = join(dir, 'graph.db.gz');
  try {
    seed(store);
    await exportArtifact(store, 'proj', dest);
  } finally {
    store.close();
  }

  const fresh = new Store(join(dir, 'fresh.db'));
  try {
    const result = await importArtifact(fresh, dest, 'other-proj');
    assert.equal(result.project, 'other-proj');
    const nodes = fresh.getNodesByProject('other-proj');
    assert.equal(nodes.length, 2);
  } finally {
    fresh.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installForAgent returns the correct MCP config structure', () => {
  const cfg = installForAgent('/abs/path/js-codebase-mem') as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.ok(cfg.mcpServers);
  const entry = cfg.mcpServers['js-codebase-mem'];
  assert.ok(entry);
  assert.equal(entry.command, '/abs/path/js-codebase-mem');
  assert.deepEqual(entry.args, ['serve']);
});

test('autoInstall detects and writes to a temp HOME without touching real config', async () => {
  const oldHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'cbm-home-test-'));
  process.env.HOME = dir;
  try {
    const claudeConfig = join(dir, '.claude.json');
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { existing: { command: 'x', args: [] } } }, null, 2));

    const result = await autoInstall('/tmp/bin/codebase-mem');
    assert.ok(result.wired.includes('Claude Code'));
    assert.ok(!result.skipped.includes('Claude Code'));

    const parsed = JSON.parse(readFileSync(claudeConfig, 'utf8'));
    assert.ok(parsed.mcpServers['existing'], 'existing entry preserved');
    assert.equal(parsed.mcpServers['js-codebase-mem'].command, '/tmp/bin/codebase-mem');
    assert.deepEqual(parsed.mcpServers['js-codebase-mem'].args, ['serve']);
  } finally {
    process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstallForAgent removes the injected entry', async () => {
  const oldHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'cbm-home-test-'));
  process.env.HOME = dir;
  try {
    const claudeConfig = join(dir, '.claude.json');
    writeFileSync(
      claudeConfig,
      JSON.stringify(
        { mcpServers: { existing: { command: 'x', args: [] }, 'js-codebase-mem': { command: '/t', args: ['serve'] } } },
        null,
        2,
      ),
    );

    const result = await uninstallForAgent();
    assert.ok(result.wired.includes('Claude Code'));
    const parsed = JSON.parse(readFileSync(claudeConfig, 'utf8'));
    assert.ok(parsed.mcpServers['existing']);
    assert.ok(!('js-codebase-mem' in parsed.mcpServers));
  } finally {
    process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
