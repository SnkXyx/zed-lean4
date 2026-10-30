; Doc comments are single external tokens in the pinned grammar. Zed injects
; their full range, including the comment delimiters; #offset! is unsupported.
((doc_comment) @injection.content
  (#set! injection.language "markdown"))

((module_doc_comment) @injection.content
  (#set! injection.language "markdown"))
