; Rust: functions, structs, enums, traits, impls, modules, calls, imports, inheritance.
; Note: functions inside impl_item/trait_item blocks are also function_item nodes;
; they are captured as defines here and (being inside one of our class-ish defines)
; are classified by labelForNode based on node type / ancestry.

; Functions
(function_item
  name: (identifier) @name) @define

; Functions nested in impl/trait blocks are also function_item; capture them too.
; (No extra pattern needed - same node type, labelForNode decides Function vs Method.)

; Structs
(struct_item
  name: (type_identifier) @name) @define

; Enums
(enum_item
  name: (type_identifier) @name) @define

; Traits
(trait_item
  name: (type_identifier) @name) @define

; Impl blocks (inherent and trait impls)
(impl_item
  type: (type_identifier) @name) @define

; Modules
(mod_item
  name: (identifier) @name) @define

; Inheritance: trait being implemented for a type
(impl_item
  trait: (type_identifier) @inherit.base)

; Imports
(use_declaration
  argument: (scoped_identifier) @import.source)

; Calls: plain identifier calls, method calls, and trait-method calls
(call_expression
  function: (identifier) @call.target)

(call_expression
  function: (field_expression
    field: (field_identifier) @call.target))
