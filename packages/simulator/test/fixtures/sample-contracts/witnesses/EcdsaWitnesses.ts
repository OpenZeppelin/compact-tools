// Ecdsa has no witnesses and no private state; the verification circuits take
// all their inputs as arguments.
export type EcdsaPrivateState = Record<string, never>;
export const EcdsaPrivateState: EcdsaPrivateState = {};
export const EcdsaWitnesses = () => ({});
