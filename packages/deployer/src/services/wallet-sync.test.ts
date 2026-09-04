import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';
import * as Rx from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { UnfundedWalletError, WalletError } from '../errors.ts';
import {
  describeProgress,
  logWalletAddresses,
  syncAndVerifyFunds,
} from './wallet-sync.ts';

// Identity-throttle so the progress + checkpoint subscriptions fire on the
// first state emission instead of waiting 30 s / 5 min in real wall-clock
// for the trailing tick.
vi.mock('rxjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rxjs')>();
  return {
    ...actual,
    throttleTime:
      () =>
      <T>(src: import('rxjs').Observable<T>): import('rxjs').Observable<T> =>
        src,
  };
});

vi.mock('@midnight-ntwrk/midnight-js-network-id', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@midnight-ntwrk/midnight-js-network-id')
    >();
  return {
    ...actual,
    // logWalletAddresses passes whatever this returns to the codec
    // mock which ignores the arg. Opaque value is fine.
    getNetworkId: vi.fn(() => 0),
  };
});

// Stub the bech32 codec triplet so `logWalletAddresses` reaches its
// happy-path info logs instead of catching at the encode call.
vi.mock('@midnight-ntwrk/wallet-sdk-address-format', () => {
  const codec = {
    encode: vi.fn(() => ({ toString: () => 'addr1stub' })),
  };
  return {
    ShieldedAddress: { codec },
    UnshieldedAddress: { codec },
    DustAddress: { codec },
  };
});

const silentLogger = pino({ level: 'silent' });

/** Pino at silent level with `info`/`warn` swapped for spies. */
function spyLogger(): { logger: typeof silentLogger; info: Mock; warn: Mock } {
  const info = vi.fn();
  const warn = vi.fn();
  const logger = pino({ level: 'silent' });
  Object.assign(logger, { info, warn });
  return { logger, info, warn };
}

type Mock = ReturnType<typeof vi.fn>;

/** Balance map that reports the same amount for every token key. */
function anyToken(amount: bigint): Record<string, bigint> {
  return new Proxy({} as Record<string, bigint>, { get: () => amount });
}

interface ProgressStub {
  strictlyComplete?: boolean;
  withinGap?: boolean;
}

/** Index-shaped progress, as the shielded and dust sub-wallets report it. */
function progress(stub: ProgressStub = {}): unknown {
  return {
    isStrictlyComplete: () => stub.strictlyComplete ?? true,
    isCompleteWithin: () => stub.withinGap ?? true,
    appliedIndex: 0n,
    highestIndex: 0n,
    isConnected: true,
  };
}

/** Id-shaped progress, as the unshielded sub-wallet reports it. */
function unshieldedProgress(stub: ProgressStub = {}): unknown {
  return {
    isStrictlyComplete: () => stub.strictlyComplete ?? true,
    isCompleteWithin: () => stub.withinGap ?? true,
    appliedId: 0n,
    highestTransactionId: 0n,
    isConnected: true,
  };
}

/** One `FacadeState` with caller-supplied balances and per-sub-wallet progress. */
function facadeState(
  opts: {
    shielded?: Record<string, bigint>;
    unshielded?: Record<string, bigint>;
    shieldedProgress?: ProgressStub;
    unshieldedProgress?: ProgressStub;
    dustProgress?: ProgressStub;
  } = {},
): unknown {
  return {
    shielded: {
      balances: opts.shielded ?? anyToken(1n),
      state: { progress: progress(opts.shieldedProgress) },
    },
    unshielded: {
      balances: opts.unshielded ?? anyToken(1n),
      progress: unshieldedProgress(opts.unshieldedProgress),
    },
    dust: {
      state: { progress: progress(opts.dustProgress) },
      balance: () => 1n,
    },
  };
}

function fakeWallet(
  state$: Rx.Observable<unknown>,
  coinKey = '0xCOIN',
): MidnightWalletProvider {
  const addr = Rx.of({ address: 'addr-bytes' });
  return {
    getCoinPublicKey: () => coinKey,
    wallet: {
      state: () => state$,
      shielded: { state: addr },
      unshielded: { state: addr },
      dust: { state: addr },
    },
  } as unknown as MidnightWalletProvider;
}

describe('describeProgress', () => {
  it('should render a percentage from the shielded/dust index fields', () => {
    expect(
      describeProgress({
        isStrictlyComplete: () => false,
        appliedIndex: 10n,
        highestIndex: 100n,
        isConnected: true,
      }),
    ).toBe('10/100 (10%) connected=true complete=false');
  });

  it('should render a percentage from the unshielded id fields', () => {
    expect(
      describeProgress({
        isStrictlyComplete: () => true,
        appliedId: 5n,
        highestTransactionId: 50n,
        isConnected: true,
      }),
    ).toBe('5/50 (10%) connected=true complete=true');
  });

  it('should report an unknown tip before the indexer reports a max event id', () => {
    // highest=0 means "indexer has not told us the tip yet"; surfacing the
    // connection state lets a user tell "connecting" from "no events yet".
    expect(
      describeProgress({
        isStrictlyComplete: () => false,
        appliedIndex: 0n,
        highestIndex: 0n,
        isConnected: false,
      }),
    ).toBe('applied=0 highest=? connected=false complete=false');
  });
});

describe('logWalletAddresses', () => {
  it('should log the three bech32m addresses on the happy path', async () => {
    const { logger, info } = spyLogger();
    await logWalletAddresses(fakeWallet(Rx.NEVER), logger);
    expect(info).toHaveBeenCalledWith(
      'Wallet addresses (verify these match your seed):',
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/shielded:.*addr1stub/),
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/unshielded:.*addr1stub/),
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/dust:.*addr1stub/),
    );
  });

  it('should warn and continue when a sub-wallet state cannot be read', async () => {
    const { logger, warn } = spyLogger();
    const wallet = fakeWallet(Rx.NEVER);
    wallet.wallet.shielded = {
      state: Rx.throwError(() => new Error('no state')),
    } as never;
    await expect(logWalletAddresses(wallet, logger)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'no state' }),
      'Could not derive wallet addresses for display; continuing',
    );
  });
});

describe('syncAndVerifyFunds', () => {
  const base = { timeoutMs: 1000, logger: silentLogger };

  it('should reject with a timeout error when the wallet never reaches chain tip', async () => {
    const pending = syncAndVerifyFunds({
      ...base,
      wallet: fakeWallet(Rx.NEVER, '0xSTUCK'),
      timeoutMs: 50,
    });
    await expect(pending).rejects.toBeInstanceOf(WalletError);
    await expect(pending).rejects.toThrow(/Wallet sync timeout after 50ms/);
  });

  it('should complete when sub-wallets are within the gap but not strictly complete', async () => {
    // Live-chain shape (issue #115): the global dust stream keeps
    // advancing, so dust is never strictly complete (gap 0) but settles
    // within the tolerated gap. The old strict `isSynced` gate would hang
    // here forever; the tolerant `isCompleteWithin` gate must proceed.
    const state = facadeState({
      dustProgress: { strictlyComplete: false, withinGap: true },
    });
    await expect(
      syncAndVerifyFunds({ ...base, wallet: fakeWallet(Rx.of(state)) }),
    ).resolves.toBeUndefined();
  });

  it('should NOT complete while any sub-wallet is outside the gap', async () => {
    // Dust still outside the tolerated gap: the gate must keep waiting and
    // ultimately time out rather than deploy against a half-synced wallet.
    const state = facadeState({
      dustProgress: { strictlyComplete: false, withinGap: false },
    });
    await expect(
      syncAndVerifyFunds({
        ...base,
        wallet: fakeWallet(Rx.concat(Rx.of(state), Rx.NEVER)),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/Wallet sync timeout after 50ms/);
  });

  it('should throw UnfundedWalletError when shielded and unshielded balances are both empty', async () => {
    const state = facadeState({ shielded: {}, unshielded: {} });
    await expect(
      syncAndVerifyFunds({
        ...base,
        wallet: fakeWallet(Rx.of(state), '0xEMPTY'),
      }),
    ).rejects.toBeInstanceOf(UnfundedWalletError);
  });

  it('should NOT throw when only the unshielded side has a positive balance', async () => {
    const state = facadeState({ shielded: {}, unshielded: anyToken(5n) });
    await expect(
      syncAndVerifyFunds({ ...base, wallet: fakeWallet(Rx.of(state)) }),
    ).resolves.toBeUndefined();
  });

  it('should NOT throw when only the shielded side has a positive balance', async () => {
    const state = facadeState({ shielded: anyToken(3n), unshielded: {} });
    await expect(
      syncAndVerifyFunds({ ...base, wallet: fakeWallet(Rx.of(state)) }),
    ).resolves.toBeUndefined();
  });

  it('should log per-sub-wallet completion and mid-sync progress lines', async () => {
    const { logger, info } = spyLogger();
    const mid = facadeState({
      shieldedProgress: { strictlyComplete: false, withinGap: false },
      unshieldedProgress: { strictlyComplete: false, withinGap: false },
      dustProgress: { strictlyComplete: false, withinGap: false },
    });
    await syncAndVerifyFunds({
      ...base,
      logger,
      wallet: fakeWallet(Rx.of(mid, facadeState())),
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Still syncing'));
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Unshielded sync complete'),
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Dust sync complete'),
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Shielded sync complete'),
    );
  });

  it('should render elapsed time as minutes and seconds past the first minute', async () => {
    const { logger, info } = spyLogger();
    const state$ = new Rx.Subject<unknown>();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const pending = syncAndVerifyFunds({
        ...base,
        logger,
        wallet: fakeWallet(state$),
      });
      now += 90_000;
      state$.next(facadeState());
      await pending;
    } finally {
      clock.mockRestore();
    }
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Still syncing (1m 30s elapsed)'),
    );
    expect(info).toHaveBeenCalledWith('Sync complete after 1m 30s');
  });

  it('should invoke onCheckpoint on a state emission', async () => {
    const onCheckpoint = vi.fn(async () => undefined);
    await syncAndVerifyFunds({
      ...base,
      wallet: fakeWallet(Rx.of(facadeState())),
      onCheckpoint,
    });
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('should warn and keep syncing when onCheckpoint rejects', async () => {
    // An unconsumed rejection here terminates the process by default,
    // which would turn a best-effort snapshot into a failed deploy.
    const onCheckpoint = vi.fn(() => Promise.reject(new Error('disk full')));
    const { logger, warn } = spyLogger();
    await expect(
      syncAndVerifyFunds({
        ...base,
        logger,
        wallet: fakeWallet(Rx.of(facadeState())),
        onCheckpoint,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { err: 'disk full' },
      'Wallet cache checkpoint failed; continuing sync',
    );
  });

  it('should not start a second checkpoint while the first is still in flight', async () => {
    // Re-entrancy guard: two emissions arrive before the first save
    // settles. A second concurrent snapshot would race the first over
    // the same cache file.
    let release: () => void = () => undefined;
    const inFlight = new Promise<void>((r) => {
      release = r;
    });
    const onCheckpoint = vi.fn(() => inFlight);
    await syncAndVerifyFunds({
      ...base,
      wallet: fakeWallet(Rx.of(facadeState(), facadeState())),
      onCheckpoint,
    });
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    release();
    await inFlight;
  });

  it('should tear down every subscription once the tip gate resolves', async () => {
    const state$ = new Rx.Subject<unknown>();
    const pending = syncAndVerifyFunds({
      ...base,
      wallet: fakeWallet(state$),
      onCheckpoint: vi.fn(async () => undefined),
    });
    expect(state$.observed).toBe(true);
    state$.next(facadeState());
    await pending;
    // A surviving subscription leaks the wallet's rxjs pipeline for the
    // rest of the process.
    expect(state$.observed).toBe(false);
  });

  it('should tear down every subscription when the tip gate times out', async () => {
    const state$ = new Rx.Subject<unknown>();
    const pending = syncAndVerifyFunds({
      ...base,
      wallet: fakeWallet(state$),
      timeoutMs: 20,
      onCheckpoint: vi.fn(async () => undefined),
    });
    await expect(pending).rejects.toThrow(/Wallet sync timeout/);
    expect(state$.observed).toBe(false);
  });

  it('should not subscribe a checkpoint tap when onCheckpoint is omitted', async () => {
    const state$ = new Rx.Subject<unknown>();
    const pending = syncAndVerifyFunds({ ...base, wallet: fakeWallet(state$) });
    // Progress tap, balance tap and the tip gate: three subscribers, one
    // fewer than the owned-wallet path that also checkpoints.
    expect(state$.observers).toHaveLength(3);
    state$.next(facadeState());
    await pending;
  });
});
