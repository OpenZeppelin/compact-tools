import { type Logger, pino } from 'pino';
import { CompactConfig } from './config/compact-config.ts';
import { Deployer, type DeployResult } from './deployer.ts';
import { DeployError } from './errors.ts';
import { resolveContractName } from './loaders/contract-resolve.ts';

/**
 * Shape every Compact-compiled `Contract` class satisfies. The
 * compiler emits an `initialState(context, ...args)` method whose tail
 * args mirror the constructor signature; {@link ConstructorArgsOf}
 * lifts those args out of the artifact's `.d.ts` so deploy scripts
 * don't have to redeclare them.
 */
export type CompactContractClass = {
  prototype: { initialState(context: never, ...args: never[]): unknown };
};

/**
 * Extracts the constructor args tuple from a Compact-compiled
 * `Contract` class (strips the leading `context` parameter). The
 * result is a labeled tuple — hover on a value shows the param name
 * and type. No codegen needed; the artifact's `.d.ts` is the source
 * of truth.
 *
 * @example
 * ```ts
 * import type { Contract } from '../artifacts/Token/contract/index.js';
 * import { runDeploy, type ConstructorArgsOf } from '@openzeppelin/compact-deployer';
 *
 * await runDeploy<ConstructorArgsOf<typeof Contract>>({
 *   contract: 'Token',
 *   args: ['OZE', 'OZE', 18n, ... ],
 * });
 * ```
 */
export type ConstructorArgsOf<C extends CompactContractClass> =
  C['prototype']['initialState'] extends (
    context: never,
    ...args: infer A
  ) => unknown
    ? A
    : never;

/**
 * Typed constructor-args helper. Returns the args tuple unchanged at
 * runtime; the work happens in the type system: `Contract` anchors
 * the generic so each subsequent arg is checked against the matching
 * position in `initialState`, and the editor shows the param name +
 * type as you type each comma (TypeScript signature help works on
 * function calls but not on tuple literals — that's why this exists
 * instead of just `args: [...]`).
 *
 * @example
 * ```ts
 * import { runDeploy, constructorArgs } from '@openzeppelin/compact-deployer';
 * import { Contract } from '../artifacts/Token/contract/index.js';
 *
 * await runDeploy({
 *   contract: 'Token',
 *   args: constructorArgs(Contract,
 *     'OpenZeppelin Token',  // _name: string
 *     'OZE',                 // _symbol: string
 *     18n,                   // _decimals: bigint
 *   ),
 * });
 * ```
 */
export function constructorArgs<C extends CompactContractClass>(
  _Contract: C,
  ...args: ConstructorArgsOf<C>
): ConstructorArgsOf<C> {
  return args;
}

/**
 * Inputs to {@link runDeploy}. Every field has an argv default so a
 * hand-written deploy script can be as short as
 * `await runDeploy<ConstructorArgsOf<typeof Contract>>({ contract: 'X', args: [ … ] });`
 * (typed tuple form) or
 * `await runDeploy<MyNamedArgs>({ contract: 'X', args: { … } });`
 * (named-object form — `MyNamedArgs` is hand-written or generated
 * separately), or `await runDeploy({ contract: 'X' });` when args
 * live in `compact.toml`.
 *
 * The `Args` generic is either:
 * - a `readonly unknown[]` tuple (use `ConstructorArgsOf<typeof Contract>`
 *   to get the labeled tuple from the compiled artifact), or
 * - a `Record<string, unknown>` object describing the constructor's
 *   named parameters; keys can appear in any order and the deployer
 *   reorders them via the artifact's `index.d.ts`.
 */
export interface RunDeployOptions<
  Args extends readonly unknown[] | Record<string, unknown> =
    | readonly unknown[]
    | Record<string, unknown>,
> {
  /** Contract name in `compact.toml` (required). */
  contract: string;
  /**
   * Constructor args, either as a positional tuple or a named object.
   * Highest precedence: overrides `compact.toml`'s `args` field.
   */
  args?: Args;
  /** Path to `compact.toml`. Argv: `--config`. Default: walk up from cwd. */
  configPath?: string;
  /** Network name. Argv: `--network`. Default: `[profile].default_network` from `compact.toml`. */
  network?: string;
  /** Seed file override. Argv: `--seed-file`. */
  seedFile?: string;
  /** Proof-server URL override. Argv: `--proof-server`. */
  proofServer?: string;
  /** Wallet-sync timeout in seconds. Argv: `--sync-timeout`. */
  syncTimeoutSec?: number;
  /** Skip the on-disk wallet-state cache. Argv: `--no-cache`. */
  skipWalletCache?: boolean;
  /**
   * Import a pre-warmed dust wallet state file (raw JSON or gzipped)
   * into `.states/` before deploy. Use this when first-run preprod
   * cold sync OOMs and you already have a `serializeState()` output.
   * Argv: `--seed-cache-from-dust`.
   */
  seedCacheFromDust?: string;
  /** Like {@link seedCacheFromDust} but for the shielded sub-wallet. Argv: `--seed-cache-from-shielded`. */
  seedCacheFromShielded?: string;
  /** Dry-run mode (skip on-chain submission). Argv: `--dry-run`. */
  dryRun?: boolean;
  /** Emit a machine-readable JSON object on stdout instead of pretty lines. Argv: `--json`. */
  json?: boolean;
  /** Pino debug logs to stderr. Argv: `-v` / `--verbose`. */
  verbose?: boolean;
  /** Override the auto-built logger (for testing or for embedding in larger apps). */
  logger?: Logger;
  /** Keystore passphrase prompt. Only needed when `[wallet].keystore` is set. */
  promptPassphrase?: (path: string) => Promise<string>;
}

/**
 * High-level deploy entrypoint for hand-written deploy scripts.
 *
 * Two call forms:
 *
 * 1. **Curried with Contract** — single source of truth for the
 *    contract identity, and the constructor args are typed function
 *    parameters (per-comma signature help in the editor):
 *    ```ts
 *    await runDeploy(Contract)('OZE', 'OZE', 18n, …);
 *    ```
 *    The deployer matches `Contract` against `[contracts.X]` entries
 *    in `compact.toml` by class identity to pick the config. Extra
 *    deploy opts can be passed as a second arg:
 *    ```ts
 *    await runDeploy(Contract, { network: 'preview' })('OZE', …);
 *    ```
 *
 * 2. **Options object** (legacy / multi-contract / TOML-driven args):
 *    ```ts
 *    await runDeploy({ contract: 'TokenExample', args: [...] });
 *    ```
 *
 * Parses `--network`, `--dry-run`, `--sync-timeout`, `--no-cache`,
 * `--seed-cache-from-dust`, `--seed-cache-from-shielded`,
 * `--seed-file`, `--proof-server`, `--config`, `--json`, `-v` /
 * `--verbose` from `process.argv` as defaults. Explicit options win
 * over argv. Wires a pino logger, runs Deployer.prepare + deploy or
 * dryRun, prints the result, and exits with the typed exit code on
 * error.
 *
 * Returns the result on success so callers can chain post-deploy work
 * (e.g. seeding state via callTx). On error: logs and calls
 * `process.exit` — never returns to the caller.
 */
export function runDeploy<C extends CompactContractClass>(
  Contract: C,
  opts?: Omit<RunDeployOptions, 'contract' | 'args'>,
): (...args: ConstructorArgsOf<C>) => Promise<DeployResult>;
export function runDeploy<
  Args extends readonly unknown[] | Record<string, unknown> =
    | readonly unknown[]
    | Record<string, unknown>,
>(opts: RunDeployOptions<Args>): Promise<DeployResult>;
export function runDeploy(
  arg: CompactContractClass | RunDeployOptions,
  opts2?: Omit<RunDeployOptions, 'contract' | 'args'>,
): Promise<DeployResult> | ((...args: unknown[]) => Promise<DeployResult>) {
  if (isContractClass(arg)) {
    const Contract = arg;
    return (...args: unknown[]) =>
      runDeployImpl(
        {
          ...(opts2 ?? {}),
          contract: '',
          args,
        },
        Contract,
      );
  }
  return runDeployImpl(arg);
}

function isContractClass(x: unknown): x is CompactContractClass {
  return (
    typeof x === 'function' &&
    typeof (x as { prototype?: { initialState?: unknown } }).prototype
      ?.initialState === 'function'
  );
}

async function runDeployImpl(
  opts: RunDeployOptions,
  Contract?: CompactContractClass,
): Promise<DeployResult> {
  const argv = parseArgv(process.argv.slice(2));
  const json = opts.json ?? argv.json;
  const verbose = opts.verbose ?? argv.verbose;
  const dryRun = opts.dryRun ?? argv.dryRun;
  const syncTimeoutSec = opts.syncTimeoutSec ?? argv.syncTimeoutSec;
  const logger = opts.logger ?? buildLogger({ json, verbose });
  const configPath = opts.configPath ?? argv.configPath;

  try {
    // Curried form: resolve the Contract class to the matching
    // [contracts.X] entry in compact.toml by identity.
    let contractName = opts.contract;
    if (Contract) {
      const config = await CompactConfig.load(configPath);
      contractName = await resolveContractName(
        Contract,
        config,
        config.rootDir,
      );
    }
    await using deployer = await Deployer.prepare({
      contract: contractName,
      network: opts.network ?? argv.network,
      configPath,
      seedFile: opts.seedFile ?? argv.seedFile,
      proofServer: opts.proofServer ?? argv.proofServer,
      args: opts.args,
      syncTimeoutMs:
        syncTimeoutSec !== undefined ? syncTimeoutSec * 1000 : undefined,
      skipWalletCache: opts.skipWalletCache ?? argv.noCache,
      seedCacheDust: opts.seedCacheFromDust ?? argv.seedCacheFromDust,
      seedCacheShielded:
        opts.seedCacheFromShielded ?? argv.seedCacheFromShielded,
      promptPassphrase: opts.promptPassphrase,
      logger,
    });

    const result = dryRun ? await deployer.dryRun() : await deployer.deploy();
    printResult(result, { json, logger });
    return result;
  } catch (e) {
    handleError(e, { json, verbose, logger });
    throw e; // unreachable — handleError calls process.exit
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedArgv {
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
}

function parseArgv(argv: string[]): ParsedArgv {
  const out: ParsedArgv = {
    noCache: false,
    dryRun: false,
    json: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
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
        // Unknown flags are ignored so the helper coexists with extra
        // argv the caller's wrapper script may inject.
        break;
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

function buildLogger(opts: { json: boolean; verbose: boolean }): Logger {
  // JSON mode keeps stdout machine-parseable, so logger writes to stderr.
  // Default mode goes to stdout with the standard pino-pretty fallback.
  return pino({
    level: opts.verbose ? 'debug' : 'info',
  });
}

function printResult(
  result: DeployResult,
  opts: { json: boolean; logger: Logger },
): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.dryRun) {
    opts.logger.info(
      `Dry-run for ${result.contractName} on ${result.network} OK`,
    );
    return;
  }
  opts.logger.info(
    `${result.contractName} deployed on ${result.network}: ${result.address}`,
  );
  opts.logger.info(`  txId:        ${result.txId}`);
  opts.logger.info(`  txHash:      ${result.txHash}`);
  opts.logger.info(`  blockHeight: ${result.blockHeight}`);
  opts.logger.info(`  saved to:    ${result.deploymentsFile}`);
  if (result.explorerUrl) {
    opts.logger.info(`  explorer:    ${result.explorerUrl}`);
  }
}

function handleError(
  e: unknown,
  opts: { json: boolean; verbose: boolean; logger: Logger },
): never {
  const code = e instanceof DeployError ? e.exitCode : 1;
  const name = e instanceof Error ? e.name : 'Error';
  const message = e instanceof Error ? e.message : String(e);
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ error: name, message, exitCode: code })}\n`,
    );
  } else {
    opts.logger.error({ err: message }, `Deploy failed: ${name}`);
    if (opts.verbose && e instanceof Error && e.stack) {
      opts.logger.debug(e.stack);
    }
  }
  process.exit(code);
}
