/**
 * Zod schema for `compact.toml` — the single source of truth for config shape.
 *
 * Top-level sections:
 *   [profile]      — defaults (artifacts dir, deployments dir, default_network).
 *   [networks.X]   — one block per target (URLs, optional faucet, optional
 *                    prefunded local-wallet pointer).
 *   [wallet]       — optional keystore path (passphrase-prompted at runtime).
 *   [contracts.X]  — per-contract: artifact ref, args, witnesses, init
 *                    private state, signing-key path (REQUIRED).
 *
 * Two `.refine()` cross-field rules:
 *   1. `profile.default_network` must reference a defined `[networks.X]`.
 *   2. `private_state_id` and `init_private_state` must both be set or both
 *      omitted (a contract either has private state or it doesn't).
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
  faucet: z.boolean().default(false),
  faucet_url: url.optional(),
});

const walletObjectSchema = z.object({
  keystore: z.string().optional(),
});
const walletSchema = walletObjectSchema.optional();

const fileRefSchema = z.object({ file: z.string().min(1) });
const moduleRefSchema = z.object({
  module: z.string().min(1),
  export: z.string().default('default'),
});
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

/**
 * Zod-inferred shape of a validated `compact.toml`. Used internally by
 * the {@link CompactConfig} class; not exported from the package barrel.
 */
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
