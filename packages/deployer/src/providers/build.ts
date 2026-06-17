import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
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
import { derivePrivateStatePassword } from './private-state-password.ts';

export interface BuildProvidersOptions {
  env: EnvironmentConfiguration;
  wallet: MidnightWalletProvider;
  contractName: string;
  contract: ContractConfig;
  zkConfigPath: string;
  /** Inject `inMemoryPrivateStateProvider` in tests to avoid LevelDB file-lock contention. */
  privateStateProvider?: PrivateStateProvider;
}

export function buildProviders({
  env,
  wallet,
  contractName,
  contract,
  zkConfigPath,
  privateStateProvider,
}: BuildProvidersOptions): MidnightProviders {
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

  const resolvedPrivateStateProvider: PrivateStateProvider =
    privateStateProvider ??
    defaultLevelPrivateStateProvider(wallet, contract, contractName);

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
): PrivateStateProvider {
  const password = derivePrivateStatePassword(wallet.getEncryptionPublicKey());
  return levelPrivateStateProvider({
    privateStateStoreName:
      contract.private_state_store_name ?? `${contractName}-private-state`,
    accountId: wallet.getCoinPublicKey(),
    privateStoragePasswordProvider: () => password,
  });
}
