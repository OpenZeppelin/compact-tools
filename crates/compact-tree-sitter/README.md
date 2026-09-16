# compact-tree-sitter

Declaration-level [tree-sitter](https://tree-sitter.github.io) grammar for the
Compact smart-contract language (Midnight), tracking language version 0.26.

It exists to feed a doc-comment linter, so it resolves declarations precisely and
leaves everything else opaque.

## What it covers

- Every top-level and module-level declaration is a named node, but the fields
  differ per declaration. These carry a `name` field: `pragma_declaration`,
  `import_declaration`, `module_declaration`, `struct_declaration`,
  `enum_declaration`, `contract_declaration`, `type_declaration`,
  `ledger_declaration`, `witness_declaration`, `circuit_declaration`.
- The exceptions: `include_declaration` carries `path`,
  `implements_declaration` carries `type`, `constructor_declaration` has no
  identifier, and `export_declaration` holds its exported names as bare
  `identifier` children with no field.
- `module_declaration` recurses: a `module_body` holds the same declarations.
- Comments are named nodes in `extras`: `line_comment`, `block_comment`,
  `doc_comment`.
- Types are structured enough to walk: `type_expression`, `generic_arguments`,
  `generic_parameters`, `generic_parameter`.
- All import forms: bare module, quoted path, generic arguments, `prefix`, and
  the `{ a, b as c } from` selection.

## What is opaque

- Circuit and constructor bodies: `block` is a brace-balanced token run. Strings
  and comments are lexed first, so braces inside them do not count.
- Struct, enum and external-contract bodies reuse the same `block`.
- Parameter lists: `parameter_list` is a paren-balanced run, so destructuring
  patterns parse without a pattern grammar.
- Statements and expressions. There is no expression grammar and none is planned.
- Version expressions: `version_constraint` is one token that runs to the `;`.

Angle brackets are balanced only inside `generic_arguments`, where a `>` always
closes a type-argument list. They are never balanced in opaque runs.

## Modifiers

`export`, `sealed`, `pure` and `new` stay anonymous keyword tokens directly under
the declaration node. A consumer tests for them by walking children and comparing
`node.kind()`:

```rust
let exported = {
    let mut cursor = declaration.walk();
    declaration
        .children(&mut cursor)
        .any(|child| child.kind() == "export")
};
```

They are not fields, because a field would need a distinct name per modifier and
the linter only ever asks whether one is present.

## Comment disambiguation

`doc_comment` matches `/** … */` and outranks `block_comment` by lexical
precedence when both match the same span. `/**/` matches only `block_comment`,
since the doc pattern needs at least one `*` after the opener.

## Regenerating the parser

`src/parser.c`, `src/grammar.json`, `src/node-types.json` and `src/tree_sitter/*`
are generated and committed. After editing `grammar.js`:

```sh
npx -y tree-sitter-cli@0.25.8 generate
```

CI regenerates and fails on any diff under `crates/compact-tree-sitter/src`.

## Tests

```sh
# Grammar corpus, run from this directory.
npx -y tree-sitter-cli@0.25.8 test

# Rust bindings plus the fixture corpora.
cargo test --workspace

# Add an external tree of .compact files.
COMPACT_CORPUS_DIR=/path/to/contracts cargo test --workspace -- --nocapture corpus
```

`tests/corpus.rs` asserts that no fixture produces an `ERROR` or `MISSING` node.
`test/fixtures/upstream/` holds the Compact formatter's own examples; see the
`NOTICE` beside them for provenance.
