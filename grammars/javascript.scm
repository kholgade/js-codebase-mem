; JavaScript (plain JS grammar): functions, methods, classes, calls, imports, inheritance.
; Note: interface_declaration / abstract_class_declaration / extends_clause are
; TypeScript-only node types and do NOT exist in grammars/javascript.wasm — omitting
; them here avoids a QueryError. (typescript.scm handles those.)

; Definitions
(function_declaration
  name: (identifier) @name) @define

(method_definition
  name: (property_identifier) @name) @define

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)] @define))

(class_declaration
  name: (identifier) @name) @define

; Inheritance / extends
(class_declaration
  (class_heritage
    (identifier) @inherit.base))

; Imports
(import_statement
  source: (string (string_fragment) @import.source))

; Export from
(export_statement
  source: (string (string_fragment) @import.source))

; Calls
(call_expression
  function: (identifier) @call.target)

(call_expression
  function: (member_expression
    property: (property_identifier) @call.target))

; HTTP routes — Express-style app.get('/path', handler)
(call_expression
  function: (member_expression
    object: (identifier) @route.app
    property: (property_identifier) @route.method)
  arguments: (arguments
    (string (string_fragment) @route.path)
    (arrow_function) @route.handler))

; HTTP routes — handler as named function reference
(call_expression
  function: (member_expression
    object: (identifier) @route.app
    property: (property_identifier) @route.method)
  arguments: (arguments
    (string (string_fragment) @route.path)
    (identifier) @route.handler))
