import type { StateValue } from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import type { SyncSimulator } from '../../src/backend/DryBackend.js';
import { LiveBackend } from '../../src/live/LiveBackend.js';
import type {
  DeployedTxHandle,
  FinalizedCallResult,
  LiveContext,
} from '../../src/live/LiveContext.js';
import { Signers } from '../../src/signers/Signers.js';

type PendingTx = {
  resolve: (result: FinalizedCallResult) => void;
  reject: (error: Error) => void;
};

/** Records the alias of every call; each `wait` tx stays pending until the test settles it. */
class PendingWorld implements LiveContext<object> {
  readonly contractAddress = '0200cafef00d';
  readonly aliases: (string | null)[] = [];
  readonly pending: PendingTx[] = [];

  async handleFor(alias: string | null): Promise<DeployedTxHandle> {
    this.aliases.push(alias);
    return {
      callTx: {
        wait: () =>
          new Promise<FinalizedCallResult>((resolve, reject) => {
            this.pending.push({ resolve, reject });
          }),
        noop: async () => ({ private: { result: undefined } }),
      },
    };
  }

  async queryLedger(): Promise<StateValue> {
    return {} as StateValue;
  }

  async queryPrivateState(): Promise<object> {
    return {};
  }
}

const makeBackend = () => {
  const world = new PendingWorld();
  const backend = new LiveBackend<object, object>({
    ctx: world,
    pureSim: { circuits: { pure: {}, impure: {} } } as unknown as SyncSimulator<
      object,
      object
    >,
    signers: new Signers({
      mode: 'live',
      liveAliases: ['OWNER', 'ALICE', 'BOB'],
    }),
    ledgerExtractor: () => ({}),
  });
  return { backend, world };
};

/** Lets every queued promise continuation run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const done: FinalizedCallResult = { private: { result: undefined } };

describe('the as() caller on the live backend, with overlapping calls', () => {
  it('runs a call started while an as() call is pending as the default caller', async () => {
    const { backend, world } = makeBackend();

    backend.setCaller('OWNER', 'single');
    const calls = [
      backend.call('impure', 'wait', []),
      backend.call('impure', 'wait', []),
    ];
    await flush();
    for (const tx of world.pending) tx.resolve(done);
    await Promise.all(calls);

    expect(world.aliases).toEqual(['OWNER', null]);
  });

  it('runs a call started while an as() call is pending as the persistent caller', async () => {
    const { backend, world } = makeBackend();

    backend.setCaller('ALICE', 'persistent');
    backend.setCaller('OWNER', 'single');
    const calls = [
      backend.call('impure', 'wait', []),
      backend.call('impure', 'wait', []),
    ];
    await flush();
    for (const tx of world.pending) tx.resolve(done);
    await Promise.all(calls);

    expect(world.aliases).toEqual(['OWNER', 'ALICE']);
  });

  it('keeps an as() caller set while an earlier call is pending, when that call fails', async () => {
    const { backend, world } = makeBackend();

    backend.setCaller('ALICE', 'single');
    const first = backend.call('impure', 'wait', []);
    backend.setCaller('BOB', 'single');
    await flush();
    world.pending[0].reject(new Error('rejected'));
    await expect(first).rejects.toThrow('rejected');
    await backend.call('impure', 'noop', []);

    expect(world.aliases).toEqual(['ALICE', 'BOB']);
  });

  it('keeps an as() caller set while an earlier call is pending, when that call succeeds', async () => {
    const { backend, world } = makeBackend();

    backend.setCaller('ALICE', 'single');
    const first = backend.call('impure', 'wait', []);
    backend.setCaller('BOB', 'single');
    await flush();
    world.pending[0].resolve(done);
    await first;
    await backend.call('impure', 'noop', []);

    expect(world.aliases).toEqual(['ALICE', 'BOB']);
  });
});
