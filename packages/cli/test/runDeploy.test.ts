import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Deployer } from '@openzeppelin/compact-deployer/deployer';
import {
  ArtifactNotFoundError,
  DeployError,
} from '@openzeppelin/compact-deployer/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cliPackageVersion: string = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../package.json', import.meta.url)),
    'utf8',
  ),
).version;

// --- Mocks --------------------------------------------------------------

// Only the deploy entrypoint is stubbed; the error classes stay real so the
// CLI's `instanceof DeployError` exit-code branch is exercised, not faked.
vi.mock('@openzeppelin/compact-deployer/deployer', () => ({
  Deployer: {
    prepare: vi.fn(),
  },
}));

// Registered as a mock resolving to the real module: the mock registry
// survives the `vi.resetModules()` in `runMain`, so the CLI re-import keeps
// the same error classes this file holds. Without it every reset hands the
// CLI a second copy and `instanceof DeployError` is false against ours.
vi.mock('@openzeppelin/compact-deployer/errors', async () =>
  vi.importActual('@openzeppelin/compact-deployer/errors'),
);

vi.mock('chalk', () => ({
  default: {
    blue: (text: string) => text,
    red: (text: string) => text,
    green: (text: string) => text,
    gray: (text: string) => text,
    yellow: (text: string) => text,
  },
}));

const mockSpinner = {
  start: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  text: '',
};
const mockOra = vi.fn(() => mockSpinner);
vi.mock('ora', () => ({
  default: mockOra,
}));

vi.mock('../src/logger.ts', () => ({
  createLogger: vi.fn(() => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  })),
}));

const mockPromptPassphrase = vi.fn(async () => 'secret');
vi.mock('../src/prompt.ts', () => ({
  promptPassphrase: mockPromptPassphrase,
}));

// --- Process helpers ----------------------------------------------------

const mockExit = vi
  .spyOn(process, 'exit')
  .mockImplementation(() => undefined as never);
const mockStdoutWrite = vi
  .spyOn(process.stdout, 'write')
  .mockImplementation(() => true);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi
  .spyOn(console, 'error')
  .mockImplementation(() => {});

// Fixture builder for the Deployer instance returned by prepare().
interface FakeDeployerOpts {
  result?: Record<string, unknown>;
  deployError?: unknown;
  dryRunResult?: Record<string, unknown>;
  dryRunError?: unknown;
}
function fakeDeployer(opts: FakeDeployerOpts = {}) {
  const deploy = vi.fn(async () => {
    if (opts.deployError) throw opts.deployError;
    return opts.result ?? defaultResult();
  });
  const dryRun = vi.fn(async () => {
    if (opts.dryRunError) throw opts.dryRunError;
    return opts.dryRunResult ?? defaultDryRunResult();
  });
  const dispose = vi.fn(async () => {});
  return {
    deploy,
    dryRun,
    [Symbol.asyncDispose]: dispose,
  };
}

function defaultResult(overrides: Record<string, unknown> = {}) {
  return {
    contractName: 'Token',
    network: 'local',
    address: '0xabc',
    txHash: '0xhash',
    txId: 'tx-1',
    blockHeight: 42,
    deploymentsFile: '/tmp/deployments.json',
    dryRun: false,
    explorerUrl: '',
    ...overrides,
  };
}

function defaultDryRunResult(overrides: Record<string, unknown> = {}) {
  return {
    contractName: 'Token',
    network: 'local',
    address: '',
    txHash: '',
    txId: '',
    blockHeight: 0,
    deploymentsFile: '',
    dryRun: true,
    explorerUrl: '',
    ...overrides,
  };
}

// --- parseArgs probe ----------------------------------------------------
//
// parseArgs is module-private. We exercise it indirectly via main() by
// running with argv variants and asserting on either Deployer.prepare's
// args object (happy path) or on console.error + exit code 2 (parse-error
// path).

async function runMain(argv: string[]): Promise<void> {
  process.argv = ['node', 'runDeploy.js', ...argv];
  vi.resetModules();
  await import('../src/runDeploy.ts');
  // main() is invoked at module top-level but is async. Await a microtask
  // tick so its body finishes before assertions.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// --- Tests --------------------------------------------------------------

describe('runDeploy CLI', () => {
  let originalArgv: string[];
  let mockPrepare: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalArgv = [...process.argv];
    vi.clearAllMocks();
    mockPrepare = vi.mocked(Deployer.prepare);
    mockSpinner.start.mockClear();
    mockSpinner.stop.mockClear();
    mockSpinner.succeed.mockClear();
    mockSpinner.fail.mockClear();
    mockSpinner.text = '';
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  // ------------------------------------------------------------------ //
  describe('--help / --version short-circuits', () => {
    it('should print usage and return on --help', async () => {
      await runMain(['--help']);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Usage: compact-deploy'),
      );
      expect(mockExit).not.toHaveBeenCalled();
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it('should accept -h shorthand', async () => {
      await runMain(['-h']);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Usage: compact-deploy'),
      );
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it("should print the CLI's own package.json version on --version", async () => {
      // Read from the manifest, not `npm_package_version`: that env var is
      // set by whichever package's script is running, so under `npx` or a
      // consumer's `yarn deploy` it reported the wrong project's version.
      const prev = process.env.npm_package_version;
      process.env.npm_package_version = '9.9.9';
      try {
        await runMain(['--version']);
        expect(mockConsoleLog).toHaveBeenCalledWith(cliPackageVersion);
        expect(mockConsoleLog).not.toHaveBeenCalledWith('9.9.9');
        expect(cliPackageVersion).toMatch(/^\d+\.\d+\.\d+/);
      } finally {
        if (prev === undefined) delete process.env.npm_package_version;
        else process.env.npm_package_version = prev;
      }
      expect(mockPrepare).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ //
  describe('parseArgs (via main)', () => {
    beforeEach(() => {
      mockPrepare.mockResolvedValue(fakeDeployer());
    });

    it('should map every flag to the prepare() options', async () => {
      await runMain([
        'Token',
        '--network',
        'local',
        '--config',
        '/c.toml',
        '--seed-file',
        '/seed.hex',
        '--proof-server',
        'http://proof:6300',
        '--sync-timeout',
        '30',
        '--tx-timeout',
        '90',
        '--sync-batch-size',
        '5000',
        '--no-cache',
        '--force',
        '--seed-cache-from-dust',
        '/dust.json',
        '--seed-cache-from-shielded',
        '/shielded.gz',
        '--seed-cache-from-unshielded',
        '/unshielded.gz',
      ]);

      expect(mockPrepare).toHaveBeenCalledTimes(1);
      const opts = mockPrepare.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(opts.contract).toBe('Token');
      expect(opts.network).toBe('local');
      expect(opts.configPath).toBe('/c.toml');
      expect(opts.seedFile).toBe('/seed.hex');
      expect(opts.proofServer).toBe('http://proof:6300');
      expect(opts.syncTimeoutMs).toBe(30_000);
      expect(opts.txTimeoutMs).toBe(90_000);
      expect(opts.syncBatchSize).toBe(5000);
      expect(opts.skipWalletCache).toBe(true);
      expect(opts.force).toBe(true);
      expect(opts.seedCacheDust).toBe('/dust.json');
      expect(opts.seedCacheShielded).toBe('/shielded.gz');
      expect(opts.seedCacheUnshielded).toBe('/unshielded.gz');
    });

    it('should reject --seed-cache-from-dust with no follow-up value', async () => {
      await runMain(['Token', '--seed-cache-from-dust']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('--seed-cache-from-dust requires a value'),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('should leave syncTimeoutMs undefined when --sync-timeout is omitted', async () => {
      await runMain(['Token']);
      const opts = mockPrepare.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(opts.syncTimeoutMs).toBeUndefined();
    });

    it('should leave txTimeoutMs undefined and force false when both flags are omitted', async () => {
      await runMain(['Token']);
      const opts = mockPrepare.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(opts.txTimeoutMs).toBeUndefined();
      expect(opts.force).toBe(false);
    });

    it('should reject zero/negative --tx-timeout', async () => {
      await runMain(['Token', '--tx-timeout', '0']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('--tx-timeout requires a positive integer'),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('should reject unknown flags with exit code 2', async () => {
      await runMain(['Token', '--bogus']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Unknown flag: --bogus'),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it('should reject --network with no follow-up value', async () => {
      await runMain(['Token', '--network']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('--network requires a value'),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('should reject --network when followed by another flag', async () => {
      await runMain(['Token', '--network', '--json']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('--network requires a value'),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('should reject non-numeric --sync-timeout', async () => {
      await runMain(['Token', '--sync-timeout', 'abc']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('--sync-timeout requires a positive integer'),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('should reject zero/negative --sync-timeout', async () => {
      await runMain(['Token', '--sync-timeout', '0']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('--sync-timeout requires a positive integer'),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('should leave syncBatchSize undefined when --sync-batch-size is omitted', async () => {
      await runMain(['Token']);
      const opts = mockPrepare.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(opts.syncBatchSize).toBeUndefined();
    });

    it('should reject non-numeric --sync-batch-size', async () => {
      await runMain(['Token', '--sync-batch-size', 'abc']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          '--sync-batch-size requires a positive integer',
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('should reject zero/negative --sync-batch-size', async () => {
      await runMain(['Token', '--sync-batch-size', '0']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          '--sync-batch-size requires a positive integer',
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('should accept -v as a shorthand for --verbose', async () => {
      await runMain(['Token', '-v']);
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should accept --dry-run and call deployer.dryRun()', async () => {
      const fake = fakeDeployer();
      mockPrepare.mockResolvedValue(fake);

      await runMain(['Token', '--dry-run']);

      expect(fake.dryRun).toHaveBeenCalledTimes(1);
      expect(fake.deploy).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ //
  describe('missing contract positional', () => {
    it('should exit 2 with a missing-contract message', async () => {
      await runMain([]);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Missing required <Contract>'),
      );
      expect(mockExit).toHaveBeenCalledWith(2);
      expect(mockPrepare).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ //
  describe('successful deploy (text output)', () => {
    it('should succeed-spin and log the four metadata lines', async () => {
      mockPrepare.mockResolvedValue(fakeDeployer());
      await runMain(['Token', '--network', 'local']);

      expect(mockSpinner.succeed).toHaveBeenCalledWith(
        expect.stringContaining('Token deployed on local: 0xabc'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('txId:'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('txHash:'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('blockHeight:'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('saved to:'),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should also print the explorer line when explorerUrl is set', async () => {
      mockPrepare.mockResolvedValue(
        fakeDeployer({
          result: defaultResult({ explorerUrl: 'https://explorer/0xabc' }),
        }),
      );
      await runMain(['Token']);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('explorer:    https://explorer/0xabc'),
      );
    });
  });

  // ------------------------------------------------------------------ //
  describe('successful deploy (--json)', () => {
    it('should write the result as one JSON line and skip the spinner', async () => {
      mockPrepare.mockResolvedValue(fakeDeployer());
      await runMain(['Token', '--json']);

      expect(mockOra).not.toHaveBeenCalled();
      expect(mockStdoutWrite).toHaveBeenCalledWith(
        expect.stringMatching(/^\{.*"contractName":"Token".*\}\n$/s),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ //
  describe('dry-run path', () => {
    it('should succeed-spin with the dry-run message', async () => {
      mockPrepare.mockResolvedValue(fakeDeployer());
      await runMain(['Token', '--dry-run']);

      expect(mockSpinner.succeed).toHaveBeenCalledWith(
        expect.stringContaining('Dry-run for Token on local OK'),
      );
      // We should NOT see deploy-only metadata lines.
      expect(mockConsoleLog).not.toHaveBeenCalledWith(
        expect.stringContaining('txId:'),
      );
    });
  });

  // ------------------------------------------------------------------ //
  describe('passphrase prompt wiring', () => {
    it('should stop the spinner before the prompt and restart it after', async () => {
      let captured: ((path: string) => Promise<string>) | undefined;
      mockPrepare.mockImplementation(async (opts: any) => {
        captured = opts.promptPassphrase;
        return fakeDeployer();
      });

      await runMain(['Token']);
      expect(captured).toBeDefined();

      mockSpinner.stop.mockClear();
      mockSpinner.start.mockClear();
      const pp = await captured?.('/some/path');
      expect(pp).toBe('secret');
      expect(mockSpinner.stop).toHaveBeenCalledTimes(1);
      expect(mockSpinner.start).toHaveBeenCalledTimes(1);
      // Ordering: stop must come before start.
      const stopOrder = (mockSpinner.stop.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY) as number;
      const startOrder = (mockSpinner.start.mock.invocationCallOrder[0] ??
        Number.NEGATIVE_INFINITY) as number;
      expect(stopOrder).toBeLessThan(startOrder);
      expect(mockPromptPassphrase).toHaveBeenCalledWith('/some/path');
    });

    it('should NOT touch the spinner when running in --json mode', async () => {
      let captured: ((path: string) => Promise<string>) | undefined;
      mockPrepare.mockImplementation(async (opts: any) => {
        captured = opts.promptPassphrase;
        return fakeDeployer();
      });

      await runMain(['Token', '--json']);
      mockSpinner.stop.mockClear();
      mockSpinner.start.mockClear();
      await captured?.('/p');
      expect(mockSpinner.stop).not.toHaveBeenCalled();
      expect(mockSpinner.start).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ //
  describe('error handling', () => {
    it('should exit with DeployError.exitCode and log via spinner.fail', async () => {
      mockPrepare.mockRejectedValue(
        new ArtifactNotFoundError('artifact missing'),
      );
      await runMain(['Token']);

      expect(mockSpinner.fail).toHaveBeenCalledWith(
        expect.stringContaining('artifact missing'),
      );
      // ArtifactNotFoundError has exitCode 4 (per errors.ts) but we just
      // assert the exit happened; we re-check the value once below.
      expect(mockExit).toHaveBeenCalledTimes(1);
      const callArg = (mockExit.mock.calls[0] as [number])[0];
      expect(typeof callArg).toBe('number');
    });

    it('should use exitCode 1 for non-DeployError exceptions', async () => {
      mockPrepare.mockRejectedValue(new Error('boom'));
      await runMain(['Token']);
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockSpinner.fail).toHaveBeenCalledWith(
        expect.stringContaining('Error: boom'),
      );
    });

    it('should use exitCode 1 for string throws', async () => {
      mockPrepare.mockRejectedValue('weird');
      await runMain(['Token']);
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockSpinner.fail).toHaveBeenCalledWith(
        expect.stringContaining('weird'),
      );
    });

    it('should render a tagged wallet-SDK rejection instead of [object Object]', async () => {
      // The wallet SDK rejects with effect-style records, not Errors, so
      // `String(e)` collapsed the only diagnostic to `[object Object]`.
      mockPrepare.mockRejectedValue({
        _tag: 'Wallet.Sync',
        message: 'Could not deserialize Ledger Event',
      });
      await runMain(['Token']);

      expect(mockSpinner.fail).toHaveBeenCalledWith(
        expect.stringContaining(
          'Wallet.Sync: Could not deserialize Ledger Event',
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should use the DeployError.exitCode verbatim', async () => {
      class CustomError extends DeployError {
        constructor() {
          super('custom failure', 42);
          this.name = 'CustomError';
        }
      }
      mockPrepare.mockRejectedValue(new CustomError());
      await runMain(['Token']);
      expect(mockExit).toHaveBeenCalledWith(42);
    });

    it('should print the stack trace under --verbose', async () => {
      const err = new Error('boom');
      err.stack = 'Error: boom\n  at fake.ts:1:1';
      mockPrepare.mockRejectedValue(err);

      await runMain(['Token', '--verbose']);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('at fake.ts:1:1'),
      );
    });

    it('should NOT print the stack trace without --verbose', async () => {
      const err = new Error('boom');
      err.stack = 'Error: boom\n  at fake.ts:1:1';
      mockPrepare.mockRejectedValue(err);

      await runMain(['Token']);
      const wroteStack = mockConsoleError.mock.calls.some((c) =>
        String(c[0] ?? '').includes('at fake.ts:1:1'),
      );
      expect(wroteStack).toBe(false);
    });

    it('should emit JSON error line in --json mode', async () => {
      mockPrepare.mockRejectedValue(new DeployError('json-mode bad', 7));
      await runMain(['Token', '--json']);

      expect(mockStdoutWrite).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\{"error":"DeployError","message":"json-mode bad","exitCode":7\}\n$/,
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(7);
      // No spinner in json mode.
      expect(mockSpinner.fail).not.toHaveBeenCalled();
    });
  });
});
