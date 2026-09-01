export type NodeLabel =
  | 'Project' | 'Package' | 'Folder' | 'File' | 'Module'
  | 'Class' | 'Function' | 'Method' | 'Interface' | 'Enum' | 'Type'
  | 'Route' | 'Resource';

export type EdgeType =
  | 'CONTAINS_PACKAGE' | 'CONTAINS_FOLDER' | 'CONTAINS_FILE'
  | 'DEFINES' | 'DEFINES_METHOD' | 'IMPORTS'
  | 'CALLS' | 'CALL_REFERENCE' | 'USAGE'
  | 'HTTP_CALLS' | 'ASYNC_CALLS' | 'IMPLEMENTS' | 'INHERITS'
  | 'HANDLES' | 'CONFIGURES' | 'WRITES' | 'MEMBER_OF' | 'TESTS'
  | 'USES_TYPE' | 'FILE_CHANGES_WITH' | 'EMITS' | 'LISTENS_ON'
  | 'DATA_FLOWS' | 'SIMILAR_TO' | 'SEMANTICALLY_RELATED';

export type Confidence = 'exact' | 'reference' | 'usage';

export interface Position { line: number; col: number; }
export interface Range { start: Position; end: Position; }

export interface Emit {
  kind: 'define' | 'call' | 'import' | 'http-route' | 'inherit';
  name?: string;
  qualified?: string;
  label?: NodeLabel;
  targetName?: string;
  targetQualified?: string;
  confidence?: Confidence;
  source?: string;
  method?: string;
  path?: string;
  handler?: string;
  base?: string;
  range: Range;
  signature?: string;
  doc?: string;
}
