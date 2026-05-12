# @openzeppelin/compact-tools

Umbrella package for the OpenZeppelin Compact developer tools. One install gives
you both the CLI compiler/builder and the TypeScript simulator, exposed under
subpath exports.

## Install

```bash
yarn add --dev @openzeppelin/compact-tools
```

## Use

```ts
// Programmatic — testing/runtime side
import { createSimulator } from '@openzeppelin/compact-tools/simulator';

// Programmatic — build pipeline
import { CompactCompiler, CompactBuilder } from '@openzeppelin/compact-tools/cli';
```

The package also exposes the `compact-compiler` and `compact-builder` binaries:

```bash
yarn compact-compiler --help
yarn compact-builder --help
```

Both binaries delegate to [`@openzeppelin/compact-tools-cli`](https://www.npmjs.com/package/@openzeppelin/compact-tools-cli) — the umbrella simply re-exports the same entry points.

## Want only one piece?

You can install either constituent package directly and skip the umbrella:

- [`@openzeppelin/compact-tools-cli`](https://www.npmjs.com/package/@openzeppelin/compact-tools-cli) — CLI only
- [`@openzeppelin/compact-tools-simulator`](https://www.npmjs.com/package/@openzeppelin/compact-tools-simulator) — simulator only

See the [monorepo README](https://github.com/OpenZeppelin/compact-tools#readme) for the full developer guide.

## License

MIT
