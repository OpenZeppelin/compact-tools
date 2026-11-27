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
});
