# @openzeppelin/compact-linter

Bin wrapper around the [`compact-lint`](../../crates/compact-lint) Rust crate, the
doc-comment linter for Compact sources. The package itself is a thin launcher: it
resolves the native binary for the host and runs it with your arguments.

## Install

```bash
yarn add --dev @openzeppelin/compact-linter
```

```bash
npx @openzeppelin/compact-linter check
yarn compact-linter check contracts/src
yarn compact-linter fix --dry-run
```

Commands, flags, exit codes and the `[lint]` table of `compact.toml` are documented in
the [crate README](../../crates/compact-lint/README.md). `compact.toml` is the project's
one config file, shared with `compact-deploy`.

## Where the binary comes from

- Prebuilt binaries are attached to the `compact-linter/v<version>` GitHub release, one
  per target: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
  `x86_64-apple-darwin`, `aarch64-apple-darwin`.
- The first run downloads the one matching the host, checks its SHA-256 against the
  release's `checksums.txt`, and caches it at `.cache/compact-lint-<version>-<target>`
  inside the installed package. Later runs print nothing and start it directly.
- Uninstalling the package removes the cache with it.
- No prebuilt binary for the host is a hard error: build the crate with
  `cargo install --path crates/compact-lint` and point `COMPACT_LINT_BINARY` at it.

## Environment

| Variable | Effect |
| --- | --- |
| `COMPACT_LINT_BINARY` | Run this executable and skip the download. For local crate builds and air-gapped CI. |
| `COMPACT_LINT_DOWNLOAD_BASE` | Fetch the asset and `checksums.txt` from this base URL instead of the GitHub release. |
| `COMPACT_LINT_COMPACT_BIN` | Read by the linter itself: path to the `compact` binary. |

## Requirements

- Node.js >= 24
- Linux or macOS, x86_64 or aarch64
