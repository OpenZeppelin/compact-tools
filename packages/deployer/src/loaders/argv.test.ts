import { describe, expect, it } from 'vitest';
import { parseDeployArgv } from './argv.ts';

describe('parseDeployArgv', () => {
  it('should default every flag to off', () => {
    expect(parseDeployArgv([])).toEqual({
      noCache: false,
      force: false,
      dryRun: false,
      json: false,
      verbose: false,
      help: false,
      version: false,
      positional: [],
    });
  });

  it('should parse every value flag', () => {
    const p = parseDeployArgv([
      '--network',
      'preview',
      '--config',
      './compact.toml',
      '--seed-file',
      './seed.hex',
      '--proof-server',
      'http://proof:6300',
      '--sync-timeout',
      '900',
      '--tx-timeout',
      '300',
      '--sync-batch-size',
      '2500',
      '--seed-cache-from-dust',
      './dust.gz',
      '--seed-cache-from-shielded',
      './shielded.gz',
      '--seed-cache-from-unshielded',
      './unshielded.gz',
    ]);
    expect(p.network).toBe('preview');
    expect(p.configPath).toBe('./compact.toml');
    expect(p.seedFile).toBe('./seed.hex');
    expect(p.proofServer).toBe('http://proof:6300');
    expect(p.syncTimeoutSec).toBe(900);
    expect(p.txTimeoutSec).toBe(300);
    expect(p.syncBatchSize).toBe(2500);
    expect(p.seedCacheFromDust).toBe('./dust.gz');
    expect(p.seedCacheFromShielded).toBe('./shielded.gz');
    expect(p.seedCacheFromUnshielded).toBe('./unshielded.gz');
  });

  it('should reject --seed-cache-from-unshielded with no follow-up value', () => {
    expect(() => parseDeployArgv(['--seed-cache-from-unshielded'])).toThrow(
      /--seed-cache-from-unshielded requires a value/,
    );
  });

  it('should parse every boolean flag and its shorthand', () => {
    const p = parseDeployArgv([
      '--json',
      '--dry-run',
      '--no-cache',
      '--force',
      '-v',
      '-h',
      '--version',
    ]);
    expect(p).toMatchObject({
      json: true,
      dryRun: true,
      noCache: true,
      force: true,
      verbose: true,
      help: true,
      version: true,
    });
  });

  it('should collect non-flag arguments as positionals in order', () => {
    expect(parseDeployArgv(['Token', 'extra']).positional).toEqual([
      'Token',
      'extra',
    ]);
  });

  it('should treat an unrecognised single-dash arg as positional', () => {
    expect(parseDeployArgv(['-x'], { rejectUnknownFlags: true })).toMatchObject(
      { positional: ['-x'] },
    );
  });

  it('should reject an unknown --flag only under rejectUnknownFlags', () => {
    // The CLI is the whole program, so a typo is an error. The library
    // coexists with extra argv injected by a caller's wrapper script.
    expect(() =>
      parseDeployArgv(['--nope'], { rejectUnknownFlags: true }),
    ).toThrow(/Unknown flag: --nope/);
    expect(parseDeployArgv(['--nope']).positional).toEqual([]);
  });

  it('should reject a value flag whose value is missing or looks like a flag', () => {
    expect(() => parseDeployArgv(['--network'])).toThrow(
      /--network requires a value/,
    );
    expect(() => parseDeployArgv(['--network', '--json'])).toThrow(
      /--network requires a value/,
    );
  });

  it('should reject a non-positive --sync-timeout and --sync-batch-size', () => {
    expect(() => parseDeployArgv(['--sync-timeout', 'nope'])).toThrow(
      /--sync-timeout requires a positive integer \(seconds\); got "nope"/,
    );
    expect(() => parseDeployArgv(['--sync-batch-size', '0'])).toThrow(
      /--sync-batch-size requires a positive integer; got "0"/,
    );
  });

  it('should reject a non-positive --tx-timeout', () => {
    expect(() => parseDeployArgv(['--tx-timeout', '0'])).toThrow(
      /--tx-timeout requires a positive integer \(seconds\); got "0"/,
    );
    expect(() => parseDeployArgv(['--tx-timeout'])).toThrow(
      /--tx-timeout requires a value/,
    );
  });
});
