/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Declaration-level grammar for Compact (Midnight), language version 0.26.
// Every top-level and module-level declaration is a named node, but the fields
// vary: most carry `name`, while `include_declaration` carries `path`,
// `implements_declaration` carries `type`, `constructor_declaration` has no
// identifier at all, and `export_declaration` holds bare `identifier` children.
// Bodies, parameter lists and statements stay opaque brace-balanced runs.

/**
 * Comma-separated list with an optional trailing comma.
 * @param {RuleOrLiteral} rule
 */
function commaSep(rule) {
  return optional(seq(rule, repeat(seq(',', rule)), optional(',')));
}

module.exports = grammar({
  name: 'compact',

  word: ($) => $.identifier,

  extras: ($) => [/\s/, $.doc_comment, $.block_comment, $.line_comment],

  rules: {
    source_file: ($) => repeat($._declaration),

    _declaration: ($) =>
      choice(
        $.pragma_declaration,
        $.include_declaration,
        $.import_declaration,
        $.export_declaration,
        $.module_declaration,
        $.struct_declaration,
        $.enum_declaration,
        $.implements_declaration,
        $.contract_declaration,
        $.type_declaration,
        $.ledger_declaration,
        $.witness_declaration,
        $.constructor_declaration,
        $.circuit_declaration,
      ),

    // pragma id version-expr ;
    pragma_declaration: ($) =>
      seq('pragma', field('name', $.identifier), $.version_constraint, ';'),

    // Version expressions are not modelled; the run stops at the terminating `;`.
    version_constraint: (_$) => token(/[^;{}\r\n]+/),

    // include "file" ;
    include_declaration: ($) => seq('include', field('path', $.string), ';'),

    // import {sel} from? name gargs? prefix? ;
    import_declaration: ($) =>
      seq(
        'import',
        optional($.import_selection),
        field('name', choice($.identifier, $.string)),
        optional($.generic_arguments),
        optional($.import_prefix),
        ';',
      ),

    import_selection: ($) => seq('{', commaSep($.import_element), '}', 'from'),

    import_element: ($) =>
      seq(
        field('name', $.identifier),
        optional(seq('as', field('alias', $.identifier))),
      ),

    import_prefix: ($) => seq('prefix', field('prefix', $.identifier)),

    // export { id, ... } ;?
    export_declaration: ($) =>
      seq('export', '{', commaSep($.identifier), '}', optional(';')),

    // export? module Name gparams? { declaration... }
    module_declaration: ($) =>
      seq(
        optional('export'),
        'module',
        field('name', $.identifier),
        optional($.generic_parameters),
        field('body', $.module_body),
      ),

    module_body: ($) => seq('{', repeat($._declaration), '}'),

    // export? struct Name gparams? { typed-id... } ;?
    struct_declaration: ($) =>
      seq(
        optional('export'),
        'struct',
        field('name', $.identifier),
        optional($.generic_parameters),
        field('body', $.block),
        optional(';'),
      ),

    // export? enum Name { id, ... } ;?
    enum_declaration: ($) =>
      seq(
        optional('export'),
        'enum',
        field('name', $.identifier),
        field('body', $.block),
        optional(';'),
      ),

    // contract implements type ;
    implements_declaration: ($) =>
      seq('contract', 'implements', field('type', $.type_expression), ';'),

    // export? contract Name { circuit-declaration... } ;?
    contract_declaration: ($) =>
      seq(
        optional('export'),
        'contract',
        field('name', $.identifier),
        field('body', $.block),
        optional(';'),
      ),

    // export? new? type Name gparams? = type ;
    type_declaration: ($) =>
      seq(
        optional('export'),
        optional('new'),
        'type',
        field('name', $.identifier),
        optional($.generic_parameters),
        '=',
        field('value', $.type_expression),
        ';',
      ),

    // export? sealed? ledger id : type ;
    ledger_declaration: ($) =>
      seq(
        optional('export'),
        optional('sealed'),
        'ledger',
        field('name', $.identifier),
        ':',
        field('type', $.type_expression),
        ';',
      ),

    // export? witness id gparams? (params) : type ;
    witness_declaration: ($) =>
      seq(
        optional('export'),
        'witness',
        field('name', $.identifier),
        optional($.generic_parameters),
        field('parameters', $.parameter_list),
        ':',
        field('type', $.type_expression),
        ';',
      ),

    // constructor (params) block
    constructor_declaration: ($) =>
      seq(
        'constructor',
        field('parameters', $.parameter_list),
        field('body', $.block),
      ),

    // export? pure? circuit name gparams? (params) : type block
    circuit_declaration: ($) =>
      seq(
        optional('export'),
        optional('pure'),
        'circuit',
        field('name', $.identifier),
        optional($.generic_parameters),
        field('parameters', $.parameter_list),
        ':',
        field('type', $.type_expression),
        field('body', $.block),
      ),

    // <#T, U,>
    generic_parameters: ($) => seq('<', commaSep($.generic_parameter), '>'),

    generic_parameter: ($) => seq(optional('#'), field('name', $.identifier)),

    // Angle brackets nest only here, where a `>` always closes a type argument list.
    generic_arguments: ($) => seq('<', repeat($._type_item), '>'),

    type_expression: ($) => repeat1($._type_item),

    _type_item: ($) =>
      choice(
        $.identifier,
        $.number,
        $.string,
        $.generic_arguments,
        $._tuple_type,
        ',',
        ':',
        '..',
      ),

    _tuple_type: ($) => seq('[', repeat($._type_item), ']'),

    // Brace-balanced opaque run: circuit and constructor bodies, struct, enum and
    // external-contract bodies, and destructuring patterns inside parameter lists.
    block: ($) => seq('{', repeat($._opaque), '}'),

    parameter_list: ($) => seq('(', repeat($._opaque), ')'),

    _paren_group: ($) => seq('(', repeat($._opaque), ')'),

    _bracket_group: ($) => seq('[', repeat($._opaque), ']'),

    _opaque: ($) =>
      choice(
        $.block,
        $._paren_group,
        $._bracket_group,
        $.string,
        $._opaque_token,
        '/',
      ),

    // Anything that is not a delimiter, a quote or a comment opener.
    // biome-ignore lint/complexity/noUselessEscapeInRegex: tree-sitter's regex engine rejects an unescaped `[` in a class.
    _opaque_token: (_$) => token(/[^\s(){}\[\]"'\/]+/),

    identifier: (_$) => /[A-Za-z_$][A-Za-z0-9_$]*/,

    number: (_$) => /[0-9]+/,

    // Double-quoted literals span lines; the Compact formatter emits them that way.
    string: (_$) =>
      token(
        choice(
          seq('"', repeat(choice(/[^"\\]/, /\\(.|\r?\n)/)), '"'),
          seq("'", repeat(choice(/[^'\\\r\n]/, /\\./)), "'"),
        ),
      ),

    // `/** ... */` outranks `/* ... */` at equal length; `/**/` matches only the latter.
    doc_comment: (_$) =>
      token(prec(2, seq('/**', /[^*]*\*+([^/*][^*]*\*+)*/, '/'))),

    block_comment: (_$) =>
      token(prec(1, seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'))),

    line_comment: (_$) => token(seq('//', /[^\r\n]*/)),
  },
});
