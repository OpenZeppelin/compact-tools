import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

/**
 * Local-stack network identifier. The dev-preset `midnight-node` boots with
 * this id; every wallet/provider in the suite must agree.
 */
export const LOCAL_NETWORK_ID = 'undeployed';

/**
 * Endpoints for the local stack brought up by `make env-up`. Not
 * overridable: every deploy in the suite resolves its endpoints from
 * `[networks.local]` in `tests/integrations/compact.toml`, so pool
 * wallets built here must be pointed at the same stack. Change both
 * together.
 */
export function localNetworkConfig(): EnvironmentConfiguration {
  return {
    walletNetworkId: LOCAL_NETWORK_ID,
    networkId: LOCAL_NETWORK_ID,
    indexer: 'http://127.0.0.1:8088/api/v4/graphql',
    indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
    node: 'http://127.0.0.1:9944',
    nodeWS: 'ws://127.0.0.1:9944',
    proofServer: 'http://127.0.0.1:6300',
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
