#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: CLI writes user-facing diagnostics to stdout/stderr

/**
 * `compact-deploy` CLI shell over {@link Deployer}. The `globalThis.WebSocket`
 * shim is required: midnight-js's indexer client uses the browser WebSocket
 * interface, which Node only ships natively from v22.
 */
import { createRequire } from 'node:module';
import { Deployer } from '@openzeppelin/compact-deployer/deployer';
import { DeployError } from '@openzeppelin/compact-deployer/errors';
import {
  type ParsedDeployArgv,
  parseDeployArgv,
} from '@openzeppelin/compact-deployer/loaders/argv';
import chalk from 'chalk';
import ora from 'ora';
import { WebSocket } from 'ws';
import { createLogger } from './logger.ts';
import { promptPassphrase } from './prompt.ts';

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

/** Shared deploy flags plus the CLI-only contract positional. */
interface ParsedArgs extends ParsedDeployArgv {
  contract?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  // Unlike the library entrypoint, the CLI is the whole program: an
  // unrecognised flag is a user typo, not a host app's extra argv.
  const parsed = parseDeployArgv(argv, { rejectUnknownFlags: true });
  return { ...parsed, contract: parsed.positional[0] };
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
      seedCacheUnshielded: args.seedCacheFromUnshielded,
      syncBatchSize: args.syncBatchSize,
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
      '  --sync-batch-size <n> Dust/shielded sync batch size (default 5000)',
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
    chalk.yellow(
      '  --seed-cache-from-unshielded <path> Import a pre-warmed unshielded state file into .states/',
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

/**
 * The CLI's own version. `../package.json` resolves the same from `src/` and
 * from the compiled `dist/`, both being one level under the package root.
 */
function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (
      (require('../package.json') as { version?: string }).version ?? 'dev'
    );
  } catch {
    // A missing or malformed package.json means a broken install, and
    // `--version` has no better answer than a placeholder.
    return 'dev';
  }
}

main();
