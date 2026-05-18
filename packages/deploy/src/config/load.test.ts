import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { loadConfig } from './load.ts';

const MIN_VALID = `
[profile]
default_network = "local"

[networks.local]
network_id = "undeployed"
indexer = "http://127.0.0.1:8088/api/v3/graphql"
indexer_ws = "ws://127.0.0.1:8088/api/v3/graphql/ws"
node = "http://127.0.0.1:9944"
node_ws = "ws://127.0.0.1:9944"
proof_server = "http://127.0.0.1:6300"

[contracts.Token]
artifact = "src/artifacts/Token/Token"
signing_key_file = "./deploy/Token.signingkey"
`;

function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'compact-deploy-test-'));
  writeFileSync(join(dir, 'compact.toml'), toml);
  return dir;
}

describe('loadConfig', () => {
  it('parses a minimal valid config', async () => {
    const dir = tmpRepo(MIN_VALID);
    const { config, rootDir } = await loadConfig(undefined, dir);
    expect(rootDir).toBe(dir);
    expect(config.profile.default_network).toBe('local');
    expect(config.networks.local.network_id).toBe('undeployed');
    expect(config.contracts.Token.artifact).toBe('src/artifacts/Token/Token');
  });

  it('rejects a config whose default_network does not exist', async () => {
    const dir = tmpRepo(`${MIN_VALID}\n[profile]\ndefault_network = "ghost"\n`);
    await expect(loadConfig(undefined, dir)).rejects.toThrow(ConfigError);
  });

  it('rejects a contract missing signing_key_file', async () => {
    const dir = tmpRepo(`
[networks.local]
network_id = "undeployed"
indexer = "http://x"
indexer_ws = "ws://x"
node = "http://x"
node_ws = "ws://x"
proof_server = "http://x"

[contracts.Token]
artifact = "x"
`);
    await expect(loadConfig(undefined, dir)).rejects.toThrow(ConfigError);
  });

  it('rejects when init_private_state is set but private_state_id is not', async () => {
    const dir = tmpRepo(`
[networks.local]
network_id = "undeployed"
indexer = "http://127.0.0.1:8088/api/v3/graphql"
indexer_ws = "ws://127.0.0.1:8088/api/v3/graphql/ws"
node = "http://127.0.0.1:9944"
node_ws = "ws://127.0.0.1:9944"
proof_server = "http://127.0.0.1:6300"

[contracts.Token]
artifact = "x"
signing_key_file = "x.sk"
init_private_state = { file = "x.json" }
`);
    await expect(loadConfig(undefined, dir)).rejects.toThrow(ConfigError);
  });
});
