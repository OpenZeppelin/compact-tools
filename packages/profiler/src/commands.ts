import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BinaryOptions,
  type BinaryRun,
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

async function run(args: string[], source: ProfileSource): Promise<BinaryRun> {
  const full =
    source.profileFile === undefined
      ? args
      : [...args, '--profile-file', source.profileFile];
  const result = await runProfileBinary(full, source);
  if (result.exitCode !== 0) {
    throw new ProfileCommandError(full, result);
  }
  return result;
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
    const { stdout } = await run(
      ['params', '--network', network, '--out', out, '--reporter', 'json'],
      source,
    );
    const report = JSON.parse(stdout) as Omit<NetworkParams, 'bytes'>;
    return { ...report, bytes: new Uint8Array(readFileSync(out)) };
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
  const { stdout } = await run(
    ['cost', txPath, '--network', network, '--reporter', 'json'],
    source,
  );
  return JSON.parse(stdout) as CostReport;
}

export interface CheckOptions extends ProfileSource {
  manifest: string;
  /** Networks to check; at least one. */
  networks: readonly string[];
  snapshot: string;
  /** Run `update`, which writes the snapshot, instead of `check`. */
  update?: boolean;
  /** Bytes `serializedLen` and `blockUsage` may drift before `check` fails. */
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
  return run(args, options);
}
