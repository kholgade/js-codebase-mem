import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import type { LanguagePlugin, FileContext, Emit, Resolver, Resolved, ResolutionScope } from './contract.ts';

export interface LanguageDef {
  id: string;
  extensions: string[];
  /** optional per-extension wasm override (e.g. tsx for .tsx) */
  wasmByExt?: Record<string, string>;
  /** optional resolver (deep type resolution) */
  resolver?: Resolver;
  /** override contextualization */
  contextualize?: (ctx: FileContext, emits: Emit[]) => Emit[];
}

/** Resolve a WASM grammar path shipped in the package under grammars/<id>.wasm. */
function grammarPath(name: string): string {
  const here = fileURLToPath(new URL('../', import.meta.url));
  return pathToFileURL(`${here}/../grammars/${name}`).href;
}

const defaultContextualize = (ctx: FileContext, emits: Emit[]): Emit[] => {
  return emits.map((e) => {
    if (e.kind === 'define' && e.name && !e.qualified) {
      return { ...e, qualified: `${ctx.moduleSpec}.${e.name}` };
    }
    return e;
  });
};

const passthrough: Resolver = {
  resolve(_node: any, _scope: ResolutionScope, _ctx: FileContext): Resolved | undefined {
    return undefined;
  },
};

export function buildLanguage(def: LanguageDef): LanguagePlugin {
  const resolver: Resolver = def.resolver ?? passthrough;
  const defaultWasm = `${def.id}.wasm`;
  const wasmByExt = def.wasmByExt ?? {};
  return {
    id: def.id,
    extensions: def.extensions,
    wasmPath: grammarPath(defaultWasm),
    query: grammarPath(`${def.id}.scm`),
    wasmByExt: Object.fromEntries(
      Object.entries(wasmByExt).map(([ext, name]) => [ext, grammarPath(name)]),
    ),
    contextualize: def.contextualize ?? defaultContextualize,
    resolver,
  };
}
