import { Parser, Language } from 'web-tree-sitter';
import { readFile } from 'node:fs/promises';
const langId = process.argv[2], wasm = process.argv[3], code = process.argv[4];
await Parser.init();
const lang = await Language.load(new Uint8Array(await readFile(wasm)));
const p = new Parser(); p.setLanguage(lang);
const tree = p.parse(code);
console.log(tree.rootNode.toString());
