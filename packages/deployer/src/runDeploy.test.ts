import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as compactConfigModule from './config/compact-config.ts';
import * as deployerModule from './deployer.ts';
import { DeployError } from './errors.ts';
import * as contractResolveModule from './loaders/contract-resolve.ts';
import { constructorArgs, runDeploy } from './runDeploy.ts';

function fakeDeployResult(overrides: Record<string, unknown> = {}) {
  return {
    contractName: 'X',
    network: 'local',
    address: '0xaddr',
    txHash: '0xtx',
    txId: 'tx-id',
    blockHeight: 42,
    signingKey: '0xsk',
    deployer: '0xdep',
    artifact: 'X',
    deploymentsFile: '/tmp/local.json',
    dryRun: false,
    explorerUrl: '',
    ...overrides,
  };
}

function fakeDeployer(
  opts: { dryRun?: () => unknown; deploy?: () => unknown } = {},
) {
  const deploy = opts.deploy ?? vi.fn(async () => fakeDeployResult());
  const dryRun =
    opts.dryRun ?? vi.fn(async () => fakeDeployResult({ dryRun: true }));
  return {
    deploy,
    dryRun,
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
  };
}

let originalArgv: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalArgv = process.argv;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('runDeploy', () => {
  it('should call Deployer.prepare with merged opts (explicit > argv)', async () => {
    process.argv = ['node', 'script.ts', '--network', 'preview', '--dry-run'];
    const fakeDep = fakeDeployer();
    const prepare = vi
      .spyOn(deployerModule.Deployer, 'prepare')
      .mockResolvedValue(fakeDep as any);

    await runDeploy({ contract: 'X', network: 'local', args: [1, 2] });

    const callArgs = prepare.mock.calls[0]?.[0];
    expect(callArgs?.contract).toBe('X');
    expect(callArgs?.network).toBe('local'); // explicit beats argv
    expect(callArgs?.args).toEqual([1, 2]);
  });

  it('should pull --network and --dry-run from argv when opts omit them', async () => {
    process.argv = ['node', 'script.ts', '--network', 'preview', '--dry-run'];
    const fakeDep = fakeDeployer();
    vi.spyOn(deployerModule.Deployer, 'prepare').mockResolvedValue(
      fakeDep as never,
    );

    await runDeploy({ contract: 'X' });

    expect((fakeDep.dryRun as any).mock.calls.length).toBe(1);
    expect(
      (deployerModule.Deployer.prepare as any).mock.calls[0][0].network,
    ).toBe('preview');
  });

  it('should convert --sync-timeout seconds to milliseconds', async () => {
    process.argv = ['node', 'script.ts', '--sync-timeout', '120'];
    const fakeDep = fakeDeployer();
    vi.spyOn(deployerModule.Deployer, 'prepare').mockResolvedValue(
      fakeDep as never,
    );

    await runDeploy({ contract: 'X' });

    expect(
      (deployerModule.Deployer.prepare as any).mock.calls[0][0].syncTimeoutMs,
    ).toBe(120_000);
  });

  it('should reject a non-positive --sync-timeout', async () => {
    process.argv = ['node', 'script.ts', '--sync-timeout', 'nope'];
    await expect(runDeploy({ contract: 'X' })).rejects.toThrow(
      /--sync-timeout requires a positive integer/,
    );
  });

  it('should thread --seed-cache-from-dust and --seed-cache-from-shielded to Deployer.prepare', async () => {
    process.argv = [
      'node',
      'script.ts',
      '--seed-cache-from-dust',
      '/path/to/dust.json',
      '--seed-cache-from-shielded',
      '/path/to/shielded.gz',
    ];
    const fakeDep = fakeDeployer();
    vi.spyOn(deployerModule.Deployer, 'prepare').mockResolvedValue(
      fakeDep as never,
    );

    await runDeploy({ contract: 'X' });

    const callArgs = (deployerModule.Deployer.prepare as any).mock.calls[0][0];
    expect(callArgs.seedCacheDust).toBe('/path/to/dust.json');
    expect(callArgs.seedCacheShielded).toBe('/path/to/shielded.gz');
  });

  it('should let explicit seedCacheFromDust opt beat the argv value', async () => {
    process.argv = [
      'node',
      'script.ts',
      '--seed-cache-from-dust',
      '/argv.json',
    ];
    const fakeDep = fakeDeployer();
    vi.spyOn(deployerModule.Deployer, 'prepare').mockResolvedValue(
      fakeDep as never,
    );

    await runDeploy({ contract: 'X', seedCacheFromDust: '/explicit.json' });

    const callArgs = (deployerModule.Deployer.prepare as any).mock.calls[0][0];
    expect(callArgs.seedCacheDust).toBe('/explicit.json');
  });

  it('should reject --seed-cache-from-dust with no value', async () => {
    process.argv = ['node', 'script.ts', '--seed-cache-from-dust'];
    await expect(runDeploy({ contract: 'X' })).rejects.toThrow(
      /--seed-cache-from-dust requires a value/,
    );
  });

  it('should emit JSON on stdout in --json mode on success', async () => {
    process.argv = ['node', 'script.ts', '--json'];
    const fakeDep = fakeDeployer();
    vi.spyOn(deployerModule.Deployer, 'prepare').mockResolvedValue(
      fakeDep as never,
    );

    await runDeploy({ contract: 'X' });

    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.contractName).toBe('X');
    expect(parsed.address).toBe('0xaddr');
  });

  it('should emit JSON error + exit with DeployError.exitCode in --json mode', async () => {
    process.argv = ['node', 'script.ts', '--json'];
    vi.spyOn(deployerModule.Deployer, 'prepare').mockRejectedValue(
      new DeployError('boom', 3),
    );

    await expect(runDeploy({ contract: 'X' })).rejects.toThrow(
      'process.exit(3)',
    );

    const written = writeSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.error).toBe('DeployError');
    expect(parsed.message).toBe('boom');
    expect(parsed.exitCode).toBe(3);
  });

  it('should exit with code 1 on non-DeployError', async () => {
    process.argv = ['node', 'script.ts'];
    vi.spyOn(deployerModule.Deployer, 'prepare').mockRejectedValue(
      new Error('generic'),
    );

    await expect(runDeploy({ contract: 'X' })).rejects.toThrow(
      'process.exit(1)',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should pass constructorArgs(Contract, ...) tuple through to Deployer.prepare', async () => {
    process.argv = ['node', 'script.ts'];
    const fakeDep = fakeDeployer();
    const prepare = vi
      .spyOn(deployerModule.Deployer, 'prepare')
      .mockResolvedValue(fakeDep as never);

    class FakeContract {
      initialState(_ctx: never, _a: string, _b: bigint) {
        return undefined as never;
      }
    }

    await runDeploy({
      contract: 'X',
      args: constructorArgs(FakeContract as never, 'hello', 42n),
    });

    expect(prepare.mock.calls[0]?.[0]?.args).toEqual(['hello', 42n]);
  });

  it('should forward a named-object args record to Deployer.prepare untouched', async () => {
    process.argv = ['node', 'script.ts'];
    const fakeDep = fakeDeployer();
    const prepare = vi
      .spyOn(deployerModule.Deployer, 'prepare')
      .mockResolvedValue(fakeDep as never);

    interface MyArgs {
      foo: string;
      bar: bigint;
    }

    await runDeploy<MyArgs>({
      contract: 'X',
      args: { foo: 'hello', bar: 42n },
    });

    // The reorder happens inside ConstructorArgs.load against the
    // artifact's index.d.ts; runDeploy just forwards the object as-is.
    expect(prepare.mock.calls[0]?.[0]?.args).toEqual({
      foo: 'hello',
      bar: 42n,
    });
  });

  it('curried form: should resolve Contract → name and forward args positionally', async () => {
    process.argv = ['node', 'script.ts'];
    const fakeDep = fakeDeployer();
    const prepare = vi
      .spyOn(deployerModule.Deployer, 'prepare')
      .mockResolvedValue(fakeDep as never);
    vi.spyOn(compactConfigModule.CompactConfig, 'load').mockResolvedValue({
      rootDir: '/tmp',
    } as never);
    vi.spyOn(contractResolveModule, 'resolveContractName').mockResolvedValue(
      'TokenExample',
    );

    class FakeContract {
      initialState(_ctx: never, _a: string, _b: bigint) {
        return undefined as never;
      }
    }

    await runDeploy(FakeContract as never)('hello', 42n);

    expect(prepare.mock.calls[0]?.[0]?.contract).toBe('TokenExample');
    expect(prepare.mock.calls[0]?.[0]?.args).toEqual(['hello', 42n]);
  });

  it('curried form: should merge extra opts (2nd arg) into Deployer.prepare', async () => {
    process.argv = ['node', 'script.ts'];
    const fakeDep = fakeDeployer();
    const prepare = vi
      .spyOn(deployerModule.Deployer, 'prepare')
      .mockResolvedValue(fakeDep as never);
    vi.spyOn(compactConfigModule.CompactConfig, 'load').mockResolvedValue({
      rootDir: '/tmp',
    } as never);
    vi.spyOn(contractResolveModule, 'resolveContractName').mockResolvedValue(
      'TokenExample',
    );

    class FakeContract {
      initialState(_ctx: never, _a: string) {
        return undefined as never;
      }
    }

    await runDeploy(FakeContract as never, { network: 'preview' })('hello');

    expect(prepare.mock.calls[0]?.[0]?.network).toBe('preview');
  });

  it('should print dryRun success line in non-JSON mode', async () => {
    process.argv = ['node', 'script.ts', '--dry-run'];
    const fakeDep = fakeDeployer();
    vi.spyOn(deployerModule.Deployer, 'prepare').mockResolvedValue(
      fakeDep as never,
    );
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await runDeploy({
      contract: 'X',
      logger: logger as never,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/^Dry-run for /),
    );
  });

  it('should print the explorer URL line when the result carries one', async () => {
    process.argv = ['node', 'script.ts'];
    const deploy = vi.fn(async () =>
      fakeDeployResult({ explorerUrl: 'https://explorer/contracts/0xaddr' }),
    );
    const fakeDep = fakeDeployer({ deploy });
    vi.spyOn(deployerModule.Deployer, 'prepare').mockResolvedValue(
      fakeDep as never,
    );
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await runDeploy({ contract: 'X', logger: logger as never });

    const explorerCall = logger.info.mock.calls.find((c) =>
      String(c[0]).includes('explorer:'),
    );
    expect(explorerCall).toBeDefined();
  });

  it('should log the stack trace in verbose mode when an Error throws', async () => {
    process.argv = ['node', 'script.ts', '--verbose'];
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at trace';
    vi.spyOn(deployerModule.Deployer, 'prepare').mockRejectedValue(err);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await expect(
      runDeploy({ contract: 'X', logger: logger as never }),
    ).rejects.toThrow('process.exit(1)');

    expect(logger.debug).toHaveBeenCalledWith('Error: boom\n  at trace');
  });
});
