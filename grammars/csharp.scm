; C#: namespaces, classes, interfaces, enums, methods, constructors, calls, using directives, inheritance.

; Definitions
(namespace_declaration
  name: (identifier) @name) @define

(class_declaration
  name: (identifier) @name) @define

(interface_declaration
  name: (identifier) @name) @define

(enum_declaration
  name: (identifier) @name) @define

(method_declaration
  name: (identifier) @name) @define

(constructor_declaration
  name: (identifier) @name) @define

; Definitions — top-level / local functions
(local_function_statement
  name: (identifier) @name) @define

; Inheritance — base list
(class_declaration
  (base_list
    (identifier) @inherit.base))

; Using directives — imports
(using_directive
  (qualified_name) @import.source)

(using_directive
  (identifier) @import.source)

; Calls — simple invocation
(invocation_expression
  function: (identifier) @call.target)

; Calls — object method invocation (obj.Method())
(invocation_expression
  function: (member_access_expression
    name: (identifier) @call.target))
