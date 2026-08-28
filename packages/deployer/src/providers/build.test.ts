import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { derivePrivateStatePassword } from './private-state-password.ts';

vi.mock('@midnight-ntwrk/midnight-js-http-client-proof-provider', () => ({
  httpClientProofProvider: vi.fn((url: string) => ({ kind: 'proof', url })),
}));

vi.mock('@midnight-ntwrk/midnight-js-indexer-public-data-provider', () => ({
  indexerPublicDataProvider: vi.fn((indexer: string, ws: string) => ({
    kind: 'public',
    indexer,
    ws,
  })),
}));

vi.mock('@midnight-ntwrk/midnight-js-level-private-state-provider', () => ({
  levelPrivateStateProvider: vi.fn(
    (opts: { privateStateStoreName: string; accountId: string }) => ({
      kind: 'private',
      storeName: opts.privateStateStoreName,
      accountId: opts.accountId,
    }),
  ),
}));

vi.mock('@midnight-ntwrk/midnight-js-node-zk-config-provider', () => ({
  NodeZkConfigProvider: vi.fn(function NodeZkConfigProvider(
    this: { kind: string; path: string },
    path: string,
  ) {
    this.kind = 'zk';
    this.path = path;
  }),
}));

const { buildProviders } = await import('./build.ts');
const { httpClientProofProvider } = await import(
  '@midnight-ntwrk/midnight-js-http-client-proof-provider'
);
const { indexerPublicDataProvider } = await import(
  '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
);
const { levelPrivateStateProvider } = await import(
  '@midnight-ntwrk/midnight-js-level-private-state-provider'
);
const { NodeZkConfigProvider } = await import(
  '@midnight-ntwrk/midnight-js-node-zk-config-provider'
);

const env: EnvironmentConfiguration = {
  walletNetworkId: 'testnet',
  networkId: 'testnet',
  indexer: 'https://indexer.example/api',
  indexerWS: 'wss://indexer.example/ws',
  node: 'https://node.example',
  nodeWS: 'wss://node.example/ws',
  proofServer: 'http://proof:6300',
} as EnvironmentConfiguration;

const wallet = {
  getEncryptionPublicKey: vi.fn(() => 'enc-pubkey-abc'),
  getCoinPublicKey: vi.fn(() => 'coin-pubkey-def'),
} as unknown as MidnightWalletProvider;

/** Stand-in for SHA-256 of a resolved seed; only its secrecy matters. */
const SECRET = 'a1'.repeat(32);

const baseContract: ContractConfig = {
  artifact: 'src/artifacts/Counter',
  signing_key_file: 'keys/counter.signing',
};

describe('buildProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should default the private-state store name to <contract>-private-state', () => {
    buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    const opts = vi.mocked(levelPrivateStateProvider).mock.calls[0]?.[0];
    expect(opts?.privateStateStoreName).toBe('Counter-private-state');
  });

  it('should honor a contract-provided private_state_store_name', () => {
    buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: { ...baseContract, private_state_store_name: 'custom-store' },
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    const opts = vi.mocked(levelPrivateStateProvider).mock.calls[0]?.[0];
    expect(opts?.privateStateStoreName).toBe('custom-store');
  });

  it('should bind the private-state account to the wallet coin pubkey', () => {
    buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    const opts = vi.mocked(levelPrivateStateProvider).mock.calls[0]?.[0];
    expect(opts?.accountId).toBe('coin-pubkey-def');
  });

  it('should derive the private-state password from the secret, never the wallet encryption pubkey', async () => {
    buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    expect(wallet.getEncryptionPublicKey).not.toHaveBeenCalled();

    const opts = vi.mocked(levelPrivateStateProvider).mock.calls[0]?.[0] as {
      privateStoragePasswordProvider: () => string | Promise<string>;
    };
    expect(await opts.privateStoragePasswordProvider()).toBe(
      derivePrivateStatePassword(SECRET),
    );
  });

  it('should reject an injected wallet with neither a secret nor a privateStateProvider', () => {
    expect(() =>
      buildProviders({
        env,
        wallet,
        contractName: 'Counter',
        contract: baseContract,
        zkConfigPath: '/artifacts/Counter',
      }),
    ).toThrow(ConfigError);
    expect(levelPrivateStateProvider).not.toHaveBeenCalled();
  });

  it('should expose a privateStoragePasswordProvider that returns the derived password', async () => {
    buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    const opts = vi.mocked(levelPrivateStateProvider).mock.calls[0]?.[0] as {
      privateStoragePasswordProvider: () => string | Promise<string>;
    };
    const pw = await opts.privateStoragePasswordProvider();
    expect(typeof pw).toBe('string');
    expect(pw.length).toBeGreaterThan(0);
  });

  it('should construct NodeZkConfigProvider with the zkConfigPath', () => {
    buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    expect(NodeZkConfigProvider).toHaveBeenCalledWith('/artifacts/Counter');
  });

  it('should wire the indexer URLs into the public data provider', () => {
    buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    expect(indexerPublicDataProvider).toHaveBeenCalledWith(
      env.indexer,
      env.indexerWS,
    );
  });

  it('should wire the proof-server URL into the HTTP proof provider', () => {
    buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    const firstArg = vi.mocked(httpClientProofProvider).mock.calls[0]?.[0];
    expect(firstArg).toBe(env.proofServer);
  });

  it('should expose wallet as both walletProvider and midnightProvider', () => {
    const providers = buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    expect(providers.walletProvider).toBe(wallet);
    expect(providers.midnightProvider).toBe(wallet);
  });

  it('should pass through an injected privateStateProvider and skip the LevelDB construction', () => {
    const injected = {
      __injected: true,
    } as unknown as Parameters<
      typeof buildProviders
    >[0]['privateStateProvider'];

    const providers = buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateProvider: injected,
    });

    expect(providers.privateStateProvider).toBe(injected);
    expect(levelPrivateStateProvider).not.toHaveBeenCalled();
    expect(wallet.getEncryptionPublicKey).not.toHaveBeenCalled();
  });

  it('should return all six provider slots', () => {
    const providers = buildProviders({
      env,
      wallet,
      contractName: 'Counter',
      contract: baseContract,
      zkConfigPath: '/artifacts/Counter',
      privateStateSecret: SECRET,
    });

    expect(Object.keys(providers).sort()).toEqual(
      [
        'privateStateProvider',
        'publicDataProvider',
        'zkConfigProvider',
        'proofProvider',
        'walletProvider',
        'midnightProvider',
      ].sort(),
    );
  });
});
