import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import type { NetworkConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';

/**
 * Set the midnight-js network-id singleton + build an
 * `EnvironmentConfiguration`. `KNOWN_NETWORK_IDS` is closed so a typo
 * fails fast here instead of as a generic midnight-js error later.
 */

const KNOWN_NETWORK_IDS: ReadonlySet<string> = new Set([
  'undeployed',
  'devnet',
  'qanet',
  'testnet',
  'preview',
  'preprod',
]);

export interface ResolvedEnvironment {
  env: EnvironmentConfiguration;
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
    // testkit-js requires this field even though our deploys never
    // hit the faucet themselves. Set to undefined so dependent code
    // paths (e.g. wait-for-funds hints) treat it as absent.
    faucet: undefined,
  };

  return { env };
}
