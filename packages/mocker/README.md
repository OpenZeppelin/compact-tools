# @openzeppelin/compact-mocker

Bin wrapper around the [`compact-mock`](../../crates/compact-mock) Rust crate, the mock
contract generator for Compact modules. The package itself is a thin bin: it resolves
the native binary for the host with [`@openzeppelin/compact-launcher`](../launcher) and
runs it with your arguments.

## Install

```bash
yarn add --dev @openzeppelin/compact-mocker
```

```bash
yarn compact-mock generate
yarn compact-mock build +0.36.0 --skip-zk
```

- Rules live in the `[mock]` table of `compact.toml`.
- `generate` writes each mock to its module's `test/artifacts/` directory, which git
  ignores. `build` also compiles it there.
- `compact-compiler` from [`@openzeppelin/compact-cli`](../cli) runs `build` before its
  own compile when `[mock]` exists, so this package is the dependency it needs.

The commands, the `[mock]` keys, ownership and exit codes are documented in the
[crate README](../../crates/compact-mock/README.md).

## Where the binary comes from

- Prebuilt binaries are attached to the `compact-mocker/v<version>` GitHub release, one
  per target: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
  `x86_64-apple-darwin`, `aarch64-apple-darwin`.
- The first run downloads the one matching the host, checks its SHA-256 against the
  `checksums.txt` published inside this package, and caches it as
  `compact-mock-<version>-<target>` in `$XDG_CACHE_HOME/compact-mocker` or
  `~/.cache/compact-mocker` on Linux, `~/Library/Caches/compact-mocker` on macOS. A new
  cache directory is created with mode `0700`. The installed package is never written
  to, so read-only installs and Yarn Plug'n'Play work.
- Every run checks the cached binary against `checksums.txt` again before starting it.
  A cached file that does not match, or is not a regular file, is reported and downloaded
  again. The check and the start are separate steps, so a process running as you can still
  swap the file between them.
- No prebuilt binary for the host, musl Linux included, is a hard error: build the crate
  with `cargo install --path crates/compact-mock` and set `COMPACT_MOCK_BINARY`.

## Environment

| Variable | Effect |
| --- | --- |
| `COMPACT_MOCK_BINARY` | Run this executable and skip the download. For local crate builds and air-gapped CI. |
| `COMPACT_MOCK_DOWNLOAD_BASE` | Fetch the asset from this base URL instead of the GitHub release. It is still checked against the package's `checksums.txt`. |

## Requirements

- Node.js >= 24
- Linux with glibc, or macOS; x86_64 or aarch64
