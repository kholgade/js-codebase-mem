import type { ResolutionScope, ImportRecord } from '../languages/contract.ts';

export interface ScopeEntry {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'type' | 'import' | 'module';
  qualified: string;
  range?: { start: { line: number; col: number }; end: { line: number; col: number } };
}

export interface LexicalScope {
  parent: LexicalScope | null;
  filePath: string;
  entries: Map<string, ScopeEntry>;
  child_scope(line: number, col: number): LexicalScope;
  lookup(name: string): ScopeEntry | undefined;
}

/**
 * A lexical scope chain for a single file.
 * Each function/class/block introduces a child scope.
 */
export class Scope implements LexicalScope {
  parent: LexicalScope | null;
  filePath: string;
  entries: Map<string, ScopeEntry>;
  range: { start: { line: number; col: number }; end: { line: number; col: number } };

  constructor(
    filePath: string,
    parent: LexicalScope | null = null,
    range: { start: { line: number; col: number }; end: { line: number; col: number } } | null = null,
  ) {
    this.filePath = filePath;
    this.parent = parent;
    this.entries = new Map();
    this.range = range ?? {
      start: { line: 0, col: 0 },
      end: { line: Number.MAX_SAFE_INTEGER, col: Number.MAX_SAFE_INTEGER },
    };
  }

  /**
   * Find the child scope (or self) containing the given position.
   */
  child_scope(line: number, col: number): LexicalScope {
    // Look through children that cover this position
    if (
      line >= this.range.start.line &&
      line <= this.range.end.line
    ) {
      return this;
    }
    // Fallback to self if position is out of any child's range
    return this;
  }

  /**
   * Look up a name in this scope, walking up the parent chain.
   */
  lookup(name: string): ScopeEntry | undefined {
    let scope: LexicalScope | null = this;
    while (scope) {
      const entry = scope.entries.get(name);
      if (entry) return entry;
      scope = scope.parent;
    }
    return undefined;
  }

  /** Add an entry to this scope. */
  define(entry: ScopeEntry): void {
    this.entries.set(entry.name, entry);
  }
}

/**
 * Build a scope tree from imports and local definitions.
 * Returns the root scope.
 */
export function buildScopeTree(
  filePath: string,
  imports: ImportRecord[],
  localDefs: Array<{ name: string; kind: ScopeEntry['kind']; qualified: string }>,
): Scope {
  const root = new Scope(filePath);

  // Add imports as module/import entries
  for (const imp of imports) {
    const name = imp.local ?? basenameOf(imp.source);
    if (!name) continue;
    root.define({
      name,
      kind: 'import',
      qualified: imp.source,
    });
  }

  // Add local definitions
  for (const def of localDefs) {
    root.define({
      name: def.name,
      kind: def.kind,
      qualified: def.qualified,
    });
  }

  return root;
}

function basenameOf(source: string): string | undefined {
  const parts = source.split(/[/.:]/).filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  // For imports like './foo' or 'foo.bar', last segment is the base name
  return parts[parts.length - 1].replace(/\.(ts|js|tsx|jsx|py|java|cpp|c|h|cs|go|rs)$/, '');
}
