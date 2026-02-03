import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_OUT_DIR } from '../config.ts';
import { type ArtifactManifest, MANIFEST_FILENAME } from '../types/manifest.ts';

/**
 * Service responsible for managing the artifact manifest file.
 * Handles reading, writing, and comparing manifest data to detect structure mismatches.
 *
 * @class ManifestService
 * @example
 * ```typescript
 * const manifestService = new ManifestService('artifacts');
 * const manifest = await manifestService.read();
 * if (manifest && manifest.structure !== 'hierarchical') {
 *   // Structure mismatch detected
 * }
 * ```
 */
export class ManifestService {
  private outDir: string;

  /**
   * Creates a new ManifestService instance.
   *
   * @param outDir - Output directory where the manifest is stored
   */
  constructor(outDir: string = DEFAULT_OUT_DIR) {
    this.outDir = outDir;
  }

  /**
   * Gets the full path to the manifest file.
   */
  get manifestPath(): string {
    return join(this.outDir, MANIFEST_FILENAME);
  }

  /**
   * Reads the artifact manifest from the output directory.
   *
   * @returns Promise resolving to the manifest or null if not found/invalid
   */
  async read(): Promise<ArtifactManifest | null> {
    try {
      if (!existsSync(this.manifestPath)) {
        return null;
      }
      const content = await readFile(this.manifestPath, 'utf-8');
      return JSON.parse(content) as ArtifactManifest;
    } catch {
      return null;
    }
  }

  /**
   * Writes the artifact manifest to the output directory.
   *
   * @param manifest - The manifest to write
   */
  async write(manifest: ArtifactManifest): Promise<void> {
    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  /**
   * Checks if there's a structure mismatch between existing and requested structure.
   *
   * @param requestedStructure - The structure type being requested
   * @returns Promise resolving to the existing manifest if mismatch, null otherwise
   */
  async checkMismatch(
    requestedStructure: 'flattened' | 'hierarchical',
  ): Promise<ArtifactManifest | null> {
    const existing = await this.read();
    if (existing && existing.structure !== requestedStructure) {
      return existing;
    }
    return null;
  }

  /**
   * Deletes the output directory and all its contents.
   */
  async cleanOutputDirectory(): Promise<void> {
    if (existsSync(this.outDir)) {
      await rm(this.outDir, { recursive: true, force: true });
    }
  }
}
