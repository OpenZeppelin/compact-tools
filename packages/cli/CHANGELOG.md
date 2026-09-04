# Changelog

All notable changes to `@openzeppelin/compact-cli` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases before this file see the `compact-cli/v*` tags.

## Unreleased

### Added

- `compact-deploy` bin, a wrapper around [`@openzeppelin/compact-deployer`](../deployer) that deploys a compiled contract to a Midnight network (#86)

### Changed

- **Breaking:** compact-cli now requires Node 24. compact-deploy uses explicit resource management (`await using`, `AsyncDisposableStack`), unavailable on Node 22. (#86)
