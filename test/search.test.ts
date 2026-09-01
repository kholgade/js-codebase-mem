import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HashingEmbedder, embedText, quantizeToInt8, dequantizeFromInt8 } from '../src/search/semantic.ts';
import { splitIdentifier, normalizeIdent, escapeFtsToken } from '../src/search/tokenize.ts';
import { buildMatchQuery, searchFts } from '../src/search/fts.ts';
import { Store } from '../src/sql/store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('hashing embedder is deterministic and fixed-dim', () => {
  const emb = new HashingEmbedder();
  const a = emb.embed('getUserById fetches a user');
  const b = emb.embed('getUserById fetches a user');
  assert.equal(a.length, 256);
  assert.deepEqual(a, b, 'vector must be deterministic');
  // different text -> different vectors
  const c = emb.embed('creates a brand new widget');
  assert.notDeepEqual(a, c);
  // normalized (unit-ish) length
  const mag = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(mag - 1) < 1e-6, `expected unit vector, got ${mag}`);
});

test('empty text yields a stable vector', () => {
  const a = embedText('');
  const b = embedText('');
  assert.deepEqual(a, b);
  assert.equal(a.length, 256);
});

test('int8 quantization round-trips', () => {
  const vec = embedText('parseConfiguration options deep merge');
  const q = quantizeToInt8(vec);
  assert.equal(q.length, 256);
  const d = dequantizeFromInt8(q);
  assert.equal(d.length, 256);
  // dequantized should be close to original
  for (let i = 0; i < vec.length; i++) {
    assert.ok(Math.abs(d[i] - vec[i]) < 0.01, `index ${i} off`);
  }
});

test('identifier tokenizer splits camelCase, snake_case, kebab, dots', () => {
  assert.deepEqual(splitIdentifier('getUserById'), ['get', 'user', 'by', 'id']);
  assert.deepEqual(splitIdentifier('parse_config'), ['parse', 'config']);
  assert.deepEqual(splitIdentifier('fetch-data'), ['fetch', 'data']);
  assert.deepEqual(splitIdentifier('RedisCacheStore'), ['redis', 'cache', 'store']);
  assert.deepEqual(splitIdentifier('util.parseJSON'), ['util', 'parse', 'json']);
  // dot paths produce no duplicate empties
  const norm = normalizeIdent('getUser.byId');
  assert.equal(norm, 'get user by id');
});

test('escapeFtsToken strips specials', () => {
  const esc = escapeFtsToken('a"b(c)');
  assert.ok(!esc.includes('('));
  assert.ok(!esc.includes('"'));
});

test('fts tokenizer builds AND of prefixed phrases without special chars', () => {
  const m = buildMatchQuery('getUserBy "exact phrase"');
  assert.ok(m.includes('AND'));
  assert.ok(m.startsWith('"getUserBy"*'), m);
  assert.ok(m.includes('"exact"*') && m.includes('"phrase"*'), m);
  assert.ok(!m.includes('(') && !m.includes('[') && !m.includes(':'));
});

test('fts + embeddings over a real store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-search-'));
  const store = new Store(join(dir, 'g.db'));
  const id1 = store.insertNode(
    { id: 0, project: 'demo', file: 'a.ts', label: 'Function', name: 'getUserById', qualified: 'demo.a.getUserById', signature: 'getUserById(id: number)', doc: 'finds a user by identifier' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  store.insertNode(
    { id: 0, project: 'demo', file: 'b.ts', label: 'Class', name: 'CacheStore', qualified: 'demo.b.CacheStore', signature: 'class CacheStore', doc: 'in-memory cache' },
    { sl: 1, sc: 0, el: 9, ec: 0 },
  );
  const fts = searchFts(store, 'demo', 'getUserById', 10);
  assert.equal(fts.length, 1);
  assert.equal(fts[0].id, id1);

  // embeddings built then queried
  const { ensureModelStrategy } = await import('../src/search/semantic.ts');
  process.env.CBM_MODEL = 'off';
  const asyncEmb = await ensureModelStrategy();
  assert.equal(asyncEmb, null, 'CBM_MODEL=off disables the (optional) model strategy');

  const { buildEmbeddings, semanticSearch } = await import('../src/search/semantic.ts');
  const built = buildEmbeddings(store, 'demo');
  assert.ok(built.embedded >= 2);
  const hits = semanticSearch(store, 'demo', 'find user by id', 5);
  assert.ok(hits.length >= 1, 'should return a semantic hit');
  // getUserById should rank above CacheStore for a user/id query
  const userNode = hits.findIndex((h) => h.name === 'getUserById');
  const cacheNode = hits.findIndex((h) => h.name === 'CacheStore');
  assert.ok(userNode >= 0 && (cacheNode === -1 || userNode < cacheNode), 'user node should rank higher');
  store.close();
});
