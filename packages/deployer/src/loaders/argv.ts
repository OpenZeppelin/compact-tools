/**
 * Deploy-flag parser shared by the library entrypoint (`runDeploy`) and the
 * `compact-deploy` CLI, so the two can't drift on flag names or validation.
 */

/** Flags recognised by both front-ends. */
export interface ParsedDeployArgv {
  network?: string;
  configPath?: string;
  seedFile?: string;
  proofServer?: string;
  syncTimeoutSec?: number;
  txTimeoutSec?: number;
  syncBatchSize?: number;
  seedCacheFromDust?: string;
  seedCacheFromShielded?: string;
  seedCacheFromUnshielded?: string;
  noCache: boolean;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  /** Non-flag arguments, in order. The CLI reads the contract name from slot 0. */
  positional: string[];
}

export interface ParseDeployArgvOptions {
  /**
   * Throw on an unrecognised `--flag`. The CLI sets this; the library leaves
   * it off so it coexists with extra argv a caller's wrapper script injects.
   * Unrecognised single-dash args are positional under either setting.
   */
  rejectUnknownFlags?: boolean;
}

export function parseDeployArgv(
  argv: string[],
  opts: ParseDeployArgvOptions = {},
): ParsedDeployArgv {
  const out: ParsedDeployArgv = {
    noCache: false,
    force: false,
    dryRun: false,
    json: false,
    verbose: false,
    help: false,
    version: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '--version':
        out.version = true;
        break;
      case '-v':
      case '--verbose':
        out.verbose = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--no-cache':
        out.noCache = true;
        break;
      case '--force':
        out.force = true;
        break;
      case '--seed-cache-from-dust':
        out.seedCacheFromDust = expectValue(
          argv,
          ++i,
          '--seed-cache-from-dust',
        );
        break;
      case '--seed-cache-from-shielded':
        out.seedCacheFromShielded = expectValue(
          argv,
          ++i,
          '--seed-cache-from-shielded',
        );
        break;
      case '--seed-cache-from-unshielded':
        out.seedCacheFromUnshielded = expectValue(
          argv,
          ++i,
          '--seed-cache-from-unshielded',
        );
        break;
      case '--network':
        out.network = expectValue(argv, ++i, '--network');
        break;
      case '--config':
        out.configPath = expectValue(argv, ++i, '--config');
        break;
      case '--seed-file':
        out.seedFile = expectValue(argv, ++i, '--seed-file');
        break;
      case '--proof-server':
        out.proofServer = expectValue(argv, ++i, '--proof-server');
        break;
      case '--sync-timeout':
        out.syncTimeoutSec = expectPositiveInt(
          expectValue(argv, ++i, '--sync-timeout'),
          '--sync-timeout',
          ' (seconds)',
        );
        break;
      case '--tx-timeout':
        out.txTimeoutSec = expectPositiveInt(
          expectValue(argv, ++i, '--tx-timeout'),
          '--tx-timeout',
          ' (seconds)',
        );
        break;
      case '--sync-batch-size':
        out.syncBatchSize = expectPositiveInt(
          expectValue(argv, ++i, '--sync-batch-size'),
          '--sync-batch-size',
        );
        break;
      default:
        if (opts.rejectUnknownFlags === true && arg.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        if (!arg.startsWith('--')) out.positional.push(arg);
    }
  }
  return out;
}

function expectValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return v;
}

function expectPositiveInt(raw: string, flag: string, unit = ''): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} requires a positive integer${unit}; got "${raw}"`);
  }
  return n;
}
