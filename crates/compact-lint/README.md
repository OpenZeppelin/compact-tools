# compact-lint

Doc-comment linter for Compact sources. It parses `.compact` files with
[`compact-tree-sitter`](../compact-tree-sitter), matches every declaration against the
per-kind template in `compact-lint.toml`, and prints one finding per line. `fix`
rewrites the comments the repairable rules report.

## Usage

```sh
compact-lint check [PATHS]... [--config <file>] [--strict] [--no-format] [--compact-bin <path>]
compact-lint fix [PATHS]... [--config <file>] [--dry-run]
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

## Fix

`fix` rewrites `.compact` files so a following `check` is clean for every rule it
covers. It runs the same detection pass as `check`, so the two never disagree.

```sh
compact-lint fix [PATHS]... [--config <file>] [--dry-run]
```

- `PATHS` and `--config` resolve exactly as they do for `check`.
- `--dry-run` — report the edits and write nothing. Exit `1` when there are edits, so
  CI gates on it the way it gates on `cargo fmt --check`.

Edits go to stdout, one per line, in `path:line:col: fix: <message>` form. The
`N edits in M files` summary goes to stderr, where `M` is the number of files changed.

Exit codes:

- `0` — the files were written, including when there was nothing to do.
- `1` — `--dry-run` only: edits would be made.
- `2` — usage, config, IO or parser error.

What each rule's fix does:

| Rule | Fix |
| --- | --- |
| `missing-doc` | Inserts a doc skeleton above the declaration, indented to it. Body lines come from `kinds.<kind>.tags` in config order; `@module` takes the declaration's name, every other tag takes `fix.placeholder`. Exported non-pure circuits also get the constraints line. A kind with neither gets a single placeholder line. |
| `missing-tag` | Inserts each missing tag after the block of the last tag that precedes it in `kinds.<kind>.tags`, else at the top of the body. A missing `@description` adopts untagged prose that opens the body instead of writing a placeholder. A `/** … */` one-liner expands to the multi-line form first. |
| `missing-constraints` | Inserts `<tag> k=?, rows=?` after the `@description` block, with a blank ` *` line before it and, where prose follows, one after. Without a `@description` it opens the body. |
| `forbidden-tag` | Renames the tag in place, and only where `tags.rename` maps it. |
| `module-name` | Replaces the first word of the `@module` value with the module's name, keeping what follows. |

Not fixed:

- `constraints-format` — a human wrote a measurement the rule cannot parse; guessing at
  it would lose the value.
- `constraints-placeholder` — filling `k=?` needs a real measurement.
- `parse` — the file does not parse, so no rewrite is trustworthy.
- `format` — that is `compact format`'s job.
- A forbidden tag with no `tags.rename` entry stays a `check` finding.

Existing lines are never reordered or reflowed. Edits are computed against the original
text and applied from the highest offset down; several edits on one comment merge into a
single replacement of it. Files are rewritten through a sibling `.tmp` file and renamed
into place, keeping the file's line ending and its trailing newline, or lack of one.

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
rename = { "@return" = "@returns" }

[fix]
placeholder = "TODO"

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
| `tags.rename` | `{}` |
| `fix.placeholder` | `"TODO"` |
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
- `tags.rename` maps a forbidden tag to the tag `fix` writes in its place. Every key
  must appear in `tags.forbid` and no value may, or the config is rejected. Both
  spellings are validated like every other tag. An unmapped forbidden tag is reported,
  never rewritten.
- `fix.placeholder` is the text `fix` writes where it has no value of its own.

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

`tests/fixtures/<case>/` holds one `check` case per rule plus a clean case: a
`compact-lint.toml`, the `.compact` sources, and `expected.txt`, the exact stdout with
paths relative to the case directory.

`tests/fixtures/fix-<case>/` holds one `fix` case per rule: a `compact-lint.toml`,
`before/`, `after/` and `expected.txt`. The run copies `before/` into a temporary
directory, so the fixtures are never rewritten in place.
