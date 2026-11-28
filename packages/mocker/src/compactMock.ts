#!/usr/bin/env node

import { runBin } from '@openzeppelin/compact-launcher';
import { COMPACT_MOCK, packageDir } from './launcher.ts';

process.exit(await runBin(COMPACT_MOCK, packageDir, process.argv.slice(2)));
