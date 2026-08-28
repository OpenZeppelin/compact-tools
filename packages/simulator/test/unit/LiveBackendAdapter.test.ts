import type { StateValue } from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import type { SyncSimulator } from '../../src/backend/DryBackend.js';
import {
  LiveBackend,
  PRIVATE_STATE_MUTATION_UNSUPPORTED,
} from '../../src/live/LiveBackend.js';
import type {
  DeployedTxHandle,
  LiveContext,
} from '../../src/live/LiveContext.js';
import { Signers } from '../../src/signers/Signers.js';

type Ledger = { tag: string };

/** Records the alias passed to handleFor and serves scripted callTx results. */
class FakeWorld implements LiveContext<{ secret: number }> {
  readonly contractAddress = '0200cafef00d';
  lastAlias: string | null | undefined;
  private readonly callTx: DeployedTxHandle['callTx'];

  constructor(callTx: DeployedTxHandle['callTx']) {
    this.callTx = callTx;
  }

  async handleFor(alias: string | null): Promise<DeployedTxHandle> {
    this.lastAlias = alias;
    return { callTx: this.callTx };
  }

  async queryLedger(): Promise<StateValue> {
    return { tag: 'ledger-state' } as unknown as StateValue;
  }

  async queryPrivateState() {
    return { secret: 7 };
  }
}

/** Minimal pure-circuit evaluator: only `circuits.pure` is exercised by LiveBackend. */
const fakePureSim = (
  pure: Record<string, (...args: unknown[]) => unknown>,
): SyncSimulator<{ secret: number }, Ledger> =>
  ({ circuits: { pure, impure: {} } }) as unknown as SyncSimulator<
    { secret: number },
    Ledger
  >;

const makeBackend = (
  callTx: DeployedTxHandle['callTx'],
  pure: Record<string, (...args: unknown[]) => unknown> = {},
  liveAliases: string[] = ['OWNER', 'ALICE'],
) => {
  const world = new FakeWorld(callTx);
  const backend = new LiveBackend<{ secret: number }, Ledger>({
    ctx: world,
    pureSim: fakePureSim(pure),
    signers: new Signers({ mode: 'live', liveAliases }),
    ledgerExtractor: (state) => state as unknown as Ledger,
  });
  return { backend, world };
};

describe('LiveBackend adapter', () => {
  it('runs pure circuits locally without touching the node', async () => {
    const { backend, world } = makeBackend(
      {},
      { double: (n) => (n as bigint) * 2n },
    );
    expect(await backend.call('pure', 'double', [21n])).toEqual(42n);
    // No impure handle was ever requested.
    expect(world.lastAlias).toBeUndefined();
  });

  it('normalizes impure results from .private.result to bare R', async () => {
    const { backend } = makeBackend({
      owner: async () => ({ private: { result: 'OWNER_COMMITMENT' } }),
    });
    expect(await backend.call('impure', 'owner', [])).toEqual(
      'OWNER_COMMITMENT',
    );
  });

  it('propagates the contract assert message as a substring', async () => {
    const { backend } = makeBackend({
      guarded: async () => {
        throw new Error(
          'AccessControl: unauthorized account (+ proof/tx framing)',
        );
      },
    });
    await expect(backend.call('impure', 'guarded', [])).rejects.toThrow(
      'AccessControl: unauthorized account',
    );
  });

  it('applies single-shot caller for one call, then reverts', async () => {
    const { backend, world } = makeBackend({
      noop: async () => ({ private: { result: undefined } }),
    });
    backend.setCaller('OWNER', 'single');
    await backend.call('impure', 'noop', []);
    expect(world.lastAlias).toBe('OWNER');

    await backend.call('impure', 'noop', []);
    expect(world.lastAlias).toBeNull();
  });

  it('keeps a persistent caller across calls', async () => {
    const { backend, world } = makeBackend({
      noop: async () => ({ private: { result: undefined } }),
    });
    backend.setCaller('ALICE', 'persistent');
    await backend.call('impure', 'noop', []);
    await backend.call('impure', 'noop', []);
    expect(world.lastAlias).toBe('ALICE');
  });

  it('rejects callers outside the prefunded pool', () => {
    const { backend } = makeBackend({});
    expect(() => backend.setCaller('STRANGER', 'single')).toThrow(
      'not in the prefunded pool',
    );
  });

  it('hard-errors on witness override / setWitnesses', () => {
    const { backend } = makeBackend({});
    expect(() => backend.overrideWitness('w', () => {})).toThrow(
      'witness override unsupported on live backend',
    );
    expect(() => backend.setWitnesses({})).toThrow(
      'witness override unsupported on live backend',
    );
  });

  it('reads private state through the provider', async () => {
    const { backend } = makeBackend({});
    expect(await backend.getPrivateState()).toEqual({ secret: 7 });
  });

  it('throws when the LiveContext opts out of private-state mutation', async () => {
    // FakeWorld implements no setPrivateState.
    const { backend } = makeBackend({});
    await expect(backend.setPrivateState({ secret: 9 })).rejects.toThrow(
      PRIVATE_STATE_MUTATION_UNSUPPORTED,
    );
  });

  it('delegates private-state mutation to the LiveContext (read-after-write)', async () => {
    /** A world that stores private state, so a write is observable by a read. */
    class MutableWorld extends FakeWorld {
      private stored = { secret: 7 };
      override async queryPrivateState() {
        return this.stored;
      }
      async setPrivateState(state: { secret: number }) {
        this.stored = state;
      }
    }
    const world = new MutableWorld({});
    const backend = new LiveBackend<{ secret: number }, Ledger>({
      ctx: world,
      pureSim: fakePureSim({}),
      signers: new Signers({ mode: 'live', liveAliases: ['OWNER'] }),
      ledgerExtractor: (state) => state as unknown as Ledger,
    });

    await backend.setPrivateState({ secret: 42 });
    expect(await backend.getPrivateState()).toEqual({ secret: 42 });
  });
});
