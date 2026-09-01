import type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext } from './interface.ts';

/**
 * Java resolver.
 *
 * Handles:
 * - `import com.foo.Bar;` — fully-qualified class imports
 * - `import com.foo.*;` — wildcard imports
 * - `import static com.foo.Util.method;` — static imports
 * - `this.method()`, `obj.method()` — member calls
 */
export class JavaResolver implements Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined {
    // Method invocation: obj.method() or method()
    if (node.type === 'method_invocation') {
      const name = node.child('name') ?? node.namedChildren[0];
      if (name) {
        return this.resolveIdentifier(name.text, scope);
      }
    }

    // Method declaration reference
    if (node.type === 'identifier') {
      return this.resolveIdentifier(node.text, scope);
    }

    // Variable/field reference
    if (node.type === 'this') {
      return { kind: 'reference', qualified: 'this' };
    }

    return undefined;
  }

  private resolveIdentifier(name: string, scope: ResolutionScope): Resolved | undefined {
    // Check local symbols
    const local = scope.symbols.get(name);
    if (local) return { kind: 'exact', qualified: local };

    // Check imports: exact match and wildcard
    for (const imp of scope.imports) {
      const src = imp.source;
      if (src === name) return { kind: 'exact', qualified: src };
      if (src.endsWith('.*')) {
        const base = src.slice(0, -2);
        // Wildcard: could be any class in the package
        return { kind: 'reference', qualified: `${base}.${name}` };
      }
      const lastSeg = src.split('.').pop() ?? '';
      if (lastSeg === name) {
        return { kind: 'exact', qualified: src };
      }
    }

    // Java builtins (java.lang is auto-imported)
    if (JAVA_LANG.has(name)) {
      return { kind: 'reference', qualified: `java.lang.${name}` };
    }

    return undefined;
  }
}

const JAVA_LANG = new Set([
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character', 'Byte',
  'Short', 'Object', 'System', 'Math', 'Exception', 'RuntimeException', 'Error',
  'Throwable', 'Class', 'Thread', 'ThreadLocal',
]);

export function createJavaResolver(): Resolver {
  return new JavaResolver();
}
