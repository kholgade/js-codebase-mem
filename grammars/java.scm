; Java: classes, interfaces, enums, methods, constructors, calls, imports, inheritance.

; Definitions
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

; Inheritance — extends
(class_declaration
  superclass: (superclass
    (type_identifier) @inherit.base))

; Inheritance — implements
(class_declaration
  interfaces: (super_interfaces
    (type_list
      (type_identifier) @inherit.base)))

; Imports
(import_declaration
  (scoped_identifier) @import.source)

; Calls — method invocation (covers both d.speak() and helper(d))
(method_invocation
  name: (identifier) @call.target)
