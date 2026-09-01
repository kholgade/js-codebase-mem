# Language support

`js-codebase-mem` supports **8 languages**, each driven by a tree-sitter WASM
grammar and a `.scm` query file. Support is pluggable: adding a language is a
matter of implementing the `LanguagePlugin` contract and registering it — no
changes to the schema, query engine, MCP tools, or indexer.

## Supported languages

Registered in `src/languages/index.ts`:

| id | Extensions | Grammar `.wasm` | Query `.scm` | Resolver |
|----|------------|-----------------|--------------|----------|
| `python` | `.py` | `python.wasm` | `python.scm` | `createPythonResolver()` |
| `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs`, `.es6` | `javascript.wasm` (`.jsx` → `tsx.wasm`) | `javascript.scm` | `createJsTsResolver()` |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts` | `typescript.wasm` (`.tsx` → `tsx.wasm`) | `typescript.scm` | `createJsTsResolver()` |
| `java` | `.java` | `java.wasm` | `java.scm` | `createJavaResolver()` |
| `cpp` | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`, `.cxx` | `cpp.wasm` (`.c`, `.h` → `c.wasm`) | `cpp.scm` (`.c`, `.h` → `c.scm`) | `createCppResolver()` |
| `csharp` | `.cs` | `csharp.wasm` | `csharp.scm` | `createCSharpResolver()` |
| `go` | `.go` | `go.wasm` | `go.scm` | `createGoResolver()` |
| `rust` | `.rs` | `rust.wasm` | `rust.scm` | `createRustResolver()` |

Grammar files live under `grammars/` (see `grammars/*.wasm` and `grammars/*.scm`).
`buildLanguage` in `src/languages/base-plugin.ts` resolves the shipped paths
(`grammars/<id>.wasm` and `grammars/<id>.scm`) and wires optional per-extension
overrides (`wasmByExt`, `queryByExt`).

## The `LanguagePlugin` contract

Defined in `src/languages/contract.ts`:

```ts
interface LanguagePlugin {
  readonly id: string;
  readonly extensions: string[];
  readonly wasmPath: string;
  readonly wasmByExt?: Record<string, string>;   // e.g. { '.tsx': 'tsx.wasm' }
  readonly queryByExt?: Record<string, string>;   // e.g. { '.c': 'c.scm' }
  readonly query: string;                          // .scm query source path
  contextualize(ctx: FileContext, emits: Emit[]): Emit[];
  readonly resolver?: Resolver;
}
```

There is also a `Resolver` interface for deep type resolution:

```ts
interface Resolver {
  resolve(node: SyntaxNodeLike, scope: ResolutionScope, ctx: FileContext): Resolved | undefined;
}
interface Resolved { kind: 'exact' | 'reference' | 'usage'; qualified?: string; }
```

`buildLanguage(def: LanguageDef)` in `src/languages/base-plugin.ts` turns a
`LanguageDef` into a fully resolved `LanguagePlugin`, providing:

- a `defaultContextualize` that assigns `qualified = moduleSpec.name` to any
  `define` emit missing a qualified name;
- a `passthrough` resolver when no resolver is given.

`LanguageRegistry` maps extensions to plugins using **longest-suffix** matching
in `forPath` (so `.tsx` wins over `.ts`), and `get(id)` looks a plugin up by id.

## How indexing uses a plugin

1. `indexer/walk` collects candidate files; `registry.forPath(file)` selects a
   plugin (or `undefined` → the file is skipped).
2. `indexer/extract` (in `src/indexer/index.ts`) picks the query via
   `plugin.queryByExt?.[ext] ?? plugin.query`, loads the grammar via
   `wasmByExt?.[ext] ?? wasmPath`, parses the file, and runs the query.
3. Raw captures are converted to `Emit` facts by `emitsFromQuery`
   (`src/languages/base.ts`).
4. `contextualize` attributes qualified names/module scope.
5. Optional `resolver` deep-resolves calls/imports during graph writing.

## Grammar query shape

Each language ships a tree-sitter query file (`grammars/<id>.scm`). The query
defines named captures that `emitsFromQuery` maps to structured `Emit`s. The
conventions are documented in the source of `src/languages/base.ts`:

| Capture | Emit | Meaning |
|---------|------|---------|
| `@define` | `define` | The full defining node (function/class/method/...). Label is derived from the node type by `labelForNode`. |
| `@name` | — | The name identifier of a definition. If missing, the define node's text is used as the name. |
| `@sig` | — | Optional signature text (`signature`). |
| `@doc` | — | Optional doc text (`doc`). |
| `@call.target` | `call` | A call target name → `CALLS` edge. |
| `@import.source` | `import` | An import source → `IMPORTS` edge. |
| `@inherit.base` | `inherit` | A base type → `INHERITS` edge. |
| `@route.method`, `@route.path`, `@route.handler` | `http-route` | An HTTP route → `Route` node + `HANDLES` edge. |
| `@enum.member` | (handled per language) | Enum members (used by some grammars). |

`emitsFromQuery` maps captured node types to labels via `labelForNode`
(`Class`, `Interface`, `Enum`, `Type`, `Module`, `Method`, or `Function`).

### Example — `python.scm`

```scm
; Definitions
(function_definition
  name: (identifier) @name) @define

(class_definition
  name: (identifier) @name) @define

; Inheritance
(class_definition
  superclasses: (argument_list
    (identifier) @inherit.base))

; Imports
(import_statement
  name: (dotted_name) @import.source)

; Calls
(call
  function: (identifier) @call.target)

; HTTP routes — Flask decorator
(decorated_definition
  (decorator
    (call
      function: (attribute attribute: (identifier))
      arguments: (argument_list
        (string (string_content) @route.path))))
  definition: (function_definition
    name: (identifier) @route.handler))
```

### Example — `typescript.scm`

```scm
(function_declaration name: (identifier) @name) @define
(class_declaration name: (type_identifier) @name) @define
(interface_declaration name: (type_identifier) @name) @define

(class_declaration
  (class_heritage (extends_clause value: (identifier) @inherit.base)))

(import_statement source: (string (string_fragment) @import.source))
(call_expression function: (identifier) @call.target)

; Express-style routes
(call_expression
  function: (member_expression
    object: (_) @route.app
    property: (property_identifier) @route.method)
  arguments: (arguments
    (string (string_fragment) @route.path)
    (_) @route.handler))
```

## Adding a new language (plugin development guide)

To add a language, for example `kotlin`:

1. **Vendor a grammar.** Obtain or build a tree-sitter WASM for the language and
   place it at `grammars/kotlin.wasm`. (The `scripts/build-grammars.mjs` script
   shows how existing grammars are pinned/downloaded and writes
   `grammars/manifest.json`.)
2. **Write a query file.** Create `grammars/kotlin.scm` with the capture
   conventions above (`@define`, `@name`, `@call.target`, `@import.source`,
   `@inherit.base`, optional `@route.*`). Study `python.scm` / `typescript.scm`
   as templates.
3. **Create a plugin def and (optionally) a resolver.** In
   `src/languages/index.ts`, add an entry to `DEFS`:

   ```ts
   { id: 'kotlin', extensions: ['.kt', '.kts'], resolver: createKotlinResolver() }
   ```

   - Use `wasmByExt` if some extensions need a different grammar (e.g.
     `.kts`), and `queryByExt` if they need a different query.
   - Optionally implement a `Resolver` in `src/resolver/` (see the existing
     `python.ts`, `js-ts.ts`, etc.) and export it from `src/resolver/index.ts`.
     If omitted, the passthrough resolver is used and resolution is
     syntactic-only.
4. **Register and rebuild.** The plugin is auto-registered via `DEFS` in
   `createRegistry()`; ensure `grammars/kotlin.wasm` is shipped in the package
   (`files` includes `grammars`). No other code changes are needed.

## Defaults and overrides

- `buildLanguage` defaults `wasmPath` to `grammars/<id>.wasm` and `query` to
  `grammars/<id>.scm`, resolved relative to the package.
- `contextualize` defaults to prefixing `moduleSpec.name` for unqualified
  defines. Override it in `LanguageDef.contextualize` for custom module
  attribution (e.g. Python packages, Go package declarations).
- `detectModuleSpec` (in `src/indexer/index.ts`) provides a per-language module
  spec heuristic used during contextualization: Python joins path parts with no
  separator, Go uses the package declaration line, and other languages use
  `langId.<path.parts>`.
