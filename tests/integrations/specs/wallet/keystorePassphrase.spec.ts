import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Deployer,
  Keystore,
  WalletError,
} from '@openzeppelin/compact-deployer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { harnessPrivateStateProvider } from '../../_harness/deployer.ts';
import { testLogger } from '../../_harness/logger.ts';
import {
  localNetworkConfig,
  setupLocalNetwork,
} from '../../_harness/network.ts';

/**
 * Spec: the `[wallet].keystore` path in `compact.toml` resolves the
 * deployer seed via an encrypted JSON keystore. `Deployer.prepare`
 * invokes the user-supplied `promptPassphrase` callback exactly once
 * with the keystore's absolute path; the decrypted seed builds the
 * wallet just like a `--seed-file` would.
 *
 * Every other integration spec injects `walletProvider` and skips
 * `resolveSeed` — this is the only spec that exercises the
 * keystore-resolution path end-to-end against the live stack.
 */
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const INTEGRATION_DIR = resolve(HARNESS_DIR, '..', '..');
const FIXTURES_ARTIFACTS = resolve(INTEGRATION_DIR, 'fixtures/artifacts');
const FIXTURES_SIGNING_KEY = resolve(
  INTEGRATION_DIR,
  'fixtures/signingkeys/Counter.signingkey',
);

// ALICE's prefunded seed — picked so the wallet built from the keystore
// has the dev-preset's genesis balance and can submit a deploy.
const ALICE_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';
const PASSPHRASE = 'hunter2-keystore-spec';
// Scrypt parameters relaxed for test speed; the real CLI uses defaults
// (~1s derivation). Matches the convention from
// `wallet/keystore.test.ts`.
const FAST_SCRYPT = { scryptN: 1024, scryptR: 8, scryptP: 1, dklen: 32 };

describe('compact-deploy — [wallet].keystore resolves via promptPassphrase', () => {
  let tmpRoot: string;
  let tomlPath: string;
  let keystorePath: string;

  beforeAll(() => {
    setupLocalNetwork();
    tmpRoot = mkdtempSync(join(tmpdir(), 'keystore-spec-'));
    keystorePath = join(tmpRoot, 'wallet.keystore.json');

    const ks = Keystore.encrypt(ALICE_SEED, PASSPHRASE, FAST_SCRYPT);
    writeFileSync(keystorePath, JSON.stringify(ks.toJSON()));

    const net = localNetworkConfig();
    tomlPath = join(tmpRoot, 'compact.toml');
    writeFileSync(
      tomlPath,
      [
        '[profile]',
        'default_network = "local"',
        `artifacts_dir   = "${FIXTURES_ARTIFACTS}"`,
        `deployments_dir = "${join(tmpRoot, 'deployments')}"`,
        '',
        '[networks.local]',
        'network_id   = "undeployed"',
        `indexer      = "${net.indexer}"`,
        `indexer_ws   = "${net.indexerWS}"`,
        `node         = "${net.node}"`,
        `node_ws      = "${net.nodeWS}"`,
        `proof_server = "${net.proofServer}"`,
        'faucet       = false',
        '',
        '[wallet]',
        'keystore = "wallet.keystore.json"',
        '',
        '[contracts.Counter]',
        'artifact         = "Counter"',
        `signing_key_file = "${FIXTURES_SIGNING_KEY}"`,
        '',
      ].join('\n'),
    );
  });

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('should invoke promptPassphrase with the absolute keystore path', async () => {
    const promptPassphrase = vi.fn(async () => PASSPHRASE);

    await using deployer = await Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: tomlPath,
      logger: testLogger(),
      promptPassphrase,
      privateStateProvider: harnessPrivateStateProvider(),
    });

    expect(deployer.contractName).toBe('Counter');
    expect(promptPassphrase).toHaveBeenCalledOnce();
    expect(promptPassphrase).toHaveBeenCalledWith(keystorePath);
  }, 240_000);

  it('should reject when the keystore is configured but no promptPassphrase is provided', async () => {
    await expect(
      Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: tomlPath,
        logger: testLogger(),
      }),
    ).rejects.toThrow(WalletError);
  }, 60_000);

  it('should reject when the passphrase is wrong (MAC mismatch)', async () => {
    await expect(
      Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: tomlPath,
        logger: testLogger(),
        promptPassphrase: async () => 'definitely-not-the-passphrase',
      }),
    ).rejects.toThrow(/MAC mismatch/);
  }, 60_000);
});
