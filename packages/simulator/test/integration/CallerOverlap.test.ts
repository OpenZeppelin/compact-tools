import { describe, expect, it } from 'vitest';
import { FlatBase, type FlatWitnessSet } from './FlatSimulator.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

type Sim = Awaited<ReturnType<typeof FlatBase.create>>;

const lastCaller = async (sim: Sim): Promise<string> =>
  hex((await sim.getPublicState())._caller.bytes);

const failingWitness: FlatWitnessSet['wit_value'] = () => {
  throw new Error('witness failed');
};

describe('the as() caller on the dry backend, with overlapping calls', () => {
  it('runs a call started while an as() call is pending as the default caller', async () => {
    const sim = await FlatBase.create();
    await sim.recordCaller();
    const defaultCaller = await lastCaller(sim);

    const first = sim.as('ALICE').bump();
    const second = sim.recordCaller();
    await Promise.all([first, second]);

    expect(await lastCaller(sim)).toBe(defaultCaller);
  });

  it('keeps an as() caller set while an earlier call is pending, when that call fails', async () => {
    const sim = await FlatBase.create();
    sim.overrideWitness('wit_value', failingWitness);

    const first = sim.as('ALICE').setFromWitness();
    sim.as('BOB');
    await expect(first).rejects.toThrow('witness failed');
    await sim.recordCaller();

    expect(await lastCaller(sim)).toBe(sim.signers.resolveDryKey('BOB'));
  });

  it('keeps an as() caller set while an earlier call is pending, when that call succeeds', async () => {
    const sim = await FlatBase.create();

    const first = sim.as('ALICE').bump();
    sim.as('BOB');
    await first;
    await sim.recordCaller();

    expect(await lastCaller(sim)).toBe(sim.signers.resolveDryKey('BOB'));
  });
});
