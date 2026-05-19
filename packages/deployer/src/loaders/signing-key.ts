import { ConfigError } from '../errors.ts';
import { LoaderContext } from './context.ts';

/**
 * A contract's maintenance-authority signing key, loaded from
 * `[contracts.X].signing_key_file` in `compact.toml`.
 *
 * Canonical form: 64 lowercase hex chars, no `0x` prefix. We refuse fuzzy
 * input formats to avoid the foot-gun where midnight-js silently
 * auto-samples a key the user then can't recover.
 */
export class SigningKey {
  readonly hex: string;

  private constructor(hex: string) {
    this.hex = hex;
  }

  /**
   * Read and validate a key file — exactly 64 hex chars after stripping
   * optional `0x` and trimming whitespace.
   */
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
