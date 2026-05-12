[![Generic badge](https://img.shields.io/badge/Compact%20Compiler-0.29.0-1abc9c.svg)](https://docs.midnight.network/relnotes/compact/)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/OpenZeppelin/compact-tools/badge)](https://api.securityscorecards.dev/projects/github.com/OpenZeppelin/compact-tools)

This project extends the Midnight Network with additional developer tooling.

# OpenZeppelin Compact Tools

Tools for compiling, building, and testing Compact smart contracts. This is a monorepo containing:

- `packages/cli`: CLI utilities to run the Compact compiler and builder
- `packages/simulator`: TypeScript simulator to run and test Compact contracts locally
- `packages/tools`: Umbrella package re-exporting both under subpath exports

## Installation

The fastest path is the umbrella package, which gives you the CLI binaries and
the simulator under subpath exports in a single install:

```bash
yarn add --dev @openzeppelin/compact-tools
```

```ts
import { createSimulator } from '@openzeppelin/compact-tools/simulator';
import { CompactCompiler, CompactBuilder } from '@openzeppelin/compact-tools/cli';
```

```bash
yarn compact-compiler --help
yarn compact-builder --help
```

If you want only one piece, install the corresponding constituent directly:

```bash
# Simulator only (test/runtime side)
yarn add --dev @openzeppelin/compact-tools-simulator

# CLI utilities only (compile + build)
yarn add --dev @openzeppelin/compact-tools-cli
```

### Developing against unreleased changes

If you need a not-yet-published change, you can consume this repo locally via a
git submodule + `file:` dependency:

```bash
git submodule add https://github.com/OpenZeppelin/compact-tools tools/compact-tools
yarn --cwd tools/compact-tools install
yarn --cwd tools/compact-tools build

# In your package.json
"devDependencies": {
  "@openzeppelin/compact-tools-simulator": "file:./tools/compact-tools/packages/simulator",
  "@openzeppelin/compact-tools-cli": "file:./tools/compact-tools/packages/cli"
}
```

## Requirements

- Node.js >= 20 (root and `packages/cli`), >= 22 for `packages/simulator`
- Yarn 4 (Berry)
- Turbo
- Optional: Midnight Compact toolchain installed and available in `PATH`

Confirm your Compact toolchain:

```bash
$ compact compile --version

Compactc version: 0.29.0
0.29.0
```

## Getting started

Install dependencies at the repo root:

```bash
nvm install
yarn
```

Build everything:

```bash
yarn build
```

Run tests (root runs package tests via Turbo):

```bash
yarn test
```

Format and lint (Biome):

```bash
yarn lint
yarn lint:fix
```

Clean generated artifacts:

```bash
yarn clean
```

## Packages

### `@openzeppelin/compact-tools-cli` ([packages/cli](./packages/cli))

CLI utilities for compiling and building Compact smart contracts.

**Quickstart:**

```bash
# Compile all .compact files
compact-compiler

# Skip ZK proofs for faster development builds
compact-compiler --skip-zk

# Compile a specific subdirectory
compact-compiler --dir security

# Skip mock files at discovery time
compact-compiler --exclude 'Mock*' --exclude '*.mock.compact'

# Full build (compile + TypeScript + copy .compact files into dist/)
compact-builder

# Library-publish build: clean dist, preserve src tree, copy package metadata
compact-builder \
  --clean-dist \
  --hierarchical \
  --copy package.json --copy ../README.md
```

See [packages/cli/README.md](./packages/cli/README.md) for full documentation including all options, programmatic API, and examples.

### `@openzeppelin/compact-tools-simulator` ([packages/simulator](./packages/simulator))

TypeScript simulator for testing Compact contracts locally.

**Quickstart:**

```ts
import { createSimulator } from '@openzeppelin/compact-tools-simulator';

const simulator = createSimulator({});
// Deploy and execute contract circuits, inspect state, etc.
```

See package tests in `packages/simulator/src/integration` and `src/unit` for full examples.

## Contributing

Before opening a PR, please read `CODE_OF_CONDUCT.md`. Use the root scripts to build, test, and format. For targeted work inside a package, run the scripts in that package directory.

## License

MIT
