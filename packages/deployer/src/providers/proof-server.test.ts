import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';

/**
 * Stand-in for testkit's container config. Kept global and mutable like the
 * real one, so a start observes whatever the last write left behind.
 */
let containersConfig = {
  proofServer: {
    path: process.cwd(),
    fileName: 'proof-server.yml',
    container: { name: 'proof-server', port: 6300, waitStrategy: {} },
  },
};

/** Directories `DynamicProofServerContainer.start` was pointed at, in order. */
const composeDirs: string[] = [];

vi.mock('@midnight-ntwrk/testkit-js', () => ({
  DynamicProofServerContainer: {
    start: vi.fn(async () => {
      composeDirs.push(containersConfig.proofServer.path);
      return {
        getUrl: () => 'http://dynamic-container:6300',
        stop: vi.fn(async () => undefined),
      };
    }),
  },
  StaticProofServerContainer: vi.fn(function StaticProofServerContainer(
    this: { getUrl: () => string; stop: () => Promise<void> },
    port: number,
  ) {
    this.getUrl = () => `http://127.0.0.1:${port}`;
    this.stop = vi.fn(async () => undefined);
  }),
  getContainersConfiguration: vi.fn(() => containersConfig),
  setContainersConfiguration: vi.fn((next: typeof containersConfig) => {
    containersConfig = next;
  }),
}));

const { DynamicProofServerContainer, StaticProofServerContainer } =
  await import('@midnight-ntwrk/testkit-js');
const { ProofServer } = await import('./proof-server.ts');

const makeLogger = (): Logger => {
  const noop = vi.fn();
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    trace: noop,
  } as unknown as Logger;
};

const baseNetwork: NetworkConfig = {
  network_id: 'testnet',
  indexer: 'https://indexer.example/api',
  indexer_ws: 'wss://indexer.example/ws',
  node: 'https://node.example',
  node_ws: 'wss://node.example/ws',
};

describe('ProofServer.start — precedence chain', () => {
  const originalPort = process.env.PROOF_SERVER_PORT;

  beforeEach(() => {
    vi.mocked(DynamicProofServerContainer.start).mockClear();
    vi.mocked(StaticProofServerContainer).mockClear();
    delete process.env.PROOF_SERVER_PORT;
  });

  afterEach(() => {
    if (originalPort === undefined) {
      delete process.env.PROOF_SERVER_PORT;
    } else {
      process.env.PROOF_SERVER_PORT = originalPort;
    }
  });

  it('(1) should use cliOverride above everything else', async () => {
    process.env.PROOF_SERVER_PORT = '9999';
    const ps = await ProofServer.start({
      cliOverride: 'http://cli:6300',
      network: { ...baseNetwork, proof_server: 'http://toml:6300' },
      logger: makeLogger(),
    });

    expect(ps.url).toBe('http://cli:6300');
    expect(DynamicProofServerContainer.start).not.toHaveBeenCalled();
    expect(StaticProofServerContainer).not.toHaveBeenCalled();
  });

  it('(2) should use the TOML proof_server URL when no CLI override', async () => {
    const ps = await ProofServer.start({
      network: { ...baseNetwork, proof_server: 'http://toml:6300' },
      logger: makeLogger(),
    });
    expect(ps.url).toBe('http://toml:6300');
    expect(DynamicProofServerContainer.start).not.toHaveBeenCalled();
  });

  it('(3) should boot a dynamic container when TOML proof_server = "auto"', async () => {
    const ps = await ProofServer.start({
      network: { ...baseNetwork, proof_server: 'auto' },
      logger: makeLogger(),
    });

    expect(ps.url).toBe('http://dynamic-container:6300');
    expect(DynamicProofServerContainer.start).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(DynamicProofServerContainer.start).mock.calls[0];
    expect(callArgs?.[2]).toBe('testnet');
  });

  it('(4) should use PROOF_SERVER_PORT when no explicit config', async () => {
    process.env.PROOF_SERVER_PORT = '7777';
    const ps = await ProofServer.start({
      network: baseNetwork,
      logger: makeLogger(),
    });

    expect(ps.url).toBe('http://127.0.0.1:7777');
    expect(StaticProofServerContainer).toHaveBeenCalledWith(7777);
  });

  it('(4) should throw ConfigError for a non-numeric PROOF_SERVER_PORT', async () => {
    process.env.PROOF_SERVER_PORT = 'not-a-number';
    await expect(
      ProofServer.start({ network: baseNetwork, logger: makeLogger() }),
    ).rejects.toThrow(ConfigError);
  });

  it('(4) should reject a partially-numeric PROOF_SERVER_PORT (e.g. "6300abc")', async () => {
    process.env.PROOF_SERVER_PORT = '6300abc';
    await expect(
      ProofServer.start({ network: baseNetwork, logger: makeLogger() }),
    ).rejects.toThrow(ConfigError);
    expect(StaticProofServerContainer).not.toHaveBeenCalled();
  });

  it('(4) should reject an out-of-range PROOF_SERVER_PORT', async () => {
    process.env.PROOF_SERVER_PORT = '70000';
    await expect(
      ProofServer.start({ network: baseNetwork, logger: makeLogger() }),
    ).rejects.toThrow(ConfigError);
    expect(StaticProofServerContainer).not.toHaveBeenCalled();
  });

  it('(5) should fall back to http://127.0.0.1:6300 when nothing is configured', async () => {
    const ps = await ProofServer.start({
      network: baseNetwork,
      logger: makeLogger(),
    });

    expect(ps.url).toBe('http://127.0.0.1:6300');
    expect(DynamicProofServerContainer.start).not.toHaveBeenCalled();
    expect(StaticProofServerContainer).not.toHaveBeenCalled();
  });

  it('should prefer cliOverride = "auto" over TOML URL (CLI wins)', async () => {
    const ps = await ProofServer.start({
      cliOverride: 'http://cli-static',
      network: { ...baseNetwork, proof_server: 'auto' },
      logger: makeLogger(),
    });

    expect(ps.url).toBe('http://cli-static');
    expect(DynamicProofServerContainer.start).not.toHaveBeenCalled();
  });
});

describe('ProofServer — disposal', () => {
  it('should be a no-op for static-URL instances', async () => {
    const ps = await ProofServer.start({
      network: { ...baseNetwork, proof_server: 'http://static' },
      logger: makeLogger(),
    });
    await expect(ps.dispose()).resolves.toBeUndefined();
  });

  it('should stop the static container for the PROOF_SERVER_PORT path', async () => {
    process.env.PROOF_SERVER_PORT = '7777';
    const ps = await ProofServer.start({
      network: baseNetwork,
      logger: makeLogger(),
    });
    const instance = vi.mocked(StaticProofServerContainer).mock.instances[0];
    await ps.dispose();
    expect(instance?.stop).toHaveBeenCalledOnce();
  });

  it('should stop the underlying container for the "auto" path', async () => {
    const stop = vi.fn(async () => undefined);
    vi.mocked(DynamicProofServerContainer.start).mockResolvedValueOnce({
      getUrl: () => 'http://dyn',
      stop,
    } as never);

    const ps = await ProofServer.start({
      network: { ...baseNetwork, proof_server: 'auto' },
      logger: makeLogger(),
    });
    await ps.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('Symbol.asyncDispose should swallow teardown errors via the warn log', async () => {
    const stop = vi.fn(async () => {
      throw new Error('boom');
    });
    vi.mocked(DynamicProofServerContainer.start).mockResolvedValueOnce({
      getUrl: () => 'http://dyn',
      stop,
    } as never);

    const logger = makeLogger();
    const ps = await ProofServer.start({
      network: { ...baseNetwork, proof_server: 'auto' },
      logger,
    });

    await expect(ps[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('ProofServer.start — the "auto" compose file', () => {
  const FILE_NAME = 'proof-server.yml';

  const emptyDir = (): string => mkdtempSync(join(tmpdir(), 'compose-'));

  const dirWithComposeFile = (): string => {
    const dir = emptyDir();
    writeFileSync(join(dir, FILE_NAME), 'services: {}\n');
    return dir;
  };

  /** Starts `auto` from `cwd`; answers with the directory testkit booted from. */
  const composeDirFrom = async (cwd: string): Promise<string> => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    composeDirs.length = 0;
    await ProofServer.start({
      network: { ...baseNetwork, proof_server: 'auto' },
      logger: makeLogger(),
    });
    expect(composeDirs).toHaveLength(1);
    return composeDirs[0];
  };

  afterEach(() => {
    vi.mocked(process.cwd).mockRestore();
  });

  // Also guards `files` in package.json: dropping the yaml there would break
  // `auto` for npm installs only, never in CI, which runs from the worktree.
  it('should boot from the packaged file when the cwd has no compose file', async () => {
    const dir = await composeDirFrom(emptyDir());

    expect(existsSync(join(dir, FILE_NAME))).toBe(true);
  });

  it('should prefer a compose file in the cwd over the packaged one', async () => {
    const cwd = dirWithComposeFile();

    expect(await composeDirFrom(cwd)).toBe(cwd);
  });

  it('should re-resolve per start rather than reuse the last path', async () => {
    const overriding = dirWithComposeFile();
    expect(await composeDirFrom(overriding)).toBe(overriding);

    const packaged = await composeDirFrom(emptyDir());
    expect(packaged).not.toBe(overriding);
    expect(existsSync(join(packaged, FILE_NAME))).toBe(true);
  });
});
