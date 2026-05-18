import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { CompactConfig } from '../config/compact-config.ts';
import type { NetworkConfig } from '../config/schema.ts';
import { WalletError } from '../errors.ts';
import { Keystore } from './keystore.ts';
import { localPrefundedSeed } from './local-seeds.ts';
import { classifySeed, type WalletSeed } from './normalize.ts';

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
    // Keystores store a raw 32-byte hex secret; classify ensures shape.
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
