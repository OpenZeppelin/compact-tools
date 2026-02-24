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
| `--exclude <pattern>` | Glob pattern to exclude files (can be repeated) | (none) |
| `--dry-run` | Preview which files would be compiled without compiling | `false` |
| `--hierarchical` | Preserve source directory structure in output | `false` |
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

### Excluding Files

Use `--exclude` to skip files matching glob patterns. This is useful for excluding mock contracts, test files, or any files you don't want to compile.

**Supported glob patterns:**
- `*` matches any characters except `/`
- `**` matches zero or more path segments

**Examples:**
```bash
# Exclude all mock contracts
compact-compiler --exclude "**/*.mock.compact"

# Exclude test directory
compact-compiler --exclude "**/test/**"

# Multiple patterns
compact-compiler --exclude "**/*.mock.compact" --exclude "**/test/**"

# Root-level only (no ** prefix)
compact-compiler --exclude "*.mock.compact"  # Only matches root-level mocks
```

**Programmatic usage:**
```typescript
import { matchGlob, globToRegExp } from '@openzeppelin/compact-tools-cli';

// Test if a path matches a pattern
matchGlob('foo/bar.mock.compact', '**/*.mock.compact'); // true
matchGlob('bar.mock.compact', '*.mock.compact');        // true

// Get the underlying RegExp
const re = globToRegExp('**/*.mock.compact');
re.test('nested/file.mock.compact'); // true
```

### Dry run

Use `--dry-run` to see which files would be compiled without running the compiler. No environment validation or compilation is performed. Useful to verify `--exclude` patterns or to see the file list before a full run.

**Usage:**
```bash
# Preview all files that would be compiled
compact-compiler --dry-run

# Preview with exclusions (verify your exclude patterns)
compact-compiler --exclude "**/*.mock.compact" --dry-run

# Dry run in a specific directory
compact-compiler --dir access --dry-run
```

**Example output:**
```
ℹ [DRY-RUN] Would compile 2 file(s):
    Token.compact
    AccessControl.compact
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

# Exclude mock contracts
compact-compiler --exclude "**/*.mock.compact"

# Exclude multiple patterns
compact-compiler --exclude "**/*.mock.compact" --exclude "**/test/**"

# Preview which files would be compiled (dry run)
compact-compiler --dry-run

# Dry run with exclusions to verify patterns
compact-compiler --exclude "**/*.mock.compact" --dry-run
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

Accepts all compiler options except `--skip-zk` (builds always include ZK proofs). Use `--exclude` to skip mock contracts or test files during the build.

### Examples

```bash
# Full build
compact-builder

# Build specific directory
compact-builder --dir token

# Build with custom directories
compact-builder --src contracts --out build

# Build excluding mock contracts
compact-builder --exclude "**/*.mock.compact"
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
  constructor(options?: CompilerOptions);
  static fromArgs(args: string[], env?: NodeJS.ProcessEnv): CompactBuilder;
  build(): Promise<void>;
}

// Options interface
interface CompilerOptions {
  flags?: string;           // Compiler flags (e.g., '--skip-zk --verbose')
  targetDir?: string;       // Subdirectory within srcDir to compile
  version?: string;         // Toolchain version (e.g., '0.28.0')
  hierarchical?: boolean;   // Preserve directory structure in output
  srcDir?: string;          // Source directory (default: 'src')
  outDir?: string;          // Output directory (default: 'artifacts')
  exclude?: string[];       // Glob patterns to exclude (e.g., ['**/*.mock.compact'])
  dryRun?: boolean;         // Preview files without compiling
}
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

