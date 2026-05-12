# @openzeppelin/compact-tools

Umbrella package for the OpenZeppelin Compact developer tools. One install
gives you the build library, the simulator, and the CLI binaries — all
reachable from a single import path.

## Install

```bash
yarn add --dev @openzeppelin/compact-tools
```

## Use

```ts
import {
  // simulator
  createSimulator,
  // builder library
  CompactCompiler,
  CompactBuilder,
} from '@openzeppelin/compact-tools';
```

The package also exposes the `compact-compiler` and `compact-builder` binaries:

```bash
yarn compact-compiler --help
yarn compact-builder --help
```

Both binaries delegate to
[`@openzeppelin/compact-tools-cli`](https://www.npmjs.com/package/@openzeppelin/compact-tools-cli),
which in turn calls into
[`@openzeppelin/compact-tools-builder`](https://www.npmjs.com/package/@openzeppelin/compact-tools-builder).

## Want only one piece?

You can install constituents directly and skip the umbrella:

- [`@openzeppelin/compact-tools-builder`](https://www.npmjs.com/package/@openzeppelin/compact-tools-builder) — programmatic library (no bins)
- [`@openzeppelin/compact-tools-cli`](https://www.npmjs.com/package/@openzeppelin/compact-tools-cli) — bin wrapper only
- [`@openzeppelin/compact-tools-simulator`](https://www.npmjs.com/package/@openzeppelin/compact-tools-simulator) — simulator only

See the [monorepo README](https://github.com/OpenZeppelin/compact-tools#readme) for the full developer guide.

## License

MIT
