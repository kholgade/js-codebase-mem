; TypeScript / TSX: functions, methods, classes, interfaces, enums, type aliases, calls, imports, inheritance.

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
  name: (type_identifier) @name) @define

(abstract_class_declaration
  name: (type_identifier) @name) @define

(interface_declaration
  name: (type_identifier) @name) @define

(enum_declaration
  name: (identifier) @name) @define

(type_alias_declaration
  name: (type_identifier) @name) @define

; Inheritance / extends / implements
(class_declaration
  (class_heritage
    (extends_clause value: (identifier) @inherit.base)))

(interface_declaration
  (extends_type_clause
    type: (type_identifier) @inherit.base))

; Imports
(import_statement
  source: (string (string_fragment) @import.source))

(export_statement
  source: (string (string_fragment) @import.source))

; Calls
(call_expression
  function: (identifier) @call.target)

(call_expression
  function: (member_expression
    property: (property_identifier) @call.target))
