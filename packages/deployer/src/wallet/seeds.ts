/**
 * Seed input handling: prefunded local-dev seeds, hex-vs-mnemonic
 * classification, and the precedence chain that picks a seed from CLI,
 * env, keystore, or local pool.
 *
 * Kept as plain functions on purpose — none of these own state, hold a
 * lifecycle, or share data; merging them into a class would just add
 * ceremony.
 */
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

// ---------------------------------------------------------------------------
// Local prefunded seeds (dev-preset midnight-node).
// ---------------------------------------------------------------------------

/**
 * Prefunded wallets on `midnight-node --preset=dev`.
 *
 * Slot 0 is the canonical testkit-js BIP39 mnemonic
 * (`abandon × 23 diesel`), which the dev preset funds at genesis.
 * Slots 1..4 are the additional hex seeds the standalone testkit
 * exposes via `LocalTestEnvironment`.
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

// ---------------------------------------------------------------------------
// Classify: raw string → discriminated WalletSeed.
// ---------------------------------------------------------------------------

/**
 * Discriminated representation of a deployer wallet input.
 *
 * The wallet builder offers two paths — `.withSeed(hex)` and
 * `.withMnemonic(phrase)` — that derive *different* wallets from the
 * same underlying entropy. Keeping the kind explicit through the
 * resolve chain lets the builder pick the matching method instead of
 * force-converting a mnemonic to hex (which silently lands on the
 * wrong wallet).
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

// ---------------------------------------------------------------------------
// Resolve: pick a seed from the precedence chain.
// ---------------------------------------------------------------------------

/**
 * Resolve the deployer seed for a given network, with a documented
 * precedence chain.
 *
 * Order (highest first):
 *  1. `--seed-file <path>`  (CLI)
 *  2. `MN_DEPLOYER_SEED`     (env)
 *  3. `[wallet].keystore`    (TOML; passphrase prompt required)
 *  4. `[networks.local].wallet.source = "local"` (prefunded dev seed)
 *
 * Fails with {@link WalletError} when none match — with an actionable
 * message that lists every path the user can take.
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
  const { rootDir } = opts.config;
  if (opts.seedFile) {
    const path = absoluteUnder(rootDir, opts.seedFile);
    const raw = await safeRead(path, '--seed-file');
    return { seed: classifySeed(raw), origin: 'cli' };
  }

  const envSeed = process.env.MN_DEPLOYER_SEED;
  if (envSeed?.trim()) {
    return { seed: classifySeed(envSeed), origin: 'env' };
  }

  const keystorePath = opts.config.wallet?.keystore;
  if (keystorePath) {
    const path = absoluteUnder(rootDir, keystorePath);
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
