import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { applyNetwork } from './network.ts';

vi.mock('@midnight-ntwrk/midnight-js-network-id', () => ({
  setNetworkId: vi.fn(),
}));

const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');

const baseNetwork: NetworkConfig = {
  network_id: 'testnet',
  indexer: 'https://indexer.example/api',
  indexer_ws: 'wss://indexer.example/ws',
  node: 'https://node.example',
  node_ws: 'wss://node.example/ws',
};

describe('applyNetwork', () => {
  beforeEach(() => {
    vi.mocked(setNetworkId).mockClear();
  });

  it('should set the network id and assemble the environment for a known id', () => {
    const { env } = applyNetwork(baseNetwork, 'http://proof-server:6300');

    expect(setNetworkId).toHaveBeenCalledWith('testnet');
    expect(env.networkId).toBe('testnet');
    expect(env.indexer).toBe('https://indexer.example/api');
    expect(env.indexerWS).toBe('wss://indexer.example/ws');
    expect(env.node).toBe('https://node.example');
    expect(env.nodeWS).toBe('wss://node.example/ws');
    expect(env.proofServer).toBe('http://proof-server:6300');
  });

  it.each([
    'undeployed',
    'devnet',
    'qanet',
    'testnet',
    'preview',
    'preprod',
    'mainnet',
  ])('should accept known network id %s', (id) => {
    expect(() =>
      applyNetwork({ ...baseNetwork, network_id: id }, 'http://ps'),
    ).not.toThrow();
    expect(setNetworkId).toHaveBeenLastCalledWith(id);
  });

  it('should reject an unknown network id with ConfigError', () => {
    expect(() =>
      applyNetwork({ ...baseNetwork, network_id: 'bogus-net' }, 'http://ps'),
    ).toThrow(ConfigError);
  });

  it('should not call setNetworkId when the id is unknown', () => {
    try {
      applyNetwork({ ...baseNetwork, network_id: 'bogus-net' }, 'http://ps');
    } catch {
      /* expected */
    }
    expect(setNetworkId).not.toHaveBeenCalled();
  });

  it('should include the allowed-id list in the error message', () => {
    expect(() =>
      applyNetwork({ ...baseNetwork, network_id: 'bogus' }, 'http://ps'),
    ).toThrow(/expected one of:.*testnet/);
  });
});
