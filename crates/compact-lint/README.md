# compact-lint

Doc-comment linter for Compact sources. It parses `.compact` files with
[`compact-tree-sitter`](../compact-tree-sitter), matches every declaration against the
per-kind template in `compact-lint.toml`, and prints one finding per line.

## Usage

```sh
compact-lint check [PATHS]... [--config <file>] [--strict] [--no-format] [--compact-bin <path>]
```

- `PATHS` — files or directories, walked recursively for `.compact`. Skipped while
  walking: `node_modules`, `target`, `dist`, `build`, `.git`.
- No `PATHS` — the config's `include` globs are used instead.
- `--config <file>` — use this config instead of searching upward for
  `compact-lint.toml`.
- `--strict` — turn `k=?` / `rows=?` placeholders into findings. Use it on release
  branches.
- `--no-format` — skip the `compact format --check` pass. Required where the `compact`
  binary is unavailable, CI included.
- `--compact-bin <path>` — path to the `compact` binary. Also settable with
  `COMPACT_LINT_COMPACT_BIN`; the flag wins.

Findings go to stdout, one per line, in `path:line:col: rule: message` form (the
rustc / eslint shape, so editors and `grep` both read it). The `N findings in M files`
summary goes to stderr, where `M` is the number of files checked.

## Exit codes

- `0` — no findings.
- `1` — findings.
- `2` — usage, config, IO or parser error.

## Rules

| Rule | Meaning |
| --- | --- |
| `missing-doc` | The declaration needs docs per `kinds.<kind>.docs` and has no doc comment attached. |
| `missing-tag` | A tag listed in `kinds.<kind>.tags` is absent from the doc comment. |
| `forbidden-tag` | A tag listed in `tags.forbid` is present. |
| `module-name` | `@module <Name>` does not name the module it documents. |
| `missing-constraints` | An exported non-pure circuit has no constraints tag. |
| `constraints-format` | The constraints value is not `k=<n>, rows=<n>`. |
| `constraints-placeholder` | `--strict` only: the constraints value still holds a `?`. |
| `parse` | The file holds a syntax defect; the first one is reported and the doc rules are skipped for that file. |
| `format` | `compact format --check` reported the file. |

Rule detail:

- **Attachment.** A doc comment counts as attached only when it is the declaration's
  immediately preceding *named* sibling. A `//` or `/* */` comment between the two
  breaks the attachment and the declaration reads as undocumented.
- **Export.** "Exported" means the declaration carries the `export` token itself. A
  non-exported circuit inside an exported module is not exported.
- **Constraints.** The rule applies to exported non-pure circuits only, and that is
  fixed, not configurable. A missing doc comment reports as `missing-doc`, not
  `missing-constraints`.
- **`module-name`.** The documented name is the first word of the `@module` value,
  without its generic arguments or trailing punctuation, so `@module Signer<T>` matches
  `module Signer` and `@module Utils.` matches `module Utils`.
- **`forbidden-tag`.** It fires on any doc comment attached to a checked declaration,
  including declarations whose docs are optional.

## Config

`compact-lint.toml`, searched for upward from the current directory. Every field is
optional; unknown fields are rejected. A config found by walking upward anchors the
`include` globs at its own directory; a config named with `--config` is a shareable
preset, so the globs stay anchored at the current directory.

```toml
version = 1
include = ["contracts/src/**/*.compact"]
exclude = ["**/test/mocks/**", "**/archive/**"]

[constraints]
tag = "@constraints"

[tags]
forbid = ["@return"]

[kinds.module]
docs = "exported"
tags = ["@module", "@description"]
```

Defaults when no config file is found:

| Key | Default |
| --- | --- |
| `version` | `1`, the only version this build accepts |
| `include` | `["**/*.compact"]` |
| `exclude` | `[]` |
| `constraints.tag` | `"@constraints"` |
| `tags.forbid` | `[]` |
| `kinds.<kind>.docs` | `"exported"` |
| `kinds.<kind>.tags` | `[]` |

- `kinds` takes one table per kind: `module`, `circuit`, `ledger`, `witness`,
  `constructor`, `struct`, `enum`, `contract`, `type`. `pragma`, `import`, `include`,
  `export { … }` and `contract implements` are never checked.
- `docs` is `"all"`, `"exported"` or `"none"`.
- `constructor` carries no `export` token, so `"exported"` means "never" for it. Use
  `"all"` or `"none"` there.
- `exclude` filters files found by walking a directory. A file named on the command
  line is always checked.

`examples/compact-contracts.toml` is the config for OpenZeppelin/compact-contracts.

## Doc-comment model

- `/**`, `*/` and the leading ` * ` gutter are stripped.
- A tag line's first non-blank token is `@` followed by one or more ASCII letters.
- A tag's value is the rest of its line plus every following line until the next tag or
  a blank line.
- Repeated tags are kept in source order; `@param` normally repeats.
- `@param {Type} name - text` is not parsed further.

## Tests

```sh
cargo test --workspace
```

`tests/fixtures/<case>/` holds one case per rule plus a clean case: a
`compact-lint.toml`, the `.compact` sources, and `expected.txt`, the exact stdout with
paths relative to the case directory.
