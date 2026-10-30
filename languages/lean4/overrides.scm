[
  (str_lit)
  (raw_string)
  (interpolated_str)
  (char_lit)
] @string

; Interpolation expressions are Lean code. Nested string literals still
; select their smaller @string scope.
(interpolation) @embedded

[
  (line_comment)
  (block_comment)
  (doc_comment)
  (module_doc_comment)
] @comment.inclusive
