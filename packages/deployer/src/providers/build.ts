import { resolve } from 'node:path';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {
  DEFAULT_CONFIG as LEVEL_DEFAULTS,
  levelPrivateStateProvider,
} from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type {
  MidnightProviders,
  PrivateStateProvider,
} from '@midnight-ntwrk/midnight-js-types';
import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import type { ContractConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { derivePrivateStatePassword } from './private-state-password.ts';

export interface BuildProvidersOptions {
  env: EnvironmentConfiguration;
  wallet: MidnightWalletProvider;
  contractName: string;
  contract: ContractConfig;
  zkConfigPath: string;
  /**
   * Directory `compact.toml` was loaded from. The LevelDB private-state
   * directory is created under it, so the deployed contract's private
   * state stays with the project instead of landing wherever
   * `compact-deploy` was invoked from.
   */
  rootDir: string;
  /** Inject `inMemoryPrivateStateProvider` in tests to avoid LevelDB file-lock contention. */
  privateStateProvider?: PrivateStateProvider;
  /**
   * Secret material for the default LevelDB password (SHA-256 of the wallet
   * seed). Required unless {@link privateStateProvider} is supplied.
   */
  privateStateSecret?: string;
}

export function buildProviders({
  env,
  wallet,
  contractName,
  contract,
  zkConfigPath,
  rootDir,
  privateStateProvider,
  privateStateSecret,
}: BuildProvidersOptions): MidnightProviders {
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

  const resolvedPrivateStateProvider: PrivateStateProvider =
    privateStateProvider ??
    defaultLevelPrivateStateProvider(
      wallet,
      contract,
      contractName,
      rootDir,
      privateStateSecret,
    );

  return {
    privateStateProvider: resolvedPrivateStateProvider,
    publicDataProvider: indexerPublicDataProvider(env.indexer, env.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(env.proofServer, zkConfigProvider),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
}

function defaultLevelPrivateStateProvider(
  wallet: MidnightWalletProvider,
  contract: ContractConfig,
  contractName: string,
  rootDir: string,
  privateStateSecret: string | undefined,
): PrivateStateProvider {
  if (!privateStateSecret) {
    // Reached only with an injected wallet and no injected provider. There is
    // no seed to derive from, and falling back to wallet public-key material
    // would leave the private-state DB readable by anyone holding the address.
    throw new ConfigError(
      'Cannot derive a private-state DB password without a deployer seed. Pass `privateStateProvider` alongside `walletProvider`.',
    );
  }
  const password = derivePrivateStatePassword(privateStateSecret);
  return levelPrivateStateProvider({
    // `midnightDbName` is handed straight to `new Level(location)`, so it
    // is a filesystem path, not a logical name: left at the bare default
    // the DB materialises in the shell's CWD and a deploy run from a
    // subdirectory silently starts from an empty private state. There is
    // no separate path option, so anchor the default name on rootDir.
    midnightDbName: resolve(rootDir, LEVEL_DEFAULTS.midnightDbName),
    privateStateStoreName:
      contract.private_state_store_name ?? `${contractName}-private-state`,
    accountId: wallet.getCoinPublicKey(),
    privateStoragePasswordProvider: () => password,
  });
}
