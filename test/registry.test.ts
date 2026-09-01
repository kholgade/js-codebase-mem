import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/languages/index.ts';
import { LanguageRegistry } from '../src/languages/contract.ts';
import { isSupportedFile, walk, parseGitignorePatterns, matchesGitignore } from '../src/indexer/index.ts';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('registry has all 8 languages and resolves by extension', () => {
  const reg = createRegistry();
  const langs = reg.all().map((l) => l.id).sort();
  assert.deepEqual(langs, ['cpp', 'csharp', 'go', 'java', 'javascript', 'python', 'rust', 'typescript']);
  assert.equal(reg.forPath('/a/b/main.py')?.id, 'python');
  assert.equal(reg.forPath('/a/b/main.ts')?.id, 'typescript');
  assert.equal(reg.forPath('/a/b/main.cpp')?.id, 'cpp');
  assert.equal(reg.forPath('/a/b/main.cs')?.id, 'csharp');
  assert.equal(reg.forPath('/a/b/main.rs')?.id, 'rust');
  assert.equal(reg.forPath('/a/b/main.go')?.id, 'go');
  assert.equal(reg.forPath('/a/b/Main.java')?.id, 'java');
  assert.equal(reg.forPath('/a/b/app.jsx')?.id, 'javascript');
});

test('extension registration wins for longer suffix', () => {
  const reg = new LanguageRegistry();
  reg.register({ id: 'a', extensions: ['.ts'], wasmPath: '', query: '', contextualize: (_, e) => e });
  reg.register({ id: 'b', extensions: ['.d.ts'], wasmPath: '', query: '', contextualize: (_, e) => e });
  assert.equal(reg.forPath('x.d.ts')?.id, 'b');
  assert.equal(reg.forPath('x.ts')?.id, 'a');
});

test('isSupportedFile matches 8 family extensions', () => {
  for (const f of ['a.py', 'a.js', 'a.tsx', 'a.java', 'a.cpp', 'a.cs', 'a.go', 'a.rs', 'a.h']) {
    assert.equal(isSupportedFile('/r/' + f), true, f);
  }
  assert.equal(isSupportedFile('README.md'), false);
  assert.equal(isSupportedFile('a.rb'), false);
});

test('walk respects ignore dirs and collects files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-walk-'));
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'x', 'a.py'), '#');
  writeFileSync(join(dir, 'src', 'b.py'), '#');
  writeFileSync(join(dir, 'README.md'), '#');
  const out: string[] = [];
  await walk(dir, new Set(['node_modules', '.git', 'dist']), out);
  assert.equal(out.filter((f) => f.includes('node_modules')).length, 0);
  assert.equal(out.includes(join(dir, 'src', 'b.py')), true);
  assert.equal(out.includes(join(dir, 'README.md')), true);
});

test('parseGitignorePatterns parses basic patterns', () => {
  const patterns = parseGitignorePatterns(`
# Comment
*.log
build/
!important.log
`);
  assert.equal(patterns.length, 3);
  assert.equal(patterns[0].pattern, '*.log');
  assert.equal(patterns[0].isNegation, false);
  assert.equal(patterns[1].pattern, 'build/');
  assert.equal(patterns[1].isDirOnly, true);
  assert.equal(patterns[2].pattern, '!important.log');
  assert.equal(patterns[2].isNegation, true);
});

test('matchesGitignore matches simple patterns', () => {
  const patterns = parseGitignorePatterns('*.log\nbuild/\n');
  assert.equal(matchesGitignore('debug.log', false, patterns), true);
  assert.equal(matchesGitignore('build', true, patterns), true);
  assert.equal(matchesGitignore('src/main.ts', false, patterns), false);
});

test('matchesGitignore handles negation', () => {
  const patterns = parseGitignorePatterns('*.log\n!important.log\n');
  assert.equal(matchesGitignore('debug.log', false, patterns), true);
  assert.equal(matchesGitignore('important.log', false, patterns), false);
});

test('walk reads .gitignore and excludes matching files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-gitignore-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '*.log\nlogs/\n');
  writeFileSync(join(dir, 'src', 'main.py'), '#');
  writeFileSync(join(dir, 'logs', 'debug.log'), '#');
  writeFileSync(join(dir, 'error.log'), '#');
  const out: string[] = [];
  await walk(dir, new Set(['node_modules', '.git']), out);
  assert.equal(out.filter((f) => f.endsWith('.log')).length, 0);
  assert.equal(out.filter((f) => f.includes('logs')).length, 0);
  assert.equal(out.includes(join(dir, 'src', 'main.py')), true);
});

test('walk reads .cbm-ignore and excludes matching files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-cbmignore-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.cbm-ignore'), 'test/\n*.spec.ts\n');
  writeFileSync(join(dir, 'src', 'main.ts'), '#');
  writeFileSync(join(dir, 'src', 'helper.spec.ts'), '#');
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test', 'unit.ts'), '#');
  const out: string[] = [];
  await walk(dir, new Set(['node_modules', '.git']), out);
  assert.equal(out.filter((f) => f.includes('test')).length, 0);
  assert.equal(out.includes(join(dir, 'src', 'main.ts')), true);
  assert.equal(out.includes(join(dir, 'src', 'helper.spec.ts')), false);
});
