import type { CompactConfig } from '../config/compact-config.ts';
import { ConfigError } from '../errors.ts';
import { findArtifactEntry, resolveUnderRoot } from './artifact-path.ts';
import { LoaderContext } from './context.ts';

/**
 * Walks `compact.toml`'s `[contracts.X]` entries and returns the name
 * whose compiled `Contract` class is identity-equal to the one
 * imported by the caller's deploy script. Used by the curried
 * `runDeploy(Contract)(...)` form so the deploy script names the
 * contract once.
 *
 * Throws when:
 * - no entry resolves to the same Contract class (the script likely
 *   imported from a path that isn't referenced by `compact.toml`)
 * - two entries match (ambiguous — likely two TOML entries pointing
 *   at the same artifact directory).
 */
export async function resolveContractName(
  Contract: unknown,
  config: CompactConfig,
  rootDir: string,
): Promise<string> {
  const ctx = new LoaderContext(rootDir);
  const matches: string[] = [];
  const tried: Array<{ name: string; reason: string }> = [];

  for (const name of config.listContracts()) {
    const cfg = config.contract(name);
    const entry = findArtifactEntry(
      resolveUnderRoot(rootDir, cfg.artifact, config.artifactsDir),
    );
    if (!entry) {
      tried.push({
        name,
        reason: `no contract/index.{cjs,js} or index.{cjs,js} under ${cfg.artifact}`,
      });
      continue;
    }
    try {
      const { mod } = await ctx.importModule(entry, 'artifact');
      const Loaded =
        (mod as { Contract?: unknown }).Contract ??
        (mod as { default?: { Contract?: unknown } }).default?.Contract;
      if (Loaded === Contract) {
        matches.push(name);
      }
    } catch (e) {
      tried.push({ name, reason: (e as Error).message });
    }
  }

  if (matches.length === 1) return matches[0] as string;
  if (matches.length > 1) {
    throw new ConfigError(
      `Ambiguous Contract: matches ${matches.length} entries in compact.toml (${matches.join(', ')}). Use the string form: runDeploy({ contract: 'X' }).`,
    );
  }
  const tail =
    tried.length > 0
      ? `\nSkipped: ${tried.map((t) => `${t.name} (${t.reason})`).join('; ')}`
      : '';
  throw new ConfigError(
    `Contract class did not match any [contracts.X] entry in compact.toml. Make sure the import path resolves to the same artifact directory referenced by the TOML.${tail}`,
  );
}
