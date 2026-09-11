/**
 * Shared harness for the deployer suites. Mock-free on purpose: `vi.mock` is
 * hoisted per module, so each suite declares its own.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import pino, { type Logger } from 'pino';
import * as Rx from 'rxjs';
import { type Mock, vi } from 'vitest';
import { ConfigError } from './errors.ts';
import type { WalletHandler } from './wallet/handler.ts';

export const silentLogger = pino({ level: 'silent' });

export interface FakeProvider {
  getCoinPublicKey: () => string;
  start: Mock;
  stop: Mock;
  wallet: {
    state: () => Rx.Observable<unknown>;
    shielded: { tag: string; state?: Rx.Observable<unknown> };
    unshielded?: { state: Rx.Observable<unknown> };
    dust?: { state: Rx.Observable<unknown> };
  };
}

export function fakeSubWalletStates() {
  const addr = { address: 'addr-bytes' };
  return {
    shielded: Rx.of(addr),
    unshielded: Rx.of(addr),
    dust: Rx.of(addr),
  };
}

/**
 * Emits one already-synced `FacadeState` with a `Proxy` balance map that
 * returns `1n` for any token key, so `syncAndVerifyFunds` passes through
 * without a real Rx pipeline (we don't mock ledger-v8 in this file).
 */
export function fakeProvider(coinKey = '0xCOIN'): FakeProvider {
  const anyKeyHasBalance = new Proxy({} as Record<string, bigint>, {
    get: () => 1n,
  });
  const syncedState = {
    isSynced: true,
    shielded: {
      balances: anyKeyHasBalance,
      state: {
        progress: {
          isStrictlyComplete: () => true,
          isCompleteWithin: () => true,
          appliedIndex: 0n,
          highestIndex: 0n,
          isConnected: true,
        },
      },
    },
    unshielded: {
      balances: anyKeyHasBalance,
      // Id-shaped, unlike the index-shaped shielded and dust progress.
      progress: {
        isStrictlyComplete: () => true,
        isCompleteWithin: () => true,
        appliedId: 0n,
        highestTransactionId: 0n,
        isConnected: true,
      },
    },
    dust: {
      state: {
        progress: {
          isStrictlyComplete: () => true,
          isCompleteWithin: () => true,
          appliedIndex: 0n,
          highestIndex: 0n,
          isConnected: true,
        },
      },
      balance: () => 1n,
    },
  };
  const sub = fakeSubWalletStates();
  return {
    getCoinPublicKey: () => coinKey,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    wallet: {
      state: () => Rx.of(syncedState as unknown),
      shielded: { tag: 'shielded', state: sub.shielded },
      unshielded: { state: sub.unshielded },
      dust: { state: sub.dust },
    },
  };
}

export function asInjected(p: FakeProvider): MidnightWalletProvider {
  return p as unknown as MidnightWalletProvider;
}

export interface FakeOwned {
  owned: WalletHandler;
  provider: FakeProvider;
  dispose: Mock;
  saveCache: Mock;
}

export function fakeOwnedWallet(coinKey = '0xCOIN'): FakeOwned {
  return fakeOwnedFromProvider(fakeProvider(coinKey));
}

export function fakeOwnedFromProvider(provider: FakeProvider): FakeOwned {
  const dispose = vi.fn(async () => {
    await provider.stop();
  });
  const saveCache = vi.fn(async () => undefined);
  const owned = {
    provider,
    saveCache,
    [Symbol.asyncDispose]: dispose,
  } as unknown as WalletHandler;
  return { owned, provider, dispose, saveCache };
}

/**
 * Provider whose `wallet.state()` is fully caller-controlled. Used to drive
 * timeout / unfunded / mixed-funds branches of `syncAndVerifyFunds`.
 */
export function fakeProviderWithState(
  state$: Rx.Observable<unknown>,
  coinKey = '0xCOIN',
): FakeProvider {
  const sub = fakeSubWalletStates();
  return {
    getCoinPublicKey: () => coinKey,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    wallet: {
      state: () => state$,
      shielded: { tag: 'shielded', state: sub.shielded },
      unshielded: { state: sub.unshielded },
      dust: { state: sub.dust },
    },
  };
}

/** Mirrors `Artifact.verifierKeys`, which refuses a bundle missing a key. */
export function fakeVerifierKeys(
  circuits: readonly string[],
  bytes: Uint8Array,
  omit: readonly string[] = [],
): () => Promise<ReadonlyMap<string, Uint8Array>> {
  return async () => {
    const missing = circuits.filter((id) => omit.includes(id));
    if (missing.length > 0) {
      throw new ConfigError(
        `Artifact at /fake/artifact has no verifier key for: ${missing.join(', ')}.`,
      );
    }
    return new Map(circuits.map((id) => [id, bytes]));
  };
}

export function fakeUnsubmittedDeploy(address = '0xCONTRACT') {
  return {
    public: { contractAddress: address },
    private: {
      unprovenTx: { tag: 'unproven' },
      signingKey: 'contract-maintenance-key',
      initialPrivateState: { seeded: true },
    },
  };
}

export function fakeFinalized(overrides: Record<string, unknown> = {}) {
  return {
    status: 'SucceedEntirely',
    txId: '0xTX',
    txHash: '0xHASH',
    blockHeight: 1234,
    ...overrides,
  };
}

export interface FakeProviders {
  publicDataProvider: {
    watchForTxData: Mock;
    watchForDeployTxData: Mock;
    queryContractState: Mock;
  };
  privateStateProvider: {
    setContractAddress: Mock;
    set: Mock;
    setSigningKey: Mock;
    getSigningKey: Mock;
  };
  zkConfigProvider: { getVerifierKeys: Mock };
}

export function fakeProviders(): FakeProviders {
  return {
    publicDataProvider: {
      watchForTxData: vi.fn(async () => fakeFinalized()),
      watchForDeployTxData: vi.fn(async () => fakeFinalized()),
      queryContractState: vi.fn(async () => null),
    },
    privateStateProvider: {
      setContractAddress: vi.fn(),
      set: vi.fn(async () => undefined),
      setSigningKey: vi.fn(async () => undefined),
      getSigningKey: vi.fn(async () => 'aa'.repeat(32)),
    },
    zkConfigProvider: {
      getVerifierKeys: vi.fn(async (ids: string[]) =>
        ids.map((id) => [id, new Uint8Array([1, 2, 3])] as const),
      ),
    },
  };
}

/** Pino stubbed down to the four levels the deploy path uses. */
export function recordingLogger(): {
  logger: Logger;
  info: Mock;
  /** Every argument of every call, joined, for grep-style assertions. */
  lines: () => string;
} {
  const info = vi.fn();
  const debug = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return {
    logger: { info, debug, warn, error } as unknown as Logger,
    info,
    lines: () =>
      [info, debug, warn, error]
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join('\n'),
  };
}

/** The head ledger file for the fixture's only network. */
export function headPath(rootDir: string): string {
  return join(rootDir, 'deployments', 'local.json');
}

export function readHead(
  rootDir: string,
): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(headPath(rootDir), 'utf8'));
}

export interface Fixture {
  rootDir: string;
  configPath: string;
  cleanup: () => void;
}

export function writeFixture(
  opts: {
    explorer?: string;
    syncTimeout?: number;
    syncBatchSize?: number;
    initPrivateState?: string;
    circuitsPerTx?: number;
  } = {},
): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'deployer-test-'));
  const explorerLine = opts.explorer ? `explorer = "${opts.explorer}"\n` : '';
  const syncTimeoutLine =
    opts.syncTimeout !== undefined
      ? `sync_timeout = ${opts.syncTimeout}\n`
      : '';
  const syncBatchLine =
    opts.syncBatchSize !== undefined
      ? `sync_batch_size = ${opts.syncBatchSize}\n`
      : '';
  const initStateLine =
    opts.initPrivateState !== undefined
      ? `init_private_state = { file = "${opts.initPrivateState}" }\n`
      : '';
  const budgetLine =
    opts.circuitsPerTx !== undefined
      ? `circuits_per_tx = ${opts.circuitsPerTx}\n`
      : '';
  const toml = `
[profile]
artifacts_dir = "artifacts"
deployments_dir = "deployments"

[networks.local]
network_id = "undeployed"
indexer = "http://localhost:8088/api/v1/graphql"
indexer_ws = "ws://localhost:8088/api/v1/graphql/ws"
node = "http://localhost:9944"
node_ws = "ws://localhost:9944"
proof_server = "http://localhost:6300"
wallet = { source = "local", index = 0 }
${explorerLine}${syncTimeoutLine}${syncBatchLine}
[contracts.Counter]
artifact = "Counter"
signing_key_file = "signing-key.hex"
${initStateLine}${budgetLine}`;
  writeFileSync(join(rootDir, 'compact.toml'), toml);
  writeFileSync(join(rootDir, 'signing-key.hex'), `${'aa'.repeat(32)}\n`);
  return {
    rootDir,
    configPath: join(rootDir, 'compact.toml'),
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}
