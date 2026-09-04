import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeploymentsFileError } from '../errors.ts';
import { readJson, writeJson } from './atomic-json.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'atomic-json-test-'));
}

describe('readJson', () => {
  it('should return the fallback when the file does not exist', async () => {
    const path = join(scratch(), 'missing.json');
    expect(await readJson(path, { seeded: true })).toEqual({ seeded: true });
  });

  it('should return the fallback when the file is empty', async () => {
    const path = join(scratch(), 'empty.json');
    writeFileSync(path, '   \n');
    expect(await readJson(path, { seeded: true })).toEqual({ seeded: true });
  });

  it('should parse an existing document', async () => {
    const path = join(scratch(), 'head.json');
    writeFileSync(path, '{"Token":{"address":"0xT1"}}');
    expect(await readJson(path, {})).toEqual({ Token: { address: '0xT1' } });
  });

  it('should name the file in a typed error when the document is malformed', async () => {
    const path = join(scratch(), 'local.json');
    writeFileSync(path, '{"Token": {');
    const thrown = await readJson(path, {}).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(DeploymentsFileError);
    expect((thrown as DeploymentsFileError).message).toContain(path);
    expect((thrown as DeploymentsFileError).exitCode).toBe(6);
    expect((thrown as DeploymentsFileError).cause).toBeInstanceOf(SyntaxError);
  });
});

describe('writeJson', () => {
  it('should round-trip a value through readJson', async () => {
    const path = join(scratch(), 'head.json');
    await writeJson(path, { Token: { address: '0xT1' } });
    expect(await readJson(path, {})).toEqual({ Token: { address: '0xT1' } });
  });

  it('should create missing parent directories', async () => {
    const path = join(scratch(), 'nested', 'deeper', 'head.json');
    await writeJson(path, { ok: 1 });
    expect(await readJson(path, {})).toEqual({ ok: 1 });
  });

  it('should leave no temp sibling behind and end the file with a newline', async () => {
    const dir = scratch();
    const path = join(dir, 'head.json');
    await writeJson(path, { ok: 1 });
    // The rename target is the only artefact; a leftover `.tmp` would mean
    // the atomic write degraded into a plain write.
    expect(readdirSync(dir)).toEqual(['head.json']);
    expect(readFileSync(path, 'utf8')).toBe('{\n  "ok": 1\n}\n');
  });
});
