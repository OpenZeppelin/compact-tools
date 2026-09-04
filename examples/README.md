# compact-tools examples

Runnable, copy-pasteable starting points for `compact-deployer`. Each example is self-contained: its own `compact.toml`, its own `package.json`, its own compiled artifact, and its own hand-written deploy script using the programmatic deployer API.

## Available examples

| Example | What it covers |
|---|---|
| [fungible-token/](./fungible-token/) | Deploys a small ERC20-flavoured contract wrapping OpenZeppelin Compact's `FungibleToken` module. Constructor exercises every common Compact primitive type: strings, `Uint<8/32/64/128>`, `Boolean`, `Bytes<8/32>`. |

More to come (private state + witnesses, multisig patterns, programmatic API).

## Conventions

- Each example builds and runs on Node 24+.
- Compiled artifacts are gitignored. Run `yarn compile` in the example before deploying; it needs the `compact` toolchain with compiler 0.31.1 installed.
- `deploy/*.signingkey` files are gitignored. Generate per the example README.
- `.states/` (wallet cache) and `deployments/` (deploy records) are gitignored.
- Compact-contracts modules (`FungibleToken`, `Initializable`, `Utils`) are vendored as byte-identical copies of [openzeppelin/compact-contracts](https://github.com/openzeppelin/compact-contracts) at commit `19b36a74`, not submodules. Each file's header names that commit; refresh by recopying from a newer one.
- These examples must stay compilable on compactc 0.31.1, which is what the deployer's compact-runtime 0.16.0 pin requires. Compact-contracts `main` has since moved to compiler 0.34 / runtime 0.19, so its newer sources will not drop in unchanged.

## Setup

Each example is a yarn workspace member, so a single root-level install wires every binary (`compact-compiler`, `compact-deploy`) into the example. From the repo root:

```bash
yarn install
yarn build
```

After that:

```bash
cd examples/<name>
yarn compile        # rebuild the artifact if you edit a .compact file
yarn deploy:local   # run the example
```
