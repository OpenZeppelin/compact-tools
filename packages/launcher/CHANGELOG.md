# Changelog

All notable changes to `@openzeppelin/compact-launcher` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `resolveBinary`, which returns the path to a Compact tool's Rust binary: the executable its override variable names, else the GitHub release asset for the host, checked against the calling package's `checksums.txt` and cached per user (#239)
- `userCacheDir` and `isMusl`, the per-user cache directory and the musl check a caller passes to `resolveBinary` (#239)
- `hostOptions`, the `resolveBinary` options for the running process: its host, environment and user cache, and the version in the package's `package.json` (#239)
- `runBin`, the body of a bin: it resolves the binary, runs it on the bin's arguments and returns the exit code to pass on, which is 2 when the binary cannot be resolved or started and `128 + n` when signal `n` ends it (#239)
- `resolveBinary` verifies the cached binary on every run: it must be a regular file whose SHA-256 matches `checksums.txt`, else it is reported through `notify`, downloaded again and replaced. `checksums.txt` is required for a cache hit too, and a new cache directory gets mode `0700` (#239)
