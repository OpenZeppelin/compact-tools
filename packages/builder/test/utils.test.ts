import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CircuitInfoFile,
  cleanCompileOutput,
  cleanForDisplay,
  parseCircuitConstraints,
  writeCircuitInfoJson,
} from '../src/utils.js';

describe('cleanCompileOutput', () => {
  it('strips ANSI CSI color sequences', () => {
    const input = '\x1B[32m\x1B[1mhello\x1B[0m world';
    const result = cleanCompileOutput(input);
    expect(result).toContain('hello');
    expect(result).toContain('world');
    expect(result).not.toContain('\x1B');
  });

  it('strips cursor movement sequences', () => {
    const input = '\x1B[3A\x1B[2Ksome text';
    const result = cleanCompileOutput(input);
    expect(result).toContain('some text');
    expect(result).not.toContain('\x1B');
  });

  it('keeps only the last frame on carriage-return overwrites', () => {
    const input = 'loading |\rloading /\rloading done';
    const result = cleanCompileOutput(input);
    expect(result).toContain('loading done');
    expect(result).not.toContain('loading |');
    expect(result).not.toContain('loading /');
  });

  it('preserves newlines', () => {
    const input = 'line 1\nline 2\nline 3';
    const result = cleanCompileOutput(input);
    expect(result).toBe('line 1\nline 2\nline 3');
  });

  it('strips unicode spinner characters', () => {
    const input = 'circuit "foo" (k=5, rows=100) ⠋';
    const result = cleanCompileOutput(input);
    expect(result).not.toContain('⠋');
    expect(result).toContain('circuit "foo"');
  });

  it('handles empty input', () => {
    expect(cleanCompileOutput('')).toBe('');
  });

  it('cleans real compactc TTY output with ANSI and spinners', () => {
    const input =
      '  circuit "owner" \x1B[32m\x1B[1m|\x1B[0m\r\x1B[2K' +
      '  circuit "owner" (k=7, rows=76) \x1B[32m\x1B[1m|\x1B[0m\r\n';
    const result = cleanCompileOutput(input);
    expect(result).toContain('circuit "owner" (k=7, rows=76)');
  });
});

describe('cleanForDisplay', () => {
  it('strips the compactc version line', () => {
    const input =
      'compactc 0.26.0\nCompiling 3 circuits:\n  circuit "foo" (k=5, rows=100)\n';
    const result = cleanForDisplay(input);
    expect(result).not.toContain('compactc');
    expect(result).toContain('Compiling 3 circuits');
  });

  it('deduplicates circuit lines from spinner redraws', () => {
    const input = [
      'Compiling 2 circuits:',
      '  circuit "foo" (k=5, rows=100)',
      '  circuit "bar" (k=7, rows=200)',
      '  circuit "foo" (k=5, rows=100)',
      '  circuit "bar" (k=7, rows=200)',
      '  circuit "foo" (k=5, rows=100)',
      '  circuit "bar" (k=7, rows=200)',
      'Overall progress [====================] 2/2',
    ].join('\n');

    const result = cleanForDisplay(input);
    const fooCount = (result.match(/circuit "foo"/g) ?? []).length;
    const barCount = (result.match(/circuit "bar"/g) ?? []).length;

    expect(fooCount).toBe(1);
    expect(barCount).toBe(1);
    expect(result).toContain('Compiling 2 circuits');
    expect(result).toContain('Overall progress');
  });

  it('drops partial circuit lines (no k/rows)', () => {
    const input = [
      'Compiling 1 circuits:',
      '  circuit "foo"',
      '  circuit "foo" (k=5)',
      '  circuit "foo" (k=5, rows=100)',
    ].join('\n');

    const result = cleanForDisplay(input);
    expect(result).toContain('circuit "foo" (k=5, rows=100)');
    const fooCount = (result.match(/circuit "foo"/g) ?? []).length;
    expect(fooCount).toBe(1);
  });

  it('returns empty string for empty input', () => {
    expect(cleanForDisplay('')).toBe('');
  });

  it('returns only the compiling line for --skip-zk output', () => {
    const input = 'Compiling 3 circuits:\n';
    const result = cleanForDisplay(input);
    expect(result).toBe('Compiling 3 circuits:');
  });
});

describe('parseCircuitConstraints', () => {
  it('parses clean compile output', () => {
    const input = `Compiling 3 circuits:
  circuit "assertInitialized" (k=6, rows=26)
  circuit "assertNotInitialized" (k=6, rows=29)
  circuit "initialize" (k=6, rows=29)
Overall progress [====================] 3/3`;

    const circuits = parseCircuitConstraints(input);

    expect(circuits).toHaveLength(3);
    expect(circuits).toEqual([
      { name: 'assertInitialized', k: 6, rows: 26 },
      { name: 'assertNotInitialized', k: 6, rows: 29 },
      { name: 'initialize', k: 6, rows: 29 },
    ]);
  });

  it('parses output with ANSI codes', () => {
    const input =
      '  \x1B[36mcircuit\x1B[0m "owner" \x1B[33m(k=7, rows=76)\x1B[0m\n' +
      '  \x1B[36mcircuit\x1B[0m "transfer" \x1B[33m(k=10, rows=970)\x1B[0m\n';

    const circuits = parseCircuitConstraints(input);

    expect(circuits).toHaveLength(2);
    expect(circuits[0]).toEqual({ name: 'owner', k: 7, rows: 76 });
    expect(circuits[1]).toEqual({ name: 'transfer', k: 10, rows: 970 });
  });

  it('deduplicates by circuit name (last occurrence wins)', () => {
    const input = [
      '  circuit "foo" (k=5, rows=100)',
      '  circuit "bar" (k=7, rows=200)',
      '  circuit "foo" (k=5, rows=100)',
      '  circuit "bar" (k=7, rows=200)',
      '  circuit "foo" (k=5, rows=100)',
      '  circuit "bar" (k=7, rows=200)',
    ].join('\n');

    const circuits = parseCircuitConstraints(input);

    expect(circuits).toHaveLength(2);
    expect(circuits[0]).toEqual({ name: 'foo', k: 5, rows: 100 });
    expect(circuits[1]).toEqual({ name: 'bar', k: 7, rows: 200 });
  });

  it('ignores partial circuit lines without k/rows', () => {
    const input = [
      '  circuit "foo"',
      '  circuit "foo" (k=5)',
      '  circuit "foo" (k=5, rows=100)',
    ].join('\n');

    const circuits = parseCircuitConstraints(input);

    expect(circuits).toHaveLength(1);
    expect(circuits[0]).toEqual({ name: 'foo', k: 5, rows: 100 });
  });

  it('returns empty array for --skip-zk output', () => {
    expect(parseCircuitConstraints('Compiling 3 circuits:\n')).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseCircuitConstraints('')).toEqual([]);
  });

  it('returns empty array for unrelated output', () => {
    expect(
      parseCircuitConstraints('Some random text\nwith no circuits\n'),
    ).toEqual([]);
  });

  it('handles real-world compactc output with many circuits', () => {
    const input = `Compiling 7 circuits:
  circuit "_transferOwnership" (k=10, rows=600)
  circuit "_unsafeTransferOwnership" (k=13, rows=2956)
  circuit "_unsafeUncheckedTransferOwnership" (k=10, rows=597)
  circuit "assertOnlyOwner" (k=13, rows=2360)
  circuit "owner" (k=7, rows=76)
  circuit "renounceOwnership" (k=13, rows=2364)
  circuit "transferOwnership" (k=13, rows=2959)
Overall progress [====================] 7/7`;

    const circuits = parseCircuitConstraints(input);

    expect(circuits).toHaveLength(7);
    expect(circuits.find((c) => c.name === 'owner')).toEqual({
      name: 'owner',
      k: 7,
      rows: 76,
    });
    expect(circuits.find((c) => c.name === '_transferOwnership')).toEqual({
      name: '_transferOwnership',
      k: 10,
      rows: 600,
    });
  });
});

describe('writeCircuitInfoJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'circuit-info-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new .circuit-info.json when none exists', () => {
    const circuits = [
      { name: 'owner', k: 7, rows: 76 },
      { name: 'transfer', k: 10, rows: 970 },
    ];

    const jsonPath = writeCircuitInfoJson('Token.compact', tmpDir, circuits);

    expect(existsSync(jsonPath)).toBe(true);
    expect(jsonPath).toMatch(/\.circuit-info\.json$/);

    const content: CircuitInfoFile = JSON.parse(
      readFileSync(jsonPath, 'utf-8'),
    );
    expect(content.files['Token.compact']).toEqual(circuits);
    expect(new Date(content.generatedAt).getTime()).not.toBeNaN();
  });

  it('merges into an existing .circuit-info.json', () => {
    const firstCircuits = [{ name: 'owner', k: 7, rows: 76 }];
    const secondCircuits = [{ name: 'pause', k: 6, rows: 29 }];

    writeCircuitInfoJson('Token.compact', tmpDir, firstCircuits);
    writeCircuitInfoJson('Pausable.compact', tmpDir, secondCircuits);

    const jsonPath = join(tmpDir, '.circuit-info.json');
    const content: CircuitInfoFile = JSON.parse(
      readFileSync(jsonPath, 'utf-8'),
    );

    expect(Object.keys(content.files)).toHaveLength(2);
    expect(content.files['Token.compact']).toEqual(firstCircuits);
    expect(content.files['Pausable.compact']).toEqual(secondCircuits);
  });

  it('updates existing entry for the same file', () => {
    const oldCircuits = [{ name: 'owner', k: 7, rows: 76 }];
    const newCircuits = [{ name: 'owner', k: 8, rows: 100 }];

    writeCircuitInfoJson('Token.compact', tmpDir, oldCircuits);
    writeCircuitInfoJson('Token.compact', tmpDir, newCircuits);

    const jsonPath = join(tmpDir, '.circuit-info.json');
    const content: CircuitInfoFile = JSON.parse(
      readFileSync(jsonPath, 'utf-8'),
    );

    expect(Object.keys(content.files)).toHaveLength(1);
    expect(content.files['Token.compact']).toEqual(newCircuits);
  });

  it('creates intermediate directories for nested paths', () => {
    const circuits = [{ name: 'init', k: 6, rows: 26 }];

    const jsonPath = writeCircuitInfoJson(
      'test/mocks/MockInit.compact',
      tmpDir,
      circuits,
    );

    expect(jsonPath).toBe(join(tmpDir, 'test', 'mocks', '.circuit-info.json'));
    expect(existsSync(jsonPath)).toBe(true);

    const content: CircuitInfoFile = JSON.parse(
      readFileSync(jsonPath, 'utf-8'),
    );
    expect(content.files['MockInit.compact']).toEqual(circuits);
  });

  it('updates generatedAt timestamp on subsequent writes', async () => {
    const circuits = [{ name: 'owner', k: 7, rows: 76 }];
    const jsonPath = join(tmpDir, '.circuit-info.json');

    writeCircuitInfoJson('Token.compact', tmpDir, circuits);
    const firstTimestamp = JSON.parse(
      readFileSync(jsonPath, 'utf-8'),
    ).generatedAt;

    // Ensure at least 1ms passes so the timestamp differs
    await new Promise((resolve) => setTimeout(resolve, 5));

    writeCircuitInfoJson('Token.compact', tmpDir, circuits);
    const secondTimestamp = JSON.parse(
      readFileSync(jsonPath, 'utf-8'),
    ).generatedAt;

    expect(new Date(secondTimestamp).getTime()).toBeGreaterThan(
      new Date(firstTimestamp).getTime(),
    );
  });

  it('handles empty circuits array', () => {
    const jsonPath = writeCircuitInfoJson('Token.compact', tmpDir, []);

    const content: CircuitInfoFile = JSON.parse(
      readFileSync(jsonPath, 'utf-8'),
    );
    expect(content.files['Token.compact']).toEqual([]);
  });

  it('writes valid JSON with trailing newline', () => {
    writeCircuitInfoJson('Token.compact', tmpDir, [
      { name: 'foo', k: 5, rows: 100 },
    ]);

    const raw = readFileSync(join(tmpDir, '.circuit-info.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('preserves unrelated entries when updating one file', () => {
    writeCircuitInfoJson('A.compact', tmpDir, [{ name: 'a', k: 1, rows: 10 }]);
    writeCircuitInfoJson('B.compact', tmpDir, [{ name: 'b', k: 2, rows: 20 }]);
    writeCircuitInfoJson('A.compact', tmpDir, [{ name: 'a', k: 3, rows: 30 }]);

    const content: CircuitInfoFile = JSON.parse(
      readFileSync(join(tmpDir, '.circuit-info.json'), 'utf-8'),
    );

    expect(content.files['A.compact']).toEqual([{ name: 'a', k: 3, rows: 30 }]);
    expect(content.files['B.compact']).toEqual([{ name: 'b', k: 2, rows: 20 }]);
  });
});
