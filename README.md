[![Generic badge](https://img.shields.io/badge/Compact%20Compiler-0.26.0-1abc9c.svg)](https://docs.midnight.network/relnotes/compact/minokawa-0-18-26-0)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

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
- Turbo
- Optional: Midnight Compact toolchain installed and available in `PATH`

Confirm your Compact toolchain:

```bash
$ compact compile --version

Compactc version: 0.26.0
0.26.0
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
yarn fmt-and-lint
yarn fmt-and-lint:fix
```

Clean generated artifacts:

```bash
yarn clean
```

## Packages

### `@openzeppelin/compact-tools-cli` (packages/cli)

Utilities and CLIs around the Compact compiler and builder.

- Binaries provided:
  - `compact-compiler` → `packages/cli/dist/runCompiler.js`
  - `compact-builder` → `packages/cli/dist/runBuilder.js`

Useful commands:

```bash
# From repo root (via Turbo filters)
yarn compact

# Or inside the package
cd packages/cli
yarn build           # compile TypeScript
yarn test            # run unit tests
yarn types           # type-check only
```

After building, you can invoke the CLIs directly, for example:

```bash
node dist/runCompiler.js --help
node dist/runBuilder.js --help
```

### `@openzeppelin/compact-tools-simulator` (packages/simulator)

A local simulator to execute Compact contracts in tests.

Build and test:

```bash
cd packages/simulator
yarn build
yarn test
```

Minimal usage example:

```ts
import { createSimulator } from '@openzeppelin/compact-tools-simulator';

// Create a simulator instance (see package docs and tests for full examples)
const simulator = createSimulator({});

// Use simulator to deploy/execute contract circuits, inspect state, etc.
// (Refer to `packages/simulator/src/integration` and `src/unit` tests.)
```

## Contributing

Before opening a PR, please read `CODE_OF_CONDUCT.md`. Use the root scripts to build, test, and format. For targeted work inside a package, run the scripts in that package directory.

## License

MIT

 
