import type { Emit, Range, NodeLabel } from './contract.ts';
import type { QueryMatch, Node } from './contract.ts';

/** Map a tree-sitter node to our Position-based Range. */
export function toRange(node: { startPosition: any; endPosition: any } | undefined): Range {
  if (!node) return { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } };
  return {
    start: { line: node.startPosition.row, col: node.startPosition.column },
    end: { line: node.endPosition.row, col: node.endPosition.column },
  };
}

/** Classify a captured define node into a graph label from its node type + parent context. */
export function labelForNode(node: Node): NodeLabel {
  const t = node.type;
  const parentType = node.parent?.type;
  if (t === 'class_definition' || t === 'class_declaration' || t === 'class_specifier' || t === 'class' && parentType === 'class_body') {
    return 'Class';
  }
  if (t === 'interface_declaration') return 'Interface';
  if (t === 'enum_declaration' || t === 'enum_specifier' || t === 'enum_definition') return 'Enum';
  if (t === 'type_alias_declaration' || t === 'type_alias' || t === 'typedef') return 'Type';
  if (t === 'module' || t === 'namespace_definition' || t === 'namespace') return 'Module';
  // methods: function inside a class body
  const isMethod =
    t === 'function_definition' || t === 'method_definition' || t === 'function_declaration' ||
    t.startsWith('method') || parentType === 'class_body' || parentType === 'declaration_list';
  if (isMethod) {
    let n: Node | null = node;
    while (n) {
      if (n.type === 'class_definition' || n.type === 'class_declaration' || n.type === 'class_specifier' || n.type === 'class') return 'Method';
      n = n.parent;
    }
    return 'Function';
  }
  return 'Function';
}

/**
 * Convert raw query matches into Emits.
 *
 * Capture conventions:
 *   @define   full defining node (function/class/method/...); label derived from node
 *   @name     the name identifier
 *   @sig      (optional) signature text
 *   @doc      (optional) doc text
 *   @call.target            -> call
 *   @import.source          -> import
 *   @inherit.base           -> inherit
 *   @route.method @route.path @route.handler -> http-route
 *   @enum.member            -> a define.Enum? (handled per-language)
 */
export function emitsFromQuery(matches: QueryMatch[]): Emit[] {
  const out: Emit[] = [];
  const routeSeen = new Set<string>();
  for (const m of matches) {
    const isRoute = m.captures.some((c) => c.name === 'route.path');
    if (isRoute) {
      const method = get(m, 'route.method') ?? 'GET';
      const path = get(m, 'route.path');
      const handler = get(m, 'route.handler');
      if (path) {
        const key = `${method} ${path} ${handler ?? ''}`;
        if (!routeSeen.has(key)) {
          routeSeen.add(key);
          out.push({ kind: 'http-route', method, path, handler, range: toRange(m.captures[0]?.node) });
        }
      }
      continue;
    }

    const define = m.captures.find((c) => c.name === 'define');
    if (define) {
      const name = get(m, 'name') ?? define.node.text;
      out.push({
        kind: 'define',
        name,
        label: labelForNode(define.node),
        range: toRange(define.node),
        signature: get(m, 'sig'),
        doc: get(m, 'doc'),
      });
      continue;
    }

    for (const cap of m.captures) {
      const text = cap.node.text;
      if (cap.name === 'call.target') {
        out.push({ kind: 'call', targetName: text, confidence: 'usage', range: toRange(cap.node) });
      } else if (cap.name === 'import.source') {
        out.push({ kind: 'import', source: text, range: toRange(cap.node) });
      } else if (cap.name === 'inherit.base') {
        out.push({ kind: 'inherit', base: text, range: toRange(cap.node) });
      } else if (cap.name === 'iface.base' || cap.name === 'impl.type') {
        out.push({ kind: 'inherit', base: text, range: toRange(cap.node) });
      }
    }
  }
  return out;
}

function get(m: QueryMatch, name: string): string | undefined {
  return m.captures.find((c) => c.name === name)?.node.text;
}

export { get as getCapture };
