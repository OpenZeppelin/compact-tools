# Changelog

All notable changes to `@openzeppelin/compact-launcher` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `resolveBinary`, which returns the path to a Compact tool's Rust binary: the executable its override variable names, else the GitHub release asset for the host, checked against the calling package's `checksums.txt` and cached per user
- `userCacheDir` and `isMusl`, the per-user cache directory and the musl check a caller passes to `resolveBinary`
