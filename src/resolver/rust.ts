import type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext } from './interface.ts';

/**
 * Rust resolver.
 *
 * Handles:
 * - `use std::collections::HashMap;` — module paths
 * - `use crate::foo::Bar;` — crate-relative paths
 * - `use crate::foo::*;` — glob imports
 * - `self.method()`, `obj.method()` — method calls
 */
export class RustResolver implements Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined {
    // Method call: self.method() or obj.method()
    if (node.type === 'call_expression') {
      const fn = node.child('function') ?? node.namedChildren[0];
      if (fn) {
        if (fn.type === 'field_expression') {
          const obj = fn.child('value');
          const field = fn.child('field');
          if (obj && field) {
            if (obj.text === 'self' || obj.text === 'Self') {
              return { kind: 'reference', qualified: field.text };
            }
            return { kind: 'usage', qualified: `${obj.text}.${field.text}` };
          }
        }
        if (fn.type === 'identifier') {
          return this.resolveIdentifier(fn.text, scope);
        }
      }
    }

    // Identifier reference
    if (node.type === 'identifier' || node.type === 'type_identifier') {
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
      // Handle glob imports: use::foo::* brings in all public items
      const src = imp.source;
      if (src.endsWith('::*')) {
        const base = src.slice(0, -3);
        return { kind: 'reference', qualified: `${base}::${name}` };
      }
      const lastSeg = src.split('::').pop() ?? '';
      if (lastSeg === name) {
        return { kind: 'exact', qualified: src };
      }
    }

    if (RUST_PRELUDE.has(name)) {
      return { kind: 'reference', qualified: `std.${name}` };
    }

    return undefined;
  }
}

const RUST_PRELUDE = new Set([
  'String', 'Vec', 'Option', 'Some', 'None', 'Result', 'Ok', 'Err', 'Box',
  'Rc', 'Arc', 'RefCell', 'Clone', 'Copy', 'Debug', 'Display', 'Drop', 'Default',
  'Iterator', 'IteratorExt', 'Into', 'From', 'AsRef', 'AsMut', 'ToOwned',
  'ToString', 'vec', 'format', 'print', 'println', 'eprintln', 'panic', 'assert', 'assert_eq',
]);

export function createRustResolver(): Resolver {
  return new RustResolver();
}
