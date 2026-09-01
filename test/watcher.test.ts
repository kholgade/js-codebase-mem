import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/sql/store.ts';
import { createRegistry } from '../src/languages/index.ts';
import { ProjectWatcher } from '../src/indexer/watcher.ts';
import { searchGraph } from '../src/query/tools.ts';

function makeEnv(): { store: Store; dir: string; project: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-watch-'));
  const dbPath = join(dir, 'watch.db');
  const store = new Store(dbPath);
  const project = 'watch-proj';
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src/a.js'),
    'function greet() {\n  return "hello";\n}\n',
  );
  return { store, dir, project };
}

test('watcher reindex picks up edits and new files', async () => {
  const { store, dir, project } = makeEnv();
  const registry = createRegistry();
  try {
    const watcher = new ProjectWatcher({
      project,
      repoPath: dir,
      store,
      registry,
    });

    const first = await watcher.reindex();
    assert.ok(first.indexedFiles >= 1);

    let got = searchGraph(store, project, { name_pattern: 'greet' });
    assert.ok(got.some((r) => r.name === 'greet'));

    // Modify an existing file: add a new function.
    writeFileSync(
      join(dir, 'src/a.js'),
      'function greet() {\n  return "hello";\n}\n\nfunction farewell() {\n  return "bye";\n}\n',
    );
    // Add a brand-new file.
    writeFileSync(
      join(dir, 'src/b.js'),
      'function helper() {\n  return 42;\n}\n',
    );

    // Call reindex directly — do not wait on the polling timer.
    const second = await watcher.reindex();

    got = searchGraph(store, project, { name_pattern: 'farewell' });
    assert.ok(got.some((r) => r.name === 'farewell'), 'new function in edited file should be found');
    got = searchGraph(store, project, { name_pattern: 'helper' });
    assert.ok(got.some((r) => r.name === 'helper'), 'function in new file should be found');
    assert.ok(second.durationMs >= 0);
  } finally {
    store.close();
  }
});

test('watcher isRunning toggles and lastIndex is set', async () => {
  const { store, dir, project } = makeEnv();
  const registry = createRegistry();
  try {
    const watcher = new ProjectWatcher({ project, repoPath: dir, store, registry });
    assert.equal(watcher.isRunning(), false);
    assert.equal(watcher.lastIndex, undefined);

    await watcher.reindex();
    assert.ok(watcher.lastIndex);
    assert.equal(watcher.lastIndex!.project, project);

    watcher.start();
    assert.equal(watcher.isRunning(), true);
    watcher.stop();
    assert.equal(watcher.isRunning(), false);
  } finally {
    store.close();
  }
});
