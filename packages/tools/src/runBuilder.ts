#!/usr/bin/env node

// Thin shim that delegates to the @openzeppelin/compact-tools-cli bin entry.
// Declared on `@openzeppelin/compact-tools` so users who install the umbrella
// package get the `compact-builder` binary without also installing the CLI
// package separately.
import '@openzeppelin/compact-tools-cli/run-builder';
