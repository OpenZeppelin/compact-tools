import { describe, expect, it } from 'vitest';
import { defineSimulator } from '../../src/index.js';
import * as FlatArtifact from '../fixtures/artifacts/Flat/contract/index.js';
import {
  FlatPrivateState,
  FlatWitnesses,
} from '../fixtures/sample-contracts/witnesses/FlatWitnesses.js';
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

describe('overlapping impure calls on the dry backend', () => {
  it('commits both calls', async () => {
    const sim = await FlatBase.create();

    await Promise.all([sim.as('ALICE').bump(), sim.bump()]);

    expect((await sim.getPublicState())._count).toBe(2n);
  });

  it('runs each call as the caller it took when it started', async () => {
    const sim = await FlatBase.create();

    await Promise.all([sim.as('ALICE').recordCaller(), sim.bump()]);
    const state = await sim.getPublicState();

    expect(hex(state._caller.bytes)).toBe(sim.signers.resolveDryKey('ALICE'));
    expect(state._count).toBe(1n);
  });

  it('runs the calls queued behind a failed call', async () => {
    const sim = await FlatBase.create();
    sim.overrideWitness('wit_value', failingWitness);

    const failed = sim.setFromWitness();
    const bumps = Promise.all([sim.bump(), sim.bump()]);
    await expect(failed).rejects.toThrow('witness failed');
    await bumps;

    expect((await sim.getPublicState())._count).toBe(2n);
  });

  it('commits the calls of an extend helper, awaited in sequence or started together', async () => {
    const Helpers = defineSimulator(FlatArtifact, {
      witnesses: FlatWitnesses,
      privateState: FlatPrivateState.generate,
      extend: (sim) => ({
        bumpInSequence: async (): Promise<void> => {
          await sim.bump();
          await sim.bump();
        },
        bumpTogether: async (): Promise<void> => {
          await Promise.all([sim.bump(), sim.bump()]);
        },
      }),
    });
    const sim = await Helpers.create();

    await sim.bumpInSequence();
    await sim.bumpTogether();

    expect((await sim.getPublicState())._count).toBe(4n);
  });
});
