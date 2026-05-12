# @openzeppelin/compact-tools-cli

CLI wrapper around [`@openzeppelin/compact-tools-builder`](../builder).
Provides the `compact-compiler` and `compact-builder` binaries for use in
`package.json` scripts. Contains no programmatic API of its own — if you want
to call the compiler/builder from TypeScript, use the library package directly.

## Install

```bash
yarn add --dev @openzeppelin/compact-tools-cli
```

## Use

```bash
yarn compact-compiler --help
yarn compact-builder --help
```

Typical `package.json` scripts:

```json
{
  "scripts": {
    "compact": "compact-compiler +0.29.0 --exclude '*/archive/*'",
    "compact:access": "compact-compiler +0.29.0 --dir access",
    "build": "compact-builder +0.29.0 --clean-dist --hierarchical --copy package.json --copy ../README.md",
    "test": "compact-compiler +0.29.0 --skip-zk && vitest run"
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
| `+<version>` | both | Pin the Compact toolchain version (e.g. `+0.29.0`). |
| `--clean-dist` | builder | `rm -rf dist` before building. |
| `--copy <path>` | builder | Copy an extra file into `dist/` (repeatable; e.g. `package.json`, `../README.md`). |

See [`@openzeppelin/compact-tools-builder`](../builder) for the full
documentation, programmatic API, and behavioural details.

## Requirements

- Node.js >= 20
- Midnight Compact toolchain installed and available in `PATH`

```bash
$ compact compile --version
Compactc version: 0.29.0
```

## See also

- [`@openzeppelin/compact-tools-builder`](https://www.npmjs.com/package/@openzeppelin/compact-tools-builder) — programmatic library backing this CLI
- [`@openzeppelin/compact-tools-simulator`](https://www.npmjs.com/package/@openzeppelin/compact-tools-simulator) — simulator for testing Compact contracts
- [`@openzeppelin/compact-tools`](https://www.npmjs.com/package/@openzeppelin/compact-tools) — umbrella package giving you all three under subpath exports

## License

MIT
