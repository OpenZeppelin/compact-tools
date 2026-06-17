/**
 * Zod schema for `compact.toml`. Cross-field rules: `profile.default_network`
 * must name a defined `[networks.X]`; `private_state_id` and
 * `init_private_state` are both-or-neither.
 */

import { z } from 'zod';

const url = z.string().url();

const profileSchema = z
  .object({
    default_network: z.string().optional(),
    artifacts_dir: z.string().default('src/artifacts'),
    deployments_dir: z.string().default('deployments/compact'),
  })
  .default({});

const localWalletSchema = z.object({
  source: z.literal('local'),
  index: z.number().int().min(0).max(3).default(0),
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

const contractSchema = z
  .object({
    artifact: z.string().min(1),
    private_state_id: z.string().optional(),
    init_private_state: fileOrModuleRefSchema.optional(),
    private_state_store_name: z.string().optional(),
    args: argsSchema.optional(),
    witnesses: fileOrModuleRefSchema.optional(),
    signing_key_file: z.string().min(1),
  })
  .refine(
    (c) =>
      (c.private_state_id === undefined) ===
      (c.init_private_state === undefined),
    {
      message:
        'private_state_id and init_private_state must be set together (or both omitted)',
    },
  );

export const configSchema = z
  .object({
    profile: profileSchema,
    networks: z.record(z.string(), networkSchema),
    wallet: walletSchema,
    contracts: z.record(z.string(), contractSchema),
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

export type CompactConfigData = z.infer<typeof configSchema>;
export type NetworkConfig = z.infer<typeof networkSchema>;
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
