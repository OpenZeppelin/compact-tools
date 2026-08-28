import {
  type CoinPublicKey,
  convertFieldToBytes,
  encodeCoinPublicKey,
} from '@midnight-ntwrk/compact-runtime';
import type { BackendKind } from '../backend/Backend.js';

/**
 * The number of prefunded wallets available on the dev-preset live node:
 * the deployer plus three named aliases (D1). Requesting more requires
 * the deferred derive-and-fund flow.
 */
export const MAX_LIVE_SIGNERS = 4;

/** Structural mirror of a generated artifact's `ZswapCoinPublicKey`. */
export type ZswapCoinPublicKey = { bytes: Uint8Array };

/** Structural mirror of a generated artifact's `ContractAddress`. */
export type ContractAddress = { bytes: Uint8Array };

/** Structural mirror of a generated artifact's `Either<L, R>`. */
export type Either<L, R> = {
  is_left: boolean;
  left: L;
  right: R;
};

/**
 * Converts an ASCII alias to a 64-char zero-padded hex string.
 *
 * This is the exact derivation the existing test harness uses
 * (`generatePubKeyPair` / `encodeToPK`), so a backend-aware simulator resolves
 * an alias to the same key the current synchronous specs do — preserving dry
 * parity for migrated modules.
 *
 * @param alias - The caller alias.
 * @returns A 64-char hex `CoinPublicKey`.
 */
const aliasToHex = (alias: string): CoinPublicKey =>
  Buffer.from(alias, 'ascii').toString('hex').padStart(64, '0');

const zeroBytes = (): Uint8Array => convertFieldToBytes(32, 0n, '');

/**
 * Configuration for {@link Signers}.
 */
export interface SignersOptions {
  /** The backend this resolver serves. */
  mode: BackendKind;
  /**
   * Dry only: override the default deterministic alias derivation with an
   * explicit alias→key map. Aliases not present fall back to the default
   * derivation (OQ4).
   */
  dryKeys?: Readonly<Record<string, CoinPublicKey>>;
  /**
   * Live only: the aliases backed by a prefunded wallet on the node. Capped at
   * {@link MAX_LIVE_SIGNERS}. Requesting an alias outside this set
   * fails with a clear error rather than silently reusing a wallet.
   */
  liveAliases?: readonly string[];
  /**
   * Live only: resolve an alias to its wallet's coin public key. Supplied by the
   * caller's harness, which owns wallet provisioning.
   */
  resolveLiveKey?: (alias: string) => CoinPublicKey | Promise<CoinPublicKey>;
}

/**
 * Resolves caller-identity aliases to keys, uniformly across backends.
 *
 * Alias strings are the common currency for caller identity (D1): `as('OWNER')`
 * denotes the same logical actor in both modes. Dry derives a
 * deterministic key from the alias label; live resolves the alias to a pooled,
 * prefunded wallet, enforcing the {@link MAX_LIVE_SIGNERS} cap.
 *
 * The public resolvers ({@link keyFor}, {@link eitherFor}) are async so spec
 * code is uniform `await` across backends, even though dry resolves
 * synchronously.
 */
export class Signers {
  readonly mode: BackendKind;
  private readonly dryKeys: Readonly<Record<string, CoinPublicKey>>;
  private readonly liveAliases: ReadonlySet<string>;
  private readonly resolveLiveKey?: (
    alias: string,
  ) => CoinPublicKey | Promise<CoinPublicKey>;

  constructor(options: SignersOptions) {
    this.mode = options.mode;
    this.dryKeys = options.dryKeys ?? {};
    this.liveAliases = new Set(options.liveAliases ?? []);
    this.resolveLiveKey = options.resolveLiveKey;

    if (this.mode === 'live' && this.liveAliases.size > MAX_LIVE_SIGNERS) {
      throw new Error(
        `live backend supports at most ${MAX_LIVE_SIGNERS} prefunded signers; ` +
          `got ${this.liveAliases.size}. The derive-and-fund flow for more is deferred.`,
      );
    }
  }

  /**
   * Synchronous dry-mode alias→key resolution.
   *
   * Used by the dry backend's `setCaller`, which is synchronous. Not used in
   * live mode (live resolution is deferred to the async handle cache).
   *
   * @param alias - The caller alias.
   * @returns The deterministic dry key for the alias.
   */
  public resolveDryKey(alias: string): CoinPublicKey {
    return this.dryKeys[alias] ?? aliasToHex(alias);
  }

  /**
   * Asserts an alias is backed by a prefunded wallet on the live node.
   *
   * Throws the cap error rather than silently reusing a wallet or proceeding
   * with an unfunded one. A no-op in dry mode.
   *
   * @param alias - The caller alias to validate.
   */
  public assertLiveAliasAllowed(alias: string): void {
    if (this.mode !== 'live') return;
    if (this.liveAliases.size > 0 && !this.liveAliases.has(alias)) {
      throw new Error(
        `live signer "${alias}" is not in the prefunded pool ` +
          `[${[...this.liveAliases].join(', ')}] (max ${MAX_LIVE_SIGNERS}). ` +
          'Add it to the wallet pool or use the deferred derive-and-fund flow.',
      );
    }
  }

  /**
   * Resolves an alias to a raw {@link CoinPublicKey}, for use as a circuit arg.
   *
   * @param alias - The caller alias.
   * @returns The key for the alias.
   */
  public async keyFor(alias: string): Promise<CoinPublicKey> {
    if (this.mode === 'live') {
      this.assertLiveAliasAllowed(alias);
      if (!this.resolveLiveKey) {
        throw new Error(
          `cannot resolve live key for "${alias}": no resolveLiveKey supplied. ` +
            'The caller harness must provide one.',
        );
      }
      return this.resolveLiveKey(alias);
    }
    return this.resolveDryKey(alias);
  }

  /**
   * Resolves an alias to an `Either<ZswapCoinPublicKey, ContractAddress>`,
   * the shape circuits expect for an owner/user argument. Always the left
   * (coin-public-key) variant; contract-address owners are out of scope here.
   *
   * @param alias - The caller alias.
   * @returns The `Either` wrapping the alias's coin public key.
   */
  public async eitherFor(
    alias: string,
  ): Promise<Either<ZswapCoinPublicKey, ContractAddress>> {
    const key = await this.keyFor(alias);
    return {
      is_left: true,
      left: { bytes: encodeCoinPublicKey(key) },
      right: { bytes: zeroBytes() },
    };
  }
}
