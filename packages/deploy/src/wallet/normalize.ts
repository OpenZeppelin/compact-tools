import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { WalletError } from '../errors.ts';

/**
 * Discriminated representation of a deployer wallet input.
 *
 * The wallet builder offers two paths — `.withSeed(hex)` and
 * `.withMnemonic(phrase)` — that derive *different* wallets from the same
 * underlying entropy. Keeping the kind explicit through the resolve chain
 * lets the builder pick the matching method instead of force-converting a
 * mnemonic to hex (which silently lands on the wrong wallet).
 */
export type WalletSeed =
  | { kind: 'hex'; value: string }
  | { kind: 'mnemonic'; value: string };

export function classifySeed(input: string): WalletSeed {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new WalletError('Seed cannot be empty');
  }
  if (
    /^[0-9a-fA-F]+$/.test(trimmed) &&
    (trimmed.length === 64 || trimmed.length === 128)
  ) {
    return { kind: 'hex', value: trimmed.toLowerCase() };
  }
  if (validateMnemonic(trimmed, wordlist)) {
    return { kind: 'mnemonic', value: trimmed };
  }
  throw new WalletError(
    'Invalid seed: expected a 64/128-char hex string or a valid BIP39 mnemonic (12 or 24 words).',
  );
}
