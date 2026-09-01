import { LanguageRegistry } from './contract.ts';
import { buildLanguage, type LanguageDef } from './base-plugin.ts';
import { createJsTsResolver } from '../resolver/js-ts.ts';
import { createPythonResolver } from '../resolver/python.ts';
import { createJavaResolver } from '../resolver/java.ts';
import { createGoResolver } from '../resolver/go.ts';
import { createRustResolver } from '../resolver/rust.ts';
import { createCppResolver } from '../resolver/cpp.ts';
import { createCSharpResolver } from '../resolver/csharp.ts';

const DEFS: LanguageDef[] = [
  { id: 'python', extensions: ['.py'], resolver: createPythonResolver() },
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.es6'],
    wasmByExt: { '.jsx': 'tsx.wasm' },
    resolver: createJsTsResolver() },
  { id: 'typescript', extensions: ['.ts', '.tsx', '.mts', '.cts'],
    wasmByExt: { '.tsx': 'tsx.wasm' },
    resolver: createJsTsResolver() },
  { id: 'java', extensions: ['.java'], resolver: createJavaResolver() },
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.cxx'],
    wasmByExt: { '.c': 'c.wasm', '.h': 'c.wasm' },
    queryByExt: { '.c': 'c.scm', '.h': 'c.scm' },
    resolver: createCppResolver() },
  { id: 'csharp', extensions: ['.cs'], resolver: createCSharpResolver() },
  { id: 'go', extensions: ['.go'], resolver: createGoResolver() },
  { id: 'rust', extensions: ['.rs'], resolver: createRustResolver() },
];

export function createRegistry(): LanguageRegistry {
  const reg = new LanguageRegistry();
  for (const def of DEFS) {
    reg.register(buildLanguage(def));
  }
  return reg;
}
