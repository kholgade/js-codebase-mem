import { LanguageRegistry } from './contract.ts';
import { buildLanguage, type LanguageDef } from './base-plugin.ts';

const DEFS: LanguageDef[] = [
  { id: 'python', extensions: ['.py'] },
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.es6'],
    wasmByExt: { '.jsx': 'tsx.wasm' } },
  { id: 'typescript', extensions: ['.ts', '.tsx', '.mts', '.cts'],
    wasmByExt: { '.tsx': 'tsx.wasm' } },
  { id: 'java', extensions: ['.java'] },
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.cxx'],
    wasmByExt: { '.c': 'c.wasm', '.h': 'c.wasm' } },
  { id: 'csharp', extensions: ['.cs'] },
  { id: 'go', extensions: ['.go'] },
  { id: 'rust', extensions: ['.rs'] },
];

export function createRegistry(): LanguageRegistry {
  const reg = new LanguageRegistry();
  for (const def of DEFS) {
    reg.register(buildLanguage(def));
  }
  return reg;
}
