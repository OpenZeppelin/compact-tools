# Changelog

All notable changes to `@openzeppelin/compact-linter` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `check` reports `mock-coverage` (default `warn`) when `compact.toml` has a `[mock]` table: a module under its `src` that no `[[mock.rules]]` glob matches and `[mock].exclude` does not list, and an exported circuit that none of its generated mocks exposes. A `[mock]` table that does not load exits 2 (#247)

### Changed

- `constraints.sources` defaults to `{dir}/test/artifacts/Mock{stem}.compact` first, where `compact-mock` writes a generated mock, then the two `test/mocks` templates (#247)

## 0.2.0 (2026-11-26)

### Added

- `check` reports a tag value, section body or untagged paragraph still equal to `fix.placeholder`, such as the `TODO` that `fix` writes, as `doc-placeholder`: a warning that `--strict` makes an error (#244)

### Changed

- The bin resolves `compact-lint` through the new `@openzeppelin/compact-launcher` dependency. Environment variables, cache paths and download URLs are unchanged (#239)
- The cached `compact-lint` binary is now verified against the package's `checksums.txt` on every run, and downloaded again when it does not match or is not a regular file. Without `COMPACT_LINT_BINARY`, a run with no `checksums.txt` in the package exits 2. A new cache directory gets mode `0700` (#239)
- A `fix.placeholder` that opens with a tag, such as `@todo`, is a config error (#244)
- `fix` puts a blank line under a tag it inserts above untagged prose, so the prose no longer becomes the tag's value (#244)

## 0.1.0 (2026-11-19)

### Added

- `compact-linter` bin, a launcher that downloads the [`compact-lint`](https://github.com/OpenZeppelin/compact-tools/tree/main/crates/compact-lint) release binary for the host, verifies its SHA-256, and runs it (#186)
- `check` reports doc-comment issues in Compact sources: a missing doc comment, a missing or forbidden tag, a `@module` name that differs from the module, and a missing or malformed `@constraints` annotation on an exported non-pure circuit (#182)
- `fix` writes the repairs `check` marks fixable: doc skeletons, missing tags and sections, tag renames, block order and `@constraints k=?, rows=?` placeholders. `--dry-run` previews them (#184)
- `fill-constraints` compiles each contract and writes every circuit's measured `k` and `rows` into its `@constraints` annotation and into `<artifacts>/<Contract>/circuit-info.json`, the file `compact-builder` writes (#185, #189)
- Config in the `[lint]` table of `compact.toml`, with a level per rule (`error`, `warn`, `info`, `off`) under `[lint.rules]` (#189)
- Section entries such as `@notice Privacy` in `kinds.<kind>.tags` and `sections`, with the `unknown-section` and `tag-order` rules (#189)
- `--reporter concise|github`, `--diagnostic-level`, `--error-on-warnings`, `--max-diagnostics`, `--colors` and `--timings` on every command (#189)
