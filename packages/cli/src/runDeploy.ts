#!/usr/bin/env node
/**
 * `compact-deploy` — opinionated CLI shell over the deploy pipeline.
 *
 * Responsibilities limited to:
 *  - argv parsing (handwritten, no external CLI lib — keeps cold-start fast)
 *  - constructing the logger / spinner / passphrase prompt
 *  - delegating to `runPipeline` and rendering its result
 *  - mapping exceptions to typed exit codes via {@link DeployError.exitCode}
 *
 * All deploy logic lives in `pipeline.ts` and its dependencies; this file
 * should never grow business logic.
 *
 * The `globalThis.WebSocket = ws` shim is required because midnight-js's
 * indexer client uses the browser WebSocket interface and Node only
 * provides it natively from v22.
 */
// biome-ignore-all lint/suspicious/noConsole: CLI writes user-facing diagnostics to stdout/stderr
import chalk from 'chalk';
import ora from 'ora';
import { WebSocket } from 'ws';
import { deploy, DeployError } from '@openzeppelin/compact-deploy';
import { createLogger } from './logger.ts';
import { promptPassphrase } from './prompt.ts';

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

interface ParsedArgs {
  contract?: string;
  network?: string;
  configPath?: string;
  seedFile?: string;
  proofServer?: string;
  skipFaucet: boolean;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    skipFaucet: false,
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
      case '--skip-faucet':
        out.skipFaucet = true;
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
  const spinner = args.json
    ? undefined
    : ora(
        chalk.blue(
          `[DEPLOY] ${args.dryRun ? 'Dry-running' : 'Deploying'} ${args.contract}…`,
        ),
      ).start();

  try {
    const result = await deploy({
      contract: args.contract,
      network: args.network,
      configPath: args.configPath,
      seedFile: args.seedFile,
      proofServer: args.proofServer,
      skipFaucet: args.skipFaucet,
      dryRun: args.dryRun,
      logger,
      promptPassphrase: async (path) => {
        if (spinner) spinner.stop();
        const pp = await promptPassphrase(path);
        if (spinner) spinner.start();
        return pp;
      },
    });

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
    chalk.yellow('  --skip-faucet         Skip faucet even if faucet=true'),
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
}

function packageVersion(): string {
  return process.env.npm_package_version ?? 'dev';
}

main();
