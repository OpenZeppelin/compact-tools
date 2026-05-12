# Changelog

All notable changes to `@openzeppelin/compact-tools` (umbrella) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Initial public release of the `@openzeppelin/compact-tools` umbrella.
- Single root export re-exporting everything from
  `@openzeppelin/compact-tools-builder` and
  `@openzeppelin/compact-tools-simulator`, so consumers can pull anything off
  the umbrella with a single import:
  ```ts
  import { createSimulator, CompactCompiler, CompactBuilder } from '@openzeppelin/compact-tools';
  ```
- `compact-compiler` and `compact-builder` bin entries that delegate to
  `@openzeppelin/compact-tools-cli`, so a single install of the umbrella gives
  consumers both the binaries and the programmatic API surface.
