; C++: classes, structs, enums, functions, methods, calls, includes, inheritance.

; Definitions — top-level functions and constructors (constructors are
; function_definition with (identifier) declarator; labelForNode classifies
; them as Method via the enclosing class_specifier).
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @define

; Definitions — class/struct methods (declarator is a field_identifier)
(class_specifier
  body: (field_declaration_list
    (function_definition
      declarator: (function_declarator
        declarator: (field_identifier) @name)) @define))

; Definitions — classes, structs
(class_specifier
  name: (type_identifier) @name) @define

(struct_specifier
  name: (type_identifier) @name) @define

; Definitions — enums
(enum_specifier
  name: (type_identifier) @name) @define

; Inheritance — base class clause
(class_specifier
  (base_class_clause
    (type_identifier) @inherit.base))

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

; Calls — method call (obj.method())
(call_expression
  function: (field_expression
    field: (field_identifier) @call.target))
