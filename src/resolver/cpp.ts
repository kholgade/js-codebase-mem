import type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext } from './interface.ts';

/**
 * C/C++ resolver.
 *
 * Handles:
 * - `#include "foo.h"` and `#include <foo.h>` — header includes
 * - `using namespace std;` — namespace imports
 * - `obj.method()` — member access
 * - `::` scoped references
 */
export class CppResolver implements Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined {
    // Member access: obj.method()
    if (node.type === 'field_expression') {
      const field = node.child('field');
      if (field) {
        return { kind: 'reference', qualified: field.text };
      }
    }

    // Scoped reference: ns::function or Class::method
    if (node.type === 'qualified_identifier') {
      const last = node.text.split('::').pop() ?? '';
      if (last) return { kind: 'reference', qualified: last };
    }

    // Call expression
    if (node.type === 'call_expression') {
      const fn = node.namedChildren[0];
      if (fn) {
        return this.resolveIdentifier(fn.text, scope);
      }
    }

    // Identifier reference
    if (node.type === 'identifier' || node.type === 'field_identifier') {
      return this.resolveIdentifier(node.text, scope);
    }

    return undefined;
  }

  private resolveIdentifier(name: string, scope: ResolutionScope): Resolved | undefined {
    const local = scope.symbols.get(name);
    if (local) return { kind: 'exact', qualified: local };

    for (const imp of scope.imports) {
      if (imp.local === name) return { kind: 'reference', qualified: imp.source };
    }

    return undefined;
  }
}

export function createCppResolver(): Resolver {
  return new CppResolver();
}
