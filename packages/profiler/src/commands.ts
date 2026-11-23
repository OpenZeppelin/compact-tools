import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BinaryOptions,
  type BinaryRun,
  resolveProfileBinary,
  runProfileBinary,
} from './launcher.ts';

/** A `compact-profile` run that exited non-zero; the message carries both streams. */
export class ProfileCommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(args: readonly string[], run: BinaryRun) {
    // `check` prints drift and parity findings to stdout, its summary to stderr.
    super(
      [
        `compact-profile ${args.join(' ')} exited ${run.exitCode}`,
        run.stdout.trim(),
        run.stderr.trim(),
      ]
        .filter((part) => part !== '')
        .join('\n'),
    );
    this.name = 'ProfileCommandError';
    this.exitCode = run.exitCode;
    this.stdout = run.stdout;
    this.stderr = run.stderr;
  }
}

/** Where the network profiles come from. */
export interface ProfileSource extends BinaryOptions {
  /** A profile file on disk; replaces the shipped profile of the same name. */
  profileFile?: string;
}

async function run(
  args: string[],
  source: ProfileSource,
): Promise<{ binary: string; output: BinaryRun }> {
  const full =
    source.profileFile === undefined
      ? args
      : [...args, '--profile-file', source.profileFile];
  const binary = await resolveProfileBinary(source);
  const output = await runProfileBinary(full, { binary });
  if (output.exitCode !== 0) {
    throw new ProfileCommandError(full, output);
  }
  return { binary, output };
}

function fieldsOf(value: unknown): ReadonlyMap<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? new Map(Object.entries(value))
    : undefined;
}

/**
 * A `--reporter json` report read field by field. A field of the wrong type throws an error
 * naming the binary, since `COMPACT_PROFILE_BINARY` can point at any build.
 */
class Report {
  readonly #origin: string;
  readonly #prefix: string;
  readonly #fields: ReadonlyMap<string, unknown>;

  private constructor(
    origin: string,
    prefix: string,
    fields: ReadonlyMap<string, unknown>,
  ) {
    this.#origin = origin;
    this.#prefix = prefix;
    this.#fields = fields;
  }

  static parse(binary: string, command: string, stdout: string): Report {
    const origin = `${binary} ${command}`;
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      value = undefined;
    }
    const fields = fieldsOf(value);
    if (fields === undefined) {
      throw new Error(`${origin} printed no JSON object`);
    }
    return new Report(origin, '', fields);
  }

  #error(key: string, expected: string): Error {
    return new Error(
      `${this.#origin} printed an unexpected report: ${this.#prefix}${key} is not ${expected}`,
    );
  }

  string(key: string): string {
    const value = this.#fields.get(key);
    if (typeof value === 'string') return value;
    throw this.#error(key, 'a string');
  }

  stringOrNull(key: string): string | null {
    const value = this.#fields.get(key);
    if (value === null || typeof value === 'string') return value;
    throw this.#error(key, 'a string or null');
  }

  boolean(key: string): boolean {
    const value = this.#fields.get(key);
    if (typeof value === 'boolean') return value;
    throw this.#error(key, 'a boolean');
  }

  number(key: string): number {
    const value = this.#fields.get(key);
    if (typeof value === 'number') return value;
    throw this.#error(key, 'a number');
  }

  numberOrNull(key: string): number | null {
    const value = this.#fields.get(key);
    if (value === null || typeof value === 'number') return value;
    throw this.#error(key, 'a number or null');
  }

  oneOf<const T extends string>(key: string, values: readonly T[]): T {
    const value = this.#fields.get(key);
    const match = values.find((candidate) => candidate === value);
    if (match !== undefined) return match;
    throw this.#error(key, `one of ${values.join(', ')}`);
  }

  list(key: string): Report[] {
    const value = this.#fields.get(key);
    if (!Array.isArray(value)) throw this.#error(key, 'a list');
    return value.map((item: unknown, index) => {
      const fields = fieldsOf(item);
      if (fields === undefined) {
        throw this.#error(`${key}[${index}]`, 'an object');
      }
      return new Report(
        this.#origin,
        `${this.#prefix}${key}[${index}].`,
        fields,
      );
    });
  }
}

/** What `compact-profile params --reporter json` prints, plus the parameter bytes. */
export interface NetworkParams {
  network: string;
  provisional: boolean;
  paramsIdentity: string;
  minClientLedger: string | null;
  /** Tagged `LedgerParameters` bytes. */
  bytes: Uint8Array;
}

export async function networkParams(
  network: string,
  source: ProfileSource = {},
): Promise<NetworkParams> {
  const dir = mkdtempSync(join(tmpdir(), 'compact-profiler-params-'));
  try {
    const out = join(dir, 'params.bin');
    const { binary, output } = await run(
      ['params', '--network', network, '--out', out, '--reporter', 'json'],
      source,
    );
    const report = Report.parse(binary, 'params', output.stdout);
    const fields = {
      network: report.string('network'),
      provisional: report.boolean('provisional'),
      paramsIdentity: report.string('paramsIdentity'),
      minClientLedger: report.stringOrNull('minClientLedger'),
    };
    return { ...fields, bytes: new Uint8Array(readFileSync(out)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The parts of `compact-profile cost --reporter json` the runner reads. */
export interface CostReport {
  network: string;
  fits: boolean;
  binding: string | null;
  serializedLen: number;
  declaredNodes: number;
  limits: {
    name: string;
    used: string | null;
    allowed: string | null;
    ratioPpm: number | null;
    status: 'ok' | 'over' | 'n/a';
  }[];
}

export async function costTransaction(
  txPath: string,
  network: string,
  source: ProfileSource = {},
): Promise<CostReport> {
  const { binary, output } = await run(
    ['cost', txPath, '--network', network, '--reporter', 'json'],
    source,
  );
  const report = Report.parse(binary, 'cost', output.stdout);
  return {
    network: report.string('network'),
    fits: report.boolean('fits'),
    binding: report.stringOrNull('binding'),
    serializedLen: report.number('serializedLen'),
    declaredNodes: report.number('declaredNodes'),
    limits: report.list('limits').map((limit) => ({
      name: limit.string('name'),
      used: limit.stringOrNull('used'),
      allowed: limit.stringOrNull('allowed'),
      ratioPpm: limit.numberOrNull('ratioPpm'),
      status: limit.oneOf('status', ['ok', 'over', 'n/a']),
    })),
  };
}

export interface CheckOptions extends ProfileSource {
  manifest: string;
  /** Networks to check; at least one. */
  networks: readonly string[];
  snapshot: string;
  /** Run `update`, which writes the snapshot, instead of `check`. */
  update?: boolean;
  /** Bytes `serializedLen` and `blockUsage` may drift before `check` fails. Omitted, the binary's default applies. `check` only. */
  sizeTolerance?: number;
  reporter?: 'table' | 'json';
}

/**
 * Runs `compact-profile check` (or `update`) on a manifest.
 *
 * @throws {ProfileCommandError} On any non-zero exit: parity mismatch, drift, or bad input.
 */
export async function runCheck(options: CheckOptions): Promise<BinaryRun> {
  if (options.networks.length === 0) {
    throw new Error('runCheck needs at least one network');
  }
  if (options.update && options.sizeTolerance !== undefined) {
    throw new Error(
      'sizeTolerance applies to check only; update writes the snapshot without comparing',
    );
  }
  const args = [
    options.update ? 'update' : 'check',
    '--manifest',
    options.manifest,
    ...options.networks.flatMap((network) => ['--network', network]),
    '--snapshot',
    options.snapshot,
    '--reporter',
    options.reporter ?? 'table',
  ];
  if (options.sizeTolerance !== undefined) {
    args.push('--size-tolerance', String(options.sizeTolerance));
  }
  return (await run(args, options)).output;
}
