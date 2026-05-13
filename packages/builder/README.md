# @openzeppelin/compact-builder

Programmatic library for compiling and building Compact smart contracts on the
Midnight network. Drives the `compactc` toolchain with progress reporting,
structured error handling, and configurable output layouts.

This is the **library** — it ships no CLI binaries. If you want the bins
(`compact-compiler`, `compact-builder`) for use in `package.json` scripts,
install [`@openzeppelin/compact-cli`](../cli) instead, which is a thin
wrapper around this library.

## Install

```bash
yarn add --dev @openzeppelin/compact-builder
```

## Quick Start

```ts
import { CompactCompiler, CompactBuilder } from '@openzeppelin/compact-builder';

// Compile all .compact files in src/ to artifacts/
await new CompactCompiler({ flags: '--skip-zk' }).compile();

// Or run the full build pipeline (compile + dist assembly)
const builder = new CompactBuilder({
  cleanDist: true,
  hierarchical: true,
  exclude: ['Mock*', '*/archive/*'],
  copyToDist: ['package.json', '../README.md'],
});
await builder.build();
```

## Public API

```ts
// Orchestrators
export class CompactCompiler { /* … */ }
export class CompactBuilder  { /* … */ }

// Service classes (use for advanced custom pipelines)
export class EnvironmentValidator { /* … */ }
export class FileDiscovery        { /* … */ }
export class CompilerService      { /* … */ }
export const UIService = { /* … */ };

// Option types
export interface CompilerOptions { /* flags, targetDir, version, hierarchical, srcDir, outDir, exclude */ }
export type BuilderOptions = CompilerOptions & {
  cleanDist?: boolean;
  copyToDist?: string[];
};

// Errors
export class CompactCliNotFoundError extends Error { /* … */ }
export class CompilationError        extends Error { /* … */ }
export class DirectoryNotFoundError  extends Error { /* … */ }
```

## See also

- [`@openzeppelin/compact-cli`](https://www.npmjs.com/package/@openzeppelin/compact-cli) — bin wrapper around this library
- [`@openzeppelin/compact-simulator`](https://www.npmjs.com/package/@openzeppelin/compact-simulator) — TypeScript simulator for testing Compact contracts locally

See the [monorepo README](https://github.com/OpenZeppelin/compact-tools#readme) for the full developer guide.

## License

MIT
