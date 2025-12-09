import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Service for discovering .compact files in a directory
 */
export class FileDiscovery {
	/**
	 * Recursively discovers all .compact files in a directory
	 */
	async getCompactFiles(dir: string): Promise<string[]> {
		try {
			const dirents = await readdir(dir, { withFileTypes: true });

			const filePromises = dirents.map(async (entry) => {
				const fullPath = join(dir, entry.name);

				try {
					if (entry.isDirectory()) {
						return await this.getCompactFiles(fullPath);
					}
					if (entry.isFile() && fullPath.endsWith(".compact")) {
						return [fullPath];
					}
					return [];
				} catch (err) {
					console.warn(`Error accessing ${fullPath}:`, err);
					return [];
				}
			});

			const results = await Promise.all(filePromises);
			return results.flat();
		} catch (err) {
			console.error(`Failed to read dir: ${dir}`, err);
			return [];
		}
	}
}

