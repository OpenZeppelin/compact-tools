/**
 * Fragment sizes the node accepted after refusing a larger batch, per artifact
 * and network. In memory only, for the life of the process.
 */

const accepted = new Map<string, number>();

/** The size halving settled on for `artifactPath` on `network`, if it ran. */
export function rememberedSize(
  artifactPath: string,
  network: string,
): number | undefined {
  return accepted.get(keyOf(artifactPath, network));
}

/** Remember `size`, keeping a smaller one already held. */
export function rememberSize(
  artifactPath: string,
  network: string,
  size: number,
): void {
  const key = keyOf(artifactPath, network);
  const previous = accepted.get(key);
  accepted.set(key, previous === undefined ? size : Math.min(previous, size));
}

function keyOf(artifactPath: string, network: string): string {
  return JSON.stringify([artifactPath, network]);
}
