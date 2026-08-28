#!/usr/bin/env node
/**
 * Resolve the package a release workflow is acting on, and append `dir`,
 * `name`, and `version` to `$GITHUB_OUTPUT`.
 *
 *   node scripts/release/resolve-package.mjs --package compact-cli
 *   node scripts/release/resolve-package.mjs --changed-files "$CHANGED"
 *
 * `--changed-files` takes the newline-separated output of `git diff
 * --name-only`. Without `$GITHUB_OUTPUT` the result goes to stdout instead,
 * so the script is runnable by hand.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import {
  dirForPackage,
  dirFromChangedFiles,
  packageForDir,
} from './packages.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i]] = argv[i + 1];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (
    args['--package'] === undefined &&
    args['--changed-files'] === undefined
  ) {
    throw new Error('pass either --package or --changed-files');
  }

  const dir =
    args['--package'] !== undefined
      ? dirForPackage(args['--package'])
      : dirFromChangedFiles(args['--changed-files'].split('\n'));

  const { version } = JSON.parse(
    readFileSync(`packages/${dir}/package.json`, 'utf8'),
  );
  const output = `dir=${dir}\nname=${packageForDir(dir)}\nversion=${version}\n`;

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, output);
  }
  process.stdout.write(output);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  // Annotations are read from stdout, so this must not go to stderr.
  process.stdout.write(`::error::${error.message}\n`);
  process.exit(1);
}
