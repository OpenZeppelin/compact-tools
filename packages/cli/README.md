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
Compactc version: 0.26.0
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
| `--force`, `-f` | Force delete existing artifacts on structure mismatch | `false` |
| `--skip-zk` | Skip zero-knowledge proof generation | `false` |
| `+<version>` | Use specific toolchain version (e.g., `+0.26.0`) | (default) |

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

### Structure Mismatch Detection

The compiler tracks which structure type was used via a `manifest.json` file in the output directory. When switching between flattened and hierarchical structures:

- **Interactive mode (TTY):** Prompts for confirmation before deleting existing artifacts
- **Non-interactive mode (CI/CD):** Requires `--force` flag to proceed

```bash
$ compact-compiler --hierarchical

⚠ [COMPILE] Existing artifacts use "flattened" structure.
⚠ [COMPILE] You are compiling with "hierarchical" structure.
? Delete existing artifacts and recompile? (y/N)
```

To skip the prompt in scripts or CI/CD:

```bash
compact-compiler --hierarchical --force
```

### Manifest File

The compiler generates a `manifest.json` in the output directory with build metadata:

```json
{
  "structure": "hierarchical",
  "compactcVersion": "0.26.0",
  "compactToolVersion": "0.3.0",
  "createdAt": "2025-12-11T10:35:09.916Z",
  "buildDuration": 2445,
  "nodeVersion": "22",
  "platform": "linux-x64",
  "sourcePath": "src",
  "outputPath": "artifacts",
  "compilerFlags": ["--skip-zk"],
  "artifacts": {
    "ledger": ["Counter"],
    "reference": ["Boolean", "Bytes", "Field"]
  }
}
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
compact-compiler +0.26.0

# Custom source and output directories
compact-compiler --src contracts --out build

# Combine options
compact-compiler --dir access --skip-zk --hierarchical

# Force structure change without prompt
compact-compiler --hierarchical --force

# Use environment variable
SKIP_ZK=true compact-compiler
```

## Builder CLI

The builder runs the compiler as a prerequisite, then executes additional build steps:

1. Compile `.compact` files (via `compact-compiler`)
2. Compile TypeScript (`tsc --project tsconfig.build.json`)
3. Copy artifacts to `dist/artifacts/`
4. Copy and clean `.compact` files to `dist/`

### Usage

```bash
compact-builder [options]
```

Accepts all compiler options except `--skip-zk` (builds always include ZK proofs).

### Examples

```bash
# Full build
compact-builder

# Build specific directory
compact-builder --dir token

# Build with custom directories
compact-builder --src contracts --out build
```

## Programmatic API

The compiler can be used programmatically:

```typescript
import { CompactCompiler } from '@openzeppelin/compact-tools-cli';

// Using options object
const compiler = new CompactCompiler({
  flags: ['--skip-zk'],
  targetDir: 'security',
  version: '0.26.0',
  hierarchical: true,
  srcDir: 'src',
  outDir: 'artifacts',
});

await compiler.compile();

// Using factory method (parses CLI-style args)
const compiler = CompactCompiler.fromArgs([
  '--dir', 'security',
  '--skip-zk',
  '+0.26.0'
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
  constructor(options?: CompilerOptions);
  static fromArgs(args: string[], env?: NodeJS.ProcessEnv): CompactBuilder;
  build(): Promise<void>;
}

// Options interface
interface CompilerOptions {
  flags?: CompilerFlag[];   // Compiler flags (e.g., ['--skip-zk'])
  targetDir?: string;       // Subdirectory within srcDir to compile
  version?: CompactcVersion; // Toolchain version (e.g., '0.26.0')
  hierarchical?: boolean;   // Preserve directory structure in output
  srcDir?: string;          // Source directory (default: 'src')
  outDir?: string;          // Output directory (default: 'artifacts')
  force?: boolean;          // Force delete on structure mismatch
}

// Compiler flags (passed to compactc)
type CompilerFlag =
  | '--skip-zk'
  | '--vscode'
  | '--no-communications-commitment'
  | '--trace-passes'
  | `--sourceRoot ${string}`;

// Supported compactc versions
type CompactcVersion = '0.23.0' | '0.24.0' | '0.25.0' | '0.26.0';
```

### Error Types

```typescript
import {
  CompactCliNotFoundError,  // Compact CLI not in PATH
  CompilationError,         // Compilation failed (includes file path)
  DirectoryNotFoundError,   // Target directory doesn't exist
  StructureMismatchError,   // Artifact structure mismatch (flattened vs hierarchical)
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

```
ℹ [COMPILE] Compact compiler started
ℹ [COMPILE] compact-tools: 0.3.0
ℹ [COMPILE] compactc: 0.26.0
ℹ [COMPILE] Found 2 .compact file(s) to compile
✔ [COMPILE] [1/2] Compiled AccessControl.compact
✔ [COMPILE] [2/2] Compiled Token.compact
```

## License

MIT

