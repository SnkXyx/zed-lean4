; Declaration-sized motions and selections for Vim mode.
(declaration
  [
    (def)
    (theorem)
    (example)
    (abbrev)
    (opaque)
    (constant)
    (axiom)
    (instance)
  ]) @function.around

[
  (initialize)
  (where_aux_def)
] @function.around

(declaration
  [
    (structure)
    (inductive)
  ]) @class.around

[
  (namespace)
  (section)
] @class.around

; Adjacent line comments form a single comment text object.
(line_comment)+ @comment.around

[
  (block_comment)
  (doc_comment)
  (module_doc_comment)
] @comment.around
