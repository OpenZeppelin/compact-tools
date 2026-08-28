import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { CompactConfig } from './compact-config.ts';

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

describe('CompactConfig', () => {
  it('should parse a minimal valid config', async () => {
    const dir = tmpRepo(MIN_VALID);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.rootDir).toBe(dir);
    expect(config.defaultNetwork).toBe('local');
    expect(config.network('local').network_id).toBe('undeployed');
    expect(config.contract('Token').artifact).toBe('src/artifacts/Token/Token');
  });

  it('should throw with the available set when a lookup misses', async () => {
    const dir = tmpRepo(MIN_VALID);
    const config = await CompactConfig.load(undefined, dir);
    expect(() => config.network('ghost')).toThrow(/Available: local/);
    expect(() => config.contract('Vault')).toThrow(/Available: Token/);
  });

  it('should reject a config whose default_network does not exist', async () => {
    // Rewrite the existing key rather than appending a second [profile]:
    // a duplicate table is invalid TOML, so the parse would fail before
    // the schema ever checks default_network.
    const dir = tmpRepo(
      MIN_VALID.replace(
        'default_network = "local"',
        'default_network = "ghost"',
      ),
    );
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      /default_network must reference a defined \[networks\.X\] block/,
    );
  });

  it('should reject a compact.toml that is not valid TOML', async () => {
    const dir = tmpRepo('[profile\ndefault_network = "local"\n');
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      /Invalid TOML in /,
    );
  });

  it('should reject a contract missing signing_key_file', async () => {
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
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      ConfigError,
    );
  });

  it('should reject when init_private_state is set but private_state_id is not', async () => {
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
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      ConfigError,
    );
  });

  it('should expose hasNetwork / hasContract / listNetworks / listContracts', async () => {
    const dir = tmpRepo(`${MIN_VALID}
[contracts.Vault]
artifact = "src/artifacts/Vault/Vault"
signing_key_file = "./deploy/Vault.signingkey"
`);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.hasNetwork('local')).toBe(true);
    expect(config.hasNetwork('ghost')).toBe(false);
    expect(config.hasContract('Token')).toBe(true);
    expect(config.hasContract('Vault')).toBe(true);
    expect(config.hasContract('Ghost')).toBe(false);
    expect(config.listNetworks()).toEqual(['local']);
    expect(config.listContracts().sort()).toEqual(['Token', 'Vault']);
  });

  it('should throw ConfigError when --config path does not exist', async () => {
    const missing = join(tmpdir(), `does-not-exist-${Date.now()}.toml`);
    await expect(CompactConfig.load(missing)).rejects.toThrow(
      /--config path does not exist/,
    );
  });

  it('should resolve a relative --config path against cwd', async () => {
    const dir = tmpRepo(MIN_VALID);
    const config = await CompactConfig.load('compact.toml', dir);
    expect(config.configPath).toBe(join(dir, 'compact.toml'));
  });

  it('should throw ConfigError when the --config path exists but cannot be read', async () => {
    // A directory clears the existence check, then `readFile` fails EISDIR.
    const dir = mkdtempSync(join(tmpdir(), 'compact-toml-unreadable-'));
    await expect(CompactConfig.load(dir)).rejects.toThrow(ConfigError);
    await expect(CompactConfig.load(dir)).rejects.toThrow(
      /Failed to read .*: EISDIR/,
    );
  });

  it('should throw ConfigError when no compact.toml exists upward from cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-compact-toml-'));
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      /compact\.toml not found/,
    );
  });
});
