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

/**
 * Assemble the six-provider bundle midnight-js expects: private state,
 * public data (indexer), zk-config, proof, wallet, and midnight (which
 * the wallet provider doubles as).
 *
 * Notes:
 *  - The private-state store name defaults to `<contract>-private-state`
 *    so multiple contracts in one project don't collide on LevelDB keys.
 *  - The encryption password for private state is *derived* from the
 *    wallet's encryption public key (see {@link derivePrivateStatePassword})
 *    so it ties to the wallet identity without surfacing a separate secret.
 *  - ZK config comes from on-disk artifacts via `NodeZkConfigProvider`,
 *    not from an HTTP fetch — the artifact bundle already contains the
 *    proving/verifying keys.
 */
export interface BuildProvidersOptions {
  env: EnvironmentConfiguration;
  wallet: MidnightWalletProvider;
  contractName: string;
  contract: ContractConfig;
  zkConfigPath: string;
}

export function buildProviders({
  env,
  wallet,
  contractName,
  contract,
  zkConfigPath,
}: BuildProvidersOptions): MidnightProviders {
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

  const password = derivePrivateStatePassword(wallet.getEncryptionPublicKey());
  const privateStateProvider: PrivateStateProvider = levelPrivateStateProvider({
    privateStateStoreName:
      contract.private_state_store_name ?? `${contractName}-private-state`,
    accountId: wallet.getCoinPublicKey(),
    privateStoragePasswordProvider: () => password,
  });

  return {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider(env.indexer, env.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(env.proofServer, zkConfigProvider),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
}
