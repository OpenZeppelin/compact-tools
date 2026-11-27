# Changelog

All notable changes to `@openzeppelin/compact-cli` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases before this file see the `compact-cli/v*` tags.

## Unreleased

### Added

- `compact-compiler` runs `compact-mock build` before compiling when the nearest `compact.toml` has a `[mock]` table, passing on `+<version>`, `--skip-zk`, the search directory, the `--only` globs and, after `--`, the other compiler flags. Its own walk then excludes the artifacts directory under `[mock].test_dir` (`*/test/artifacts/*` by default) and `*.fragment.compact`. It needs `@openzeppelin/compact-mocker` or `COMPACT_MOCK_BINARY`, and a failed mock build stops the compile (#247)
- `compact-compiler --no-mocks` skips the mock build (#247)

### Changed

- `compact-builder` never compiles or ships generated mocks or fragments. It always applies the same two excludes, with the default `test_dir` when the nearest `compact.toml` has no `[mock]` table, through the new `@openzeppelin/compact-builder` option `alwaysExclude`, which `only` does not lift and which keeps the default `Mock*` copy excludes (#247)
- `compact-compiler` and `compact-builder` fail when the nearest `compact.toml` does not parse (#247)

## 0.3.1 (2026-11-19)

### Changed

- `pino` moves to `^10.3.1`, as it does in `@openzeppelin/compact-deployer` `0.5.1`, which `compact-deploy` now runs (#231)

### Fixed

- `compact-compiler` and `compact-builder` run compactc in a 500 by 200 terminal, so `circuit-info.json` lists every circuit. With a non-terminal stdin the terminal was 0x0 and the file dropped the last circuit (#230)

## 0.3.0 (2026-11-18)

### Changed

- **Breaking:** `compact-deploy` runs `@openzeppelin/compact-deployer` `0.5.0`, on midnight-js `5.0.0`. It needs proof server `9.0.0` or newer, indexer `4.4.0-rc.6` or newer, and a node newer than `2.1.0-rc.4`. See the deployer's changelog (#220)
- **Breaking:** `compact-compiler` and `compact-builder` write `<artifacts>/<Contract>/circuit-info.json` beside `compiler/contract-info.json`, and no longer write `.circuit-info.json` into the source tree (#191)

## 0.2.0 (2026-11-05)

### Changed

- **Breaking:** `compact-deploy` runs `@openzeppelin/compact-deployer` `0.4.0`, which loads artifacts compiled with compactc `0.36.0` on `@midnight-ntwrk/compact-runtime` `0.21.0`. An older artifact throws `Version mismatch` when it loads (#208)

## 0.1.1 (2026-09-15)

### Changed

- `compact-deploy` runs `@openzeppelin/compact-deployer` `^0.2.0`, so a contract too large for one deploy transaction splits across maintenance updates (#188)

## 0.1.0 (2026-09-15)

### Added

- `compact-deploy --circuits-per-tx <n>` forwards the fragment budget to the deployer, splitting a contract too large for one deploy transaction (#174)
- `compact-deploy` bin, a wrapper around [`@openzeppelin/compact-deployer`](../deployer) that deploys a compiled contract to a Midnight network (#86)
- `--only <glob>` on `compact-compiler` and `compact-builder`, the include counterpart of `--exclude`, so a single file can be selected without chaining two passes (#175)

### Changed

- **Breaking:** compact-cli now requires Node 24. compact-deploy uses explicit resource management (`await using`, `AsyncDisposableStack`), unavailable on Node 22. (#86)
