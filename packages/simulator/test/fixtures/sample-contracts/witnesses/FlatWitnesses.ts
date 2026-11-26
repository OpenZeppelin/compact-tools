import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

export type FlatPrivateState = { value: bigint };

export const FlatPrivateState = {
  generate: (): FlatPrivateState => ({ value: 5n }),
};

export const FlatWitnesses = <L>() => ({
  wit_value({
    privateState,
  }: WitnessContext<L, FlatPrivateState>): [FlatPrivateState, bigint] {
    return [privateState, privateState.value];
  },
});
