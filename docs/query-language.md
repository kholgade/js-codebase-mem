# Query language

`js-codebase-mem`'s `query_graph` tool accepts a **subset** of the Cypher
(openCypher) query language, implemented in `src/query/tools.ts#queryGraph`. The
parser is deliberately minimal and regex-based: it splits a query into clauses
(`MATCH`, `OPTIONAL MATCH`, `UNWIND`, `WITH`, `WHERE`, `RETURN`, `LIMIT`) and
translates patterns into SQL joins over the `nodes`/`edges` tables.

This document describes exactly what is supported and how it behaves.

## Supported clauses

- `MATCH` — required; at least one pattern must parse.
- `OPTIONAL MATCH` — a pattern whose join is a `LEFT JOIN` (missing matches
  yield `NULL` columns rather than dropping the row).
- `WHERE` — conditions combined with `AND`.
- `RETURN` — select columns, with optional aggregation.
- `LIMIT` — integer row cap (default 50 if omitted).
- `UNWIND` / `WITH` — **parsed** (recognized as clause boundaries) but not
  otherwise acted upon. Uppercase `WITH`/`UNWIND` keywords are used to split
  clauses during parsing; they have no functional effect on the generated SQL.

## Patterns

Two-node and single-node patterns are supported.

### Basic relationship

```
MATCH (a:Class)-[:INHERITS]->(b:Class) RETURN a.name
```

- Node syntax: `(alias)` or `(alias:Label)`.
- Edge syntax: `-[:TYPE]->` or a bare `-->` (untyped).
- Node labels and edge types map to the `label` and `type` columns of `nodes`
  and `edges` (see the label/edge tables below).

### Variable-length paths

```
MATCH (a:Function)-[:CALLS*1..3]->(b:Function) RETURN b.name
```

- `-[:TYPE*1..3]->` traverses edges of `TYPE` with depth between 1 and 3
  (inclusive). Implemented via a recursive CTE.
- `-[:TYPE*]->` (bare star) is also accepted; the depth range defaults to
  `1..1`.
- A trailing node label may be supplied to constrain the target, e.g.
  `(a)-[:CALLS*1..2]->(b:Function)`.

### Single node

`MATCH (n:Class) RETURN n.name` returns all nodes with label `Class`.

## WHERE operators

Conditions take the form `alias.prop OP 'value'` and are combined with `AND`.

| Operator | Behavior |
|----------|----------|
| `=` | Exact equality against the column. |
| `LIKE` | Substring match (becomes `%value%`). |
| `CONTAINS` | Substring match (becomes `%value%`, same as `LIKE` here). |
| `STARTS WITH` | Prefix match (becomes `value%`). |
| `ENDS WITH` | Suffix match (becomes `%value`). |

Supported columns in `WHERE` are mapped by name: `name`, `qualified`, `label`,
or any other property passed through verbatim (e.g. `n.file`).

> Note: values must be single-quoted `'...'`. Only one `AND` group per `WHERE`
> clause is parsed; the pattern `alias.prop OP 'value'` must match exactly.
> `OR` is not supported.

## RETURN and projections

- `RETURN alias.prop` selects a property from a node variable, e.g.
  `RETURN n.name`, `RETURN b.qualified`.
- A bare `RETURN prop` selects that property from the first pattern node.
- Without an explicit `RETURN`, columns default to `name` and `label`.

### Aggregations

| Function | SQL mapping | Example |
|----------|-------------|---------|
| `COUNT` | `COUNT(*)` or `COUNT(col)` | `COUNT(n)` / `COUNT(n.name)` / `COUNT(*)` |
| `COLLECT` | `GROUP_CONCAT` (comma-joined) | `COLLECT(n.name)` |
| `SUM` | `SUM(col)` | `SUM(n.x)` |
| `MIN` | `MIN(col)` | `MIN(n.x)` |
| `MAX` | `MAX(col)` | `MAX(n.x)` |

Aggregated columns may be aliased with `AS`, e.g.
`RETURN COUNT(*) AS total`. When any aggregation is present, `DISTINCT` is
dropped from the generated `SELECT` and rows are no longer de-duplicated.

## Node labels

Node labels come from the `NodeLabel` union in `src/core/types.ts`:

```
Project  Package  Folder  File  Module
Class  Function  Method  Interface  Enum  Type
Route  Resource
```

The labels then are produced by the language grammars; the most common in a
typical index are `Function`, `Class`, `Method`, `Interface`, `Enum`, `Type`,
`Module`, `File`, and `Route`.

## Edge types

Edge types come from the `EdgeType` union in `src/core/types.ts`:

```
CONTAINS_PACKAGE  CONTAINS_FOLDER  CONTAINS_FILE
DEFINES  DEFINES_METHOD  IMPORTS
CALLS  CALL_REFERENCE  USAGE
HTTP_CALLS  ASYNC_CALLS  IMPLEMENTS  INHERITS
HANDLES  CONFIGURES  WRITES  MEMBER_OF  TESTS
USES_TYPE  FILE_CHANGES_WITH  EMITS  LISTENS_ON
DATA_FLOWS  SIMILAR_TO  SEMANTICALLY_RELATED
```

The indexer currently emits a concrete subset: `DEFINES`, `CALLS`, `IMPORTS`,
`INHERITS`, `HANDLES`, `CALL_REFERENCE` (and `Route` nodes). Other edge types
are reserved by the schema for future/consumer-produced data.

## Examples

```cypher
-- All classes
MATCH (n:Class) RETURN n.name, n.qualified

-- Functions that call 'foo' (two hops out)
MATCH (a:Function)-[:CALLS*1..2]->(b:Function) WHERE b.name = 'foo' RETURN a.name

-- Packages/files that define things in a given module
MATCH (f:File)-[:DEFINES]->(n) WHERE f.file CONTAINS 'controllers' RETURN n.name

-- Count functions per file
MATCH (f:File)-[:DEFINES]->(n:Function) RETURN f.file, COUNT(n) AS funcs

-- Optional match: files and the routes they handle (NULL when none)
OPTIONAL MATCH (f:File)-[:HANDLES]->(r:Route) RETURN f.name, r.name

-- Inheritance hierarchy
MATCH (c:Class)-[:INHERITS*1..3]->(b:Class) RETURN c.name, b.name

-- All edges out of a single node (untyped)
MATCH (n:Function)-[]->(m) WHERE n.name = 'bootstrap' RETURN n.name, m.name
```

## Limitations / caveats

- The parser is regex-based and case-insensitive for clause keywords. Complex,
  multi-edge, multi-clause, or deeply nested Cypher is **not** supported.
- Only `AND` is supported in `WHERE`; no `OR`, no `NOT`, no parameterized
  values, no functions other than the aggregations above.
- `UNWIND` and `WITH` are parsed as boundaries only — they have no functional
  effect.
- Single-hop explicit patterns join on one edge per node pair; a node with
  several matching edges will produce one result row (the generated join uses
  `LIMIT 1` per edge lookup for standard patterns).
- Values must be enclosed in single quotes; unquoted or double-quoted values
  are not parsed.
