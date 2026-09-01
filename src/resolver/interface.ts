import type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext } from '../languages/contract.ts';

export type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext };

/**
 * Build a ResolutionScope from a file's imports and locally defined symbols.
 */
export function buildScope(
  filePath: string,
  imports: ResolutionScope['imports'],
  localSymbols: Map<string, string>,
): ResolutionScope {
  return {
    imports,
    filePath,
    symbols: localSymbols,
  };
}

/**
 * Default resolution that falls back to exact match on local symbols,
 * or returns undefined if no match found.
 */
export function resolveByIdentifier(
  name: string,
  scope: ResolutionScope,
): Resolved | undefined {
  // Exact local match
  const local = scope.symbols.get(name);
  if (local) return { kind: 'exact', qualified: local };

  // Try each import's local binding
  for (const imp of scope.imports) {
    if (imp.local === name) {
      return { kind: 'reference', qualified: imp.source };
    }
  }

  return undefined;
}

/**
 * Combine multiple resolvers into one, trying each in order.
 * Returns the first non-undefined result.
 */
export function composeResolvers(resolvers: Resolver[]): Resolver {
  return {
    resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined {
      for (const r of resolvers) {
        const result = r.resolve(node, scope, ctx);
        if (result) return result;
      }
      return undefined;
    },
  };
}
