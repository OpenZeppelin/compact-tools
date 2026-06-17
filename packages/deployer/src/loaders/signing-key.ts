import { ConfigError } from '../errors.ts';
import { LoaderContext } from './context.ts';

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
