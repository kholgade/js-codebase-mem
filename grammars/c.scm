; C: functions, structs, enums, typedefs, calls, includes, macros.

; Definitions — top-level functions
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @define

; Definitions — structs
(struct_specifier
  name: (type_identifier) @name) @define

; Definitions — enums
(enum_specifier
  name: (type_identifier) @name) @define

; Definitions — typedefs
(type_definition
  type: (type_identifier) @name) @define

; Definitions — function-like macros
(preproc_function_def
  name: (identifier) @name) @define

; Includes — system headers
(preproc_include
  path: (system_lib_string) @import.source)

; Includes — local headers
(preproc_include
  path: (string_literal
    (string_content) @import.source))

; Calls — simple function call
(call_expression
  function: (identifier) @call.target)

; Calls — function pointer call
(call_expression
  function: (parenthesized_expression
    (identifier) @call.target))
