; Declaration names.
(pragma_declaration name: (identifier) @variable.builtin)
(module_declaration name: (identifier) @type)
(struct_declaration name: (identifier) @type)
(enum_declaration name: (identifier) @type)
(contract_declaration name: (identifier) @type)
(type_declaration name: (identifier) @type)
(circuit_declaration name: (identifier) @function)
(witness_declaration name: (identifier) @function)
(ledger_declaration name: (identifier) @property)
(generic_parameter name: (identifier) @type.parameter)

; Keywords and modifiers.
[
  "pragma"
  "include"
  "import"
  "export"
  "from"
  "as"
  "prefix"
  "module"
  "struct"
  "enum"
  "contract"
  "implements"
  "type"
  "new"
  "sealed"
  "ledger"
  "witness"
  "constructor"
  "circuit"
  "pure"
] @keyword

(string) @string
(number) @number

(line_comment) @comment
(block_comment) @comment
(doc_comment) @comment.documentation
