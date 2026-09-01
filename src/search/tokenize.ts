export function splitIdentifier(ident: string): string[] {
  if (!ident) return [];
  let normalized = ident
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // acronyms: XMLParser -> XML Parser
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/[.:/\s]+/g, ' ')
    .trim();
  const tokens = normalized.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens;
}

export function normalizeIdent(text: string): string {
  return splitIdentifier(text).join(' ');
}

export function escapeFtsToken(token: string): string {
  // Escape FTS5 special characters so a user query can't break the MATCH grammar.
  return token.replace(/("|\\|[():\^*+-])/g, ' ');
}
