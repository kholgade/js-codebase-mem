import { Parser, Language, Query } from 'web-tree-sitter';
import { readFile } from 'node:fs/promises';
const wasm = process.argv[2];
await Parser.init();
const lang = await Language.load(new Uint8Array(await readFile(wasm)));
// Test-feed patterns one at a time
const patterns = process.argv.slice(3);
for (const p of patterns) {
  try { new Query(lang, p); console.log('OK  :', p.slice(0,60)); }
  catch(e){ console.log('FAIL:', p.slice(0,60), '->', e.info?.suffix); }
}
