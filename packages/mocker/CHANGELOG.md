# Changelog

All notable changes to `@openzeppelin/compact-mocker` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `compact-mock` bin, a launcher that downloads the [`compact-mock`](https://github.com/OpenZeppelin/compact-tools/tree/main/crates/compact-mock) release binary for the host, verifies its SHA-256 against the package's `checksums.txt`, caches it, and runs it (#247)
- The `compact-mock` binary, a mock contract generator for Compact modules. `generate` writes the mocks the `[mock]` table of `compact.toml` describes; `build [+<version>]` also compiles each one with `compact compile`, honouring `--skip-zk` and `SKIP_ZK` (#247)
- `[[mock.rules]]` select modules by glob and apply in file order, a later rule replacing only the keys it sets. Keys: `exclude`, `disclose`, `guard`, `rename`, `init`, `ledger`, `ledger_names`, `module_args`, `circuit_args`, `salt`, `include` and `implements` (#247)
- Named authenticators under `[mock.auth.<name>]`: each gives a mock that injects its call in place of the caller, beside the `*Caller` mock that takes the caller as an argument. Injectors under `[mock.inject.<name>]` fill other parameter types the same way (#247)
- `instances` give several mocks of one module, and `merge` or `group` puts several instances in one mock. Overloaded circuits get numbered names unless `rename` picks one by signature (#247)
- Mocks are written to each module's `test/artifacts/` directory and are not committed. A stamp file marks the directories the tool owns; it deletes the mocks no rule produces any more and never writes into a directory it does not own (#247)
- A hand-written `<test_dir>/<Mock>.fragment.compact` is included in the generated mock. A run with any config, source or planning error writes nothing (#247)
