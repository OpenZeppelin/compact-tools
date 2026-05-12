# Changelog

All notable changes to `@openzeppelin/compact-tools-builder` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Initial public release of `@openzeppelin/compact-tools-builder`.
- Programmatic API for orchestrating the Compact toolchain:
  - `CompactCompiler` — compiles `.compact` files to artifacts.
  - `CompactBuilder` — runs `CompactCompiler` then assembles a publishable
    `dist/`.
- Composable service classes: `EnvironmentValidator`, `FileDiscovery`,
  `CompilerService`, and the `UIService` helper object.
- Option types: `CompilerOptions`, `BuilderOptions`, `BuilderOnlyOptions`,
  `CompilerServiceOptions`, `BuildStep`, `ExecFunction`.
- Configurable behaviours:
  - `hierarchical` — preserve source tree in compiler artifacts and the
    builder's `.compact` copy step.
  - `exclude` — glob-style patterns to skip in file discovery and dist copy
    (`Mock*` / `*.mock.compact` excluded by default).
  - `cleanDist` — `rm -rf dist` before building.
  - `copyToDist` — extra files (e.g. `package.json`, `README.md`) to copy into
    `dist/` for publishable layouts.
  - `srcDir` / `outDir` — customize source and artifact directories.
- Structured error types: `CompactCliNotFoundError`, `CompilationError`,
  `DirectoryNotFoundError`, plus the `isPromisifiedChildProcessError` type guard.
- Dependency-injectable `ExecFunction` for testing.

### Notes

- This package contains the library code that previously lived under
  `@openzeppelin/compact-tools-cli`. The CLI package now ships only the bin
  entries (`compact-compiler`, `compact-builder`) and depends on this library.
