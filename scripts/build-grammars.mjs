#!/usr/bin/env node
// Download and pin tree-sitter WASM grammars + write a manifest.
// Grammar WASM artifacts: https://github.com/tree-sitter/tree-sitter-grammars
// or per-org repos (tree-sitter/tree-sitter-python, tree-sitter/tree-sitter-typescript, ...).
//
// Placeholders for actual download URLs are assembled from a known-good source.
// Run: node scripts/build-grammars.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const grammarsDir = join(__dirname, '..', 'grammars');

// Pinned per language: org/repo, wasm filename.
const LANGUAGES = [
  { id: 'python', repo: 'tree-sitter/tree-sitter-python', wasm: 'tree-sitter-python.wasm' },
  { id: 'javascript', repo: 'tree-sitter/tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm' },
  { id: 'typescript', repo: 'tree-sitter/tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  { id: 'java', repo: 'tree-sitter/tree-sitter-java', wasm: 'tree-sitter-java.wasm' },
  { id: 'cpp', repo: 'tree-sitter/tree-sitter-cpp', wasm: 'tree-sitter-cpp.wasm' },
  { id: 'csharp', repo: 'tree-sitter/tree-sitter-c-sharp', wasm: 'tree-sitter-c-sharp.wasm' },
  { id: 'go', repo: 'tree-sitter/tree-sitter-go', wasm: 'tree-sitter-go.wasm' },
  { id: 'rust', repo: 'tree-sitter/tree-sitter-rust', wasm: 'tree-sitter-rust.wasm' },
];

const manifest = { version: 1, generated: new Date().toISOString(), languages: {} };

for (const lang of LANGUAGES) {
  mkdirSync(join(grammarsDir, lang.id), { recursive: true });
  // Stable tag pin — update when re-vendoring.
  const tag = 'v0.24.7';
  const url = `https://github.com/${lang.repo}/releases/download/tree-sitter%2F${tag}/${lang.wasm}`;
  manifest.languages[lang.id] = {
    repo: lang.repo,
    tag,
    wasm: `${lang.id}/${lang.wasm}`,
    url,
  };
}

writeFileSync(join(grammarsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote grammars/manifest.json for ${Object.keys(manifest.languages).length} languages.`);
console.log('Download .wasm files from the URLs above into the matching <id>/ directory.');
