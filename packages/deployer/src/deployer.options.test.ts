import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitTxAsync } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import {
  type MaintenanceUpdate,
  signatureVerifyingKey,
  type VerifierKeyInsert,
} from '@midnightntwrk/ledger-v9';
import * as Rx from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeProviders,
  type Fixture,
  fakeFinalized,
  fakeProviders,
  fakeUnsubmittedDeploy,
  fakeVerifierKeys,
  headPath,
  recordingLogger,
  silentLogger,
} from './deployer.testkit.ts';
import { Deployer, type DeployerOptions } from './deployer.ts';
import { Deployments } from './deployments.ts';
import {
  BlockLimitError,
  ConfigError,
  DeployTxFailedError,
  FragmentDeployError,
} from './errors.ts';
import { Artifact } from './loaders/artifact.ts';
import { buildProviders } from './providers/build.ts';
import { ProofServer } from './providers/proof-server.ts';
import { submitDeploy } from './services/deploy-tx.ts';
import { buildInsertUpdate } from './services/maintenance-tx.ts';

vi.mock('./loaders/artifact.ts', () => ({
  Artifact: { load: vi.fn() },
}));

vi.mock('./providers/proof-server.ts', () => ({
  ProofServer: {
    start: vi.fn(async () => ({
      url: 'http://localhost:6300',
      [Symbol.asyncDispose]: async () => undefined,
    })),
  },
}));

vi.mock('./providers/build.ts', () => ({ buildProviders: vi.fn() }));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  createUnprovenDeployTx: vi.fn(),
  submitTxAsync: vi.fn(),
  verifierKeysEqual: (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]),
}));

// Real, spied so the fake insert can read which circuits the update carries.
vi.mock('./services/maintenance-tx.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./services/maintenance-tx.ts')>();
  return { ...actual, buildInsertUpdate: vi.fn(actual.buildInsertUpdate) };
});

vi.mock('./services/deploy-tx.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./services/deploy-tx.ts')>();
  return { ...actual, submitDeploy: vi.fn(actual.submitDeploy) };
});

vi.mock('@midnight-ntwrk/midnight-js-network-id', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@midnight-ntwrk/midnight-js-network-id')
    >();
  return { ...actual, getNetworkId: vi.fn(() => 'undeployed') };
});

const CIRCUITS = ['approve', 'burn', 'charge', 'deposit', 'evict'];

/** The ledger parses a contract address as hex, so the fake one has to be. */
const ADDRESS = 'cd'.repeat(32);

const SIGNING_KEY = 'aa'.repeat(32);
const VERIFYING_KEY = signatureVerifyingKey({
  tag: 'schnorr',
  value: SIGNING_KEY,
});

/** A real compiler-emitted key: the ledger checks its header on every insert. */
const VERIFIER_KEY = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL(
        './services/fixtures/counter-increment.verifier',
        import.meta.url,
      ),
    ),
  ),
);

const BLOCK_LIMIT_TEXT =
  '1010: Invalid Transaction: Transaction would exhaust the block limits';

const LEDGER_METHODS = [
  'getHead',
  'assertRecordable',
  'record',
  'confirm',
  'updatePartial',
] as const;

const NETWORK_LINES = `network_id = "undeployed"
indexer = "http://localhost:8088/api/v1/graphql"
indexer_ws = "ws://localhost:8088/api/v1/graphql/ws"
node = "http://localhost:9944"
node_ws = "ws://localhost:9944"
proof_server = "http://localhost:6300"`;

/** A project with two networks, `local` and `other`, and one `Counter` entry. */
function writeProject(contractLines = ''): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'deployer-options-'));
  writeFileSync(
    join(rootDir, 'compact.toml'),
    `
[profile]
artifacts_dir = "artifacts"
deployments_dir = "deployments"

[networks.local]
${NETWORK_LINES}

[networks.other]
${NETWORK_LINES}

[contracts.Counter]
artifact = "Counter"
signing_key_file = "signing-key.hex"
${contractLines}
`,
  );
  writeFileSync(join(rootDir, 'signing-key.hex'), `${SIGNING_KEY}\n`);
  writeFileSync(join(rootDir, 'state.json'), '{"source":"toml"}');
  return {
    rootDir,
    configPath: join(rootDir, 'compact.toml'),
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

/** Ledger-shaped contract state over the fake chain's circuits. */
function chainState(circuits: readonly string[], counter: bigint) {
  return {
    operations: () => [...circuits],
    operation: (name: string) =>
      circuits.includes(name) ? { verifierKey: VERIFIER_KEY } : undefined,
    maintenanceAuthority: {
      committee: [VERIFYING_KEY],
      threshold: 1,
      counter,
    },
  };
}

/** The dust indices `readDustTip` and `awaitDustSettled` read. */
interface DustView {
  tip: bigint;
  applied: bigint;
}

function injectedWallet(dust: DustView): MidnightWalletProvider {
  return {
    getCoinPublicKey: () => '0xDEPLOYER',
    wallet: {
      state: () =>
        Rx.of({
          dust: {
            state: {
              progress: {
                highestRelevantWalletIndex: dust.tip,
                appliedIndex: dust.applied,
              },
            },
          },
          pending: { all: [] },
        }),
    },
  } as unknown as MidnightWalletProvider;
}

/** Circuit ids of the update just built, read off the signed update. */
function lastInsertedCircuits(): string[] {
  const results = vi.mocked(buildInsertUpdate).mock.results;
  const update = results[results.length - 1]?.value as MaintenanceUpdate;
  return update.updates.map(
    (single) => (single as VerifierKeyInsert).operation as string,
  );
}

let artifactCount = 0;

/** Remembered sizes outlive a test, so each test deploys its own artifact. */
function freshArtifactPath(): string {
  artifactCount += 1;
  return `/fake/artifact-${artifactCount}`;
}

describe('Deployer options', () => {
  let fx: Fixture;
  let providers: FakeProviders;
  /** Circuits the fake chain reports, mutated as transactions land. */
  let onChain: string[];
  /** Landed maintenance updates, which is exactly the on-chain CMA counter. */
  let landedInserts: number;
  let dust: DustView;
  /** Largest deploy tx the fake node admits, in circuits. */
  let deployLimit: number;
  /** Largest insert the fake node admits, in circuits. */
  let insertLimit: number;
  let artifactPath: string;
  let circuits: readonly string[];
  /** Circuits per deploy tx submission, refused ones included. */
  let deploySizes: number[];
  /** Circuits per insert submission, refused ones included. */
  let insertSizes: number[];

  function spendDust(): void {
    dust.tip += 1n;
    dust.applied = dust.tip;
  }

  /** Every fake deploy lands at one address, so a later deploy needs a clean chain. */
  function resetChain(): void {
    onChain = [];
    landedInserts = 0;
  }

  beforeEach(() => {
    fx = writeProject();
    resetChain();
    dust = { tip: 0n, applied: 0n };
    deployLimit = Number.POSITIVE_INFINITY;
    insertLimit = Number.POSITIVE_INFINITY;
    artifactPath = freshArtifactPath();
    circuits = CIRCUITS;
    deploySizes = [];
    insertSizes = [];
    providers = fakeProviders();
    providers.publicDataProvider.queryContractState = vi.fn(async () =>
      chainState(onChain, BigInt(landedInserts)),
    );
    vi.mocked(buildProviders).mockImplementation(() => providers as never);
    vi.mocked(Artifact.load).mockImplementation(
      async () =>
        ({
          artifactPath,
          zkConfigPath: artifactPath,
          compiledContract: { fake: 'compiled' },
          circuitNames: circuits,
          verifierKeys: fakeVerifierKeys(circuits, VERIFIER_KEY),
        }) as never,
    );
    // The constructor leaves private state as given, so the fake echoes it.
    vi.mocked(submitDeploy).mockImplementation(
      async ({ circuits: batch, initialPrivateState }) => {
        deploySizes.push(batch.length);
        if (batch.length > deployLimit) {
          throw new BlockLimitError(BLOCK_LIMIT_TEXT);
        }
        onChain.push(...batch);
        spendDust();
        const unsubmitted = fakeUnsubmittedDeploy(ADDRESS);
        return {
          address: ADDRESS,
          txId: '0xTX',
          unsubmitted: {
            ...unsubmitted,
            private: { ...unsubmitted.private, initialPrivateState },
          },
        } as never;
      },
    );
    vi.mocked(submitTxAsync).mockImplementation(async () => {
      const batch = lastInsertedCircuits();
      insertSizes.push(batch.length);
      if (batch.length > insertLimit) throw new Error(BLOCK_LIMIT_TEXT);
      onChain.push(...batch);
      landedInserts += 1;
      spendDust();
      return `0xINSERT${landedInserts}`;
    });
  });

  afterEach(() => {
    fx.cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function prepare(opts: Partial<DeployerOptions> = {}): Promise<Deployer> {
    return Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: silentLogger,
      walletProvider: injectedWallet(dust),
      // Short enough that a stuck wait fails the test instead of hanging it.
      txTimeoutMs: 200,
      ...opts,
    });
  }

  async function deploy(opts: Partial<DeployerOptions> = {}) {
    await using deployer = await prepare(opts);
    return deployer.deploy();
  }

  function useProject(contractLines: string): void {
    fx.cleanup();
    fx = writeProject(contractLines);
  }

  describe('record: false', () => {
    function spyOnLedger() {
      return LEDGER_METHODS.map((method) =>
        vi.spyOn(Deployments.prototype, method),
      );
    }

    it('should deploy a single-tx contract without touching the ledger', async () => {
      circuits = ['approve'];
      const ledger = spyOnLedger();

      const result = await deploy({ record: false });

      expect(result.fragments).toBe(1);
      expect(result.circuits).toBe(1);
      expect(result.deploymentsFile).toBe('');
      for (const spy of ledger) expect(spy).not.toHaveBeenCalled();
      expect(existsSync(join(fx.rootDir, 'deployments'))).toBe(false);
    });

    it('should deploy a split contract without touching the ledger', async () => {
      const ledger = spyOnLedger();

      const result = await deploy({ record: false, circuitsPerTx: 2 });

      expect(deploySizes).toStrictEqual([2]);
      expect(insertSizes).toStrictEqual([2, 1]);
      expect(result.fragments).toBe(3);
      expect(result.circuits).toBe(5);
      expect(result.deploymentsFile).toBe('');
      for (const spy of ledger) expect(spy).not.toHaveBeenCalled();
      expect(existsSync(join(fx.rootDir, 'deployments'))).toBe(false);
    });

    it.each(['pending', 'partial'])(
      'should deploy fresh over a %s head it never reads',
      async (status) => {
        mkdirSync(join(fx.rootDir, 'deployments'));
        const head = JSON.stringify({
          Counter: {
            status,
            address: ADDRESS,
            txId: '0xOLD',
            deployer: '0xDEPLOYER',
            artifact: 'Counter',
            circuitsOnChain: ['approve', 'burn'],
            circuitsPending: ['charge', 'deposit', 'evict'],
            submittedAt: '2026-09-01T00:00:00.000Z',
          },
        });
        writeFileSync(headPath(fx.rootDir), head);

        const result = await deploy({ record: false, circuitsPerTx: 2 });

        expect(submitDeploy).toHaveBeenCalledTimes(1);
        expect(result.txId).toBe('0xTX');
        expect(readFileSync(headPath(fx.rootDir), 'utf8')).toBe(head);
        expect(readdirSync(join(fx.rootDir, 'deployments'))).toStrictEqual([
          'local.json',
        ]);
      },
    );

    describe('failure messages', () => {
      /** What a message must not point at when no record exists. */
      const RECORD_HINTS = /record|resum|--force/i;

      it('should name the address and txId of a single deploy tx that times out', async () => {
        circuits = ['approve'];
        providers.publicDataProvider.watchForTxData.mockImplementation(
          () => new Promise(() => {}),
        );

        const thrown = await deploy({ record: false }).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(DeployTxFailedError);
        expect((thrown as Error).message).toBe(
          `Deploy of "Counter" was submitted but not confirmed: no finalization within 200 ms. address ${ADDRESS}, txId 0xTX.`,
        );
      });

      it('should name the circuit lists of a split deploy tx that times out', async () => {
        providers.publicDataProvider.watchForTxData.mockImplementation(
          () => new Promise(() => {}),
        );

        const thrown = await deploy({ record: false, circuitsPerTx: 2 }).catch(
          (e: unknown) => e,
        );

        expect(thrown).toBeInstanceOf(DeployTxFailedError);
        const { message } = thrown as Error;
        expect(message).toContain(`address ${ADDRESS}, txId 0xTX.`);
        expect(message).toContain(
          'In the deploy tx: approve, burn. Not yet inserted: charge, deposit, evict.',
        );
        expect(message).not.toMatch(RECORD_HINTS);
      });

      it('should name the deploy tx and both circuit lists when an insert fails', async () => {
        vi.mocked(submitTxAsync).mockRejectedValue(new Error('out of dust'));

        const thrown = await deploy({ record: false, circuitsPerTx: 2 }).catch(
          (e: unknown) => e,
        );

        expect(thrown).toBeInstanceOf(FragmentDeployError);
        const error = thrown as FragmentDeployError;
        expect(error.exitCode).toBe(8);
        expect(error.address).toBe(ADDRESS);
        expect(error.deployTxId).toBe('0xTX');
        expect(error.circuitsOnChain).toStrictEqual(['approve', 'burn']);
        expect(error.circuitsPending).toStrictEqual([
          'charge',
          'deposit',
          'evict',
        ]);
        expect(error.message).toContain('out of dust');
        expect(error.message).toContain('Deploy txId 0xTX.');
        expect(error.message).not.toMatch(RECORD_HINTS);
        expect(error.cause).toBeInstanceOf(Error);
      });

      it('should name the failed insert and the deploy tx when an insert times out', async () => {
        providers.publicDataProvider.watchForTxData.mockImplementation(
          async (txId: string) =>
            txId === '0xTX' ? fakeFinalized() : new Promise(() => {}),
        );

        const thrown = await deploy({ record: false, circuitsPerTx: 2 }).catch(
          (e: unknown) => e,
        );

        expect(thrown).toBeInstanceOf(FragmentDeployError);
        const error = thrown as FragmentDeployError;
        expect(error.txId).toBe('0xINSERT1');
        expect(error.timedOut).toBe(true);
        expect(error.message).toContain(
          'Failed insert txId 0xINSERT1. Deploy txId 0xTX.',
        );
        expect(error.message).not.toMatch(RECORD_HINTS);
      });

      it('should leave --force out of a committee refusal', async () => {
        providers.publicDataProvider.queryContractState = vi.fn(async () => ({
          ...chainState(onChain, BigInt(landedInserts)),
          maintenanceAuthority: {
            committee: [{ tag: 'schnorr', value: 'someone-else' }],
            threshold: 1,
            counter: 0n,
          },
        }));

        const thrown = await deploy({ record: false, circuitsPerTx: 2 }).catch(
          (e: unknown) => e,
        );

        expect(thrown).toBeInstanceOf(ConfigError);
        expect((thrown as Error).message).toBe(
          `Contract ${ADDRESS} is not maintained by this signing key. Check signing_key_file.`,
        );
      });
    });
  });

  describe('in-code values', () => {
    const TOML_SOURCES = `private_state_id = "counter-state"
init_private_state = { file = "state.json" }
witnesses = { module = "witnesses.mjs", export = "witnesses" }`;

    beforeEach(() => {
      circuits = ['approve'];
    });

    it('should deploy with the in-code initialPrivateState over the TOML one', async () => {
      useProject(TOML_SOURCES);
      const state = { source: 'code' };

      await deploy({ initialPrivateState: state });

      expect(
        vi.mocked(submitDeploy).mock.calls[0]?.[0].initialPrivateState,
      ).toBe(state);
      expect(providers.privateStateProvider.set).toHaveBeenCalledWith(
        'counter-state',
        state,
      );
    });

    it('should deploy with the TOML init_private_state when no in-code value is given', async () => {
      useProject(TOML_SOURCES);

      await deploy();

      expect(
        vi.mocked(submitDeploy).mock.calls[0]?.[0].initialPrivateState,
      ).toStrictEqual({ source: 'toml' });
    });

    it('should hand the in-code witnesses to Artifact.load', async () => {
      useProject(TOML_SOURCES);
      const witnesses = { secret: () => [undefined, 1n] };

      await deploy({ witnesses });

      expect(Artifact.load).toHaveBeenCalledWith(
        expect.objectContaining({ witnessImpls: witnesses }),
      );
    });

    it('should take the initial private state from code alone', async () => {
      useProject('private_state_id = "counter-state"');
      const state = { source: 'code' };

      await deploy({ initialPrivateState: state });

      expect(providers.privateStateProvider.set).toHaveBeenCalledWith(
        'counter-state',
        state,
      );
    });

    it('should refuse a private_state_id with no initial private state before starting the proof server', async () => {
      useProject('private_state_id = "counter-state"');

      const thrown = await prepare().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toContain(
        '"Counter" sets private_state_id but no init_private_state',
      );
      expect(ProofServer.start).not.toHaveBeenCalled();
    });

    it('should refuse an in-code initialPrivateState with no private_state_id before starting the proof server', async () => {
      const thrown = await prepare({
        initialPrivateState: { source: 'code' },
      }).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toBe(
        'initialPrivateState needs private_state_id, which "Counter" does not set.',
      );
      expect(ProofServer.start).not.toHaveBeenCalled();
    });
  });

  describe('remembered fragment size', () => {
    const STARTS_AT = 'Deploy tx starts at';

    beforeEach(() => {
      deployLimit = 2;
    });

    /** Deploy, then give the next deploy an empty chain. */
    async function deployThenReset(opts: Partial<DeployerOptions> = {}) {
      await deploy(opts);
      resetChain();
    }

    function startsAtLines(info: ReturnType<typeof recordingLogger>['info']) {
      return info.mock.calls.filter(
        ([message]) =>
          typeof message === 'string' && message.startsWith(STARTS_AT),
      );
    }

    it('should start a later deploy of the same artifact at the size halving found', async () => {
      const first = recordingLogger();
      await deployThenReset({ logger: first.logger });
      const second = recordingLogger();

      await deploy({ logger: second.logger });

      expect(deploySizes).toStrictEqual([5, 2, 2]);
      expect(startsAtLines(first.info)).toStrictEqual([]);
      expect(startsAtLines(second.info)).toStrictEqual([
        [
          `${STARTS_AT} 2 circuits per tx, the size an earlier deploy of this artifact settled on`,
        ],
      ]);
    });

    it('should remember the smaller size an insert settled on', async () => {
      insertLimit = 1;
      await deployThenReset();

      await deploy();

      // 5 refused, then 2 landed. The inserts halved to 1, where the second
      // deploy starts.
      expect(deploySizes).toStrictEqual([5, 2, 1]);
    });

    it('should keep a pinned budget over the remembered size', async () => {
      await deployThenReset();
      deployLimit = 5;
      const { logger, info } = recordingLogger();

      await deploy({ circuitsPerTx: 3, logger });

      expect(deploySizes).toStrictEqual([5, 2, 3]);
      expect(startsAtLines(info)).toStrictEqual([]);
    });

    it('should plan a resume from the chain, never from the remembered size', async () => {
      await deployThenReset();
      onChain = ['approve', 'burn'];
      writeFileSync(
        headPath(fx.rootDir),
        JSON.stringify({
          Counter: {
            status: 'partial',
            address: ADDRESS,
            txId: '0xTX',
            deployer: '0xDEPLOYER',
            artifact: 'Counter',
            circuitsOnChain: ['approve', 'burn'],
            circuitsPending: ['charge', 'deposit', 'evict'],
            submittedAt: '2026-09-01T00:00:00.000Z',
            txHash: '0xHASH',
            blockHeight: 1234,
          },
        }),
      );
      insertSizes = [];

      const result = await deploy();

      expect(deploySizes).toStrictEqual([5, 2]);
      expect(insertSizes).toStrictEqual([3]);
      expect(result.circuits).toBe(5);
    });

    it('should not share a remembered size with another artifact', async () => {
      await deployThenReset();
      artifactPath = freshArtifactPath();

      await deploy();

      expect(deploySizes).toStrictEqual([5, 2, 5, 2]);
    });

    it('should not share a remembered size with another network', async () => {
      await deployThenReset();

      await deploy({ network: 'other' });

      expect(deploySizes).toStrictEqual([5, 2, 5, 2]);
    });
  });
});
