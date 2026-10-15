; Baseline highlighting for tree-sitter-lean. Lean LSP semantic tokens
; provide richer, scope-aware highlighting when available.

(line_comment) @comment
(block_comment) @comment
(doc_comment) @comment
(module_doc_comment) @comment

(num_lit) @number
(scientific_lit) @number
(char_lit) @character
(str_lit) @string
(raw_string) @string
(interpolated_str) @string
(escape_sequence) @string.escape

[(true_const) (false_const)] @boolean
[(type_const) (sort_const) (prop_const)] @type

(def name: (identifier) @function)
(theorem name: (identifier) @function)
(abbrev name: (identifier) @function)
(opaque name: (identifier) @function)
(constant name: (identifier) @function)
(axiom name: (identifier) @function)
(instance name: (identifier) @function)
(structure name: (identifier) @type)
(inductive name: (identifier) @type)
(ctor name: (identifier) @constructor)
(ctor_alt name: (identifier) @constructor)
(field name: (identifier) @property)
(namespace name: (identifier) @namespace)
(section name: (identifier) @namespace)
(end name: (identifier) @namespace)
(import name: (identifier) @module)
(open namespace: (identifier) @module)

(identifier) @variable
(hole) @variable.builtin
(synth_hole) @variable.builtin

[
  "namespace" "section" "end"
  "def" "theorem" "lemma" "example" "abbrev" "instance" "axiom"
  "opaque" "constant" "structure" "inductive" "class"
  "variable" "universe" "universes" "open" "export" "extends"
  "deriving" "where" "import" "by" "do"
  "fun" "λ" "let" "have" "show" "if" "then" "else"
  "match" "with" "forall" "exists" "∀" "∃"
  "private" "protected" "partial" "noncomputable" "unsafe"
] @keyword

[
  "→" "->" "↔" "<->" "↦" "=>" "∨" "||" "∧" "&&" "¬"
  "=" "≠" "!=" "<" "≤" "<=" ">" "≥" ">=" "∈" "∉"
  "⊆" "⊂" "⊇" "⊃" "::" "++" "+" "-" "*" "/" "%"
  "∪" "∩" "^" "∘" "|>" "<|" "←" "<-"
] @operator

[":=" ":"] @operator
["," ";" "|"] @punctuation.delimiter
["(" ")" "{" "}" "[" "]" "⟨" "⟩"] @punctuation.bracket
