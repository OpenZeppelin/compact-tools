import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactNotFoundError, ConfigError } from '../errors.ts';

/**
 * Parses an artifact's `contract/index.d.ts` and returns the ordered
 * constructor parameter names (with the trailing `_<digits>` SSA
 * suffix the Compact compiler appends stripped — `_name_2` → `_name`).
 * Used to reorder a named-object `args: { ... }` into the positional
 * tuple the contract's `initialState` expects.
 */
export function loadConstructorParamNames(artifactPath: string): string[] {
  const dtsPath = join(artifactPath, 'contract', 'index.d.ts');
  if (!existsSync(dtsPath)) {
    throw new ArtifactNotFoundError(
      `${artifactPath} (no contract/index.d.ts — cannot reorder named args)`,
    );
  }
  const source = readFileSync(dtsPath, 'utf8');
  const names = parseConstructorParamNames(source);
  if (names.length === 0) {
    throw new ConfigError(
      `Contract ${artifactPath} has a no-arg constructor; named args object should be empty`,
    );
  }
  return names;
}

/** Reorders a named-object args record into a positional tuple. */
export function reorderNamedArgs(
  named: Record<string, unknown>,
  paramNames: readonly string[],
): unknown[] {
  const missing = paramNames.filter((n) => !(n in named));
  if (missing.length > 0) {
    throw new ConfigError(
      `args object is missing constructor parameter(s): ${missing.join(', ')}`,
    );
  }
  const extra = Object.keys(named).filter((k) => !paramNames.includes(k));
  if (extra.length > 0) {
    throw new ConfigError(
      `args object has unknown constructor parameter(s): ${extra.join(', ')}. Expected: ${paramNames.join(', ')}`,
    );
  }
  return paramNames.map((n) => named[n]);
}

/**
 * Pulls the constructor parameter names out of a Compact artifact's
 * `index.d.ts`. The trailing `_<digits>` SSA suffix is stripped; if
 * stripping causes a collision in the same constructor, the original
 * names are kept.
 */
export function parseConstructorParamNames(dtsSource: string): string[] {
  const block = sliceInitialStateParams(dtsSource);
  if (block === null) return [];
  const params = splitTopLevelParams(block).slice(1); // drop `context: ...`
  if (params.length === 0) return [];
  const names = params.map(extractParamName);
  const stripped = names.map(stripSsaSuffix);
  return new Set(stripped).size === stripped.length ? stripped : names;
}

function sliceInitialStateParams(source: string): string | null {
  const head = source.indexOf('initialState(');
  if (head === -1) return null;
  const open = head + 'initialState('.length;
  let depth = 1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(open, i);
    }
  }
  return null;
}

function splitTopLevelParams(block: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(block.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = block.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

function extractParamName(raw: string): string {
  const colon = raw.indexOf(':');
  if (colon === -1) {
    throw new ConfigError(`Cannot parse constructor param: "${raw}"`);
  }
  return raw.slice(0, colon).trim();
}

function stripSsaSuffix(name: string): string {
  return name.replace(/_\d+$/, '');
}
