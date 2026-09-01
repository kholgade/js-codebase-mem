; Python: functions, classes, methods, calls, imports, inheritance, Flask/FastAPI routes.

; Definitions
(function_definition
  name: (identifier) @name) @define

(class_definition
  name: (identifier) @name) @define

; Inheritance / base classes
(class_definition
  superclasses: (argument_list
    (identifier) @inherit.base))

; Imports
(import_statement
  name: (dotted_name) @import.source)

(import_from_statement
  module_name: (dotted_name) @import.source)

; Calls (simple identifier and attribute calls)
(call
  function: (identifier) @call.target)

(call
  function: (attribute
    attribute: (identifier) @call.target))

; HTTP routes — Flask decorator with explicit methods list
(decorated_definition
  (decorator
    (call
      function: (attribute
        attribute: (identifier))
      arguments: (argument_list
        (string (string_content) @route.path)
        (keyword_argument
          value: (list (string (string_content) @route.method)))))
    )
  definition: (function_definition
    name: (identifier) @route.handler))

; HTTP routes — Flask decorator without methods (default GET)
(decorated_definition
  (decorator
    (call
      function: (attribute
        attribute: (identifier))
      arguments: (argument_list
        (string (string_content) @route.path))))
  definition: (function_definition
    name: (identifier) @route.handler))
