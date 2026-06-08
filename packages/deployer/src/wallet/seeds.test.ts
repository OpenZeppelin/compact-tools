import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompactConfig } from '../config/compact-config.ts';
import type { NetworkConfig } from '../config/schema.ts';
import { WalletError } from '../errors.ts';
import { Keystore } from './keystore.ts';
import {
  classifySeed,
  LOCAL_PREFUNDED_SEEDS,
  localPrefundedSeed,
  resolveSeed,
} from './seeds.ts';

vi.mock('./keystore.ts', () => ({
  Keystore: { readFromFile: vi.fn() },
}));

const HEX_SEED = 'aa'.repeat(32);
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function fakeConfig(rootDir: string, keystore?: string): CompactConfig {
  return {
    rootDir,
    wallet: keystore ? { keystore } : undefined,
  } as unknown as CompactConfig;
}

function fakeNetwork(opts: { local?: { index?: number } } = {}): NetworkConfig {
  return {
    wallet: opts.local
      ? { source: 'local', index: opts.local.index ?? 0 }
      : undefined,
  } as unknown as NetworkConfig;
}

describe('classifySeed', () => {
  it('should classify a 64-char hex string as hex (lowercased)', () => {
    const hex = 'A'.repeat(64);
    expect(classifySeed(hex)).toEqual({ kind: 'hex', value: 'a'.repeat(64) });
  });

  it('should classify a 128-char hex string as hex', () => {
    const hex = `${'0'.repeat(127)}1`;
    expect(classifySeed(hex)).toEqual({ kind: 'hex', value: hex });
  });

  it('should classify a valid BIP39 mnemonic as mnemonic (no conversion)', () => {
    expect(classifySeed(MNEMONIC)).toEqual({
      kind: 'mnemonic',
      value: MNEMONIC,
    });
  });

  it('should reject empty input', () => {
    expect(() => classifySeed('   ')).toThrow(WalletError);
  });

  it('should reject an invalid hex length', () => {
    expect(() => classifySeed('abc123')).toThrow(WalletError);
  });

  it('should reject gibberish that is neither hex nor BIP39', () => {
    expect(() => classifySeed('this is definitely not valid')).toThrow(
      WalletError,
    );
  });
});

describe('localPrefundedSeed', () => {
  it('should return the prefunded seed at the given index', () => {
    for (let i = 0; i < LOCAL_PREFUNDED_SEEDS.length; i++) {
      expect(localPrefundedSeed(i)).toBe(LOCAL_PREFUNDED_SEEDS[i]);
    }
  });

  it('should throw RangeError when the index is out of range', () => {
    expect(() => localPrefundedSeed(99)).toThrow(RangeError);
  });
});

describe('resolveSeed', () => {
  let rootDir: string;
  const originalEnvSeed = process.env.MN_DEPLOYER_SEED;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'seeds-resolve-'));
    delete process.env.MN_DEPLOYER_SEED;
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
    if (originalEnvSeed === undefined) {
      delete process.env.MN_DEPLOYER_SEED;
    } else {
      process.env.MN_DEPLOYER_SEED = originalEnvSeed;
    }
  });

  describe('--seed-file branch', () => {
    it('should read seed from a relative seedFile path under rootDir', async () => {
      writeFileSync(join(rootDir, 'seed.hex'), `${HEX_SEED}\n`);
      const result = await resolveSeed({
        config: fakeConfig(rootDir),
        networkName: 'testnet',
        network: fakeNetwork(),
        seedFile: 'seed.hex',
      });
      expect(result).toEqual({
        seed: { kind: 'hex', value: HEX_SEED },
        origin: 'cli',
      });
    });

    it('should read seed from an absolute seedFile path unchanged', async () => {
      const abs = join(rootDir, 'abs-seed.hex');
      writeFileSync(abs, HEX_SEED);
      const result = await resolveSeed({
        config: fakeConfig(rootDir),
        networkName: 'testnet',
        network: fakeNetwork(),
        seedFile: abs,
      });
      expect(result.origin).toBe('cli');
      expect(result.seed).toEqual({ kind: 'hex', value: HEX_SEED });
    });

    it('should wrap fs errors as WalletError with the --seed-file label', async () => {
      await expect(
        resolveSeed({
          config: fakeConfig(rootDir),
          networkName: 'testnet',
          network: fakeNetwork(),
          seedFile: 'does-not-exist.hex',
        }),
      ).rejects.toThrow(/Failed to read --seed-file/);
    });
  });

  describe('MN_DEPLOYER_SEED branch', () => {
    it('should return env seed with origin=env when set', async () => {
      process.env.MN_DEPLOYER_SEED = HEX_SEED;
      const result = await resolveSeed({
        config: fakeConfig(rootDir),
        networkName: 'testnet',
        network: fakeNetwork(),
      });
      expect(result).toEqual({
        seed: { kind: 'hex', value: HEX_SEED },
        origin: 'env',
      });
    });

    it('should ignore a whitespace-only env value', async () => {
      process.env.MN_DEPLOYER_SEED = '   ';
      await expect(
        resolveSeed({
          config: fakeConfig(rootDir),
          networkName: 'testnet',
          network: fakeNetwork(),
        }),
      ).rejects.toThrow(WalletError);
    });
  });

  describe('keystore branch', () => {
    it('should throw WalletError when the keystore file does not exist', async () => {
      await expect(
        resolveSeed({
          config: fakeConfig(rootDir, 'missing-keystore.json'),
          networkName: 'testnet',
          network: fakeNetwork(),
          promptPassphrase: async () => 'pw',
        }),
      ).rejects.toThrow(/Keystore file not found:/);
    });

    it('should throw WalletError when keystore is configured but no passphrase prompt provided', async () => {
      const ksPath = join(rootDir, 'keystore.json');
      writeFileSync(ksPath, '{}');
      await expect(
        resolveSeed({
          config: fakeConfig(rootDir, 'keystore.json'),
          networkName: 'testnet',
          network: fakeNetwork(),
        }),
      ).rejects.toThrow(/no passphrase prompt provided/);
    });

    it('should decrypt the keystore and return origin=keystore on the happy path', async () => {
      const ksPath = join(rootDir, 'keystore.json');
      writeFileSync(ksPath, '{}');
      const decrypt = vi.fn(() => HEX_SEED);
      vi.mocked(Keystore.readFromFile).mockResolvedValue({
        decrypt,
      } as unknown as Keystore);
      const prompt = vi.fn(async () => 'hunter2');
      const result = await resolveSeed({
        config: fakeConfig(rootDir, 'keystore.json'),
        networkName: 'testnet',
        network: fakeNetwork(),
        promptPassphrase: prompt,
      });
      expect(Keystore.readFromFile).toHaveBeenCalledWith(ksPath);
      expect(prompt).toHaveBeenCalledWith(ksPath);
      expect(decrypt).toHaveBeenCalledWith('hunter2');
      expect(result).toEqual({
        seed: { kind: 'hex', value: HEX_SEED },
        origin: 'keystore',
      });
    });
  });

  describe('local prefunded branch', () => {
    it('should return the indexed local prefunded seed when networkName=local and source=local', async () => {
      const result = await resolveSeed({
        config: fakeConfig(rootDir),
        networkName: 'local',
        network: fakeNetwork({ local: { index: 2 } }),
      });
      expect(result.origin).toBe('local');
      // index 2 is a 64-char hex seed in LOCAL_PREFUNDED_SEEDS
      expect(result.seed.kind).toBe('hex');
      expect(result.seed.value).toBe(LOCAL_PREFUNDED_SEEDS[2]);
    });

    it('should default to index 0 (the mnemonic) when no index is configured', async () => {
      const result = await resolveSeed({
        config: fakeConfig(rootDir),
        networkName: 'local',
        network: fakeNetwork({ local: {} }),
      });
      expect(result.origin).toBe('local');
      expect(result.seed.kind).toBe('mnemonic');
    });
  });

  describe('no source available', () => {
    it('should throw WalletError with the help message when no seed source is configured', async () => {
      await expect(
        resolveSeed({
          config: fakeConfig(rootDir),
          networkName: 'testnet',
          network: fakeNetwork(),
        }),
      ).rejects.toThrow(
        /Provide --seed-file, set MN_DEPLOYER_SEED, or configure \[wallet\].keystore/,
      );
    });

    it('should NOT fall into the local branch when networkName is local but no wallet source is set', async () => {
      await expect(
        resolveSeed({
          config: fakeConfig(rootDir),
          networkName: 'local',
          network: fakeNetwork(),
        }),
      ).rejects.toThrow(WalletError);
    });
  });
});
