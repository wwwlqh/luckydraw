# Configuration fixtures

Synthetic configuration trees for `scripts/validate_config.test.ts`. Nothing here is a deployment.

Every address, key hash, code hash and transaction hash is a repeated-nibble placeholder
(`0x1111...1111`, `0xaaaa...aaaa`) chosen so that it cannot be mistaken for a real contract, and every
tree lives under `scripts/`, never under `config/`, so the validator's own run over the repository
never reads them. The VRF cost parameters are round synthetic numbers, not measured BSC lane values.

Three roots are checked in and must pass with no errors and no warnings:

| Root | What it is |
|---|---|
| `valid-local/` | A local anvil manifest with labeled mocks, two pools and a chain record |
| `valid-mainnet/` | A mainnet-shaped manifest (no mocks, three distinct Safes, ownership accepted, a funded make-whole reserve, an observed feed interval with its window), the chain 56 record its identity is checked against, and the release-authority record carrying the recovery drill |
| `valid-plan/` | A testnet operator plan: no deployed facts, no template flag |

The failing cases are derived from these roots inside the test: each one copies a root to a temporary
directory, applies a single named mutation, and asserts that the validator fails for that reason and
no other. Deriving them keeps every failing case one documented edit away from a passing document, so
a fixture can never drift into failing for an unrelated reason.

`valid-mainnet/` holds three documents because three rules relate documents rather than fields: `CH4` reads the
chain record a mainnet manifest implies, the `safes` and `date` halves of `RA2` compare the recovery drill
against the manifest's ownership and `createdAtUtc`, and `RA3` requires the release-authority record to exist
at all. The drill in `valid-mainnet/release-authority/bsc-mainnet.json` is dated 2026-09-10, one day before the
manifest's `createdAtUtc`, because the drill happens before Deploy. The genesis hash and Multicall3 address
in `valid-mainnet/chains/56.json` are repeated-nibble placeholders that exist only so `CH4` has something
non-null to accept; the real values are verified by the operator against the live chain and never copied from
memory into `config/`.
