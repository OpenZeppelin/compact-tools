# compact-lint

Doc-comment linter for Compact sources. It parses `.compact` files with
[`compact-tree-sitter`](../compact-tree-sitter), matches every declaration against the
per-kind template in `compact.toml`, and prints one diagnostic per violation. `fix`
rewrites the comments the repairable rules report. `fill-constraints` compiles the
contracts and writes the measured `k` and `rows` into the annotations.

## Install

- npm, no Rust toolchain needed: `yarn add -D @openzeppelin/compact-linter`, or
  `npx @openzeppelin/compact-linter check`. The package downloads the release binary for
  the host on first use. See [`packages/linter`](../../packages/linter).
- From source: `cargo install --path crates/compact-lint`.

## Usage

```sh
compact-lint check [PATHS]... [--config <file>] [--strict] [--no-format] [--compact-bin <path>] [OUTPUT]
compact-lint fix [PATHS]... [--config <file>] [--dry-run] [OUTPUT]
compact-lint fill-constraints [PATHS]... [--config <file>] [--dry-run] [--no-compile] [--compact-bin <path>] [--artifacts <dir>] [OUTPUT]
```

- `PATHS` — files or directories, walked recursively for `.compact`. Skipped while
  walking: `node_modules`, `target`, `dist`, `build`, `.git`.
- No `PATHS` — the config's `include` globs are used instead.
- `--config <file>` — use this config instead of searching upward for
  `compact.toml`.
- `--strict` — report `k=?` / `rows=?` placeholders as errors instead of warnings. Use
  it on release branches.
- `--no-format` — skip the `compact format --check` pass. Required where the `compact`
  binary is unavailable, CI included. Same effect as `format = "off"` in `[lint.rules]`.
- `--compact-bin <path>` — path to the `compact` binary. Also settable with
  `COMPACT_LINT_COMPACT_BIN`; the flag wins.

`OUTPUT` is the same set of flags on all three subcommands:

- `--reporter <default|concise|github>` — output format, default `default`.
- `--diagnostic-level <info|warn|error>` — lowest level shown, default `info`. The
  summary still counts what it hides.
- `--error-on-warnings` — exit `1` on a run that only warned.
- `--max-diagnostics <none|N>` — diagnostics shown before the rest are only counted,
  default `20`.
- `--colors <off|force>` — default: colour when stdout is a TTY and `NO_COLOR` is unset.

## Output

- Diagnostics go to stdout; the truncation notice and the summary go to stderr.
- `default` — Biome-style block per diagnostic: header, message, code frame, `i` advice,
  and the fix as a line diff where one exists.
- `concise` — `<glyph> path:line:col: <rule>: <message>`, one line per diagnostic.
- `github` — `::error|warning|notice title=…,file=…,line=…::<message>` workflow commands.
- Glyphs: `×` error, `!` warning, `i` info.
- Rule names read `lint/<rule-id>`, except `parse`, `format` and `fill`, which are bare.
- `FIXABLE` in a header means `fix` repairs it; `FIXED` means this run already did.
- The summary reads `Checked N files in <duration>.` plus what the run did, then
  `Found N errors.` and `Found N warnings.` lines when either is non-zero.
- A clean run prints only the summary line.

```
Gaps.compact:6:3 lint/missing-doc  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Ledger `_owner` has no doc comment.

    4 │  */
    5 │ export module Gaps {
  > 6 │   export ledger _owner: Bytes<32>;
      │   ^^^^^^^^^^^^^^^^^^^^
    7 │ 
    8 │   export enum Kind {

  i Add a doc comment above it, or run compact-lint fix.

  i Unsafe fix: Insert a doc skeleton for ledger `_owner`

      6 │ + ··/**
      7 │ + ···*·@description·TODO
      8 │ + ···*/
```

with this on stderr:

```
Checked 1 file in 2ms. No fixes applied.
Found 3 errors.
```

## Diagnostic levels

- Every rule reports at a level: `error`, `warn`, `info`, or `off`.
- `off` stops the rule running; its findings never reach the report or the counts.
- Set them in `[lint.rules]`, keyed by rule id:

```toml
[lint.rules]
missing-doc = "error"
constraints-placeholder = "warn"
format = "off"
```

Defaults:

| Rule | Level |
| --- | --- |
| `missing-doc`, `missing-tag`, `forbidden-tag`, `module-name` | `error` |
| `missing-constraints`, `constraints-format` | `error` |
| `parse`, `format` | `error` |
| `constraints-placeholder` | `warn` |
| `constraints-unmeasured`, `constraints-unmeasurable` | `warn` |

- `--strict` promotes `constraints-placeholder` to `error` for that run; a rule set to
  `off` stays off.
- An unknown key in `[lint.rules]` is a config error.

## Exit codes

- `0` — no error-level diagnostics.
- `1` — at least one error-level diagnostic, or a warning with `--error-on-warnings`.
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

- One `info` diagnostic per edit goes to stdout, with the rewrite as a line diff.
- An offered fix reads `Safe fix:` when it writes a value the tool knows (`forbidden-tag`
  renames, `module-name`) and `Unsafe fix:` when it writes a `TODO` or `k=?, rows=?`
  placeholder a human still has to replace (`missing-doc`, `missing-tag`,
  `missing-constraints`). `fill-constraints` writes measured values, so its fixes are
  safe.
- A write run heads each with `FIXED`; `--dry-run` heads each with `FIXABLE` and keeps
  the code frame of the unchanged file.
- The summary reads `Fixed N files.` for a write run, `No fixes applied.` for a preview.

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

## Fill constraints

`fill-constraints` measures every circuit that already carries the constraints tag and
writes the value in, so `check --strict` is clean afterwards and a second run is a no-op.
`k` and `rows` reach only the compiler's terminal output, so each contract is compiled
under a pty and the progress lines are parsed.

```sh
compact-lint fill-constraints [PATHS]... [--config <file>] [--dry-run] [--no-compile] [--compact-bin <path>] [--artifacts <dir>]
```

- `PATHS` and `--config` resolve exactly as they do for `check`.
- `--dry-run` — report the changes and write nothing, the measurement cache included.
- `--no-compile` — read the `.circuit-info.json` caches instead of compiling. A source
  with no cached entry is an error.
- `--compact-bin <path>` — path to the `compact` binary, as for `check`. Also settable
  with `COMPACT_LINT_COMPACT_BIN`.
- `--artifacts <dir>` — where the compiler writes. Without it a temporary directory is
  used and removed at the end.

Scope is the annotations that already exist: every exported non-pure circuit whose doc
comment carries `constraints.tag`, whatever its value. A circuit with no annotation is
`fix`'s job and is left alone here. A file holding a parse defect is skipped, so `check`
stays the place a syntax error is reported.

Each filled value is an `info` diagnostic carrying the annotation's before and after:

```
contracts/src/access/Ownable.compact:59:6 fill  FIXED  ━━━━━━━━━━

  i Circuit `transferOwnership` measures k=13, rows=4273.

  i Applied fix: Set @constraints to k=13, rows=4273

    59    │ - ···*·@constraints·k=?,·rows=?
       59 │ + ···*·@constraints·k=13,·rows=4273
```

The `Filled N values in M files.` summary goes to stderr, with `Found N warnings.` under
it. `M` counts the files that changed; the warnings are the tagged circuits left without
a value, including the ones in a file with no measurement source.

### How a source is resolved

A library module does not compile on its own, so its constraints are measured through the
mock contract that exports the same circuit names. For each file, in order:

1. `constraints.overrides`, an exact path-to-path mapping.
2. `constraints.self`, globs for files that are contracts and compile themselves.
3. `constraints.sources`, templates expanded and tried until one exists. `{dir}` is the
   file's directory, `{parent}` its parent, `{stem}` its name without the extension.

Each distinct source is compiled once per run, whatever the number of files it measures.

### The cache

After a compile, the measurements are merged into `.circuit-info.json` beside the source,
keyed by the source's file name. It is the file the TypeScript builder in
`packages/builder` writes, in the same shape, so the two tools share it:

```json
{
  "generatedAt": "2026-09-15T08:38:49.000Z",
  "files": {
    "MockOwnable.compact": [{ "name": "owner", "k": 7, "rows": 74 }]
  }
}
```

Other files' entries are kept and `generatedAt` is refreshed. `--no-compile` reads this
file instead of running the compiler.

### Unmeasured

A tagged circuit is *unmeasured* when its source compiled but produced no measurement for
its name. That happens where the mock has no exported circuit of that name — `initialize`
is called from the mock's constructor, never exported — or where the compiler's
`contract-info.json` marks the circuit `proof: false`, which carries no constraints. The
value is left alone and the circuit is reported as `constraints-unmeasured`, at `warn`
by default, with the source that measures it named in the advice.

A file with no measurement source at all is reported once as `constraints-unmeasurable`,
with the candidates tried named in the advice.

Exit codes:

- `0` — every tagged circuit was measured, whether or not a value changed.
- `1` — at least one circuit is unmeasured or unmeasurable.
- `2` — usage, config, IO, compiler or missing-cache error. A failed compile prints the
  source and the last 20 lines of the compiler's cleaned output; the raw pty stream is
  never printed.

Files are rewritten exactly as `fix` rewrites them: through a sibling `.tmp` file, keeping
the line ending, and only the annotation's own line changes.

## Rules

| Rule | Meaning |
| --- | --- |
| `missing-doc` | The declaration needs docs per `kinds.<kind>.docs` and has no doc comment attached. |
| `missing-tag` | A tag listed in `kinds.<kind>.tags` is absent from the doc comment. |
| `forbidden-tag` | A tag listed in `tags.forbid` is present. |
| `module-name` | `@module <Name>` does not name the module it documents. |
| `missing-constraints` | An exported non-pure circuit has no constraints tag. |
| `constraints-format` | The constraints value is not `k=<n>, rows=<n>`. |
| `constraints-placeholder` | The constraints value still holds a `?`. |
| `constraints-unmeasured` | `fill-constraints` only: the source compiled but measured no circuit of that name. |
| `constraints-unmeasurable` | `fill-constraints` only: no measurement source resolves for the file. |
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

`compact.toml`, searched for upward from the current directory. The linter reads its
`[lint]` table; every key below is a key of that table.

- The file is shared with [`compact-deploy`](../../packages/deployer), which owns
  `[profile]`, `[networks.*]`, `[wallet]` and `[contracts.*]` in the same file.
- Tables the linter does not own are ignored, so a deployer-only key is never a lint
  error.
- Every field under `[lint]` is optional; an unknown one is rejected.
- A `compact.toml` with no `[lint]` table is a config error, exit `2`. No `compact.toml`
  anywhere up the tree is not: the run uses the built-in defaults.
- A config found by walking upward anchors the `include` globs at its own directory; a
  config named with `--config` is a shareable preset, so the globs stay anchored at the
  current directory.

```toml
[lint]
include = ["contracts/src/**/*.compact"]
exclude = ["**/test/mocks/**", "**/archive/**"]

[lint.constraints]
tag = "@constraints"
compiler = "0.34.0"
sources = ["{dir}/test/mocks/Mock{stem}.compact", "{parent}/test/mocks/Mock{stem}.compact"]
self = ["**/presets/**"]

[lint.constraints.overrides]
"contracts/src/utils/Utils.compact" = "contracts/src/utils/test/mocks/MockUtils.compact"

[lint.tags]
forbid = ["@return"]
rename = { "@return" = "@returns" }

[lint.fix]
placeholder = "TODO"

[lint.rules]
constraints-placeholder = "warn"

[lint.kinds.module]
docs = "exported"
tags = ["@module", "@description"]
```

Defaults when no config file is found:

| Key | Default |
| --- | --- |
| `include` | `["**/*.compact"]` |
| `exclude` | `[]` |
| `constraints.tag` | `"@constraints"` |
| `constraints.compiler` | none, so `compact` picks its default toolchain |
| `constraints.sources` | `["{dir}/test/mocks/Mock{stem}.compact", "{parent}/test/mocks/Mock{stem}.compact"]` |
| `constraints.self` | `[]` |
| `constraints.overrides` | `{}` |
| `tags.forbid` | `[]` |
| `tags.rename` | `{}` |
| `fix.placeholder` | `"TODO"` |
| `rules.<rule>` | `"error"`, except the four listed under Diagnostic levels |
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
- `tags.rename` maps a forbidden tag to the tag `fix` writes in its place. Both spellings
  are validated like every other tag. An unmapped forbidden tag is reported, never
  rewritten.
- `fix.placeholder` is the text `fix` writes where it has no value of its own.
- `rules` takes one key per rule id, valued `"off"`, `"info"`, `"warn"` or `"error"`.
- `constraints.compiler` is passed as `+<version>` to `compact compile`.
- `constraints.sources` templates are tried in order; the first existing file wins.
- `constraints.self` marks files that compile themselves, so no mock is looked for.
- `constraints.overrides` keys and values are paths relative to the config's directory,
  or to the current directory when the config came from `--config`.

`examples/compact.toml` is the config for OpenZeppelin/compact-contracts.

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
`compact.toml`, the `.compact` sources, and `expected.txt`, the exact stdout with
paths relative to the case directory. A case that also runs under a flag carries the
second expectation beside it, such as `expected-strict.txt`. The `clean` case carries
the deployer's tables too, and `no-lint-table` carries nothing else.

`tests/fixtures/fix-<case>/` holds one `fix` case per rule: a `compact.toml`,
`before/`, `after/`, `expected.txt` for the write run and `expected-dry-run.txt` for the
preview. The run copies `before/` into a temporary directory, so the fixtures are never
rewritten in place.

`tests/fixtures/fill-<case>/` holds the `fill-constraints` cases in the same shape, plus
`expected-settled.txt` for what a second run still reports. They
run against `tests/fixtures/fill-fake-compact/bin/compact`, a shell script that prints the
compiler's progress lines for a hard-coded table and writes a matching
`contract-info.json`, so the tests need no toolchain. It still runs through the pty, so
that path is covered too. `tests/fixtures/fill-transcript/pty.txt` is a captured
transcript of a real compile, for the parser's unit tests.
