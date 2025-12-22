[![Generic badge](https://img.shields.io/badge/Compact%20Compiler-0.26.0-1abc9c.svg)](https://docs.midnight.network/relnotes/compact/minokawa-0-18-26-0)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/OpenZeppelin/compact-tools/badge)](https://api.securityscorecards.dev/projects/github.com/OpenZeppelin/compact-tools)

# OpenZeppelin Compact Tools

Tools for compiling, building, and testing Compact smart contracts. This is a monorepo containing:

- `packages/cli`: CLI utilities to run the Compact compiler and builder
- `packages/simulator`: TypeScript simulator to run and test Compact contracts locally

## External usage (via git submodule until npm publish)

Until packages are published to the npm registry, you can consume this repo from another project using a git submodule:

```bash
# In your project
git submodule add https://github.com/OpenZeppelin/compact-tools
git submodule update --init --recursive

# Install and build the tools
yarn --cwd tools/compact-tools install
yarn --cwd tools/compact-tools build

# Use the simulator as a local dependency
# package.json
"devDependencies": {
  "@openzeppelin/compact-tools-simulator": "file:./compact-tools/packages/simulator"
}
yarn install

# Call the CLIs directly or via scripts
node compact-tools/packages/cli/dist/runCompiler.js --help
node compact-tools/packages/cli/dist/runBuilder.js --help
```

## Requirements

- Node.js >= 20 (root and `packages/cli`), >= 22 for `packages/simulator`
- Yarn 4 (Berry)
- Midnight Compact toolchain installed and available in `PATH`
- Prerelease of [compactc 0.27.0-rc.1](https://github.com/midnight-ntwrk/artifacts/releases/tag/compactc-v0.27.0-rc.1)

Confirm your Compact toolchain:

```bash
$ compact compile +0.27.0-rc.1 --version

0.27.0
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

# Compile specific directory
compact-compiler --dir security

# Full build (compile + TypeScript + copy artifacts)
compact-builder
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
