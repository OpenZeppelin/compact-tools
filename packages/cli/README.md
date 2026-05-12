# @openzeppelin/compact-tools-cli

CLI utilities for compiling and building Compact smart contracts.

## Installation

Until published to npm, use via git submodule or local path:

```bash
# As a local dependency
yarn add @openzeppelin/compact-tools-cli@file:./compact-tools/packages/cli

# Or invoke directly after building
node compact-tools/packages/cli/dist/runCompiler.js
```

## Requirements

- Node.js >= 20
- Midnight Compact toolchain installed and available in `PATH`

Verify your Compact installation:

```bash
$ compact compile --version
Compactc version: 0.28.0
```

## Binaries

This package provides two CLI binaries:

| Binary | Script | Description |
|--------|--------|-------------|
| `compact-compiler` | `dist/runCompiler.js` | Compile `.compact` files to artifacts |
| `compact-builder` | `dist/runBuilder.js` | Compile + build TypeScript + copy artifacts |

## Compiler CLI

### Usage

```bash
compact-compiler [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--dir <directory>` | Compile specific subdirectory within src | (all) |
| `--src <directory>` | Source directory containing `.compact` files | `src` |
| `--out <directory>` | Output directory for compiled artifacts | `artifacts` |
| `--hierarchical` | Preserve source directory structure in output | `false` |
| `--exclude <pattern>` | Skip `.compact` files matching the glob (repeatable). Patterns with `/` match the path relative to `--src`; others match the filename only. | (none) |
| `--skip-zk` | Skip zero-knowledge proof generation | `false` |
| `+<version>` | Use specific toolchain version (e.g., `+0.28.0`) | (default) |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SKIP_ZK=true` | Equivalent to `--skip-zk` flag |

### Artifact Output Structure

**Default (flattened):** All contract artifacts go directly under the output directory.

```
src/
  access/
    AccessControl.compact
  token/
    Token.compact

artifacts/           # Flattened output
  AccessControl/
  Token/
```

**Hierarchical (`--hierarchical`):** Preserves source directory structure.

```
artifacts/           # Hierarchical output
  access/
    AccessControl/
  token/
    Token/
```

### Examples

```bash
# Compile all contracts (flattened output)
compact-compiler

# Compile with hierarchical artifact structure
compact-compiler --hierarchical

# Compile specific directory only
compact-compiler --dir security

# Skip ZK proof generation (faster, for development)
compact-compiler --skip-zk

# Use specific toolchain version
compact-compiler +0.28.0

# Custom source and output directories
compact-compiler --src contracts --out build

# Combine options
compact-compiler --dir access --skip-zk --hierarchical

# Use environment variable
SKIP_ZK=true compact-compiler
```

## Builder CLI

The builder runs the compiler as a prerequisite, then executes a configurable
pipeline of distribution steps:

1. Compile `.compact` files (via `compact-compiler`)
2. *(optional)* `rm -rf dist && mkdir -p dist` — when `--clean-dist` is set
3. Compile TypeScript (`tsc --project tsconfig.build.json`)
4. Copy artifacts to `dist/artifacts/`
5. Copy `.compact` files to `dist/` (flat by default; tree-preserving with `--hierarchical`)
6. *(optional)* Copy extra files into `dist/` — one per `--copy <path>`

### Usage

```bash
compact-builder [options]
```

Accepts all compiler options plus the following **builder-only** options:

| Option | Description |
| --- | --- |
| `--clean-dist` | Run `rm -rf dist && mkdir -p dist` before building. |
| `--copy <path>` | Copy an extra file into `dist/` for distribution (e.g. `package.json`, `../README.md`). Repeatable. |

The compiler's `--hierarchical` and `--exclude` flags also affect the builder:

- **`--hierarchical`** — when set, source files keep their directory structure
  under `dist/` (e.g. `src/token/Foo.compact` → `dist/token/Foo.compact`) and
  compiled artifacts likewise preserve their subdir. When unset (default), both
  are flat.
- **`--exclude <pattern>`** — applies to both the compiler's file discovery
  AND the builder's `.compact` copy step. When unset, the builder falls back
  to `['Mock*', '*.mock.compact']` so mocks are stripped from the dist by
  default (even though the compiler with no `--exclude` still compiles them).

Builds should normally include ZK proofs; avoid passing `--skip-zk` here.

### Examples

```bash
# Default build (flat .compact copy, excludes Mock*)
compact-builder

# Build specific subdirectory
compact-builder --dir token

# Custom source/output directories
compact-builder --src contracts --out build

# Library-publish build: clean dist, hierarchical layout, exclude mocks + archive, ship metadata
compact-builder \
  --clean-dist \
  --hierarchical \
  --exclude 'Mock*' --exclude '*/archive/*' \
  --copy package.json --copy ../README.md
```

## Programmatic API

The compiler can be used programmatically:

```typescript
import { CompactCompiler } from '@openzeppelin/compact-tools-cli';

// Using options object
const compiler = new CompactCompiler({
  flags: '--skip-zk',
  targetDir: 'security',
  version: '0.28.0',
  hierarchical: true,
  srcDir: 'src',
  outDir: 'artifacts',
});

await compiler.compile();

// Using factory method (parses CLI-style args)
const compiler = CompactCompiler.fromArgs([
  '--dir', 'security',
  '--skip-zk',
  '+0.28.0'
]);

await compiler.compile();
```

### Classes and Types

```typescript
// Main compiler class
class CompactCompiler {
  constructor(options?: CompilerOptions, execFn?: ExecFunction);
  static fromArgs(args: string[], env?: NodeJS.ProcessEnv): CompactCompiler;
  static parseArgs(args: string[], env?: NodeJS.ProcessEnv): CompilerOptions;
  compile(): Promise<void>;
  validateEnvironment(): Promise<void>;
}

// Builder class
class CompactBuilder {
  constructor(options?: BuilderOptions);
  static fromArgs(args: string[], env?: NodeJS.ProcessEnv): CompactBuilder;
  static parseArgs(args: string[], env?: NodeJS.ProcessEnv): BuilderOptions;
  build(): Promise<void>;
  getSteps(): readonly { cmd: string; msg: string; shell?: string }[];
}

// Compiler options
interface CompilerOptions {
  flags?: string;           // Compiler flags (e.g., '--skip-zk --verbose')
  targetDir?: string;       // Subdirectory within srcDir to compile
  version?: string;         // Toolchain version (e.g., '0.28.0')
  hierarchical?: boolean;   // Preserve directory structure in output
  srcDir?: string;          // Source directory (default: 'src')
  outDir?: string;          // Output directory (default: 'artifacts')
  exclude?: string[];       // .compact glob patterns to skip in discovery
                            //   (and in the builder's copy step)
}

// Builder options (extends CompilerOptions with dist-layout controls)
// Note: `hierarchical` and `exclude` (from CompilerOptions) drive BOTH the
// compiler and the builder. When `exclude` is undefined, the builder
// substitutes ['Mock*', '*.mock.compact'] for its copy step.
type BuilderOptions = CompilerOptions & {
  cleanDist?: boolean;     // rm -rf dist before building
  copyToDist?: string[];   // extra files to copy into dist/ (e.g. package.json)
};
```

### Error Types

```typescript
import {
  CompactCliNotFoundError,  // Compact CLI not in PATH
  CompilationError,         // Compilation failed (includes file path)
  DirectoryNotFoundError,   // Target directory doesn't exist
} from '@openzeppelin/compact-tools-cli';
```

## Development

```bash
cd packages/cli

# Build
yarn build

# Type-check only
yarn types

# Run tests
yarn test

# Clean
yarn clean
```

## Output Example

```bash
ℹ [COMPILE] Compact compiler started
ℹ [COMPILE] Compact developer tools: compact 0.2.0
ℹ [COMPILE] Compact toolchain: Compactc version: 0.28.0
ℹ [COMPILE] Found 2 .compact file(s) to compile
✔ [COMPILE] [1/2] Compiled AccessControl.compact
    Compactc version: 0.28.0
✔ [COMPILE] [2/2] Compiled Token.compact
    Compactc version: 0.28.0
```

## License

MIT

