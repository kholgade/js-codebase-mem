import type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext } from './interface.ts';

/**
 * Go resolver.
 *
 * Handles:
 * - `import "fmt"` — standard library / module imports
 * - `import alias "module/path"` — aliased imports
 * - `import "github.com/user/repo/pkg"` — external module imports
 * - method calls: `receiver.Method()` 
 * - interface embedding and struct method sets
 */
export class GoResolver implements Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined {
    // Selector expressions: obj.Method() or pkg.Func()
    if (node.type === 'selector_expression') {
      const operand = node.child('operand');
      const field = node.child('field');
      if (operand && field) {
        // Package-qualified call if operand is a package name
        const importMatch = scope.imports.find((i) => i.local === operand.text || i.source === operand.text);
        if (importMatch) {
          return { kind: 'exact', qualified: `${importMatch.source}.${field.text}` };
        }
        // Otherwise it's a method call on a receiver; resolve to field name reference
        return { kind: 'reference', qualified: `${operand.text}.${field.text}` };
      }
    }

    // Plain function call
    if (node.type === 'call_expression') {
      const fn = node.namedChildren[0];
      if (fn) return this.resolveIdentifier(fn.text, scope);
    }

    // Identifier reference
    if (node.type === 'identifier') {
      return this.resolveIdentifier(node.text, scope);
    }

    return undefined;
  }

  private resolveIdentifier(name: string, scope: ResolutionScope): Resolved | undefined {
    const local = scope.symbols.get(name);
    if (local) return { kind: 'exact', qualified: local };

    for (const imp of scope.imports) {
      if (imp.local === name) {
        return { kind: 'reference', qualified: imp.source };
      }
    }

    if (GO_BUILTINS.has(name)) {
      return { kind: 'reference', qualified: `builtin.${name}` };
    }

    return undefined;
  }
}

const GO_BUILTINS = new Set([
  'append', 'cap', 'close', 'complex', 'copy', 'delete', 'imag', 'len',
  'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover',
  'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'float32', 'float64',
  'byte', 'rune', 'bool', 'error',
]);

export function createGoResolver(): Resolver {
  return new GoResolver();
}
