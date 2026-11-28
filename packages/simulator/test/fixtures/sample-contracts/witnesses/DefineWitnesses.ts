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

/** Module witnesses that return their own part, counted up. */
export const CountingWitnesses = <L>() => ({
  wit_count({
    privateState,
  }: WitnessContext<L, CountPrivateState>): [CountPrivateState, bigint] {
    return [{ count: privateState.count + 1n }, privateState.count];
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

/** Both parts of the private state. */
export type DefinePrivateState = CountPrivateState & SecretPrivateState;

export const DefinePrivateState = {
  generate: (): DefinePrivateState => ({ count: 3n, secret: 7n }),
};

/** Both witnesses in one factory over the whole state, as a module file bundles them. */
export const DefineWitnesses = <L>() => ({
  wit_count({
    privateState,
  }: WitnessContext<L, DefinePrivateState>): [DefinePrivateState, bigint] {
    return [privateState, privateState.count];
  },
  wit_secret({
    privateState,
  }: WitnessContext<L, DefinePrivateState>): [DefinePrivateState, bigint] {
    return [privateState, privateState.secret];
  },
});
