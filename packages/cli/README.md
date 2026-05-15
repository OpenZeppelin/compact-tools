# @openzeppelin/compact-cli

CLI wrapper around [`@openzeppelin/compact-builder`](../builder).
Provides the `compact-compiler` and `compact-builder` binaries for use in
`package.json` scripts. Contains no programmatic API of its own. If you want
to call the compiler/builder from TypeScript, use the library package directly.

## Install

```bash
yarn add --dev @openzeppelin/compact-cli
```

## Use

```bash
yarn compact-compiler --help
yarn compact-builder --help
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

Both binaries accept the same compiler-side options (forwarded to the
underlying library); `compact-builder` additionally accepts dist-layout
options:

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

- Node.js >= 20
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
