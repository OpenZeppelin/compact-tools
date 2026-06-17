#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: CLI writes user-facing diagnostics to stdout/stderr

/**
 * `compact-deploy` CLI shell over {@link Deployer}. The `globalThis.WebSocket`
 * shim is required: midnight-js's indexer client uses the browser WebSocket
 * interface, which Node only ships natively from v22.
 */
import { DeployError, Deployer } from '@openzeppelin/compact-deployer';
import chalk from 'chalk';
import ora from 'ora';
import { WebSocket } from 'ws';
import { createLogger } from './logger.ts';
import { promptPassphrase } from './prompt.ts';

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

interface ParsedArgs {
  contract?: string;
  network?: string;
  configPath?: string;
  seedFile?: string;
  proofServer?: string;
  syncTimeoutSec?: number;
  seedCacheFromDust?: string;
  seedCacheFromShielded?: string;
  noCache: boolean;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    noCache: false,
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
      case '--sync-timeout': {
        const raw = expectValue(argv, ++i, '--sync-timeout');
        const seconds = Number.parseInt(raw, 10);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error(
            `--sync-timeout requires a positive integer (seconds); got "${raw}"`,
          );
        }
        out.syncTimeoutSec = seconds;
        break;
      }
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
        out.positional.push(arg);
    }
  }
  out.contract = out.positional[0];
  return out;
}

function expectValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return v;
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(chalk.red(`[DEPLOY] ${(e as Error).message}`));
    showUsage();
    process.exit(2);
    return;
  }

  if (args.help) {
    showUsage();
    return;
  }
  if (args.version) {
    console.log(packageVersion());
    return;
  }

  if (!args.contract) {
    console.error(
      chalk.red('[DEPLOY] Missing required <Contract> positional argument.'),
    );
    showUsage();
    process.exit(2);
    return;
  }

  const logger = createLogger({ verbose: args.verbose, json: args.json });
  // Spinner narrates two phases: prepare() (proof-server start, wallet
  // build, sync to tip — can take minutes on first preprod/preview run)
  // then deploy() / dryRun() (proof generation + tx submit). Text is
  // updated between phases so the spinner matches the actual stage.
  const verbActive = args.dryRun ? 'Dry-running' : 'Deploying';
  const spinner = args.json
    ? undefined
    : ora(
        chalk.blue(
          `[DEPLOY] Preparing wallet for ${args.contract} (sync may take minutes)…`,
        ),
      ).start();

  try {
    await using deployer = await Deployer.prepare({
      contract: args.contract,
      network: args.network,
      configPath: args.configPath,
      seedFile: args.seedFile,
      proofServer: args.proofServer,
      syncTimeoutMs:
        args.syncTimeoutSec !== undefined
          ? args.syncTimeoutSec * 1000
          : undefined,
      skipWalletCache: args.noCache,
      seedCacheDust: args.seedCacheFromDust,
      seedCacheShielded: args.seedCacheFromShielded,
      logger,
      promptPassphrase: async (path) => {
        if (spinner) spinner.stop();
        const pp = await promptPassphrase(path);
        if (spinner) spinner.start();
        return pp;
      },
    });
    // Wallet is ready, providers are up — now we're actually deploying.
    if (spinner) {
      spinner.text = chalk.blue(
        `[DEPLOY] ${verbActive} ${args.contract} (proof gen + submit)…`,
      );
    }
    const result = args.dryRun
      ? await deployer.dryRun()
      : await deployer.deploy();

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (result.dryRun) {
      spinner?.succeed(
        chalk.green(
          `[DEPLOY] Dry-run for ${result.contractName} on ${result.network} OK`,
        ),
      );
      return;
    }
    spinner?.succeed(
      chalk.green(
        `[DEPLOY] ${result.contractName} deployed on ${result.network}: ${result.address}`,
      ),
    );
    console.log(chalk.gray(`  txId:        ${result.txId}`));
    console.log(chalk.gray(`  txHash:      ${result.txHash}`));
    console.log(chalk.gray(`  blockHeight: ${result.blockHeight}`));
    console.log(chalk.gray(`  saved to:    ${result.deploymentsFile}`));
    if (result.explorerUrl) {
      console.log(chalk.gray(`  explorer:    ${result.explorerUrl}`));
    }
  } catch (e) {
    const code = e instanceof DeployError ? e.exitCode : 1;
    const name = e instanceof Error ? e.name : 'Error';
    const message = e instanceof Error ? e.message : String(e);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ error: name, message, exitCode: code })}\n`,
      );
    } else {
      spinner?.fail(chalk.red(`[DEPLOY] ${name}: ${message}`));
      if (args.verbose && e instanceof Error && e.stack) {
        console.error(chalk.gray(e.stack));
      }
    }
    process.exit(code);
  }
}

function showUsage(): void {
  console.log(chalk.yellow('\nUsage: compact-deploy <Contract> [options]'));
  console.log(chalk.yellow('\nOptions:'));
  console.log(
    chalk.yellow(
      '  --network <name>      Target network (or set [profile].default_network)',
    ),
  );
  console.log(
    chalk.yellow(
      '  --config <path>       Path to compact.toml (default: walk up from CWD)',
    ),
  );
  console.log(
    chalk.yellow(
      '  --seed-file <path>    Seed override (raw hex or BIP39 mnemonic, one line)',
    ),
  );
  console.log(
    chalk.yellow('  --proof-server <url>  Override [networks.X].proof_server'),
  );
  console.log(
    chalk.yellow(
      '  --sync-timeout <s>    Max wallet-sync seconds before failing (default 600)',
    ),
  );
  console.log(
    chalk.yellow(
      '  --no-cache            Ignore the on-disk wallet-state cache; force fresh sync',
    ),
  );
  console.log(
    chalk.yellow(
      '  --seed-cache-from-dust <path>      Import a pre-warmed dust state file into .states/',
    ),
  );
  console.log(
    chalk.yellow(
      '  --seed-cache-from-shielded <path>  Import a pre-warmed shielded state file into .states/',
    ),
  );
  console.log(
    chalk.yellow('  --dry-run             Load+validate, do NOT submit a tx'),
  );
  console.log(
    chalk.yellow('  --json                Single JSON object on stdout'),
  );
  console.log(
    chalk.yellow('  -v, --verbose         Pino debug logs to .compact/logs/'),
  );
  console.log(chalk.yellow('  -h, --help            Show this help'));
  console.log(chalk.yellow('      --version         Print package version'));
  console.log(chalk.yellow('\nExamples:'));
  console.log(chalk.yellow('  compact-deploy Token --network local'));
  console.log(
    chalk.yellow(
      '  MN_DEPLOYER_SEED=$(cat seed.hex) compact-deploy Vault --network testnet',
    ),
  );
  console.log(
    chalk.yellow('  compact-deploy Token --network preprod --dry-run --json'),
  );
  console.log(
    chalk.yellow(
      '\nNote: a first sync on a long-history network (e.g. preprod) can exceed',
    ),
  );
  console.log(
    chalk.yellow(
      "      Node's default heap. On 'JavaScript heap out of memory', raise it:",
    ),
  );
  console.log(
    chalk.yellow(
      '      NODE_OPTIONS=--max-old-space-size=8192 compact-deploy <Contract> …',
    ),
  );
}

function packageVersion(): string {
  return process.env.npm_package_version ?? 'dev';
}

main();
