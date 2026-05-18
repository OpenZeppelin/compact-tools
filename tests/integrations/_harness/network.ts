import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

/**
 * Local-stack network identifier. The dev-preset `midnight-node` boots with
 * this id; every wallet/provider in the suite must agree.
 */
export const LOCAL_NETWORK_ID = 'undeployed';

/**
 * Endpoints for the local stack brought up by `make env-up`. Each one is
 * overridable via a `MIDNIGHT_*` env var so the same harness can be pointed
 * at a relocated stack (e.g. a remote CI runner).
 */
export function localNetworkConfig(): EnvironmentConfiguration {
  return {
    walletNetworkId: LOCAL_NETWORK_ID,
    networkId: LOCAL_NETWORK_ID,
    indexer:
      process.env.MIDNIGHT_INDEXER_URL ??
      'http://127.0.0.1:8088/api/v4/graphql',
    indexerWS:
      process.env.MIDNIGHT_INDEXER_WS_URL ??
      'ws://127.0.0.1:8088/api/v4/graphql/ws',
    node: process.env.MIDNIGHT_NODE_URL ?? 'http://127.0.0.1:9944',
    nodeWS: process.env.MIDNIGHT_NODE_WS_URL ?? 'ws://127.0.0.1:9944',
    proofServer:
      process.env.MIDNIGHT_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
    faucet: undefined,
  };
}

/**
 * Set the process-wide network id once before any provider/wallet is built.
 * Idempotent.
 */
let networkIdSet = false;
export function setupLocalNetwork(): void {
  if (networkIdSet) return;
  setNetworkId(LOCAL_NETWORK_ID);
  networkIdSet = true;
}
