# Changelog

All notable changes to `@openzeppelin/compact-tools-cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Initial public release of `@openzeppelin/compact-tools-cli` as a thin bin
  wrapper around [`@openzeppelin/compact-tools-builder`](../builder).
- `compact-compiler` bin — orchestrates `compact compile` over a project's
  `.compact` files with progress reporting and structured error handling.
- `compact-builder` bin — runs the compiler then assembles a publishable
  `dist/` for npm.
- CLI options:
  - `--dir <directory>` — scope to a subdirectory
  - `--src <directory>` / `--out <directory>` — customize source / artifact dirs
  - `--hierarchical` — preserve source tree in artifacts and `.compact` copy
  - `--exclude <pattern>` — skip `.compact` files matching a glob (repeatable);
    applies to both the compiler's file discovery and the builder's copy step
  - `--clean-dist` — `rm -rf dist` before building
  - `--copy <path>` — copy extra files into `dist/` (repeatable; e.g.
    `package.json`, `../README.md`)
  - `+<version>` — pin the Compact toolchain version per invocation
  - `SKIP_ZK=true` env var — equivalent to `--skip-zk`

### Notes

- The programmatic API (CompactCompiler, CompactBuilder, services, types)
  previously shipped from this package has moved to
  `@openzeppelin/compact-tools-builder`. This package now ships only the bin
  entries.
