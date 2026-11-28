import type {
  CircuitContext,
  EncodedZswapLocalState,
} from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import { FlatBase, type FlatWitnessSet } from './FlatSimulator.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

type Sim = Awaited<ReturnType<typeof FlatBase.create>>;

const recordedCaller = async (sim: Sim): Promise<string> => {
  await sim.recordCaller();
  return hex((await sim.getPublicState())._caller.bytes);
};

const failingWitness: FlatWitnessSet['wit_value'] = () => {
  throw new Error('witness failed');
};

describe('the as() caller on the dry backend', () => {
  it('applies to one successful call, then the default caller returns', async () => {
    const sim = await FlatBase.create();
    const defaultCaller = await recordedCaller(sim);

    await sim.as('ALICE').bump();

    expect(await recordedCaller(sim)).toBe(defaultCaller);
  });

  it('applies to one failed call, then the default caller returns', async () => {
    const sim = await FlatBase.create();
    const defaultCaller = await recordedCaller(sim);
    sim.overrideWitness('wit_value', failingWitness);

    await expect(sim.as('ALICE').setFromWitness()).rejects.toThrow(
      'witness failed',
    );

    expect(await recordedCaller(sim)).toBe(defaultCaller);
  });

  it('records the as() caller for the call it applies to', async () => {
    const sim = await FlatBase.create();

    await sim.as('ALICE').recordCaller();

    expect(hex((await sim.getPublicState())._caller.bytes)).toBe(
      sim.signers.resolveDryKey('ALICE'),
    );
  });

  it('returns to the default caller after resetCaller()', async () => {
    const sim = await FlatBase.create();
    const defaultCaller = await recordedCaller(sim);

    sim.setPersistentCaller('BOB');
    await sim.bump();
    sim.resetCaller();

    expect(await recordedCaller(sim)).toBe(defaultCaller);
  });

  it('runs an as(null) call as the default caller while a persistent caller is set', async () => {
    const sim = await FlatBase.create();
    const defaultCaller = await recordedCaller(sim);
    sim.setPersistentCaller('OWNER');

    await sim.as(null).recordCaller();
    const single = hex((await sim.getPublicState())._caller.bytes);

    expect(single).toBe(defaultCaller);
    expect(await recordedCaller(sim)).toBe(sim.signers.resolveDryKey('OWNER'));
  });
});

describe('the Zswap local state on the dry backend', () => {
  type DryInternals = { sim: { circuitContext: CircuitContext<unknown> } };

  const nonce = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

  const recipients = (state: EncodedZswapLocalState): string[] =>
    state.outputs.map((output) => hex(output.recipient.left.bytes));

  it('keeps the coins of an as() call under its caller, and the default caller its own', async () => {
    const sim = await FlatBase.create();
    const defaultKey = await recordedCaller(sim);
    const bob = sim.signers.resolveDryKey('BOB');

    await sim.mintToCaller(nonce(1));
    await sim.as('BOB').mintToCaller(nonce(2));
    await sim.mintToCaller(nonce(3));
    await sim.as('BOB').mintToCaller(nonce(4));
    const context = (sim._backend as unknown as DryInternals).sim
      .circuitContext;
    const stored = context.callContext.currentZswapLocalState;
    const lastCall = context.callProofDataTrace.at(-1)?.zswapLocalState;

    expect(stored && hex(stored.coinPublicKey.bytes)).toBe(defaultKey);
    expect(stored && recipients(stored)).toEqual([defaultKey, defaultKey]);
    expect(stored?.currentIndex).toBe(2n);
    expect(context.zswapLocalStates[sim.contractAddress]).toBe(stored);
    expect(lastCall && hex(lastCall.coinPublicKey.bytes)).toBe(bob);
    expect(lastCall && recipients(lastCall)).toEqual([bob, bob]);
    expect(lastCall?.currentIndex).toBe(2n);
  });
});
