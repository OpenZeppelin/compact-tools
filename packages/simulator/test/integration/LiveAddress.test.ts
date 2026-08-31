import {
  dummyContractAddress,
  type StateValue,
} from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import type {
  DeployedTxHandle,
  LiveContext,
} from '../../src/live/LiveContext.js';
import { WitnessPrivateState } from '../fixtures/sample-contracts/witnesses/WitnessWitnesses.js';
import { WitnessSimulator } from './WitnessSimulator.js';

// Runtime-parseable: the deployed address now seeds the local evaluator's
// circuit context, so a made-up string no longer works here.
const DEPLOYED = dummyContractAddress();

/** An inert live world; only the address-binding paths are exercised. */
const makeWorld = (): LiveContext<WitnessPrivateState> => ({
  contractAddress: DEPLOYED,
  async handleFor(): Promise<DeployedTxHandle> {
    return { callTx: {} };
  },
  async queryLedger(): Promise<StateValue> {
    return {} as unknown as StateValue;
  },
  async queryPrivateState(): Promise<WitnessPrivateState> {
    return WitnessPrivateState.generate();
  },
});

describe('live contract-address binding', () => {
  it('exposes the deployed address', async () => {
    const sim = await WitnessSimulator.create({
      backend: 'live',
      live: makeWorld(),
    });

    expect(sim.contractAddress).toBe(DEPLOYED);
  });

  it('accepts an explicit contractAddress equal to the deployed one', async () => {
    const sim = await WitnessSimulator.create({
      backend: 'live',
      live: makeWorld(),
      contractAddress: DEPLOYED,
    });

    expect(sim.contractAddress).toBe(DEPLOYED);
  });

  it('rejects an explicit contractAddress that differs from the deployed one', async () => {
    await expect(
      WitnessSimulator.create({
        backend: 'live',
        live: makeWorld(),
        contractAddress: '0200aaaa',
      }),
    ).rejects.toThrow(/does not match the deployed contract/);
  });
});
