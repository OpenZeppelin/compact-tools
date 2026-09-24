import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

describe('CompactConfig — patterns', () => {
  // MIN_VALID with `src_dir = "contracts"`.
  const WITH_SRC_DIR = MIN_VALID.replace(
    'default_network = "local"',
    'default_network = "local"\nsrc_dir = "contracts"',
  );

  function addSources(dir: string, files: string[]): void {
    for (const file of files) {
      mkdirSync(dirname(join(dir, 'contracts', file)), { recursive: true });
      writeFileSync(join(dir, 'contracts', file), '');
    }
  }

  it('should resolve a contract that only a name pattern matches', async () => {
    const dir = tmpRepo(`${MIN_VALID}
[contracts."Mock*"]
signing_key_file = "./deploy/{name}.signingkey"
`);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.contract('MockToken')).toEqual({
      artifact: 'MockToken',
      signing_key_file: './deploy/MockToken.signingkey',
    });
    expect(config.hasContract('MockToken')).toBe(true);
    expect(config.hasContract('Vault')).toBe(false);
  });

  it('should resolve a contract through a directory pattern on its source path', async () => {
    const dir = tmpRepo(`${WITH_SRC_DIR}
[contracts."**/test/mocks/*"]
signing_key_file = "./deploy/mock.signingkey"
`);
    addSources(dir, [
      'token/test/mocks/MockToken.compact',
      'token/FungibleToken.compact',
    ]);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.contract('MockToken').signing_key_file).toBe(
      './deploy/mock.signingkey',
    );
    expect(() => config.contract('FungibleToken')).toThrow(
      /^Contract "FungibleToken" not defined\. Available: Token, "\*\*\/test\/mocks\/\*"$/,
    );
  });

  it('should apply matching patterns in file order, whatever their kind', async () => {
    const byName = `
[contracts."Mock*"]
signing_key_file = "name.sk"
`;
    const byDirectory = `
[contracts."mocks/*"]
signing_key_file = "directory.sk"
private_state_id = "directoryState"
`;
    const load = async (patterns: string) => {
      const dir = tmpRepo(`${WITH_SRC_DIR}${patterns}`);
      addSources(dir, ['mocks/MockToken.compact']);
      return (await CompactConfig.load(undefined, dir)).contract('MockToken');
    };
    expect(await load(byDirectory + byName)).toEqual({
      artifact: 'MockToken',
      signing_key_file: 'name.sk',
      private_state_id: 'directoryState',
    });
    expect((await load(byName + byDirectory)).signing_key_file).toBe(
      'directory.sk',
    );
  });

  it('should apply the exact entry last and fill its gaps from patterns', async () => {
    const dir = tmpRepo(`${MIN_VALID}
[contracts."*"]
signing_key_file = "./deploy/{name}.signingkey"
args = [1]

[contracts.Vault]
args = [2]
`);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.contract('Token')).toEqual({
      artifact: 'src/artifacts/Token/Token',
      signing_key_file: './deploy/Token.signingkey',
      args: [1],
    });
    expect(config.contract('Vault')).toEqual({
      artifact: 'Vault',
      signing_key_file: './deploy/Vault.signingkey',
      args: [2],
    });
  });

  it('should expand {name} in refs and private state fields', async () => {
    const dir = tmpRepo(`${MIN_VALID}
[contracts."Mock*"]
signing_key_file = "./deploy/mock.signingkey"
private_state_id = "{name}State"
init_private_state = { file = "./state/{name}.json" }
witnesses = { module = "./witnesses/{name}.ts", export = "{name}Witnesses" }
`);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.contract('MockToken')).toEqual({
      artifact: 'MockToken',
      signing_key_file: './deploy/mock.signingkey',
      private_state_id: 'MockTokenState',
      init_private_state: { file: './state/MockToken.json' },
      witnesses: {
        module: './witnesses/MockToken.ts',
        export: 'MockTokenWitnesses',
      },
    });
  });

  it('should accept private_state_id without init_private_state', async () => {
    const dir = tmpRepo(`${MIN_VALID}
[contracts.Vault]
signing_key_file = "./deploy/Vault.signingkey"
private_state_id = "vaultState"
`);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.contract('Vault').private_state_id).toBe('vaultState');
    expect(config.contract('Vault').init_private_state).toBeUndefined();
  });

  it('should reject a pattern-resolved init_private_state without private_state_id', async () => {
    const dir = tmpRepo(`${MIN_VALID}
[contracts."Mock*"]
signing_key_file = "./deploy/mock.signingkey"
init_private_state = { file = "./state/{name}.json" }
`);
    const config = await CompactConfig.load(undefined, dir);
    expect(() => config.contract('MockToken')).toThrow(ConfigError);
    expect(() => config.contract('MockToken')).toThrow(
      /contracts\.MockToken: init_private_state needs private_state_id/,
    );
  });

  it('should reject a pattern-resolved contract missing signing_key_file', async () => {
    const dir = tmpRepo(`${MIN_VALID}
[contracts."Mock*"]
args = []
`);
    const config = await CompactConfig.load(undefined, dir);
    expect(() => config.contract('MockToken')).toThrow(
      'compact.toml validation failed for contract "MockToken" (from "Mock*"):\n  - contracts.MockToken.signing_key_file: Required',
    );
  });

  it('should reject a directory pattern when src_dir is unset', async () => {
    const dir = tmpRepo(`${MIN_VALID}
[contracts."**/mocks/*"]
signing_key_file = "./deploy/mock.signingkey"
`);
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      ConfigError,
    );
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      /profile\.src_dir: required by the directory pattern "\*\*\/mocks\/\*"/,
    );
  });

  it('should reject a src_dir that is not a directory', async () => {
    const dir = tmpRepo(`${WITH_SRC_DIR}
[contracts."**/mocks/*"]
signing_key_file = "./deploy/mock.signingkey"
`);
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      `[profile].src_dir is not a directory: ${join(dir, 'contracts')}`,
    );
  });

  it('should not read src_dir without a directory pattern', async () => {
    const dir = tmpRepo(`${WITH_SRC_DIR}
[contracts."Mock*"]
signing_key_file = "./deploy/mock.signingkey"
`);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.contract('MockToken').artifact).toBe('MockToken');
  });

  it('should throw ConfigError naming both sources of an ambiguous contract', async () => {
    const dir = tmpRepo(`${WITH_SRC_DIR}
[contracts."**/mocks/*"]
signing_key_file = "./deploy/mock.signingkey"
`);
    addSources(dir, ['a/mocks/MockToken.compact', 'b/mocks/MockToken.compact']);
    const config = await CompactConfig.load(undefined, dir);
    expect(() => config.contract('MockToken')).toThrow(ConfigError);
    expect(() => config.contract('MockToken')).toThrow(
      `Contract "MockToken" matches 2 sources under ${join(dir, 'contracts')}: a/mocks/MockToken.compact, b/mocks/MockToken.compact`,
    );
  });

  it('should let an exact entry inherit from a directory pattern', async () => {
    const dir = tmpRepo(`${WITH_SRC_DIR}
[contracts."**/mocks/*"]
signing_key_file = "./deploy/mock.signingkey"

[contracts.MockVault]
args = []
`);
    addSources(dir, ['mocks/MockVault.compact']);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.contract('MockVault')).toEqual({
      artifact: 'MockVault',
      signing_key_file: './deploy/mock.signingkey',
      args: [],
    });
  });

  it('should validate exact entries at load when a directory pattern exists', async () => {
    const dir = tmpRepo(`${WITH_SRC_DIR}
[contracts."**/mocks/*"]
signing_key_file = "./deploy/mock.signingkey"

[contracts.MockVault]
args = []
`);
    addSources(dir, ['vault/MockVault.compact']);
    await expect(CompactConfig.load(undefined, dir)).rejects.toThrow(
      /contracts\.MockVault\.signing_key_file: Required/,
    );
  });

  it('should list patterns apart from exact names and name both on a miss', async () => {
    const dir = tmpRepo(`${WITH_SRC_DIR}
[contracts."Mock*"]
signing_key_file = "./deploy/mock.signingkey"

[contracts."**/mocks/*"]
signing_key_file = "./deploy/mock.signingkey"
`);
    addSources(dir, ['mocks/MockToken.compact']);
    const config = await CompactConfig.load(undefined, dir);
    expect(config.listContracts()).toEqual(['Token']);
    expect(config.listPatterns()).toEqual(['Mock*', '**/mocks/*']);
    expect(() => config.contract('Vault')).toThrow(
      `Contract "Vault" not defined. Available: Token, "Mock*", "**/mocks/*" (no Vault.compact under ${join(dir, 'contracts')})`,
    );
  });
});
