# Changelog

All notable changes to `@openzeppelin/compact-linter` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- The bin resolves `compact-lint` through the new `@openzeppelin/compact-launcher` dependency. Environment variables, cache paths and download URLs are unchanged

## 0.1.0 (2026-11-19)

### Added

- `compact-linter` bin, a launcher that downloads the [`compact-lint`](https://github.com/OpenZeppelin/compact-tools/tree/main/crates/compact-lint) release binary for the host, verifies its SHA-256, and runs it (#186)
- `check` reports doc-comment issues in Compact sources: a missing doc comment, a missing or forbidden tag, a `@module` name that differs from the module, and a missing or malformed `@constraints` annotation on an exported non-pure circuit (#182)
- `fix` writes the repairs `check` marks fixable: doc skeletons, missing tags and sections, tag renames, block order and `@constraints k=?, rows=?` placeholders. `--dry-run` previews them (#184)
- `fill-constraints` compiles each contract and writes every circuit's measured `k` and `rows` into its `@constraints` annotation and into `<artifacts>/<Contract>/circuit-info.json`, the file `compact-builder` writes (#185, #189)
- Config in the `[lint]` table of `compact.toml`, with a level per rule (`error`, `warn`, `info`, `off`) under `[lint.rules]` (#189)
- Section entries such as `@notice Privacy` in `kinds.<kind>.tags` and `sections`, with the `unknown-section` and `tag-order` rules (#189)
- `--reporter concise|github`, `--diagnostic-level`, `--error-on-warnings`, `--max-diagnostics`, `--colors` and `--timings` on every command (#189)
