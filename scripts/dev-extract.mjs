// Temporary dev harness: run a language's query over sample source and print emits.
import { createRegistry } from '../src/languages/index.ts';
import { ParserPool } from '../src/indexer/parser-pool.ts';
import { Query } from 'web-tree-sitter';
import { readFile } from 'node:fs/promises';
import { emitsFromQuery } from '../src/languages/base.ts';

const [langId, sampleFile] = process.argv.slice(2);
const registry = createRegistry();
const plugin = registry.get(langId);
if (!plugin) throw new Error(`no lang ${langId}`);

const src = await readFile(sampleFile, 'utf8');
const pool = new ParserPool();
const parser = await pool.parserFor(plugin, sampleFile);
const tree = parser.parse(src);
const querySrc = await readFile(new URL(plugin.query, import.meta.url), 'utf8');
console.log(`[query for ${langId}] =====`);
console.log(querySrc);
const q = new Query(parser.language, querySrc);
const matches = q.matches(tree.rootNode);
const emits = emitsFromQuery(matches);
console.log(`[emits] count=${emits.length}`);
for (const e of emits) {
  console.log(JSON.stringify({ ...e, range: undefined }));
}
