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
| `--skip-zk` | compiler | Skip zero-knowledge proof generation (also via `SKIP_ZK=true` env var). |
| `+<version>` | both | Pin the Compact toolchain version (e.g `+0.29.0`). |
| `--clean-dist` | builder | `rm -rf dist` before building. |
| `--copy <path>` | builder | Copy an extra file into `dist/` (repeatable; e.g. `package.json`, `../README.md`). |

See [`@openzeppelin/compact-builder`](../builder) for the full
documentation, programmatic API, and behavioural details.

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
