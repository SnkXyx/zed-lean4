; Declarations may span signatures, values, tactic blocks, structure fields,
; and inductive constructors. Nested ranges still increase indentation only
; once per edited line in Zed.
[
  (declaration)
  (initialize)
] @indent

; Layout-introducing keywords.
(by
  "by" @start) @indent

(do_block
  "do" @start) @indent

(where_struct
  "where" @start) @indent

(where_decls
  "where" @start) @indent

(where_aux_def) @indent

(match
  "with" @start) @indent

(match_alt
  ["=>" "↦"] @start) @indent

(tactic_case
  "=>" @start) @indent

(fun
  ["=>" "↦"] @start) @indent

[
  (forall "," @start)
  (exists "," @start)
  (sigma "," @start)
  (big_op_binder "," @start)
] @indent

[
  (let [":=" "←" "<-"] @start)
  (have ":=" @start)
  (suffices "from" @start)
  (show "from" @start)
] @indent

(let
  ";" @start) @indent

(induction
  "with" @start) @indent

; Treat the two branches as separate ranges so `else` aligns with `if`.
(if_then_else
  "then" @start
  "else" @end) @indent

(if_then_else
  "else" @start) @indent

; Delimited forms indent their contents while keeping the closing delimiter
; aligned with the line that opened the form.
(_
  "["
  "]" @end) @indent

(_
  "#["
  "]" @end) @indent

(_
  "@["
  "]" @end) @indent

(_
  "{"
  "}" @end) @indent

(_
  "⦃"
  "⦄" @end) @indent

(_
  "{{"
  "}}" @end) @indent

(_
  "("
  ")" @end) @indent

(_
  "⟨"
  "⟩" @end) @indent

(_
  "⟪"
  "⟫" @end) @indent
