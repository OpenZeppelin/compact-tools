import type {
  SigningKey as LedgerSigningKey,
  SignatureKind,
} from '@midnightntwrk/ledger-v9';
import { ConfigError } from '../errors.ts';
import { LoaderContext } from './context.ts';

/** Scheme of every maintenance signature. The hex key file carries no tag of its own. */
const SIGNING_KEY_KIND: SignatureKind = 'schnorr';

/**
 * Maintenance-authority signing key. Canonical form: 64 lowercase hex
 * chars, no `0x`. Fuzzy input is rejected so midnight-js can't silently
 * auto-sample a key the user then can't recover.
 */
export class SigningKey {
  readonly hex: string;

  private constructor(hex: string) {
    this.hex = hex;
  }

  /** The key in the tagged form every ledger and midnight-js entry point takes. */
  get ledgerKey(): LedgerSigningKey {
    return { tag: SIGNING_KEY_KIND, value: this.hex };
  }

  static async load(rootDir: string, path: string): Promise<SigningKey> {
    const ctx = new LoaderContext(rootDir);
    const { text, path: abs } = await ctx.readText(path, 'signing_key_file');
    const trimmed = text.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new ConfigError(
        `signing_key_file ${abs}: expected 32 bytes hex-encoded (64 hex chars)`,
      );
    }
    return new SigningKey(trimmed.toLowerCase());
  }
}
