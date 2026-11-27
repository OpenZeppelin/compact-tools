import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

/** The module's part of the private state. */
export type CountPrivateState = { count: bigint };

export const CountPrivateState = {
  generate: (): CountPrivateState => ({ count: 3n }),
};

/** The module's witnesses. */
export const CountWitnesses = <L>() => ({
  wit_count({
    privateState,
  }: WitnessContext<L, CountPrivateState>): [CountPrivateState, bigint] {
    return [privateState, privateState.count];
  },
});

/** An authenticator's part of the private state. */
export type SecretPrivateState = { secret: bigint };

export const SecretPrivateState = {
  generate: (): SecretPrivateState => ({ secret: 7n }),
};

/** An authenticator's witnesses. */
export const SecretWitnesses = <L>() => ({
  wit_secret({
    privateState,
  }: WitnessContext<L, SecretPrivateState>): [SecretPrivateState, bigint] {
    return [privateState, privateState.secret];
  },
});

/** Both parts in one factory, as a hand-written module factory bundles them. */
export const DefineWitnesses = <L>() => ({
  ...CountWitnesses<L>(),
  ...SecretWitnesses<L>(),
});
