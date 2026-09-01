import type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext } from './interface.ts';

/**
 * Python resolver.
 *
 * Handles:
 * - `import foo.bar` — module bindings
 * - `from foo import bar as baz` — named imports with optional alias
 * - `self.method()` calls — resolve to class methods
 * - Relative imports (`.module`, `..module`)
 */
export class PythonResolver implements Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined {
    // Handle attribute calls (self.method(), obj.method())
    if (node.type === 'call' || node.type === 'call_expression') {
      const fn = node.child('function') ?? node.child('func') ?? node.namedChildren[0];
      if (fn) {
        if (fn.type === 'identifier') {
          return this.resolveIdentifier(fn.text, scope);
        }
        if (fn.type === 'attribute') {
          // obj.method() or self.method()
          const obj = fn.child('object') ?? fn.namedChildren[0];
          const attr = fn.child('attribute');
          if (obj && attr) {
            if (obj.text === 'self') {
              // self.method() -> resolve to a method on the enclosing class
              return { kind: 'reference', qualified: attr.text };
            }
            return { kind: 'usage', qualified: `${obj.text}.${attr.text}` };
          }
        }
      }
    }

    // Handle identifier references
    if (node.type === 'identifier') {
      return this.resolveIdentifier(node.text, scope);
    }

    return undefined;
  }

  private resolveIdentifier(name: string, scope: ResolutionScope): Resolved | undefined {
    // Check local symbols
    const local = scope.symbols.get(name);
    if (local) return { kind: 'exact', qualified: local };

    // Check imports
    for (const imp of scope.imports) {
      if (imp.local === name) {
        return { kind: 'reference', qualified: imp.source };
      }
    }

    // Python builtins
    if (PYTHON_BUILTINS.has(name)) {
      return { kind: 'reference', qualified: `builtins.${name}` };
    }

    return undefined;
  }
}

const PYTHON_BUILTINS = new Set([
  'print', 'len', 'range', 'map', 'filter', 'zip', 'enumerate', 'sorted', 'sum',
  'min', 'max', 'abs', 'round', 'str', 'int', 'float', 'bool', 'list', 'dict',
  'tuple', 'set', 'object', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'dir', 'super', 'property', 'classmethod', 'staticmethod', 'open',
  'ValueError', 'TypeError', 'KeyError', 'IndexError', 'Exception', 'RuntimeError',
]);

export function createPythonResolver(): Resolver {
  return new PythonResolver();
}
