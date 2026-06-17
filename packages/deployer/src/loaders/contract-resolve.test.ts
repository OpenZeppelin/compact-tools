import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompactConfig } from '../config/compact-config.ts';
import { ConfigError } from '../errors.ts';
import { resolveContractName } from './contract-resolve.ts';

const rootDirs: string[] = [];

afterEach(() => {
  // Module cache holds the imported artifacts. Tests use unique
  // tmpdirs so no cleanup is needed.
  rootDirs.length = 0;
});

function makeProject(entries: Record<string, { Contract: unknown }>): string {
  const root = mkdtempSync(join(tmpdir(), 'contract-resolve-'));
  rootDirs.push(root);
  mkdirSync(join(root, 'artifacts'));
  const contractsToml = Object.keys(entries)
    .map(
      (name) => `
[contracts.${name}]
artifact = "${name}"
signing_key_file = "${name}.sk"
`,
    )
    .join('\n');
  writeFileSync(
    join(root, 'compact.toml'),
    `
[profile]
default_network = "local"
artifacts_dir = "artifacts"

[networks.local]
network_id = "local"
indexer = "http://localhost:8088/api/v1/graphql"
indexer_ws = "ws://localhost:8088/api/v1/graphql/ws"
node = "http://localhost:9944"
node_ws = "ws://localhost:9944"
proof_server = "http://localhost:6300"

${contractsToml}
`,
  );
  for (const [name, { Contract }] of Object.entries(entries)) {
    const contractDir = join(root, 'artifacts', name, 'contract');
    mkdirSync(contractDir, { recursive: true });
    // The exported class instance is shared via the module cache, so
    // the loaded module's `Contract` === the test's reference.
    const g = globalThis as unknown as Record<string, unknown>;
    const key = `__test_contract_${name}_${Date.now()}_${Math.random()}`;
    g[key] = Contract;
    writeFileSync(
      join(contractDir, 'index.js'),
      `export const Contract = globalThis['${key}'];\n`,
    );
  }
  return root;
}

describe('resolveContractName', () => {
  it('returns the entry name whose artifact exports the same Contract class', async () => {
    class TokenContract {
      initialState() {}
    }
    class OtherContract {
      initialState() {}
    }
    const root = makeProject({
      TokenExample: { Contract: TokenContract },
      OtherExample: { Contract: OtherContract },
    });
    const config = await CompactConfig.load(join(root, 'compact.toml'));
    expect(await resolveContractName(TokenContract, config, root)).toBe(
      'TokenExample',
    );
  });

  it('throws when no entry matches the Contract class', async () => {
    class A {
      initialState() {}
    }
    class B {
      initialState() {}
    }
    const root = makeProject({ A: { Contract: A } });
    const config = await CompactConfig.load(join(root, 'compact.toml'));
    await expect(resolveContractName(B, config, root)).rejects.toThrow(
      /did not match any \[contracts\.X\] entry/,
    );
  });

  it('throws when two entries match the same Contract class (ambiguous)', async () => {
    class Shared {
      initialState() {}
    }
    const root = makeProject({
      A: { Contract: Shared },
      B: { Contract: Shared },
    });
    const config = await CompactConfig.load(join(root, 'compact.toml'));
    await expect(resolveContractName(Shared, config, root)).rejects.toThrow(
      ConfigError,
    );
    await expect(resolveContractName(Shared, config, root)).rejects.toThrow(
      /Ambiguous Contract/,
    );
  });

  it('lists skipped entries when an artifact dir has no contract module', async () => {
    class Target {
      initialState() {}
    }
    const root = makeProject({ A: { Contract: Target } });
    // Inject a second entry whose artifact dir is empty (no
    // contract/index.{cjs,js} files).
    writeFileSync(
      join(root, 'compact.toml'),
      readFileSync(join(root, 'compact.toml'), 'utf8') +
        `
[contracts.Empty]
artifact = "Empty"
signing_key_file = "Empty.sk"
`,
    );
    mkdirSync(join(root, 'artifacts', 'Empty'));
    class Other {
      initialState() {}
    }
    const config = await CompactConfig.load(join(root, 'compact.toml'));
    await expect(resolveContractName(Other, config, root)).rejects.toThrow(
      /Skipped: Empty \(no contract\/index/,
    );
  });

  it('skips entries whose artifact module import throws', async () => {
    class Target {
      initialState() {}
    }
    const root = makeProject({ Good: { Contract: Target } });
    writeFileSync(
      join(root, 'compact.toml'),
      readFileSync(join(root, 'compact.toml'), 'utf8') +
        `
[contracts.Broken]
artifact = "Broken"
signing_key_file = "Broken.sk"
`,
    );
    mkdirSync(join(root, 'artifacts', 'Broken', 'contract'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'artifacts', 'Broken', 'contract', 'index.js'),
      'throw new Error("boom on import");\n',
    );
    const config = await CompactConfig.load(join(root, 'compact.toml'));
    // Target still matches "Good" (good entry has the right Contract);
    // the broken entry is just skipped silently in the match path.
    expect(await resolveContractName(Target, config, root)).toBe('Good');
  });

  it('honours an absolute `artifact` path in compact.toml', async () => {
    class Target {
      initialState() {}
    }
    const root = makeProject({ Token: { Contract: Target } });
    // Rewrite the [contracts.Token] entry to use an absolute artifact path.
    const absPath = join(root, 'artifacts', 'Token');
    const toml = readFileSync(join(root, 'compact.toml'), 'utf8').replace(
      'artifact = "Token"',
      `artifact = "${absPath}"`,
    );
    writeFileSync(join(root, 'compact.toml'), toml);
    const config = await CompactConfig.load(join(root, 'compact.toml'));
    expect(await resolveContractName(Target, config, root)).toBe('Token');
  });
});
