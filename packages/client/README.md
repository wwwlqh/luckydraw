# `@luckydraw/client`

Shared client library for the web app, indexer and keeper (SPEC §10.1, §12). Everything a consumer needs to
read LuckyDraw state, quote an entry, build a transaction, decode a revert or render a number lives here, so
no page, worker or service ever does an ad hoc RPC scan or reimplements the spec math.

## Rules

- **Erasable TypeScript only.** Sources run directly under `node --test` on Node 24 (type stripping), so the
  code stays inside the erasable subset: no `enum`, no `namespace`, no parameter properties, no `const enum`.
  `tsconfig.json` enforces this with `erasableSyntaxOnly`. Relative imports carry the `.ts` extension;
  `tsc -p tsconfig.build.json` rewrites them to `.js` when emitting `dist/` for consumers.
- **bigint everywhere.** Every ABI integer (uint8 through uint256, int256, timestamps) is a `bigint` in the
  public types. The only exceptions are Solidity enums, which are the numeric literal unions in `types/`.
  Nothing converts a chain integer to a JS `number` except the display helpers in `format/`.
- **Addresses and hashes are lowercase strings.** `Address` is `0x` + 40 lowercase hex; `Hex32` is `0x` + 64
  lowercase hex. Compare with `===` after lowercasing at the boundary, never with a checksum compare.
- **Generated code is committed and checked.** `scripts/generate.ts` reads `contracts/out/` (after
  `forge build`), `contracts/src/Types.sol` and `contracts/src/Errors.sol` and writes `src/abi/generated/` and
  `src/types/generated.ts` (enums, structs, event argument records, topic and selector tables, the project
  error list). `pnpm abi:check` fails when the committed output is stale. Never hand-edit generated files.
- **Math mirrors the vectors.** `src/math/` must reproduce every vector in
  `contracts/test/vectors/spec_vectors.json` (SPEC §11.2 "Math"). Vectors are regenerated only by
  `scripts/spec_reference.py`.
- **No keys, no secrets, no signing.** The library encodes calldata and decodes results. Signing belongs to the
  user's wallet (web) or the operator's keeper process; neither passes through here.
- **Snapshots are consistent.** Related reads use one block (Multicall3 where the manifest lists it, otherwise
  individual calls pinned to one explicit block number) and return `chainId`, `blockNumber`, `blockHash`,
  `timestamp` and `confidence` with the values (SPEC §10.1).
- **Manifest first.** Consumers load a deployment manifest from `config/deployments/`, verify chain id and code
  hashes against the connected node, and only then read or write. Logs are accepted only from the manifest
  Vault and Draw addresses.

## Modules

| Directory | Owns | Notes |
|---|---|---|
| `src/abi/` | Generated ABI constants (`as const`) for LuckyVault, LuckyDraw, Multicall3 and AggregatorV3, plus `normalize.ts`, the ABI-driven conversion of decoded values into the generated bigint/enum types | Generated files are written by `scripts/generate.ts`; `normalize.ts` is hand-written and reads `internalType` |
| `src/types/` | Generated enums and struct types plus hand-written snapshot, event and manifest types | Enum member order is the ABI order from `Types.sol` |
| `src/math/` | Fee partition, USD minimum and value, target gross, calendar cutoffs, 512-bit modular index, binary search, price validation | Pure functions over `bigint`; vector tests |
| `src/format/` | Number, percentage and date formatting per SPEC §9.7; decimal input parsing | `Intl.NumberFormat` with an explicit locale |
| `src/deployments/` | Manifest parsing into typed records, identifier agreement, chain-id and code-hash verification, asset listing | SPEC §12, §15, A37, U15 |
| `src/errors/` | Revert decoding (custom errors, `Panic`, `Error(string)`, unknown data), with a token's bytes attributed to the token for allowance steps and token-calling Vault writes | Never a raw stack trace (SPEC §8.1) |
| `src/catalog/` | The externalized string catalog: every custom error, Panic code, QuoteReason and wallet condition with message, funds effect and next action | SPEC §9.6, §9.7 |
| `src/events/` | Typed log decoding with the emitter filter and the FundsLocked/EntryBought correlation key | SPEC §10.1 |
| `src/reads/` | Provider-backed snapshot reads and adapters returning the bigint types; quotes come stamped with the round, buyer and asset they were read for | One block per snapshot, re-checked by hash when pinned to the head |
| `src/writes/` | Calldata builders with the decoded summary shown before every wallet prompt, the quote-context binding, deadline and `minNetContribution` guard, the ERC-20 allowance steps | SPEC §5.3, §9.5, §9.6 |
| `src/e2e/` | Opt-in local end-to-end journey against anvil (`LUCKYDRAW_ANVIL=1`): deploy through the Foundry scripts, verify, read, deposit, quote, enter, close | Needs `forge` and `anvil` on PATH; skipped otherwise |

## Commands

```sh
pnpm --filter @luckydraw/client abi:generate   # after forge build
pnpm --filter @luckydraw/client abi:check
pnpm --filter @luckydraw/client typecheck
pnpm --filter @luckydraw/client test
LUCKYDRAW_ANVIL=1 pnpm --filter @luckydraw/client test   # also runs the anvil end-to-end journey
pnpm --filter @luckydraw/client build
```

Enum names and values, struct shapes and error lists are generated from the contracts; the math module is
checked against the reference vectors; the catalog is checked for completeness against `Errors.sol`,
`Types.sol` and the generated ABIs. Adding a contract error, enum member or event therefore fails a client
test until the client is updated, which is the intended coupling.
