#!/usr/bin/env node

import { runBin } from '@openzeppelin/compact-launcher';
import { COMPACT_PROFILE, packageDir } from './launcher.ts';

process.exit(await runBin(COMPACT_PROFILE, packageDir, process.argv.slice(2)));
