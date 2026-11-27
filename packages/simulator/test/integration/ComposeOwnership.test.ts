import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import { defineSimulator } from '../../src/index.js';
import * as DefineArtifact from '../fixtures/artifacts/Define/contract/index.js';
import {
  CountPrivateState,
  CountWitnesses,
} from '../fixtures/sample-contracts/witnesses/DefineWitnesses.js';

const OWNER = new Uint8Array(32).fill(1);
const VALUES = [4n, 5n];
const ORIGIN = { x: 1n, y: 2n };

/** An authenticator's part with a key its witness may drop. */
type SecretState = { secret: bigint; pending?: bigint };

const SecretState = {
  generate: (): SecretState => ({ secret: 7n, pending: 1n }),
};

/** Returns its own part without `pending`. */
const SlicingWitnesses = <L>() => ({
  wit_secret({
    privateState,
  }: WitnessContext<L, SecretState>): [SecretState, bigint] {
    return [{ secret: privateState.secret }, privateState.secret];
  },
});

/** Returns the whole state without `pending`. */
const SpreadingWitnesses = <L>() => ({
  wit_secret({
    privateState,
  }: WitnessContext<L, SecretState>): [SecretState, bigint] {
    const { pending: _, ...rest } = privateState;
    return [rest, privateState.secret];
  },
});

/** Returns none of its keys. */
const EmptyingWitnesses = <L>() => ({
  wit_secret({
    privateState,
  }: WitnessContext<L, SecretState>): [Partial<SecretState>, bigint] {
    return [{}, privateState.secret];
  },
});

const stateParts = [CountPrivateState.generate, SecretState.generate];

class OwnedSlice extends defineSimulator(DefineArtifact, {
  witnesses: [
    CountWitnesses,
    Object.assign(<L>() => SlicingWitnesses<L>(), {
      privateState: SecretState.generate,
    }),
  ],
  privateState: stateParts,
}) {}

class OwnedSpread extends defineSimulator(DefineArtifact, {
  witnesses: [
    CountWitnesses,
    Object.assign(<L>() => SpreadingWitnesses<L>(), {
      privateState: SecretState.generate,
    }),
  ],
  privateState: stateParts,
}) {}

class OwnedEmpty extends defineSimulator(DefineArtifact, {
  witnesses: [
    CountWitnesses,
    Object.assign(<L>() => EmptyingWitnesses<L>(), {
      privateState: SecretState.generate,
    }),
  ],
  privateState: stateParts,
}) {}

class UnownedSlice extends defineSimulator(DefineArtifact, {
  witnesses: [CountWitnesses, SlicingWitnesses],
  privateState: stateParts,
}) {}

describe('a witness part that names its private-state factory', () => {
  it('deletes an owned key its returned part omits and keeps the other parts', async () => {
    const sim = await OwnedSlice.create(OWNER, VALUES, ORIGIN);

    expect(await sim.storeSecret()).toBe(7n);
    expect(await sim.getPrivateState()).toStrictEqual({
      count: 3n,
      secret: 7n,
    });
  });

  it('deletes an owned key the whole state it returns omits', async () => {
    const sim = await OwnedSpread.create(OWNER, VALUES, ORIGIN);

    await sim.storeSecret();

    expect(await sim.getPrivateState()).toStrictEqual({
      count: 3n,
      secret: 7n,
    });
  });

  it('deletes every owned key when its witness returns an empty part', async () => {
    const sim = await OwnedEmpty.create(OWNER, VALUES, ORIGIN);

    await sim.storeSecret();

    expect(await sim.getPrivateState()).toStrictEqual({ count: 3n });
  });
});

describe('a witness part that names no private-state factory', () => {
  it('keeps a key its returned part omits', async () => {
    const sim = await UnownedSlice.create(OWNER, VALUES, ORIGIN);

    await sim.storeSecret();

    expect(await sim.getPrivateState()).toStrictEqual({
      count: 3n,
      secret: 7n,
      pending: 1n,
    });
  });
});
