/**
 * Zod schema for `compact.toml`. Cross-field rules: `profile.default_network`
 * must name a defined `[networks.X]`; `init_private_state` needs
 * `private_state_id`; a directory pattern needs `profile.src_dir`.
 */

import { z } from 'zod';
import { keyKind, resolveEntry } from './patterns.ts';

const url = z.string().url();

const profileSchema = z
  .object({
    default_network: z.string().optional(),
    artifacts_dir: z.string().default('src/artifacts'),
    deployments_dir: z.string().default('deployments/compact'),
    // Directory patterns in `[contracts]` match source paths under it.
    src_dir: z.string().optional(),
  })
  .default({});

const localWalletSchema = z.object({
  source: z.literal('local'),
  // Upper bound matches LOCAL_PREFUNDED_SEEDS' five slots.
  index: z.number().int().min(0).max(4).default(0),
});

const networkSchema = z.object({
  network_id: z.string().min(1),
  indexer: url,
  indexer_ws: url,
  node: url,
  node_ws: url,
  proof_server: z.union([url, z.literal('auto')]).optional(),
  wallet: localWalletSchema.optional(),
  // Optional block-explorer base URL (e.g. `https://preview.midnightexplorer.com`).
  // When set, the CLI prints `<explorer>/contracts/0x<address>` on a successful
  // deploy. Trailing slash is stripped at print time.
  explorer: url.optional(),
  // Optional sync tuning, per network. `sync_timeout` is the max seconds to
  // wait for the wallet to reach chain tip; `sync_batch_size` is the
  // dust/shielded sync batch size (raise for long-history networks like
  // preprod, default 5000). The matching CLI flags (`--sync-timeout`,
  // `--sync-batch-size`) override these when set.
  sync_timeout: z.number().int().positive().optional(),
  sync_batch_size: z.number().int().positive().optional(),
});

const walletObjectSchema = z.object({
  keystore: z.string().optional(),
});
const walletSchema = walletObjectSchema.optional();

const fileRefSchema = z.object({ file: z.string().min(1) }).strict();
const moduleRefSchema = z
  .object({
    module: z.string().min(1),
    export: z.string().default('default'),
  })
  .strict();
const fileOrModuleRefSchema = z.union([fileRefSchema, moduleRefSchema]);

const argsSchema = z.union([z.array(z.unknown()), fileOrModuleRefSchema]);

const contractFields = {
  artifact: z.string().min(1),
  private_state_id: z.string().optional(),
  init_private_state: fileOrModuleRefSchema.optional(),
  private_state_store_name: z.string().optional(),
  args: argsSchema.optional(),
  witnesses: fileOrModuleRefSchema.optional(),
  signing_key_file: z.string().min(1),
  // Verifier keys per transaction. Set it for a contract too large to deploy
  // in one tx: fragment 0 rides the deploy and the rest arrive as batched
  // maintenance updates within the same `deploy()` call. `--circuits-per-tx`
  // overrides it.
  circuits_per_tx: z.number().int().positive().optional(),
};

/** One `[contracts]` table; the keys matching a contract merge before validation. */
const contractEntrySchema = z.object(contractFields).partial();

/** A contract once its matching `[contracts]` tables merge. */
export const contractSchema = z
  .object(contractFields)
  .refine(
    (c) =>
      c.init_private_state === undefined || c.private_state_id !== undefined,
    { message: 'init_private_state needs private_state_id' },
  );

const rawConfigSchema = z
  .object({
    profile: profileSchema,
    networks: z.record(z.string(), networkSchema),
    wallet: walletSchema,
    contracts: z.record(z.string(), contractEntrySchema),
  })
  .refine(
    (c) =>
      c.profile.default_network === undefined ||
      Object.hasOwn(c.networks, c.profile.default_network),
    {
      message:
        'profile.default_network must reference a defined [networks.X] block',
      path: ['profile', 'default_network'],
    },
  );

type RawConfig = z.infer<typeof rawConfigSchema>;

// Piped so merged entries are checked only once every field parses, which
// keeps a bad field from being reported twice.
export const configSchema = rawConfigSchema.pipe(
  z.custom<RawConfig>().superRefine(checkContracts),
);

export type CompactConfigData = z.infer<typeof configSchema>;
export type NetworkConfig = z.infer<typeof networkSchema>;
export type ContractEntry = z.infer<typeof contractEntrySchema>;
export type ContractConfig = z.infer<typeof contractSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type WalletConfig = z.infer<typeof walletObjectSchema>;
export type FileRef = z.infer<typeof fileRefSchema>;
export type ModuleRef = z.infer<typeof moduleRefSchema>;
export type FileOrModuleRef = z.infer<typeof fileOrModuleRefSchema>;

export function isFileRef(v: unknown): v is FileRef {
  return typeof v === 'object' && v !== null && 'file' in v;
}

export function isModuleRef(v: unknown): v is ModuleRef {
  return typeof v === 'object' && v !== null && 'module' in v;
}

function checkContracts(c: RawConfig, ctx: z.RefinementCtx): void {
  const keys = Object.keys(c.contracts);
  const directory = keys.find((key) => keyKind(key) === 'directory');
  if (directory !== undefined) {
    if (c.profile.src_dir === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profile', 'src_dir'],
        message: `required by the directory pattern "${directory}"`,
      });
    }
    // Exact entries wait for `CompactConfig.load`, which has the source index.
    return;
  }
  for (const name of keys.filter((key) => keyKind(key) === 'exact')) {
    const { entry } = resolveEntry(name, c.contracts, undefined)!;
    const result = contractSchema.safeParse(entry);
    for (const issue of result.error?.issues ?? []) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contracts', name, ...issue.path],
        message: issue.message,
      });
    }
  }
}
