import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolutionScope, FileContext, SyntaxNodeLike } from '../src/languages/contract.ts';
import { buildScope, resolveByIdentifier } from '../src/resolver/index.ts';
import { createJsTsResolver } from '../src/resolver/js-ts.ts';
import { createPythonResolver } from '../src/resolver/python.ts';
import { createJavaResolver } from '../src/resolver/java.ts';
import { createGoResolver } from '../src/resolver/go.ts';

// Mini helper to build a fake SyntaxNodeLike
function node(type: string, text: string): SyntaxNodeLike {
  return {
    type,
    text,
    startIndex: 0,
    endIndex: text.length,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: text.length },
    child: () => null,
    childForFieldName: () => null,
    namedChildren: [],
    parent: null,
  };
}

function mkScope(imports: Array<{ source: string; local?: string }>, symbols: [string, string][] = []): ResolutionScope {
  return buildScope('/proj/src/main.ts', imports, new Map(symbols));
}

const ctx: FileContext = {
  path: '/proj/src/main.ts',
  moduleSpec: 'main',
  imports: [],
  source: '',
  language: undefined as any,
};

test('buildScope creates scope with imports and symbols', () => {
  const scope = mkScope(
    [{ source: './utils', local: 'utils' }],
    [['foo', 'foo.qualified']],
  );
  assert.equal(scope.symbols.get('foo'), 'foo.qualified');
  assert.equal(scope.imports[0].local, 'utils');
});

test('resolveByIdentifier finds local symbols', () => {
  const scope = mkScope([], [['myFunc', 'pkg.myFunc']]);
  const r = resolveByIdentifier('myFunc', scope);
  assert.equal(r?.kind, 'exact');
  assert.equal(r?.qualified, 'pkg.myFunc');
  assert.equal(resolveByIdentifier('missing', scope), undefined);
});

test('resolveByIdentifier finds imported bindings', () => {
  const scope = mkScope([{ source: './lodash', local: '_' }]);
  const r = resolveByIdentifier('_', scope);
  assert.equal(r?.kind, 'reference');
  assert.equal(r?.qualified, './lodash');
});

test('js-ts resolver resolves identifiers and calls', () => {
  const r = createJsTsResolver();
  const scope = mkScope([{ source: './helper', local: 'helper' }], [['localFn', 'pkg.localFn']]);
  assert.equal(r.resolve(node('identifier', 'localFn'), scope, ctx)?.kind, 'exact');
  // Import paths get normalized (leading ./ stripped, extension stripped)
  assert.equal(r.resolve(node('identifier', 'helper'), scope, ctx)?.qualified, 'helper');
  // Globals
  assert.equal(r.resolve(node('identifier', 'console'), scope, ctx)?.kind, 'reference');
});

test('python resolver resolves imports and builtins', () => {
  const r = createPythonResolver();
  const scope = mkScope([{ source: 'os', local: 'os' }], [['my_func', 'pkg.my_func']]);
  assert.equal(r.resolve(node('identifier', 'my_func'), scope, ctx)?.kind, 'exact');
  assert.equal(r.resolve(node('identifier', 'print'), scope, ctx)?.qualified, 'builtins.print');
  assert.equal(r.resolve(node('identifier', 'os'), scope, ctx)?.qualified, 'os');
});

test('java resolver resolves fully-qualified imports', () => {
  const r = createJavaResolver();
  const scope = mkScope([{ source: 'java.util.List' }]);
  assert.equal(r.resolve(node('identifier', 'List'), scope, ctx)?.kind, 'exact');
  assert.equal(r.resolve(node('identifier', 'List'), scope, ctx)?.qualified, 'java.util.List');
  assert.equal(r.resolve(node('identifier', 'String'), scope, ctx)?.qualified, 'java.lang.String');
});

test('go resolver resolves package selector calls', () => {
  const r = createGoResolver();
  const scope = mkScope([{ source: 'fmt', local: 'fmt' }], [['localFn', 'pkg.localFn']]);
  assert.equal(r.resolve(node('identifier', 'localFn'), scope, ctx)?.kind, 'exact');
  assert.equal(r.resolve(node('identifier', 'len'), scope, ctx)?.qualified, 'builtin.len');
});
