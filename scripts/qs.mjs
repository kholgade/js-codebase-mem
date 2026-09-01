import { Parser, Language, Query } from 'web-tree-sitter';
import { readFile } from 'node:fs/promises';
const wasm = process.argv[2], querySrc = process.argv[3];
await Parser.init();
const lang = await Language.load(new Uint8Array(await readFile(wasm)));
try { const q = new Query(lang, querySrc); console.log('OK'); }
catch(e){ console.log('ERR:', e.info?.suffix); process.exit(1); }
