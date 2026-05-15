[![Generic badge](https://img.shields.io/badge/Compact%20Compiler-0.29.0-1abc9c.svg)](https://docs.midnight.network/relnotes/compact/)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/OpenZeppelin/compact-tools/badge)](https://api.securityscorecards.dev/projects/github.com/OpenZeppelin/compact-tools)

This project extends the Midnight Network with additional developer tooling.

# OpenZeppelin Compact Tools

Tools for compiling, building, and testing Compact smart contracts. This is a monorepo containing:

- [`packages/builder`](./packages/builder) — programmatic library that drives the Compact compiler + builder
- [`packages/cli`](./packages/cli) — thin bin wrapper around the builder library (`compact-compiler`, `compact-builder`)
- [`packages/simulator`](./packages/simulator) — TypeScript simulator to run and test Compact contracts locally

See each package's README for usage, options, and examples.

## Installation

Pick the package that matches what you need:

```bash
# Programmatic library — call the compiler/builder from TypeScript
yarn add --dev @openzeppelin/compact-builder

# CLI bins (compact-compiler, compact-builder) for use in package.json scripts
yarn add --dev @openzeppelin/compact-cli

# Simulator — test Compact contracts locally
yarn add --dev @openzeppelin/compact-simulator
```

`compact-cli` depends transitively on `compact-builder`, so installing the CLI
gives you both the binaries and the underlying library.

```bash
yarn compact-compiler --help
yarn compact-builder --help
```

```ts
import { CompactCompiler, CompactBuilder } from '@openzeppelin/compact-builder';
import { createSimulator } from '@openzeppelin/compact-simulator';
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

## Development

Clone the repo and install dependencies at the root:

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

## Contributing

Before opening a PR, please read `CODE_OF_CONDUCT.md`. Use the root scripts to build, test, and format. For targeted work inside a package, run the scripts in that package directory.

## License

MIT
