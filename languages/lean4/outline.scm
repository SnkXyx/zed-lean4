(namespace
  "namespace" @context
  name: (identifier) @name) @item

(section
  "section" @context
  name: (identifier) @name) @item

(declaration
  (attributes)? @annotation
  (def
    "def" @context
    name: (identifier) @name)) @item

(declaration
  (attributes)? @annotation
  (theorem
    ["theorem" "lemma"] @context
    name: (identifier) @name)) @item

(declaration
  (attributes)? @annotation
  (abbrev
    "abbrev" @context
    name: (identifier) @name)) @item

(declaration
  (attributes)? @annotation
  (opaque
    "opaque" @context
    name: (identifier) @name)) @item

(declaration
  (attributes)? @annotation
  (constant
    "constant" @context
    name: (identifier) @name)) @item

(declaration
  (attributes)? @annotation
  (axiom
    "axiom" @context
    name: (identifier) @name)) @item

(declaration
  (attributes)? @annotation
  (instance
    "instance" @context
    name: (identifier) @name)) @item

(declaration
  (attributes)? @annotation
  (structure
    ["structure" "class"] @context
    name: (identifier) @name)) @item

(declaration
  (attributes)? @annotation
  (inductive
    "inductive" @context
    name: (identifier) @name)) @item

(initialize
  ["initialize" "builtin_initialize"] @context
  name: (identifier) @name) @item

(where_aux_def
  name: (identifier) @name) @item

(field
  name: (identifier) @name) @item

(ctor
  name: (identifier) @name) @item

(ctor_alt
  name: (identifier) @name) @item
