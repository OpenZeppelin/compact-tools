import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type { CompactConfig } from '../config/compact-config.ts';
import type { NetworkConfig } from '../config/schema.ts';
import { WalletError } from '../errors.ts';
import { Keystore } from './keystore.ts';

// --- Local prefunded seeds (dev-preset midnight-node) ---

/**
 * Prefunded wallets on `midnight-node --preset=dev`. Slot 0 is the testkit-js
 * `TEST_MNEMONIC`; slots 1..4 are the hex seeds from `LocalTestEnvironment`.
 */
export const LOCAL_PREFUNDED_SEEDS: readonly string[] = [
  TEST_MNEMONIC,
  '0000000000000000000000000000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000003',
  '0000000000000000000000000000000000000000000000000000000000000004',
] as const;

export function localPrefundedSeed(index: number): string {
  const seed = LOCAL_PREFUNDED_SEEDS[index];
  if (!seed) {
    throw new RangeError(
      `local wallet index ${index} out of range (0..${LOCAL_PREFUNDED_SEEDS.length - 1})`,
    );
  }
  return seed;
}

// --- Classify: raw string → discriminated WalletSeed ---

/**
 * The wallet builder derives *different* wallets from `.withSeed(hex)` vs
 * `.withMnemonic(phrase)` for the same entropy, so we keep the kind
 * explicit through the resolve chain.
 */
export type WalletSeed =
  | { kind: 'hex'; value: string }
  | { kind: 'mnemonic'; value: string };

export function classifySeed(input: string): WalletSeed {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new WalletError('Seed cannot be empty');
  }
  if (
    /^[0-9a-fA-F]+$/.test(trimmed) &&
    (trimmed.length === 64 || trimmed.length === 128)
  ) {
    return { kind: 'hex', value: trimmed.toLowerCase() };
  }
  if (validateMnemonic(trimmed, wordlist)) {
    return { kind: 'mnemonic', value: trimmed };
  }
  throw new WalletError(
    'Invalid seed: expected a 64/128-char hex string or a valid BIP39 mnemonic (12 or 24 words).',
  );
}

// --- Resolve: pick a seed from the precedence chain ---

/**
 * Precedence: `--seed-file` > `MN_DEPLOYER_SEED` > `[wallet].keystore`
 * (passphrase-prompted) > `[networks.local].wallet.source = "local"`.
 * A relative `--seed-file` resolves against the CWD, like every other path
 * the CLI takes; a relative `[wallet].keystore` resolves against `rootDir`,
 * so a `compact.toml` value means the same thing from any directory.
 * Throws {@link WalletError} when none match.
 */
export interface SeedResolution {
  seed: WalletSeed;
  origin: 'cli' | 'env' | 'keystore' | 'local';
}

export interface ResolveOptions {
  config: CompactConfig;
  networkName: string;
  network: NetworkConfig;
  seedFile?: string;
  promptPassphrase?: (path: string) => Promise<string>;
}

export async function resolveSeed(
  opts: ResolveOptions,
): Promise<SeedResolution> {
  if (opts.seedFile) {
    const path = absoluteUnder(process.cwd(), opts.seedFile);
    const raw = await safeRead(path, '--seed-file');
    return { seed: classifySeed(raw), origin: 'cli' };
  }

  const envSeed = process.env.MN_DEPLOYER_SEED;
  if (envSeed?.trim()) {
    return { seed: classifySeed(envSeed), origin: 'env' };
  }

  const keystorePath = opts.config.wallet?.keystore;
  if (keystorePath) {
    const path = absoluteUnder(opts.config.rootDir, keystorePath);
    if (!existsSync(path)) {
      throw new WalletError(`Keystore file not found: ${path}`);
    }
    if (!opts.promptPassphrase) {
      throw new WalletError(
        'Keystore configured but no passphrase prompt provided',
      );
    }
    const ks = await Keystore.readFromFile(path);
    const passphrase = await opts.promptPassphrase(path);
    return { seed: classifySeed(ks.decrypt(passphrase)), origin: 'keystore' };
  }

  if (opts.networkName === 'local' && opts.network.wallet?.source === 'local') {
    return {
      seed: classifySeed(localPrefundedSeed(opts.network.wallet.index ?? 0)),
      origin: 'local',
    };
  }

  throw new WalletError(
    `No deployer seed for network "${opts.networkName}". Provide --seed-file, set MN_DEPLOYER_SEED, or configure [wallet].keystore in compact.toml.`,
  );
}

function absoluteUnder(root: string, p: string): string {
  return isAbsolute(p) ? p : resolve(root, p);
}

async function safeRead(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    throw new WalletError(
      `Failed to read ${label} (${path}): ${(e as Error).message}`,
    );
  }
}
