#!/usr/bin/env node

import { runBin } from '@openzeppelin/compact-launcher';
import { COMPACT_LINT, packageDir } from './launcher.ts';

process.exit(await runBin(COMPACT_LINT, packageDir, process.argv.slice(2)));
