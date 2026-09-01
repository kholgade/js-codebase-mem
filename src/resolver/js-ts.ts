import type { Resolver, Resolved, ResolutionScope, SyntaxNodeLike, FileContext } from './interface.ts';
import { buildScopeTree } from './scope.ts';

/**
 * JavaScript/TypeScript resolver.
 *
 * Handles:
 * - ES module imports (named, default, namespace)
 * - CommonJS require
 * - Relative imports resolved against the file path
 * - Local function/class/variable scope resolution
 * - Member expressions (obj.method() -> class method)
 */
export class JsTsResolver implements Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined {
    // Handle member expressions: return the property name if it looks like a method
    if (node.type === 'call_expression') {
      const fn = node.child('function');
      if (fn) {
        if (fn.type === 'identifier') {
          return this.resolveIdentifier(fn.text, scope);
        }
        if (fn.type === 'member_expression') {
          const prop = fn.child('property');
          if (prop) {
            // Return the property as a reference (best-effort without type info)
            return { kind: 'reference', qualified: prop.text };
          }
        }
      }
    }

    // Handle identifier references
    if (node.type === 'identifier' || node.type === 'property_identifier') {
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
        return { kind: 'reference', qualified: this.resolveImportPath(imp.source, scope.filePath) };
      }
    }

    // Maybe it's a global (React, Node builtins, etc)
    if (isGloballyAvailable(name)) {
      return { kind: 'reference', qualified: name };
    }

    return undefined;
  }

  private resolveImportPath(source: string, filePath: string): string {
    // Strip file extension and normalize to a qualified name
    const normalized = source
      .replace(/^\.\//, '')
      .replace(/^\.\.\//, '')
      .replace(/\.[a-zA-Z0-9]+$/, '')
      .replace(/\//g, '.');
    if (normalized.startsWith('.') || normalized.startsWith('..')) {
      // Relative import; resolve against file path
      return `${scopeQualify(filePath)}.${normalized}`;
    }
    // Package or alias import
    return normalized;
  }
}

function scopeQualify(filePath: string): string {
  // 'src/foo.ts' -> 'src.foo'
  return filePath.replace(/\.[a-zA-Z0-9]+$/, '').replace(/[/\\]/g, '.');
}

// Common globals available without import
const GLOBALS = new Set([
  'console', 'process', 'Buffer', 'require', 'module', 'exports', 'Promise',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Map', 'Set', 'JSON', 'Math',
  'Date', 'RegExp', 'Error', 'Symbol', 'Proxy', 'Reflect', 'globalThis',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'URL', 'URLSearchParams', 'Request', 'Response', 'Headers',
]);

function isGloballyAvailable(name: string): boolean {
  return GLOBALS.has(name);
}

export function createJsTsResolver(): Resolver {
  return new JsTsResolver();
}
