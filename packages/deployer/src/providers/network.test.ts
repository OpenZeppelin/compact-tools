import { describe, expect, it } from 'vitest';
import type { NetworkConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { applyNetwork } from './network.ts';

const baseNetwork: NetworkConfig = {
  network_id: 'testnet',
  indexer: 'https://indexer.example/api',
  indexer_ws: 'wss://indexer.example/ws',
  node: 'https://node.example',
  node_ws: 'wss://node.example/ws',
};

describe('applyNetwork', () => {
  it('should assemble the environment for a known id', () => {
    const { env } = applyNetwork(baseNetwork, 'http://proof-server:6300');

    expect(env.networkId).toBe('testnet');
    expect(env.walletNetworkId).toBe('testnet');
    expect(env.indexer).toBe('https://indexer.example/api');
    expect(env.indexerWS).toBe('wss://indexer.example/ws');
    expect(env.node).toBe('https://node.example');
    expect(env.nodeWS).toBe('wss://node.example/ws');
    expect(env.proofServer).toBe('http://proof-server:6300');
  });

  it.each(['undeployed', 'devnet', 'qanet', 'testnet', 'preview', 'preprod'])(
    'should accept known network id %s',
    (id) => {
      expect(
        applyNetwork({ ...baseNetwork, network_id: id }, 'http://ps').env
          .networkId,
      ).toBe(id);
    },
  );

  it('should reject mainnet while the deployer is testnet/preview-only', () => {
    expect(() =>
      applyNetwork({ ...baseNetwork, network_id: 'mainnet' }, 'http://ps'),
    ).toThrow(ConfigError);
  });

  it('should reject an unknown network id with ConfigError', () => {
    expect(() =>
      applyNetwork({ ...baseNetwork, network_id: 'bogus-net' }, 'http://ps'),
    ).toThrow(ConfigError);
  });

  it('should include the allowed-id list in the error message', () => {
    expect(() =>
      applyNetwork({ ...baseNetwork, network_id: 'bogus' }, 'http://ps'),
    ).toThrow(/expected one of:.*testnet/);
  });
});
