/**
 * Writes the `compact-profile` crate's test fixtures from the Mint sample contract: the base
 * set in `mint/`, a rebuild of one series member in `mint-rerun/`, and each check case's
 * derived manifest or snapshot. Runs as `yarn generate:crate-fixtures` and needs the binary
 * (`COMPACT_PROFILE_BINARY`). The crate's `expected.txt` files come from its own bless run.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileCommandError, runCheck } from '../src/commands.ts';
import {
  compareVersions,
  type Manifest,
  type ManifestScenario,
} from '../src/manifest.ts';
import {
  createProfiler,
  defaultCaller,
  type Profiler,
  type TxBuilder,
} from '../src/profiler.ts';
import { binaryUnderTest } from './binaryUnderTest.ts';
import globalSetup from './setup.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(
  TEST_DIR,
  '..',
  '..',
  '..',
  'crates',
  'compact-profile',
  'tests',
  'fixtures',
);
const BASE = join(FIXTURES, 'mint');
const RERUN = join(FIXTURES, 'mint-rerun');

const LEDGER = '@midnightntwrk/ledger-v9';
const RUNTIME = '@midnight-ntwrk/compact-runtime';
/** Below mainnet's minimum client ledger. */
const OLD_CLIENT = '1.0.0-rc.5';

const SERIES = 'mint multi-call';
/** The series member rebuilt for the size tolerance case. */
const RERUN_N = 4;
const RERUN_ATTEMPTS = 10;
/** The series member whose declared nodes the parity case lowers. */
const PARITY_N = 8;

const AMOUNT = 1000n;
const recipient = {
  bytes: new Uint8Array(Buffer.from(defaultCaller().coinPublicKey, 'hex')),
};
const nonce = (i: number) =>
  new Uint8Array(createHash('sha256').update(`nonce-${i}`).digest());

function multiCall(tx: TxBuilder<unknown>, n: number): void {
  for (let i = 0; i < n; i++) tx.call('mint', recipient, AMOUNT, nonce(i));
}

/** The snapshot fields this script edits. */
interface Snapshot {
  toolchain: Record<string, string>;
  scenarios: {
    name: string;
    ops: number;
    measured: { cost: Record<string, string>; serializedLen: number };
  }[];
  networks: {
    name: string;
    scenarios: {
      name: string;
      fits: boolean;
      blockBinding: string | null;
      txsPerBlock: number;
      opsPerBlock: number;
    }[];
    series: { name: string; maxN: number; basis: string }[];
  }[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Writes JSON as the runner does: two-space indent and a final newline. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function find<T extends { name: string }>(entries: T[], name: string): T {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`no entry named ${JSON.stringify(name)}`);
  }
  return entry;
}

function memberName(n: number): string {
  return `${SERIES} n=${n}`;
}

function addToDecimal(value: string, delta: bigint): string {
  return (BigInt(value) + delta).toString();
}

/** The same version with the minor lowered by one. */
function olderMinor(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null || Number(match[2]) === 0) {
    throw new Error(`cannot derive a release older than ${version}`);
  }
  return `${match[1]}.${Number(match[2]) - 1}.${match[3]}`;
}

/** A copy of the base manifest for a case directory, its transactions read from `mint/`. */
function caseManifest(base: Manifest): Manifest {
  const copy = structuredClone(base);
  for (const entry of copy.scenarios) entry.tx = `../mint/${entry.tx}`;
  return copy;
}

async function main(): Promise<void> {
  const { binary, skip } = binaryUnderTest(process.env, existsSync);
  if (skip !== undefined) throw new Error(skip);

  await globalSetup();
  const { Contract: Mint } = await import(
    './fixtures/artifacts/Mint/contract/index.js'
  );
  const compactc = readFileSync(
    join(TEST_DIR, 'fixtures', 'artifacts', 'Mint', '.compiler-stamp'),
    'utf8',
  ).trim();
  const mintProfiler = (outDir: string): Promise<Profiler<unknown>> =>
    createProfiler({
      name: 'Mint',
      contract: new Mint({}),
      network: 'mainnet',
      outDir,
      binary,
      toolchain: { compactc },
    });
  const update = (
    manifest: string,
    snapshot: string,
    networks: string[],
    profileFile?: string,
  ) =>
    runCheck({
      binary,
      manifest,
      networks,
      snapshot,
      update: true,
      profileFile,
    });

  // Base set.
  const profiler = await mintProfiler(BASE);
  await profiler.scenario('mint', (tx) =>
    tx.call('mint', recipient, AMOUNT, nonce(0)),
  );
  await profiler.scenario('mint to self', (tx) =>
    tx.call('mintToSelf', AMOUNT, nonce(0)),
  );
  await profiler.scenario('mint batch of 4', { ops: 4 }, (tx) =>
    tx.call(
      'mintBatch4',
      recipient,
      AMOUNT,
      [0, 1, 2, 3].map((i) => nonce(i)),
    ),
  );
  const search = await profiler.searchMax(SERIES, {}, multiCall);
  if (search.capped || search.binding !== 'mainnet: nodes') {
    throw new Error(
      `${SERIES} must stop at the mainnet node cap; searchMax returned ${JSON.stringify({ maxN: search.maxN, capped: search.capped, binding: search.binding })}`,
    );
  }
  const sizes = search.scenarios.map((entry) => entry.n);
  for (const n of [RERUN_N, PARITY_N]) {
    if (!sizes.includes(n)) {
      throw new Error(`${SERIES} has no member n=${n}; recorded ${sizes}`);
    }
  }
  const baseManifestPath = await profiler.write();
  const baseManifest = readJson<Manifest>(baseManifestPath);
  const baseSnapshotPath = join(BASE, 'snapshot.json');
  await update(baseManifestPath, baseSnapshotPath, ['mainnet']);
  console.log(
    `${SERIES}: mainnet cap n=${search.maxN}, members n=${sizes.join(', ')}`,
  );

  // A rebuild of one member whose size differs from the base build, within the default
  // tolerance.
  const tolerancePath = join(FIXTURES, 'check-tolerance', 'manifest.json');
  const original = find(baseManifest.scenarios, memberName(RERUN_N));
  const rebuildMember = async (): Promise<ManifestScenario> => {
    for (let attempt = 0; attempt < RERUN_ATTEMPTS; attempt++) {
      const rebuild = await mintProfiler(RERUN);
      const [entry] = await rebuild.series(
        SERIES,
        { sizes: [RERUN_N] },
        multiCall,
      );
      await rebuild.write();
      if (
        entry === undefined ||
        (entry.js.serializedLen === original.js.serializedLen &&
          entry.js.cost.blockUsage === original.js.cost.blockUsage)
      ) {
        continue;
      }
      const tolerance = caseManifest(baseManifest);
      tolerance.scenarios = tolerance.scenarios.map((scenario) =>
        scenario.name === entry.name
          ? { ...scenario, tx: `../mint-rerun/${entry.tx}`, js: entry.js }
          : scenario,
      );
      writeJson(tolerancePath, tolerance);
      try {
        await runCheck({
          binary,
          manifest: tolerancePath,
          networks: ['mainnet'],
          snapshot: baseSnapshotPath,
        });
        return entry;
      } catch (error) {
        if (!(error instanceof ProfileCommandError)) throw error;
      }
    }
    throw new Error(
      `${RERUN_ATTEMPTS} rebuilds of ${original.name} matched the base size or broke the default tolerance`,
    );
  };
  const rerun = await rebuildMember();
  console.log(
    `${rerun.name}: serializedLen ${original.js.serializedLen} -> ${rerun.js.serializedLen}, blockUsage ${original.js.cost.blockUsage} -> ${rerun.js.cost.blockUsage}`,
  );

  // Derived manifests.
  const parity = caseManifest(baseManifest);
  const [first] = parity.scenarios;
  if (first === undefined) throw new Error('the base manifest is empty');
  first.js.cost.computeTime = addToDecimal(first.js.cost.computeTime, 1n);
  find(parity.scenarios, memberName(PARITY_N)).js.declaredNodes -= 1;
  writeJson(join(FIXTURES, 'check-parity', 'manifest.json'), parity);

  const identity = caseManifest(baseManifest);
  identity.paramsIdentity = '0'.repeat(identity.paramsIdentity.length);
  writeJson(join(FIXTURES, 'check-identity', 'manifest.json'), identity);

  const form = caseManifest(baseManifest);
  form.scenarios[0]!.tx = '../live/base-mint-proven.bin';
  writeJson(join(FIXTURES, 'check-form', 'manifest.json'), form);

  const client = baseManifest.toolchain[LEDGER];
  if (client === undefined || compareVersions(OLD_CLIENT, client) >= 0) {
    throw new Error(`${OLD_CLIENT} is not older than the client ${client}`);
  }
  const oldClient = caseManifest(baseManifest);
  oldClient.toolchain[LEDGER] = OLD_CLIENT;
  const oldClientPath = join(FIXTURES, 'check-client', 'manifest.json');
  writeJson(oldClientPath, oldClient);

  const noClient = caseManifest(baseManifest);
  delete noClient.toolchain[LEDGER];
  delete noClient.toolchain[RUNTIME];
  writeJson(
    join(FIXTURES, 'check-client', 'manifest-no-client.json'),
    noClient,
  );

  // Snapshots.
  await update(oldClientPath, join(FIXTURES, 'check-client', 'snapshot.json'), [
    'mainnet',
  ]);
  // `unmeasured.toml` is hand-written and replaces the shipped `undeployed`.
  await update(
    baseManifestPath,
    join(FIXTURES, 'check-networks', 'snapshot.json'),
    ['mainnet', 'undeployed'],
    join(FIXTURES, 'check-networks', 'unmeasured.toml'),
  );

  const drift = readJson<Snapshot>(baseSnapshotPath);
  drift.toolchain.compactc = olderMinor(compactc);
  const second = find(drift.scenarios, 'mint to self');
  second.measured.cost.bytesWritten = addToDecimal(
    second.measured.cost.bytesWritten!,
    1n,
  );
  second.measured.serializedLen += 100;
  const mainnet = find(drift.networks, 'mainnet');
  const atCap = find(mainnet.scenarios, memberName(search.maxN));
  const overCap = find(mainnet.scenarios, memberName(search.maxN + 1));
  const series = find(mainnet.series, SERIES);
  if (
    !atCap.fits ||
    overCap.fits ||
    series.maxN !== search.maxN ||
    series.basis !== 'measured' ||
    atCap.blockBinding === overCap.blockBinding
  ) {
    throw new Error(
      `the base snapshot does not show ${SERIES} bounded at n=${search.maxN}`,
    );
  }
  // The over-cap member recorded as fitting like the at-cap one, the series maximum with it.
  Object.assign(overCap, {
    ...atCap,
    name: overCap.name,
    opsPerBlock: atCap.txsPerBlock * find(drift.scenarios, overCap.name).ops,
  });
  series.maxN = search.maxN + 1;
  writeJson(join(FIXTURES, 'check-drift', 'snapshot.json'), drift);
}

await main();
