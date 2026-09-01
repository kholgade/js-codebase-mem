import { Parser, Language } from 'web-tree-sitter';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { LanguagePlugin } from '../languages/contract.ts';

let initialized = false;

/** Initialize the shared web-tree-sitter runtime (call once). */
export async function initRuntime(): Promise<void> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
}

const langCache = new Map<string, Language>();

/** Load + cache a language's WASM grammar by filesystem path (or URL string). */
export async function loadLanguage(wasmPath: string): Promise<Language> {
  const cached = langCache.get(wasmPath);
  if (cached) return cached;
  await initRuntime();
  const url = new URL(wasmPath, import.meta.url);
  const bytes = await readFile(url);
  const lang = await Language.load(new Uint8Array(bytes));
  langCache.set(wasmPath, lang);
  return lang;
}

/** A minimal pool: one Parser per (plugin,wasm) pair, reused across files. */
export class ParserPool {
  private parsers = new Map<string, Parser>();

  async parserFor(plugin: LanguagePlugin, filePath?: string): Promise<Parser> {
    const ext = filePath ? extname(filePath) : '';
    const wasmPath = (ext && plugin.wasmByExt?.[ext]) ?? plugin.wasmPath;
    const key = `${plugin.id}:${wasmPath}`;
    const existing = this.parsers.get(key);
    if (existing) return existing;
    const lang = await loadLanguage(wasmPath);
    const parser = new Parser();
    parser.setLanguage(lang);
    this.parsers.set(key, parser);
    return parser;
  }
}

export type { Parser, Language };
