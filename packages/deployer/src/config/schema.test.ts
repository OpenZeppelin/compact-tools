import { describe, expect, it } from 'vitest';
import { configSchema, isFileRef, isModuleRef } from './schema.ts';

const validNetwork = {
  network_id: 'testnet',
  indexer: 'https://indexer.example/api',
  indexer_ws: 'wss://indexer.example/ws',
  node: 'https://node.example',
  node_ws: 'wss://node.example/ws',
};

const validContract = {
  artifact: 'src/artifacts/Counter',
  signing_key_file: 'keys/counter.signing',
};

const baseConfig = {
  networks: { testnet: validNetwork },
  contracts: { Counter: validContract },
};

describe('configSchema — profile', () => {
  it('should default artifacts_dir and deployments_dir', () => {
    const parsed = configSchema.parse(baseConfig);
    expect(parsed.profile.artifacts_dir).toBe('src/artifacts');
    expect(parsed.profile.deployments_dir).toBe('deployments/compact');
  });

  it('should accept an explicit profile block', () => {
    const parsed = configSchema.parse({
      ...baseConfig,
      profile: {
        artifacts_dir: 'out',
        deployments_dir: 'deploys',
      },
    });
    expect(parsed.profile.artifacts_dir).toBe('out');
    expect(parsed.profile.deployments_dir).toBe('deploys');
  });
});

describe('configSchema — networks', () => {
  it('should reject a non-URL indexer', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        networks: { testnet: { ...validNetwork, indexer: 'not-a-url' } },
      }),
    ).toThrow();
  });

  it('should accept proof_server = "auto"', () => {
    const parsed = configSchema.parse({
      ...baseConfig,
      networks: { testnet: { ...validNetwork, proof_server: 'auto' } },
    });
    expect(parsed.networks.testnet.proof_server).toBe('auto');
  });

  it('should accept proof_server as a URL', () => {
    const parsed = configSchema.parse({
      ...baseConfig,
      networks: {
        testnet: { ...validNetwork, proof_server: 'http://localhost:6300' },
      },
    });
    expect(parsed.networks.testnet.proof_server).toBe('http://localhost:6300');
  });

  it('should reject proof_server other than URL or "auto"', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        networks: { testnet: { ...validNetwork, proof_server: 'manual' } },
      }),
    ).toThrow();
  });

  it('should clamp wallet.index to 0..3 only', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        networks: {
          testnet: {
            ...validNetwork,
            wallet: { source: 'local', index: 4 },
          },
        },
      }),
    ).toThrow();
  });

  it('should default wallet.index to 0', () => {
    const parsed = configSchema.parse({
      ...baseConfig,
      networks: {
        testnet: {
          ...validNetwork,
          wallet: { source: 'local' },
        },
      },
    });
    expect(parsed.networks.testnet.wallet?.index).toBe(0);
  });
});

describe('configSchema — network sync tuning', () => {
  it('should accept sync_timeout and sync_batch_size as positive integers', () => {
    const parsed = configSchema.parse({
      ...baseConfig,
      networks: {
        testnet: { ...validNetwork, sync_timeout: 3600, sync_batch_size: 5000 },
      },
    });
    expect(parsed.networks.testnet.sync_timeout).toBe(3600);
    expect(parsed.networks.testnet.sync_batch_size).toBe(5000);
  });

  it('should leave sync_timeout and sync_batch_size undefined when omitted', () => {
    const parsed = configSchema.parse(baseConfig);
    expect(parsed.networks.testnet.sync_timeout).toBeUndefined();
    expect(parsed.networks.testnet.sync_batch_size).toBeUndefined();
  });

  it('should reject a non-positive sync_batch_size', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        networks: { testnet: { ...validNetwork, sync_batch_size: 0 } },
      }),
    ).toThrow();
  });

  it('should reject a fractional sync_timeout', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        networks: { testnet: { ...validNetwork, sync_timeout: 1.5 } },
      }),
    ).toThrow();
  });
});

describe('configSchema — profile.default_network refine', () => {
  it('should accept default_network pointing at a defined network', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        profile: { default_network: 'testnet' },
      }),
    ).not.toThrow();
  });

  it('should reject default_network pointing at an undefined network', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        profile: { default_network: 'mainnet' },
      }),
    ).toThrow(/default_network.*defined.*networks/);
  });

  it('should allow default_network to be omitted', () => {
    const parsed = configSchema.parse(baseConfig);
    expect(parsed.profile.default_network).toBeUndefined();
  });
});

describe('configSchema — contract refine (private state pairing)', () => {
  it('should accept both private_state_id and init_private_state set together', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        contracts: {
          Counter: {
            ...validContract,
            private_state_id: 'counter-ps',
            init_private_state: { file: 'state.json' },
          },
        },
      }),
    ).not.toThrow();
  });

  it('should accept both omitted', () => {
    expect(() => configSchema.parse(baseConfig)).not.toThrow();
  });

  it('should reject private_state_id without init_private_state', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        contracts: {
          Counter: { ...validContract, private_state_id: 'counter-ps' },
        },
      }),
    ).toThrow(/private_state_id and init_private_state must be set together/);
  });

  it('should reject init_private_state without private_state_id', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        contracts: {
          Counter: {
            ...validContract,
            init_private_state: { file: 'state.json' },
          },
        },
      }),
    ).toThrow(/private_state_id and init_private_state must be set together/);
  });
});

describe('configSchema — contract args', () => {
  it('should accept args as an array', () => {
    const parsed = configSchema.parse({
      ...baseConfig,
      contracts: {
        Counter: { ...validContract, args: [1, 'two', { x: 3 }] },
      },
    });
    expect(parsed.contracts.Counter.args).toEqual([1, 'two', { x: 3 }]);
  });

  it('should accept args as a file ref', () => {
    const parsed = configSchema.parse({
      ...baseConfig,
      contracts: {
        Counter: { ...validContract, args: { file: 'args.json' } },
      },
    });
    expect(parsed.contracts.Counter.args).toEqual({ file: 'args.json' });
  });

  it('should accept args as a module ref and default export to "default"', () => {
    const parsed = configSchema.parse({
      ...baseConfig,
      contracts: {
        Counter: { ...validContract, args: { module: 'args.ts' } },
      },
    });
    expect(parsed.contracts.Counter.args).toEqual({
      module: 'args.ts',
      export: 'default',
    });
  });

  it('should reject an ambiguous ref carrying both file and module', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        contracts: {
          Counter: {
            ...validContract,
            args: { file: 'args.json', module: 'args.ts' },
          },
        },
      }),
    ).toThrow();
  });
});

describe('configSchema — required fields', () => {
  it('should reject a contract missing signing_key_file', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        contracts: { Counter: { artifact: 'src/artifacts/Counter' } },
      }),
    ).toThrow();
  });

  it('should reject a network missing network_id', () => {
    const { network_id: _omit, ...withoutId } = validNetwork;
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        networks: { testnet: withoutId },
      }),
    ).toThrow();
  });
});

describe('isFileRef / isModuleRef', () => {
  it('should distinguish a file ref', () => {
    expect(isFileRef({ file: 'x' })).toBe(true);
    expect(isFileRef({ module: 'x' })).toBe(false);
    expect(isFileRef(undefined)).toBe(false);
    expect(isFileRef(null)).toBe(false);
    expect(isFileRef('plain string')).toBe(false);
  });

  it('should distinguish a module ref', () => {
    expect(isModuleRef({ module: 'x', export: 'default' })).toBe(true);
    expect(isModuleRef({ file: 'x' })).toBe(false);
    expect(isModuleRef(undefined)).toBe(false);
    expect(isModuleRef(null)).toBe(false);
  });
});
