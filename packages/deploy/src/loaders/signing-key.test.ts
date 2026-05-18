import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { loadSigningKey } from './signing-key.ts';

const VALID = 'a'.repeat(64);

describe('loadSigningKey', () => {
  it('reads and lowercases a 32-byte hex key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-test-'));
    writeFileSync(join(dir, 'sk'), `${VALID.toUpperCase()}\n`);
    expect(await loadSigningKey(dir, 'sk')).toBe(VALID);
  });

  it('strips an optional 0x prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-test-'));
    writeFileSync(join(dir, 'sk'), `0x${VALID}\n`);
    expect(await loadSigningKey(dir, 'sk')).toBe(VALID);
  });

  it('rejects a wrong-length key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-test-'));
    writeFileSync(join(dir, 'sk'), 'abcd');
    await expect(loadSigningKey(dir, 'sk')).rejects.toThrow(ConfigError);
  });

  it('rejects a missing file', async () => {
    await expect(loadSigningKey('/tmp', 'no-such-file')).rejects.toThrow(
      ConfigError,
    );
  });
});
