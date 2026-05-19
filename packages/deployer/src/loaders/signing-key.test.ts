import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { SigningKey } from './signing-key.ts';

const VALID = 'a'.repeat(64);

describe('SigningKey', () => {
  it('should read and lowercase a 32-byte hex key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-test-'));
    writeFileSync(join(dir, 'sk'), `${VALID.toUpperCase()}\n`);
    expect((await SigningKey.load(dir, 'sk')).hex).toBe(VALID);
  });

  it('should strip an optional 0x prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-test-'));
    writeFileSync(join(dir, 'sk'), `0x${VALID}\n`);
    expect((await SigningKey.load(dir, 'sk')).hex).toBe(VALID);
  });

  it('should reject a wrong-length key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-test-'));
    writeFileSync(join(dir, 'sk'), 'abcd');
    await expect(SigningKey.load(dir, 'sk')).rejects.toThrow(ConfigError);
  });

  it('should reject a missing file', async () => {
    await expect(SigningKey.load('/tmp', 'no-such-file')).rejects.toThrow(
      ConfigError,
    );
  });
});
