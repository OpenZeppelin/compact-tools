import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CompiledContract, type Contract } from '@midnight-ntwrk/compact-js';
import type { ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types';
import type { Types } from 'effect';
import {
  type FileOrModuleRef,
  isFileRef,
  isModuleRef,
} from '../config/schema.ts';
import { ArtifactNotFoundError, ConfigError } from '../errors.ts';
import { findArtifactEntry, resolveUnderRoot } from './artifact-path.ts';
import { LoaderContext } from './context.ts';

/**
 * A compactc artifact bundle on disk:
 *   <artifact>/contract/index.{cjs,js}   — Contract class
 *   <artifact>/keys/<circuit>.{prover,verifier}
 *   <artifact>/zkir/<circuit>.bzkir
 * Witnesses live outside the bundle, referenced via `[contracts.X].witnesses`.
 */

type AnyContract = Contract.Any;
type AnyWitnesses = Contract.Witnesses<AnyContract>;
/**
 * `unknown` private state would not satisfy either SDK entry point that takes
 * this value, and the artifact's real private-state type is only known to the
 * dApp. `any` is the one place that gap is bridged, so no consumer casts.
 */
type AnyCompiledContract = CompiledContract.CompiledContract<AnyContract, any>;

export interface LoadArtifactOptions {
  rootDir: string;
  artifactsDir: string;
  artifact: string;
  contractName: string;
  witnesses?: FileOrModuleRef;
}

/** Verifier key bytes per circuit, as read from `keys/<circuit>.verifier`. */
export type ArtifactKeys = ReadonlyMap<string, Uint8Array>;

export class Artifact {
  readonly compiledContract: AnyCompiledContract;
  readonly artifactPath: string;
  readonly zkConfigPath: string;
  readonly circuitNames: readonly string[];

  private constructor(input: {
    compiledContract: AnyCompiledContract;
    artifactPath: string;
    zkConfigPath: string;
    circuitNames: readonly string[];
  }) {
    this.compiledContract = input.compiledContract;
    this.artifactPath = input.artifactPath;
    this.zkConfigPath = input.zkConfigPath;
    this.circuitNames = input.circuitNames;
  }

  /**
   * Verifier key bytes for every circuit this artifact declares.
   *
   * INV-11: read before fragment 0, so a bundle missing a key fails before any
   * transaction rather than mid-way through the inserts.
   */
  async verifierKeys(
    zkConfigProvider: ZKConfigProvider<string>,
  ): Promise<ArtifactKeys> {
    const pairs = await zkConfigProvider.getVerifierKeys([
      ...this.circuitNames,
    ]);
    const keys = new Map(pairs);
    const missing = this.circuitNames.filter((name) => !keys.has(name));
    if (missing.length > 0) {
      throw new ConfigError(
        `Artifact at ${this.artifactPath} has no verifier key for: ${missing.join(', ')}.`,
      );
    }
    return keys;
  }

  /** Resolve, validate, and import the bundle. Throws {@link ArtifactNotFoundError} on missing dir/entry/keys/zkir. */
  static async load(opts: LoadArtifactOptions): Promise<Artifact> {
    const { rootDir, artifactsDir, artifact, contractName, witnesses } = opts;
    const ctx = new LoaderContext(rootDir);
    const artifactPath = resolveUnderRoot(rootDir, artifact, artifactsDir);

    if (!existsSync(artifactPath)) {
      throw new ArtifactNotFoundError(artifactPath);
    }

    const entry = findArtifactEntry(artifactPath);
    if (!entry) {
      throw new ArtifactNotFoundError(
        `${artifactPath} (no contract/index.{cjs,js} or index.{cjs,js} found)`,
      );
    }
    // Bind compiled assets to the directory the entry actually lives in:
    // `findArtifactEntry` may resolve a top-level `index.{cjs,js}` rather than the
    // `contract/` subdir, in which case the hardcoded path would be wrong.
    const contractDir = dirname(entry);

    const keysDir = resolve(artifactPath, 'keys');
    const zkirDir = resolve(artifactPath, 'zkir');
    if (!existsSync(keysDir) || !existsSync(zkirDir)) {
      throw new ArtifactNotFoundError(
        `${artifactPath} (missing keys/ or zkir/ subdirectory)`,
      );
    }

    const circuitNames = collectCircuitNames(zkirDir);
    const Ctor = await importContractCtor(ctx, entry);
    const witnessImpls = witnesses
      ? await importWitnesses(ctx, witnesses)
      : undefined;

    const compiledContract = buildCompiledContract({
      contractName,
      Ctor,
      witnessImpls,
      contractDir,
    });

    return new Artifact({
      compiledContract,
      artifactPath,
      zkConfigPath: artifactPath,
      circuitNames,
    });
  }
}

async function importContractCtor(
  ctx: LoaderContext,
  entry: string,
): Promise<Types.Ctor<AnyContract>> {
  const { mod, path } = await ctx.importModule(entry, 'artifact');
  const m = mod as ArtifactModule;
  const Ctor = m.Contract ?? m.default?.Contract;
  if (!Ctor) {
    throw new ConfigError(
      `Artifact at ${path} does not export a \`Contract\` class (got keys: ${Object.keys(m).join(', ')})`,
    );
  }
  return Ctor;
}

async function importWitnesses(
  ctx: LoaderContext,
  ref: FileOrModuleRef,
): Promise<AnyWitnesses> {
  if (isFileRef(ref)) {
    throw new ConfigError(
      'witnesses must be a { module, export } reference; JSON file refs are not supported (witnesses are functions)',
    );
  }
  if (!isModuleRef(ref)) {
    throw new ConfigError('witnesses must be { module, export }');
  }
  const { mod, path } = await ctx.importModule(ref.module, 'witnesses');
  const exported = mod[ref.export];
  const resolved =
    typeof exported === 'function'
      ? await (exported as () => unknown)()
      : exported;
  if (typeof resolved !== 'object' || resolved === null) {
    throw new ConfigError(
      `witnesses: module ${path} export "${ref.export}" must resolve to an object`,
    );
  }
  return resolved as AnyWitnesses;
}

function buildCompiledContract(input: {
  contractName: string;
  Ctor: Types.Ctor<AnyContract>;
  witnessImpls: AnyWitnesses | undefined;
  contractDir: string;
}): AnyCompiledContract {
  const base = CompiledContract.make(input.contractName, input.Ctor);
  const withWit = input.witnessImpls
    ? CompiledContract.withWitnesses(base, input.witnessImpls)
    : CompiledContract.withVacantWitnesses(base);
  return CompiledContract.withCompiledFileAssets(withWit, input.contractDir);
}

interface ArtifactModule {
  Contract?: Types.Ctor<AnyContract>;
  default?: { Contract?: Types.Ctor<AnyContract> };
}

function collectCircuitNames(zkirDir: string): string[] {
  return readdirSync(zkirDir)
    .filter((f) => f.endsWith('.bzkir'))
    .map((f) => f.slice(0, -'.bzkir'.length))
    .sort();
}
