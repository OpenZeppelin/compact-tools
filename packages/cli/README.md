# @openzeppelin/compact-cli

CLI wrapper around [`@openzeppelin/compact-builder`](../builder) and
[`@openzeppelin/compact-deployer`](../deployer). Provides the
`compact-compiler`, `compact-builder`, and `compact-deploy` binaries for use
in `package.json` scripts. Contains no programmatic API of its own. If you
want to call the compiler, builder, or deployer from TypeScript, use the
library package directly.

## Install

```bash
yarn add --dev @openzeppelin/compact-cli
```

## Use

```bash
yarn compact-compiler --help
yarn compact-builder --help
yarn compact-deploy --help
```

Typical `package.json` scripts (replace `<version>` with the Compact
toolchain release you want to pin, e.g. `+0.29.0`):

```json
{
  "scripts": {
    "compact": "compact-compiler +<version> --exclude '*/archive/*'",
    "compact:access": "compact-compiler +<version> --dir access",
    "compact:mocks": "compact-compiler +<version> --dir crypto/test/mocks --only 'MockEcdsa.compact'",
    "build": "compact-builder +<version> --clean-dist --hierarchical --copy package.json --copy ../README.md",
    "test": "compact-compiler +<version> --skip-zk && vitest run"
  }
}
```

## Options

### `compact-deploy`

Deploys a compiled contract to a Midnight network. Options are documented
in full under [`@openzeppelin/compact-deployer`](../deployer); the common
ones are `--network`, `--config`, `--seed-file`, `--dry-run`, and `--json`.

```bash
compact-deploy <Contract> --network local
```

### `compact-compiler` and `compact-builder`

Both accept the same compiler-side options (forwarded to the underlying
library); `compact-builder` additionally accepts dist-layout options:

| Flag | Applies to | Description |
|---|---|---|
| `--dir <directory>` | both | Scope to a subdirectory inside `--src`. |
| `--src <directory>` | both | Source directory containing `.compact` files (default: `src`). |
| `--out <directory>` | both | Output directory for compiled artifacts (default: `artifacts`). |
| `--hierarchical` | both | Preserve source directory structure in artifacts AND in the builder's `.compact` copy. |
| `--exclude <pattern>` | both | Skip `.compact` files matching the glob (repeatable). Default for the builder: `Mock*`, `*.mock.compact`. |
| `--only <pattern>` | both | Keep only `.compact` files matching the glob (repeatable). Applied before `--exclude`; a non-empty `--only` also drops the builder's default excludes. No match compiles nothing and warns. |
| `--skip-zk` | compiler | Skip zero-knowledge proof generation (also via `SKIP_ZK=true` env var). |
| `+<version>` | both | Pin the Compact toolchain version (e.g `+0.29.0`). |
| `--no-mocks` | compiler | Skip the mock build below. |
| `--clean-dist` | builder | `rm -rf dist` before building. |
| `--copy <path>` | builder | Copy an extra file into `dist/` (repeatable; e.g. `package.json`, `../README.md`). |

See [`@openzeppelin/compact-builder`](../builder) for the full
documentation, programmatic API, and behavioural details.

### Mock build

When the nearest `compact.toml` at or above the working directory has a `[mock]` table,
`compact-compiler` runs `compact-mock build` first, so a new module circuit reaches its
mocks on the next compile.

- The build gets only `+<version>`, `--skip-zk` (or `SKIP_ZK=true`) and the search
  directory (`--src`, `--dir`), so `--dir access` builds only that directory's mocks.
- The compiler's own walk then excludes `*/artifacts/*` and `*.fragment.compact`, so
  generated mocks are not compiled twice and fragments are not compiled alone.
- `--no-mocks` skips the build. The two excludes still apply.
- A failed build stops the run before compiling: `Mock build failed (compact-mock exit
  <code>)`.
- The binary is `COMPACT_MOCK_BINARY` when set, else the bin of
  [`@openzeppelin/compact-mocker`](../mocker). Without either the run fails with an
  install hint.
- A `compact.toml` that does not parse fails the run.
- Without a `[mock]` table nothing changes. `compact-builder` never builds mocks.

The `[mock]` keys are documented in the
[`compact-mock` README](../../crates/compact-mock/README.md).

## Requirements

- Node.js >= 24 for `compact-deploy`, which uses explicit resource management (`await using` / `AsyncDisposableStack`), global only from Node 24. The compiler and builder binaries run on older releases.
- Midnight Compact toolchain installed and available in `PATH`

```bash
$ compact compile --version
Compactc version: 0.29.0
```

## See also

- [`@openzeppelin/compact-builder`](https://www.npmjs.com/package/@openzeppelin/compact-builder) — programmatic library backing this CLI
- [`@openzeppelin/compact-simulator`](https://www.npmjs.com/package/@openzeppelin/compact-simulator) — simulator for testing Compact contracts

## License

MIT
