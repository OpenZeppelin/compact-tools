import type {
  CoinPublicKey,
  ContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import type { BackendKind } from '../backend/Backend.js';
import type { LiveContext } from '../live/LiveContext.js';

/**
 * Base configuration options for simulator constructors.
 *
 * @template P - Private state type
 * @template W - Witnesses type
 */
export type BaseSimulatorOptions<P, W> = {
  /** Initial private state (uses default if not provided) */
  privateState?: P;
  /** Witness functions (uses default if not provided) */
  witnesses?: W;
  /** Coin public key for transactions */
  coinPK?: CoinPublicKey;
  /** Contract deployment address */
  contractAddress?: ContractAddress;
};

/**
 * Options for `createSimulator`'s async `create`. Extends the base construction
 * options with backend selection and the live-world injection seam.
 *
 * @template P - Private state type.
 * @template W - Witnesses type.
 */
export interface SimulatorOptions<P, W> extends BaseSimulatorOptions<P, W> {
  /**
   * Force a backend instead of reading `MIDNIGHT_BACKEND`. Mainly for tests that
   * pin a backend regardless of the environment.
   */
  backend?: BackendKind;
  /**
   * The live world, supplied by the caller's harness (INV-22). In live mode this
   * is used if provided; otherwise the globally registered live backend (see
   * `registerLiveBackend`) is used. Ignored in dry mode.
   */
  live?: LiveContext<P>;
  /** Dry only: override the deterministic alias→key derivation (OQ4). */
  signerKeys?: Readonly<Record<string, CoinPublicKey>>;
  /** Live only: the prefunded alias pool (max `MAX_LIVE_SIGNERS`, INV-21). */
  liveAliases?: readonly string[];
  /** Live only: resolve an alias to its wallet's coin public key (INV-22). */
  resolveLiveKey?: (alias: string) => CoinPublicKey | Promise<CoinPublicKey>;
}
