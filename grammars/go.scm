; Go: functions, methods, structs/interfaces, calls, imports.

; Function declarations
(function_declaration
  name: (identifier) @name) @define

; Method declarations (receiver + name). Receiver must precede name for the
; tree-sitter Query parser to accept both fields in one pattern.
(method_declaration
  receiver: (parameter_list)
  name: (field_identifier) @name) @define

; Struct and interface declarations (and type aliases) via type_spec.
(type_declaration
  (type_spec
    name: (type_identifier) @name)) @define

; Imports
(import_declaration
  (import_spec
    path: (interpreted_string_literal) @import.source))

; Calls: plain identifier calls and method/selector calls
(call_expression
  function: (identifier) @call.target)

(call_expression
  function: (selector_expression
    field: (field_identifier) @call.target))

; HTTP routes — net/http http.HandleFunc("/path", handler)
(call_expression
  function: (selector_expression
    field: (field_identifier) @route.method)
  arguments: (argument_list
    (interpreted_string_literal) @route.path
    (identifier) @route.handler))
