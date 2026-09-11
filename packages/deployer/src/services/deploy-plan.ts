/**
 * Partitions a contract's circuits into deploy fragments. Fragment 0 rides the
 * deploy tx; every later fragment becomes one batched verifier-key insert.
 *
 * The budget is always explicit or derived by halving on a rejection: the node
 * cannot weigh a transaction before submission, so there is nothing to plan
 * against.
 *
 * Pure: no clock, no randomness, no I/O, so a rerun after an interruption
 * rebuilds the same plan.
 */

export interface Fragment {
  readonly index: number;
  readonly circuits: readonly string[];
}

export interface DeployPlan {
  /** The artifact's circuits, sorted. */
  readonly circuits: readonly string[];
  /** Pairwise-disjoint, jointly equal to {@link DeployPlan.circuits}. */
  readonly fragments: readonly Fragment[];
}

/**
 * Code-unit sort. `localeCompare` would reorder the same circuit list under a
 * different `LANG`, and the fragment plan has to be reproducible across hosts.
 */
export function sortCircuits(circuits: readonly string[]): string[] {
  return [...circuits].sort();
}

/**
 * INV-1, INV-2: split sorted `circuits` into fragments of at most `budget`
 * each. Validated at the edges (TOML schema, argv, `Deployer.prepare`), so
 * `budget` is trusted to be an integer of at least one.
 */
export function planFragments(
  circuits: readonly string[],
  budget: number,
): DeployPlan {
  const sorted = sortCircuits(circuits);
  const fragments: Fragment[] = [];
  for (let i = 0; i < sorted.length; i += budget) {
    fragments.push({
      index: fragments.length,
      circuits: sorted.slice(i, i + budget),
    });
  }
  return { circuits: sorted, fragments };
}

/** INV-10: artifact circuits absent from `onChain`, sorted. */
export function remaining(
  circuits: readonly string[],
  onChain: readonly string[],
): string[] {
  const present = new Set(onChain);
  return sortCircuits(circuits).filter((c) => !present.has(c));
}

/** Circuits of `fragment` that are not yet on chain, in plan order. */
export function fragmentRemainder(
  fragment: Fragment,
  onChain: readonly string[],
): string[] {
  const present = new Set(onChain);
  return fragment.circuits.filter((c) => !present.has(c));
}
