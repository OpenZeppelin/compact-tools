import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coinCommitment,
  Transaction,
  ZswapSecretKeys,
} from '@midnightntwrk/ledger-v9';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { costTransaction, runCheck } from '../src/commands.ts';
import type { Manifest } from '../src/manifest.ts';
import {
  createProfiler,
  defaultCaller,
  type Profiler,
  type ProfilerOptions,
} from '../src/profiler.ts';
import { binaryUnderTest } from './binaryUnderTest.ts';
import {
  Contract as Counter,
  ledger as counterLedger,
} from './fixtures/artifacts/Counter/contract/index.js';
import { Contract as Mint } from './fixtures/artifacts/Mint/contract/index.js';
import { Contract as PrivateCounter } from './fixtures/artifacts/PrivateCounter/contract/index.js';
import { Contract as SameCoin } from './fixtures/artifacts/SameCoin/contract/index.js';

const { binary, skip } = binaryUnderTest(process.env, existsSync);

const SHIPPED_MAINNET = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'crates',
  'compact-profile',
  'profiles',
  'mainnet.toml',
);
const skipReason = skip === undefined ? '' : ` (skipped: ${skip})`;

const caller = defaultCaller().coinPublicKey;
const recipient = { bytes: new Uint8Array(Buffer.from(caller, 'hex')) };
const nonce = (i: number) =>
  new Uint8Array(createHash('sha256').update(`nonce-${i}`).digest());
const nonces = (n: number) => Array.from({ length: n }, (_, i) => nonce(i));

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'compact-profiler-e2e-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function counter(
  outDir: string,
  extra: Partial<ProfilerOptions<unknown>> = {},
): Promise<Profiler<unknown>> {
  return createProfiler({
    name: 'Counter',
    contract: new Counter({}),
    network: 'mainnet',
    outDir: join(root, outDir),
    binary,
    ...extra,
  });
}

interface CountState {
  count: bigint;
}

/** The PrivateCounter sample, its witness handing out the private count from 5. */
function privateCounter(outDir: string): Promise<Profiler<CountState>> {
  return createProfiler({
    name: 'PrivateCounter',
    contract: new PrivateCounter<CountState>({
      nextCount: ({ privateState }) => [
        { count: privateState.count + 1n },
        privateState.count,
      ],
    }),
    privateState: { count: 5n },
    network: 'mainnet',
    outDir: join(root, outDir),
    binary,
  });
}

/** The PrivateCounter sample, its witness bumping the count in the private state it receives. */
function inPlaceCounter<PS extends CountState>(
  outDir: string,
  privateState: PS,
): Promise<Profiler<PS>> {
  return createProfiler({
    name: 'PrivateCounter',
    contract: new PrivateCounter<PS>({
      nextCount: ({ privateState }) => {
        const count = privateState.count;
        privateState.count += 1n;
        return [privateState, count];
      },
    }),
    privateState,
    network: 'mainnet',
    outDir: join(root, outDir),
    binary,
  });
}

function mint(outDir: string): Promise<Profiler<unknown>> {
  return createProfiler({
    name: 'Mint',
    contract: new Mint({}),
    network: 'mainnet',
    outDir: join(root, outDir),
    binary,
    toolchain: { compactc: '0.36.0' },
  });
}

function sameCoin(outDir: string): Promise<Profiler<unknown>> {
  return createProfiler({
    name: 'SameCoin',
    contract: new SameCoin({}),
    network: 'mainnet',
    outDir: join(root, outDir),
    binary,
  });
}

function readTransaction(path: string) {
  return Transaction.deserialize(
    'signature',
    'pre-proof',
    'pre-binding',
    new Uint8Array(readFileSync(path)),
  );
}

/** Every Zswap offer of a transaction, guaranteed first. */
function zswapOffers(tx: ReturnType<typeof readTransaction>) {
  return [
    ...(tx.guaranteedOffer ? [tx.guaranteedOffer] : []),
    ...(tx.fallibleOffer?.values() ?? []),
  ];
}

/** The commitment of `coin`, as a circuit returns it, sent to `coinPublicKey`. */
function commitment(
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
  coinPublicKey: string,
): string {
  return coinCommitment(
    {
      type: Buffer.from(coin.color).toString('hex'),
      nonce: Buffer.from(coin.nonce).toString('hex'),
      value: coin.value,
    },
    coinPublicKey,
  );
}

/** The mint scenarios both determinism runs record. */
async function profileMint(outDir: string): Promise<string> {
  const profiler = await mint(outDir);
  await profiler.scenario('mint to caller', (tx) =>
    tx.call('mint', recipient, 1000n, nonce(0)),
  );
  await profiler.scenario('mint to self', (tx) =>
    tx.call('mintToSelf', 1000n, nonce(0)),
  );
  await profiler.scenario('mint and send', (tx) =>
    tx.call('mintAndSend', recipient, 1000n, nonce(0)),
  );
  await profiler.scenario('mint unshielded', (tx) =>
    tx.call('mintUnshielded', { bytes: nonce(99) }, 1000n),
  );
  await profiler.series('mint multi-call', { sizes: [1, 2, 4] }, (tx, n) => {
    for (let i = 0; i < n; i++) tx.call('mint', recipient, 1000n, nonce(i));
  });
  await profiler.series(
    'mint batch',
    { sizes: [2, 4], ops: (n) => n },
    (tx, n) => tx.call(`mintBatch${n}`, recipient, 1000n, nonces(n)),
  );
  return profiler.write();
}

interface CheckReport {
  parity: unknown[];
  networks: {
    network: string;
    scenarios: {
      name: string;
      calls: number;
      ops: number;
      fits: boolean;
      block: { txsPerBlock: number };
    }[];
    series: { name: string; maxN: number; basis: string; binding: string }[];
  }[];
}

async function check(
  manifest: string,
  snapshot: string,
  update: boolean,
): Promise<CheckReport> {
  const run = await runCheck({
    binary,
    manifest,
    networks: ['mainnet', 'preprod'],
    snapshot,
    update,
    reporter: 'json',
  });
  return JSON.parse(run.stdout) as CheckReport;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/** A manifest without the two size fields that jitter between builds. */
function withoutSizes(manifest: Manifest): unknown {
  return manifest.scenarios.map(({ js, ...entry }) => ({
    ...entry,
    js: {
      declaredNodes: js.declaredNodes,
      cost: { ...js.cost, blockUsage: undefined },
    },
  }));
}

describe('ProfilerOptions', () => {
  it('requires privateState unless undefined is a valid private state', () => {
    expectTypeOf<
      Pick<ProfilerOptions<CountState>, 'privateState'>
    >().toEqualTypeOf<{ privateState: CountState }>();
    expectTypeOf<
      Pick<ProfilerOptions<CountState | undefined>, 'privateState'>
    >().toEqualTypeOf<{ privateState?: CountState | undefined }>();
    expectTypeOf<
      Pick<ProfilerOptions<unknown>, 'privateState'>
    >().toEqualTypeOf<{ privateState?: unknown }>();
  });
});

describe.skipIf(skip !== undefined)(`profiler, end to end${skipReason}`, () => {
  describe('manifest', () => {
    let first: string;

    beforeAll(async () => {
      first = await profileMint('mint-a');
    });

    it('passes update then check with JS and Rust costs at parity', async () => {
      const snapshot = join(root, 'mint-a.snapshot.json');

      const updated = await check(first, snapshot, true);
      const checked = await check(first, snapshot, false);

      expect(updated.parity).toStrictEqual([]);
      expect(checked.parity).toStrictEqual([]);
      expect(
        checked.networks.map((entry) => [
          entry.network,
          entry.scenarios.length,
        ]),
      ).toStrictEqual([
        ['mainnet', 9],
        ['preprod', 9],
      ]);
    });

    it('writes the schema the binary reads', async () => {
      const manifest = readManifest(first);

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.contract).toBe('Mint');
      expect(Object.keys(manifest.toolchain)).toStrictEqual([
        '@midnight-ntwrk/compact-runtime',
        '@midnightntwrk/ledger-v9',
        'compactc',
      ]);
      expect(
        manifest.scenarios.map(({ name, series, n, calls, ops, tx }) => ({
          name,
          series,
          n,
          calls,
          ops,
          tx,
        })),
      ).toEqual([
        {
          name: 'mint to caller',
          calls: 1,
          ops: 1,
          tx: 'txs/mint-to-caller.tx',
        },
        { name: 'mint to self', calls: 1, ops: 1, tx: 'txs/mint-to-self.tx' },
        {
          name: 'mint and send',
          calls: 1,
          ops: 1,
          tx: 'txs/mint-and-send.tx',
        },
        {
          name: 'mint unshielded',
          calls: 1,
          ops: 1,
          tx: 'txs/mint-unshielded.tx',
        },
        {
          name: 'mint multi-call n=1',
          series: 'mint multi-call',
          n: 1,
          calls: 1,
          ops: 1,
          tx: 'txs/mint-multi-call-n-1.tx',
        },
        {
          name: 'mint multi-call n=2',
          series: 'mint multi-call',
          n: 2,
          calls: 2,
          ops: 2,
          tx: 'txs/mint-multi-call-n-2.tx',
        },
        {
          name: 'mint multi-call n=4',
          series: 'mint multi-call',
          n: 4,
          calls: 4,
          ops: 4,
          tx: 'txs/mint-multi-call-n-4.tx',
        },
        {
          name: 'mint batch n=2',
          series: 'mint batch',
          n: 2,
          calls: 1,
          ops: 2,
          tx: 'txs/mint-batch-n-2.tx',
        },
        {
          name: 'mint batch n=4',
          series: 'mint batch',
          n: 4,
          calls: 1,
          ops: 4,
          tx: 'txs/mint-batch-n-4.tx',
        },
      ]);
    });

    it('measures a second run the same, up to the size jitter', async () => {
      const snapshot = join(root, 'mint-b.snapshot.json');
      await check(first, snapshot, true);

      const second = await profileMint('mint-b');

      expect(withoutSizes(readManifest(second))).toStrictEqual(
        withoutSizes(readManifest(first)),
      );
      await expect(check(second, snapshot, false)).resolves.toMatchObject({
        parity: [],
      });
    });
  });

  describe('transaction', () => {
    it('gives each call its own intent at segments 1 to N, in call order', async () => {
      const profiler = await mint('segments');
      const entry = await profiler.scenario('three circuits', (tx) => {
        tx.call('mint', recipient, 1000n, nonce(0));
        tx.call('mintToSelf', 1000n, nonce(1));
        tx.call('mintUnshielded', { bytes: nonce(99) }, 1000n);
      });

      const tx = readTransaction(join(root, 'segments', entry.tx));
      const entryPoints = (segment: number) =>
        tx.intents
          ?.get(segment)
          ?.actions.map((action) =>
            'entryPoint' in action
              ? typeof action.entryPoint === 'string'
                ? action.entryPoint
                : new TextDecoder().decode(action.entryPoint)
              : null,
          );

      expect(
        [...(tx.intents?.keys() ?? [])].sort((a, b) => a - b),
      ).toStrictEqual([1, 2, 3]);
      expect([1, 2, 3].map(entryPoints)).toStrictEqual([
        ['mint'],
        ['mintToSelf'],
        ['mintUnshielded'],
      ]);
    });

    it('counts a Zswap transient as two built-in proofs', async () => {
      const profiler = await mint('transient');
      const entry = await profiler.scenario('mint and send', (tx) =>
        tx.call('mintAndSend', recipient, 1000n, nonce(0)),
      );

      const report = await costTransaction(
        join(root, 'transient', entry.tx),
        'mainnet',
        { binary },
      );

      // One Zswap output and one transient: 1 + 2.
      expect(report.proofTerm).toMatchObject({
        callProofs: 1,
        builtinProofs: 3,
      });
    });

    it('keeps outputs that share type, nonce and value but not recipient', async () => {
      const profiler = await sameCoin('same-coin');
      const other = ZswapSecretKeys.fromSeed(
        new Uint8Array(createHash('sha256').update('other').digest()),
      ).coinPublicKey;
      let coin: Parameters<typeof commitment>[0] | undefined;

      const entry = await profiler.scenario('mint pair', async (tx) => {
        coin = await tx.call(
          'mintPair',
          recipient,
          { bytes: new Uint8Array(Buffer.from(other, 'hex')) },
          1000n,
          nonce(0),
        );
      });
      const path = join(root, 'same-coin', entry.tx);
      const outputs = zswapOffers(readTransaction(path)).flatMap((offer) =>
        offer.outputs.map((output) => output.commitment),
      );
      const report = await costTransaction(path, 'mainnet', { binary });

      expect(outputs.sort()).toStrictEqual(
        [commitment(coin!, caller), commitment(coin!, other)].sort(),
      );
      expect(report.proofTerm.builtinProofs).toBe(2);
    });

    it('spends a coin through its contract-owned output when a user output shares its coin info', async () => {
      const profiler = await sameCoin('same-coin-spent');
      let coin: Parameters<typeof commitment>[0] | undefined;

      const entry = await profiler.scenario(
        'mint pair and send',
        async (tx) => {
          coin = await tx.call('mintPairAndSend', recipient, 1000n, nonce(0));
        },
      );
      const offers = zswapOffers(
        readTransaction(join(root, 'same-coin-spent', entry.tx)),
      );
      const outputs = offers.flatMap((offer) =>
        offer.outputs.map((output) => output.commitment),
      );

      // The user's coin and the coin sent on; the contract's copy is the transient.
      expect(offers.flatMap((offer) => offer.transients)).toHaveLength(1);
      expect(outputs).toHaveLength(2);
      expect(outputs).toContain(commitment(coin!, caller));
    });
  });

  describe('state', () => {
    it('chains the calls of one scenario', async () => {
      const profiler = await counter('chain');

      const entry = await profiler.scenario('increment x5', (tx) => {
        for (let i = 0; i < 5; i++) tx.call('incrementFrom', BigInt(i));
      });

      expect(entry.calls).toBe(5);
    });

    it('fails a scenario whose calls expect another state', async () => {
      const profiler = await counter('unchained');

      await expect(
        profiler.scenario('increment from 0 twice', async (tx) => {
          await tx.call('incrementFrom', 0n);
          await tx.call('incrementFrom', 0n);
        }),
      ).rejects.toThrow('Counter: unexpected count');
    });

    it('starts every scenario from the base state', async () => {
      const profiler = await counter('base');

      await profiler.scenario('first', (tx) => tx.call('incrementFrom', 0n));
      await profiler.scenario('second', (tx) => tx.call('incrementFrom', 0n));

      expect(counterLedger(profiler.contractState).count).toBe(0n);
    });

    it('advances the base state with apply', async () => {
      const profiler = await counter('apply');

      await profiler.apply((tx) => tx.call('incrementFrom', 0n));
      await profiler.scenario('after apply', (tx) =>
        tx.call('incrementFrom', 1n),
      );

      expect(counterLedger(profiler.contractState).count).toBe(1n);
      expect(profiler.scenarios.map((entry) => entry.name)).toStrictEqual([
        'after apply',
      ]);
    });

    it('exposes the state after each awaited call', async () => {
      const profiler = await counter('read');

      await profiler.scenario('read back', async (tx) => {
        await tx.call('increment');
        await tx.call('increment');
        expect(counterLedger(tx.contractState).count).toBe(2n);
      });
    });

    it('threads the private state through the calls of one scenario', async () => {
      const profiler = await privateCounter('private-chain');
      const seen: unknown[] = [];

      await profiler.scenario('record twice', async (tx) => {
        seen.push(await tx.call('record'), tx.privateState);
        seen.push(await tx.call('record'), tx.privateState);
      });

      expect(seen).toStrictEqual([5n, { count: 6n }, 6n, { count: 7n }]);
    });

    it('starts every scenario from the base private state', async () => {
      const profiler = await privateCounter('private-base');
      const seen: unknown[] = [];

      await profiler.scenario('first', async (tx) => {
        seen.push(await tx.call('record'));
      });
      await profiler.scenario('second', async (tx) => {
        seen.push(await tx.call('record'));
      });

      expect(seen).toStrictEqual([5n, 5n]);
      expect(profiler.privateState).toStrictEqual({ count: 5n });
    });

    it('advances the base private state with apply', async () => {
      const profiler = await privateCounter('private-apply');
      const seen: unknown[] = [];

      await profiler.apply((tx) => tx.call('record'));
      await profiler.scenario('after apply', async (tx) => {
        seen.push(await tx.call('record'));
      });

      expect(seen).toStrictEqual([6n]);
      expect(profiler.privateState).toStrictEqual({ count: 6n });
    });

    describe('with a witness that changes its private state in place', () => {
      it('starts every scenario from the base private state', async () => {
        const profiler = await inPlaceCounter('in-place-base', { count: 5n });
        const seen: unknown[] = [];

        await profiler.scenario('first', async (tx) => {
          seen.push(await tx.call('record'), tx.privateState);
        });
        await profiler.scenario('second', async (tx) => {
          seen.push(await tx.call('record'), tx.privateState);
        });

        expect(seen).toStrictEqual([5n, { count: 6n }, 5n, { count: 6n }]);
        expect(profiler.privateState).toStrictEqual({ count: 5n });
      });

      it('leaves the base private state unchanged when a scenario fails after a call', async () => {
        const profiler = await inPlaceCounter('in-place-throw', { count: 5n });

        await expect(
          profiler.scenario('record then fail', async (tx) => {
            await tx.call('record');
            throw new Error('build failed');
          }),
        ).rejects.toThrow('build failed');

        expect(profiler.privateState).toStrictEqual({ count: 5n });
      });

      it('advances the base private state with apply', async () => {
        const profiler = await inPlaceCounter('in-place-apply', { count: 5n });
        const seen: unknown[] = [];

        await profiler.apply((tx) => tx.call('record'));
        await profiler.scenario('after apply', async (tx) => {
          seen.push(await tx.call('record'));
        });

        expect(seen).toStrictEqual([6n]);
        expect(profiler.privateState).toStrictEqual({ count: 6n });
      });
    });

    it('rejects a private state that cannot be structured-cloned', async () => {
      const profiler = await inPlaceCounter('uncloneable', {
        count: 5n,
        onRecord: () => {},
      });

      await expect(
        profiler.scenario('record', (tx) => tx.call('record')),
      ).rejects.toThrow('the private state must be structured-cloneable');
    });

    it('returns a circuit result to an awaiting builder', async () => {
      const profiler = await mint('result');

      await profiler.scenario('mint and read', async (tx) => {
        const coin = await tx.call<{ value: bigint }>(
          'mint',
          recipient,
          1000n,
          nonce(0),
        );
        expect(coin.value).toBe(1000n);
      });
    });

    it('runs a call as another caller', async () => {
      const profiler = await counter('caller');
      const other = createHash('sha256').update('other').digest('hex');

      await expect(
        profiler.scenario('reset as owner', (tx) => tx.call('reset')),
      ).resolves.toMatchObject({ calls: 1 });
      await expect(
        profiler.scenario('reset as other', (tx) =>
          tx.callWith({ caller: other }, 'reset'),
        ),
      ).rejects.toThrow('Counter: caller is not the owner');
    });

    it('rejects a circuit the contract does not have', async () => {
      const profiler = await counter('unknown');

      await expect(
        profiler.scenario('missing', (tx) => tx.call('decrement')),
      ).rejects.toThrow('the contract has no impure circuit decrement');
    });

    it('rejects a scenario name that is already recorded', async () => {
      const profiler = await counter('names');

      await profiler.scenario('once', (tx) => tx.call('increment'));

      await expect(
        profiler.scenario('once', (tx) => tx.call('increment')),
      ).rejects.toThrow('scenario "once" is already recorded');
      await expect(
        profiler.scenario('ONCE', (tx) => tx.call('increment')),
      ).rejects.toThrow('share the file name txs/once.tx');
    });
  });

  describe('capacity', () => {
    it('fits one serial transaction per block', async () => {
      const profiler = await counter('serial');
      await profiler.scenario('increment', (tx) => tx.call('increment'));
      await profiler.scenario(
        'increment serial',
        { conflict: 'serial' },
        (tx) => tx.call('increment'),
      );

      const report = await check(
        await profiler.write(),
        join(root, 'serial.snapshot.json'),
        true,
      );

      const [free, serial] = report.networks[0]!.scenarios;
      expect(free!.block.txsPerBlock).toBeGreaterThan(1);
      expect(serial!.block.txsPerBlock).toBe(1);
    });

    it('finds the largest multi-call that fits the node cap', async () => {
      const profiler = await mint('search');

      const result = await profiler.searchMax(
        'mint multi-call',
        { networks: ['mainnet', 'preprod'] },
        (tx, n) => {
          for (let i = 0; i < n; i++)
            tx.call('mint', recipient, 1000n, nonce(i));
        },
      );
      const report = await check(
        await profiler.write(),
        join(root, 'search.snapshot.json'),
        true,
      );

      expect(result.capped).toBe(false);
      expect(result.binding).toBe('mainnet: nodes');
      expect(result.scenarios.map((entry) => entry.n)).toStrictEqual([
        1,
        2,
        4,
        8,
        result.maxN,
        result.maxN + 1,
      ]);
      expect(report.networks[0]!.series).toMatchObject([
        { maxN: result.maxN, basis: 'measured', binding: 'nodes' },
      ]);
    });

    it('reports 0 when the smallest size does not fit', async () => {
      const profiler = await mint('none');

      const result = await profiler.searchMax(
        'mint fifty per step',
        {},
        (tx, n) => {
          for (let i = 0; i < 50 * n; i++) {
            tx.call('mint', recipient, 1000n, nonce(i));
          }
        },
      );

      expect(result).toMatchObject({
        maxN: 0,
        capped: false,
        binding: 'mainnet: nodes',
      });
      expect(result.scenarios.map((entry) => entry.n)).toStrictEqual([1]);
    });

    it('reports a search that reaches its cap', async () => {
      const profiler = await counter('cap');

      const result = await profiler.searchMax(
        'increment capped',
        { cap: 4 },
        (tx, n) => {
          for (let i = 0; i < n; i++) tx.call('increment');
        },
      );

      expect(result).toMatchObject({ maxN: 4, capped: true, binding: null });
      expect(result.scenarios.map((entry) => entry.n)).toStrictEqual([1, 2, 4]);
    });

    it('rejects a search over no networks', async () => {
      const profiler = await counter('no-networks');
      const build = vi.fn((tx) => tx.call('increment'));

      await expect(
        profiler.searchMax('increment', { networks: [], cap: 2 }, build),
      ).rejects.toThrow('searchMax needs at least one network');
      expect(build).not.toHaveBeenCalled();
      expect(profiler.scenarios).toStrictEqual([]);
    });
  });

  describe('client ledger', () => {
    it('warns once when the client ledger is below a network minimum', async () => {
      const profileFile = join(root, 'minimum-9.9.9.toml');
      writeFileSync(
        profileFile,
        readFileSync(SHIPPED_MAINNET, 'utf8').replace(
          'value = "1.0.2"',
          'value = "9.9.9"',
        ),
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let written: string[] = [];
      try {
        const profiler = await counter('below-minimum', { profileFile });
        await profiler.searchMax('increment', { cap: 1 }, (tx) =>
          tx.call('increment'),
        );
      } finally {
        written = stderr.mock.calls.map(([chunk]) => String(chunk));
        stderr.mockRestore();
      }

      expect(
        written.filter((line) =>
          line.includes("below mainnet's minimum client ledger 9.9.9"),
        ),
      ).toHaveLength(1);
    });
  });
});
