import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import type { NetworkConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';

/**
 * Apply the chosen network to the global midnight-js network-id singleton
 * and assemble an `EnvironmentConfiguration` for testkit-js.
 *
 * `setNetworkId` is a module-level side effect required by midnight-js
 * before any wallet/tx code runs — calling it from one well-known spot
 * keeps the lifecycle obvious. The accepted set of `network_id` values is
 * intentionally closed: we'd rather fail fast on a typo than silently
 * accept an unknown id and let midnight-js produce a generic error later.
 */

const KNOWN_NETWORK_IDS: ReadonlySet<string> = new Set([
  'undeployed',
  'devnet',
  'qanet',
  'testnet',
  'preview',
  'preprod',
  'mainnet',
]);

export interface ResolvedEnvironment {
  env: EnvironmentConfiguration;
  faucetUrl: string | undefined;
}

export function applyNetwork(
  network: NetworkConfig,
  proofServerUrl: string,
): ResolvedEnvironment {
  if (!KNOWN_NETWORK_IDS.has(network.network_id)) {
    throw new ConfigError(
      `Unknown network_id "${network.network_id}" (expected one of: ${[...KNOWN_NETWORK_IDS].join(', ')})`,
    );
  }
  setNetworkId(network.network_id);

  const env: EnvironmentConfiguration = {
    walletNetworkId:
      network.network_id as EnvironmentConfiguration['walletNetworkId'],
    networkId: network.network_id,
    indexer: network.indexer,
    indexerWS: network.indexer_ws,
    node: network.node,
    nodeWS: network.node_ws,
    proofServer: proofServerUrl,
    faucet: network.faucet_url,
  };

  return { env, faucetUrl: network.faucet_url };
}
