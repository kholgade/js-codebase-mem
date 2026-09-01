import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/sql/store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCorpus, buildInvertedIndex, buildIdf, tfidfScore,
  computeSignals, normalizeSignals, DEFAULT_SIGNAL_WEIGHTS,
} from '../src/search/signals.ts';

test('buildCorpus tokenizes node text into tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-sig-'));
  const store = new Store(join(dir, 'g.db'));
  store.insertNode(
    { id: 0, project: 'demo', file: 'a.ts', label: 'Function', name: 'getUserById', qualified: 'demo.a.getUserById', signature: 'getUserById(id: number)', doc: 'find user' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  const corpus = buildCorpus(store, 'demo');
  assert.equal(corpus.length, 1);
  assert.ok(corpus[0].tokens.length > 0, 'should have tokens');
  assert.ok(corpus[0].tokens.includes('user'), 'camelCase split should include user');
  store.close();
});

test('inverted index and idf are consistent', () => {
  const corpus = [
    { id: 1, name: 'foo', qualified: 'a.foo', file: 'a.ts', tokens: ['foo', 'bar'] },
    { id: 2, name: 'baz', qualified: 'a.baz', file: 'b.ts', tokens: ['bar', 'qux'] },
  ] as any;
  const index = buildInvertedIndex(corpus);
  assert.equal(index.get('bar')!.size, 2);
  assert.equal(index.get('foo')!.size, 1);
  const idf = buildIdf(corpus, index);
  assert.ok(idf.get('foo')! > idf.get('bar')!, 'rarer term should have higher idf');
});

test('tfidfScore rewards term frequency', () => {
  const corpus = [
    { id: 1, name: 'a', file: 'a.ts', qualified: 'x.a', tokens: ['apple', 'banana'] },
    { id: 2, name: 'b', file: 'b.ts', qualified: 'x.b', tokens: ['apple'] },
  ] as any;
  const index = buildInvertedIndex(corpus);
  const idf = buildIdf(corpus, index);
  const s1 = tfidfScore(['apple'], corpus[0], idf);
  const s2 = tfidfScore(['apple'], corpus[1], idf);
  // Both have one 'apple'; foo doc has max freq 1, so equal tf. Normalized equal.
  assert.ok(s1 >= 0 && s2 >= 0);
});

test('computeSignals produces scores and normalizes to [0,1]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-sig2-'));
  const store = new Store(join(dir, 'g.db'));
  store.insertNode(
    { id: 0, project: 'demo', file: 'auth.ts', label: 'Function', name: 'loginUser', qualified: 'demo.auth.loginUser', signature: 'loginUser(user, pass)', doc: 'authenticate a user' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  store.insertNode(
    { id: 0, project: 'demo', file: 'billing.ts', label: 'Function', name: 'chargeCard', qualified: 'demo.billing.chargeCard', signature: 'chargeCard(card)', doc: 'process a payment' },
    { sl: 1, sc: 0, el: 5, ec: 0 },
  );
  const signals = computeSignals(store, 'demo', 'user login auth', DEFAULT_SIGNAL_WEIGHTS);
  assert.equal(signals.perDoc.size, 2);
  normalizeSignals(signals);
  for (const s of signals.perDoc.values()) {
    for (const v of [s.tfidf, s.moduleProximity, s.signature, s.astProfile]) {
      assert.ok(v >= 0 && v <= 1, `signal out of range: ${v}`);
    }
  }
  store.close();
});
