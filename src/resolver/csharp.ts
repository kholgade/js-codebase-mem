import type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext } from './interface.ts';

/**
 * C# resolver.
 *
 * Handles:
 * - `using Foo.Bar;` — namespace imports
 * - `using Alias = Foo.Bar;` — aliased imports
 * - `using static Foo.Util;` — static imports
 * - `obj.Method()` — member access
 * - Fully-qualified `System.Console.WriteLine` references
 */
export class CSharpResolver implements Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined {
    // Member access: obj.Method() or Namespace.Class.Method()
    if (node.type === 'member_access_expression') {
      const name = node.child('name') ?? node.namedChildren[0];
      if (name) return { kind: 'reference', qualified: name.text };
    }

    // Invocation expression: Method() or obj.Method()
    if (node.type === 'invocation_expression') {
      const fn = node.namedChildren[0];
      if (fn) {
        return this.resolveIdentifier(fn.text, scope);
      }
    }

    // Identifier reference
    if (node.type === 'identifier' || node.type === 'qualified_name') {
      return this.resolveIdentifier(node.text, scope);
    }

    return undefined;
  }

  private resolveIdentifier(name: string, scope: ResolutionScope): Resolved | undefined {
    const local = scope.symbols.get(name);
    if (local) return { kind: 'exact', qualified: local };

    for (const imp of scope.imports) {
      const src = imp.source;
      if (imp.local === name) return { kind: 'reference', qualified: src };
      if (src === name) return { kind: 'exact', qualified: src };
      const lastSeg = src.split('.').pop() ?? '';
      if (lastSeg === name) return { kind: 'exact', qualified: src };
    }

    if (CSHARP_BUILTINS.has(name)) {
      return { kind: 'reference', qualified: `System.${name}` };
    }

    return undefined;
  }
}

const CSHARP_BUILTINS = new Set([
  'String', 'Console', 'Math', 'Exception', 'Object', 'Int32', 'Int64', 'Double',
  'Single', 'Decimal', 'Boolean', 'Char', 'Byte', 'DateTime', 'TimeSpan',
  'Array', 'List', 'Dictionary', 'Action', 'Func', 'Task', 'System',
]);

export function createCSharpResolver(): Resolver {
  return new CSharpResolver();
}
