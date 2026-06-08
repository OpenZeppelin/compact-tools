import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { CompiledContract, type Contract } from '@midnight-ntwrk/compact-js';
import type { Types } from 'effect';
import {
  type FileOrModuleRef,
  isFileRef,
  isModuleRef,
} from '../config/schema.ts';
import { ArtifactNotFoundError, ConfigError } from '../errors.ts';
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
type AnyCompiledContract = CompiledContract.CompiledContract<
  AnyContract,
  unknown,
  never
>;

export interface LoadArtifactOptions {
  rootDir: string;
  artifactsDir: string;
  artifact: string;
  contractName: string;
  witnesses?: FileOrModuleRef;
}

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

  /** Resolve, validate, and import the bundle. Throws {@link ArtifactNotFoundError} on missing dir/entry/keys/zkir. */
  static async load(opts: LoadArtifactOptions): Promise<Artifact> {
    const { rootDir, artifactsDir, artifact, contractName, witnesses } = opts;
    const ctx = new LoaderContext(rootDir);
    const artifactPath = resolveUnderRoot(rootDir, artifact, artifactsDir);

    if (!existsSync(artifactPath)) {
      throw new ArtifactNotFoundError(artifactPath);
    }

    const contractDir = resolve(artifactPath, 'contract');
    const entry = findEntry(contractDir, artifactPath);
    if (!entry) {
      throw new ArtifactNotFoundError(
        `${artifactPath} (no contract/index.{cjs,js} or index.{cjs,js} found)`,
      );
    }

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

function resolveUnderRoot(
  rootDir: string,
  artifact: string,
  artifactsDir: string,
): string {
  if (isAbsolute(artifact)) return artifact;
  const direct = resolve(rootDir, artifact);
  if (existsSync(direct)) return direct;
  return resolve(rootDir, artifactsDir, artifact);
}

function findEntry(
  contractDir: string,
  artifactDir: string,
): string | undefined {
  const candidates = [
    resolve(contractDir, 'index.cjs'),
    resolve(contractDir, 'index.js'),
    resolve(artifactDir, 'index.cjs'),
    resolve(artifactDir, 'index.js'),
  ];
  return candidates.find(existsSync);
}

function collectCircuitNames(zkirDir: string): string[] {
  return readdirSync(zkirDir)
    .filter((f) => f.endsWith('.bzkir'))
    .map((f) => f.slice(0, -'.bzkir'.length))
    .sort();
}
