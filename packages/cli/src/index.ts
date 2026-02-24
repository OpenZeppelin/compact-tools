// Main classes
export { CompactCompiler, type CompilerOptions } from './Compiler.ts';
export { CompactBuilder, type BuilderOptions } from './Builder.ts';

// Utility functions for glob pattern testing
export { matchGlob, globToRegExp } from './Compiler.ts';

// Services (for advanced usage)
export {
  EnvironmentValidator,
  FileDiscovery,
  CompilerService,
  UIService,
  type ExecFunction,
} from './Compiler.ts';

// Error types
export {
  CompactCliNotFoundError,
  CompilationError,
  DirectoryNotFoundError,
} from './types/errors.ts';
