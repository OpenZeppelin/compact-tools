// Deploy script for TokenExample. The curried call form names the
// contract once via the imported `Contract` class — the deployer
// matches it to the `[contracts.TokenExample]` entry in compact.toml
// by class identity. Constructor args are typed function parameters,
// so the editor shows each param's name + type as you type each comma.

import { runDeploy } from '@openzeppelin/compact-deployer';
import { Contract } from '../artifacts/TokenExample/contract/index.js';

await runDeploy(Contract)(
  'OpenZeppelin Example Token',
  'OZE',
  18n,
  new Uint8Array(32).fill(0xab),
  1_000_000_000_000_000_000_000_000n,
  250n,
  7n,
  true,
  new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe]),
);
