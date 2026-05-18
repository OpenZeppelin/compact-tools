import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';

/**
 * Prefunded wallets on `midnight-node --preset=dev`.
 *
 * Slot 0 is the canonical testkit-js BIP39 mnemonic (`abandon × 23 diesel`),
 * which the dev preset funds at genesis. Slots 1..4 are the additional hex
 * seeds the standalone testkit exposes via `LocalTestEnvironment`. The
 * mnemonic is normalised to its 128-char BIP39 hex seed inside
 * `normalizeSeed`, so every entry here is the input we pass to
 * `FluentWalletBuilder.withSeed(...)` after normalisation.
 */
export const LOCAL_PREFUNDED_SEEDS: readonly string[] = [
  TEST_MNEMONIC,
  '0000000000000000000000000000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000003',
  '0000000000000000000000000000000000000000000000000000000000000004',
] as const;

export function localPrefundedSeed(index: number): string {
  const seed = LOCAL_PREFUNDED_SEEDS[index];
  if (!seed) {
    throw new RangeError(
      `local wallet index ${index} out of range (0..${LOCAL_PREFUNDED_SEEDS.length - 1})`,
    );
  }
  return seed;
}
