import type { Node, QueryMatch } from 'web-tree-sitter';
import type { Emit, NodeLabel, Range } from '../core/types.ts';

export type { Emit, NodeLabel, Range, QueryMatch };
export type { Node };

/** Minimal structural contract for a syntax node handed to resolvers/contextualizers. */
export interface SyntaxNodeLike {
  readonly text: string;
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  child(fieldName: string): SyntaxNodeLike | null;
  childForFieldName(fieldName: string): SyntaxNodeLike | null;
  namedChildren: readonly SyntaxNodeLike[];
  parent: SyntaxNodeLike | null;
}

export interface FileContext {
  path: string;
  language: LanguagePlugin;
  moduleSpec: string;
  imports: ImportRecord[];
  source: string;
}

export interface ImportRecord {
  source: string;      // resolved specifier or file path
  local?: string;      // local binding if any
  raw: string;
}

/**
 * The extension point. A new language = implement this interface + register it.
 * Schema, query engine, MCP tools, and indexer never change.
 */
export interface LanguagePlugin {
  readonly id: string;
  readonly extensions: string[];
  readonly wasmPath: string;
  /** optional per-extension wasm override (e.g. tsx for .tsx) */
  readonly wasmByExt?: Record<string, string>;
  /** tree-sitter .scm query source mapping AST node kinds -> captures. */
  readonly query: string;
  /** Attribute emitted facts (qualified names, module/package scope). */
  contextualize(ctx: FileContext, emits: Emit[]): Emit[];
  /** Optional deep type resolution tier. Absent => syntactic-only fallback. */
  readonly resolver?: Resolver;
}

export interface Resolved {
  kind: 'exact' | 'reference' | 'usage';
  qualified?: string;
}

export interface ResolutionScope {
  imports: ImportRecord[];
  filePath: string;
  symbols: Map<string, string>;   // local name -> qualified
}

export interface Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined;
}

export class LanguageRegistry {
  private byExt = new Map<string, LanguagePlugin>();
  private list: LanguagePlugin[] = [];

  register(p: LanguagePlugin): void {
    this.list.push(p);
    for (const ext of p.extensions) {
      this.byExt.set(ext, p); // longest-suffix lookup happens in forPath
    }
  }

  forPath(path: string): LanguagePlugin | undefined {
    let best: LanguagePlugin | undefined;
    let bestLen = -1;
    for (const [ext, plugin] of this.byExt) {
      if (path.endsWith(ext) && ext.length > bestLen) {
        best = plugin;
        bestLen = ext.length;
      }
    }
    return best;
  }

  get(id: string): LanguagePlugin | undefined {
    return this.list.find((p) => p.id === id);
  }

  all(): LanguagePlugin[] {
    return [...this.list];
  }

  get count(): number {
    return this.list.length;
  }
}
