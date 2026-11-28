import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import { composeWitnesses, defineSimulator } from '../../src/index.js';
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
  }: WitnessContext<L, SecretState>): [SecretState, bigint] {
    // Cast: the part check rejects an owning witness that drops `secret`.
    return [{} as SecretState, privateState.secret];
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

class NestedSlice extends defineSimulator(DefineArtifact, {
  witnesses: [
    CountWitnesses,
    composeWitnesses(
      Object.assign(<L>() => SlicingWitnesses<L>(), {
        privateState: SecretState.generate,
      }),
    ),
  ],
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

  it('deletes an owned key inside a composeWitnesses part', async () => {
    const sim = await NestedSlice.create(OWNER, VALUES, ORIGIN);

    await sim.storeSecret();

    expect(await sim.getPrivateState()).toStrictEqual({
      count: 3n,
      secret: 7n,
    });
  });

  it('deletes an owned symbol key its returned part omits', () => {
    const nonce = Symbol('nonce');
    type NonceState = { secret: bigint; [nonce]?: bigint };
    const witnesses = composeWitnesses(
      Object.assign(
        <L>() => ({
          wit_secret({
            privateState,
          }: WitnessContext<L, NonceState>): [NonceState, bigint] {
            return [{ secret: privateState.secret }, privateState.secret];
          },
        }),
        { privateState: (): NonceState => ({ secret: 7n, [nonce]: 1n }) },
      ),
    )();
    const context = {
      privateState: { count: 3n, secret: 7n, [nonce]: 1n },
    } as unknown as WitnessContext<unknown, NonceState>;

    const [next] = witnesses.wit_secret(context);

    expect(next).toStrictEqual({ count: 3n, secret: 7n });
  });

  it('rejects a witness a listed part and a composeWitnesses part both define', () => {
    expect(() =>
      defineSimulator(DefineArtifact, {
        witnesses: [
          CountWitnesses,
          SlicingWitnesses,
          composeWitnesses(SpreadingWitnesses),
        ],
        privateState: stateParts,
      }),
    ).toThrow(
      'witness "wit_secret" is defined by both part 1 ("SlicingWitnesses") and part 2 ("SpreadingWitnesses")',
    );
  });
});

describe('an optional key a witness part may own', () => {
  /** Declares `pending` set to `undefined`, so the part owns it. */
  const DeclaringSecretState = {
    generate: (): SecretState => ({ secret: 7n, pending: undefined }),
  };
  /** Does not return `pending`, so no part owns it. */
  const LeanSecretState = {
    generate: (): SecretState => ({ secret: 7n }),
  };
  const owning = (generate: () => SecretState) =>
    defineSimulator(DefineArtifact, {
      witnesses: [
        CountWitnesses,
        Object.assign(<L>() => SlicingWitnesses<L>(), {
          privateState: generate,
        }),
      ],
      privateState: [CountPrivateState.generate, generate],
    });

  it('is deleted when the factory returns it set to undefined', async () => {
    const sim = await owning(DeclaringSecretState.generate).create(
      OWNER,
      VALUES,
      ORIGIN,
    );
    await sim.setPrivateState({ count: 3n, secret: 7n, pending: 1n });

    await sim.storeSecret();

    expect(await sim.getPrivateState()).toStrictEqual({
      count: 3n,
      secret: 7n,
    });
  });

  it('stays when the factory does not return it', async () => {
    const sim = await owning(LeanSecretState.generate).create(
      OWNER,
      VALUES,
      ORIGIN,
    );
    await sim.setPrivateState({ count: 3n, secret: 7n, pending: 1n });

    await sim.storeSecret();

    expect(await sim.getPrivateState()).toStrictEqual({
      count: 3n,
      secret: 7n,
      pending: 1n,
    });
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
