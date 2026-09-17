# `config/`

Versioned configuration records for LuckyDraw (SPEC §12 and §15). Every document here is public,
machine-checked JSON. No secrets, no RPC URLs, no signer identities, no host inventory: those live in
environment variables or in the ignored `/.private/` directory and are referenced by name only.

## Directories

| Directory | Holds | Schema |
|---|---|---|
| `schema/` | The JSON Schema (draft 2020-12) for each §15 record | — |
| `chains/` | One record per chain: `<chainId>.json` | `chain.schema.json` |
| `assets/<chainId>/` | One record per admitted asset: `<lowercase symbol>.json` | `asset.schema.json` |
| `deployments/<chainId>/` | Deployment manifests `<lowercase draw address>.json` and operator plans `<name>.plan.json` | `deployment.schema.json`, `deployment-plan.schema.json` |
| `operations/` | Keeper, RPC, alerting, backup and finality facts per deployment | `operations.schema.json` |
| `hosting/` | Logical host roles and sanitised configuration | `hosting.schema.json` |
| `release-authority/` | Custody, review policy, approval and provenance per deployment | `release-authority.schema.json` |
| `acceptance/` | Measured release evidence per deployment | `acceptance.schema.json` |

The last four directories are created when the first record of that kind is written. The validator
checks whatever exists.

## Naming rules

- A chain record's file name is its `chainId`: `chains/56.json`.
- An asset record's directory is its `chainId` and its file name is its lowercase `symbol`:
  `assets/31337/test2.json`.
- A deployment manifest's directory is its `chain.chainId` and its file name is the lowercase Draw
  address: `deployments/31337/0x….json`.
- A plan's file name ends in `.plan.json`; if the document carries a `name`, it must match the file.

`deploymentId` is `${chainId}:${lowercase Draw address}` everywhere — API, caches, keeper and manifest
(SPEC §10.3). A colon cannot appear in a Windows file name, so the **file** is named after the Draw
address alone while the **field** keeps the full `chainId:address` form. The validator checks that the
two agree, so nothing is lost by the shorter file name.

## Conventions inside a document

- Addresses are lowercase `0x` + 40 hex. `0x0000…0000` is the native BNB sentinel (`Types.sol`).
- `bytes32` values (code hashes, key hashes, transaction hashes) are lowercase `0x` + 64 hex.
- `uint256` values are decimal strings, never JSON numbers, and are range-checked against 2^256-1.
- Timestamps are UTC with an explicit `Z`; dates are `YYYY-MM-DD`.
- Every file is LF-terminated (`.gitattributes`); the validator rejects CR bytes.
- An asset's optional `requiresZeroReset` is `false` when absent. Set it to `true` only for a token whose
  `approve` reverts unless the current allowance is zero (the USDT pattern): the app then presents
  `approve(0)` and `approve(amount)` as two explicit steps instead of one `approve(amount)` (SPEC §9.5).
  Getting it wrong in this direction costs one extra transaction; getting it wrong in the other costs a
  reverted approval with the user's gas spent, so record it at admission. Native BNB has no `approve`, so the
  native asset may never set it.
- A price record's `observationWindow` is `{fromBlock, toBlock, samples}`: the block range and sample count
  `observedP999IntervalSeconds` was computed over, as printed by the feed observation script. A mainnet record
  carries both (rules `P6`–`P8`); elsewhere it may be null or absent. `observedP999IntervalSeconds` must be at
  or below `maxPriceAge`; it is deliberately *not* required to be at or above `heartbeatSeconds`, because a
  deviation-driven feed updates far more often than its heartbeat.
- A deployment manifest may carry an optional top-level `release` object:

  ```json
  "release": {
    "customerLaunch": false,
    "shakedown": {
      "performed": true,
      "date": "2026-09-20",
      "roundIds": [7, 8],
      "callbackGasUsed": 118000,
      "requestToFulfilmentSeconds": 92,
      "costPerDrawNativeWei": "2500000000000000"
    }
  }
  ```

  An **absent `release` object means `customerLaunch: false`**. `shakedown` is null until the private mainnet
  shakedown is played (SPEC §14): the operator alone plays one full daily round and one refund path and records
  the measured numbers here. `customerLaunch` may only be true once `shakedown.performed` is true (rule `D26`),
  and a performed shakedown must carry all of its measurements (rule `D27`). The pre-deploy
  `vrf.measuredCallbackGasUsed` is the Foundry measurement from the contract suite; the mainnet observation is
  `release.shakedown.callbackGasUsed`, not that field.

  Rule `D27` also rejects a measurement that **could not have been taken**, because a number nobody measured
  reads as evidence: `callbackGasUsed` is at least 1 and at most `vrf.callbackGasLimit` (the coordinator caps
  the callback there, so a larger figure was never observed), `requestToFulfilmentSeconds` is at least 1 (the
  fulfilment lands whole confirmations after the request), `costPerDrawNativeWei` is never `"0"` (a draw pays
  the coordinator's premium and the keeper's gas) and `shakedown.date` is not earlier than the manifest's
  `createdAtUtc` date (the shakedown is played on the deployed contracts). The schema carries the three
  field-level minimums; the two comparisons against other fields are validator rules.
- A release-authority record's `custody.recoveryDrill` records where the drill happened, not only that it
  happened: `chainId` (the chain whose Safes were drilled) and `safes` (`{owner, treasury, seed}`) join the
  existing `performed`, `date`, the three outcome booleans, `treasuryWithdrawalProven` and `receiptRefs`. The
  drill is performed on the **mainnet** Safes before the contracts are deployed (SPEC §10.5 and §14), so
  `date` may not be later than the manifest's `createdAtUtc` date (rule `RA2`); `receiptRefs` holds pointers to
  the receipts, never the restricted material itself (SPEC §15).
- A mainnet deployment manifest is not valid on its own: **every** mainnet manifest needs a release-authority
  record carrying the same `deploymentId`, and that record must itself be `"environment": "mainnet"` (rule
  `RA3`). The rule is not limited to `release.customerLaunch`, because the drill is a gate on Deploy and not on
  launch day: by the time a manifest exists, the mainnet Safes already hold the owner, treasury and seed roles.
  Write the release-authority record first.

## Mocks

A mock exists only in the `local` environment. The validator rejects any `testnet` or `mainnet`
document whose `mocks` list is non-empty, or that sets `isMock`, `feedIsMock` or `coordinatorIsMock`
to true. **A mainnet manifest may reference no mock artifact** (SPEC §12): a chain, subscription or
feed problem fails the release, it is never silently replaced with a mock.

Asset admission is an operator process (SPEC §3.1), so no asset record is invented here. `assets/31337/`
holds two clearly labeled local mocks; `assets/56/usdt.json` is the one real-network record, a
**candidate** whose verified facts were read off chain 56 and whose missing evidence is named in the
record itself (ADR 037). `assets/README.md` states the evidence a real admission needs.

## Running the validator

```sh
pnpm install --frozen-lockfile
pnpm validate:config          # node scripts/validate_config.ts
pnpm test:config              # node --test scripts/validate_config.test.ts
```

`validate:config` walks `config/`, validates each document against the schema its directory implies,
applies the cross-field rules, prints one line per document and exits 1 if anything failed. Both
commands run in CI (`.github/workflows/ci.yml`, the `docs` job) as the §11.2 "config schema
validation" step. It needs no network access and reads no secrets.

Pass a directory to check a different tree: `node scripts/validate_config.ts some/other/config`.

## Verifying a chain record against a node

`networkIdentity.genesisHash` and `networkIdentity.multicall3` are the two chain-record fields only a node can
settle, and rule CH4 fails a chain record that still holds a null in either once a mainnet manifest exists.
Get them with:

```sh
pnpm check:chain --rpc-url "$LUCKYDRAW_OPS_RPC_URL" --chain-id 56 \
  --multicall3 <the address you read from the Multicall3 deployments page today>
```

The script reads `eth_chainId`, the block 0 hash and the code at that address, calls `getBlockNumber()` and
`aggregate3([getBlockNumber(), getChainId()])` through it, checks the answers against `eth_blockNumber` and
against the record, and prints the `networkIdentity` object to paste. It never writes the file and it never
prints the RPC URL. Set `"source".url` to the page the address came from before committing, then run
`validate:config`.

## Observing a feed's update interval

`observedP999IntervalSeconds` and `observationWindow` in a price record are measurements, not estimates.
Take them from chain history before admitting a feed:

```sh
LUCKYDRAW_OPS_RPC_URL=<keyed endpoint> \
  pnpm observe:feed --feed <aggregator proxy> --days 30 --heartbeat <documented H>
```

It walks the proxy's round history back `--days` (across the `phaseId` boundary into the previous
aggregator when the window reaches that far) and prints the p50, p99 and p99.9 update interval, the
observed min/max answer, the block window, `maxAge = max(2H, 3600)` and whether p99.9 fits inside it
(SPEC section 3.1, ADR 020). It exits non-zero when it does not; a feed that fails here is ineligible. Copy the
printed fragment into the record's `price` object by hand: the script is read-only and writes no file. Pass
`--heartbeat` always, or the `maxAge` check does not run. Pass `--rpc-url` instead of the variable only on a
host with no shell history: an operational endpoint is usually itself a credential, and every line the script
prints has its URLs replaced by `<rpc>`. A rate-limited public endpoint aborts the run rather than shortening
the history; lower `--concurrency` (default 8) on such an endpoint.

## Cross-field rules the schemas cannot express

The schema file for each record carries the field-level constraints. These relationships are checked
in `scripts/validate_config.ts`, each with a rule tag that appears in its error message:

| Tag | Rule |
|---|---|
| `G1` | Every decimal string fits in `uint256` |
| `G2` | No CR bytes; the repository is LF |
| `L1` | A JSON document's directory must imply a schema |
| `TPL` | `"template": true` is a blank form and is always rejected |
| `CH1`/`CH2` | A chain record is named after its chain id and agrees with that chain's public identity. On chains 56 and 97 that identity includes the player-facing `displayName` ("BNB Smart Chain" and "BNB Smart Chain Testnet"), alongside `nativeSymbol` and `explorerUrl`; CH2 applies to the chain record and to the copy a manifest or plan embeds, so no build can name a testnet as if it were mainnet |
| `CH4` | When any mainnet manifest is in the tree, `config/chains/<its chainId>.json` must exist with non-null `networkIdentity.multicall3` and `genesisHash` (cross-record) |
| `A1`–`A8` | Asset path, symbol/file agreement, native/zero-address/18-decimals agreement, mock labelling, mainnet evidence |
| `A9` | Optional `requiresZeroReset` is a boolean (absent means false) and is never true on the native asset |
| `P1`–`P5` | `maxPriceAge = max(2H, 3600)` within 60..172,800, with a documented heartbeat `H` required outside `local` (a null or absent `heartbeatSeconds` is a local-mock escape hatch only, SPEC §3.1 and §15); `minAnswer < maxAnswer`; `UnderlyingAsset` needs a label and a peg assumption |
| `P6`–`P8` | A mainnet price record carries a measured `observedP999IntervalSeconds` at or below `maxPriceAge`, with the `observationWindow` (`fromBlock`, `toBlock`, `samples`) it was measured over |
| `M1` | Nothing marked mock outside `local` |
| `E1` | `environment` and `chainId` agree (mainnet is 56, testnet is 97). On a release-authority record, which has no `chainId` of its own, the chain is the chain half of its `deploymentId` |
| `D1`–`D3` | `deploymentId`, directory and file name all agree with `contracts.draw.address` |
| `D4` | No mock artifacts outside `local` |
| `D8`–`D11` | The Draw `constructorArgs` record exists and matches the Vault, VRF and ownership records |
| `D12`/`D13` | Pool ids are unique and `firstRoundIds` increase strictly across pools |
| `D15` | `seedAmount` is within the authorized per-round cap |
| `D16` | Accepted ownership leaves both contracts owned by `finalOwner` with nothing pending |
| `D17`/`D25` | Deploy blocks are at or above `startBlock`; Vault and Draw are distinct |
| `D22` | A mainnet deployment has a registered VRF consumer |
| `D26` | `release.customerLaunch` is true on mainnet only once `release.shakedown.performed` is true (SPEC §14) |
| `D27` | A performed shakedown records its date, round ids, callback gas, request-to-fulfilment latency and cost per draw, and each is a value a real fulfilment could produce: `0 < callbackGasUsed <= vrf.callbackGasLimit`, `requestToFulfilmentSeconds >= 1`, `costPerDrawNativeWei != "0"`, and `date` at or after the manifest's `createdAtUtc` |
| `O1`/`O2w` | Mainnet needs three distinct Safes; testnet may share one (SPEC §12.1) |
| `O4` | Mainnet needs a nonzero `makeWholeReserve` and `makeWholeCap`; `local` and `testnet` may leave them null or `"0"` |
| `T1` | `toolchain` matches the pins in `contracts/foundry.toml` |
| `V1` | `maxRequestCostNative` covers its own recorded derivation |
| `OP1`–`OP3`, `AC1`/`AC2` | Operations and acceptance record minimums |
| `RA1` | A mainnet release-authority record declares separate owner, treasury and seed Safes |
| `RA2` | The recovery drill was performed on the **mainnet** Safes: `performed`, `unavailableSignerPassed`, `compromisedSignerBlocked`, `signerReplacementPassed` and `treasuryWithdrawalProven` all true, a `date`, `chainId` equal to the chain in the record's `deploymentId`, `safes` equal to the manifest's `ownership.finalOwner`/`feeAccount`/`seedAccount` and a `date` no later than that manifest's `createdAtUtc` (cross-record), and at least one `receiptRefs` pointer |
| `RA3` | Every mainnet manifest is covered by a release-authority record with the same `deploymentId` (reported on the manifest), and every record covering one is itself `environment: "mainnet"` (reported on the record), so a missing or `testnet`-labelled record can no longer exempt a deployment from `RA1` and `RA2` (cross-record) |

Tags ending in `w` are warnings: they are printed but do not fail the run.

Three rules relate documents rather than fields: `CH4` (mainnet manifest → chain record), the `safes` and
`date` halves of `RA2` (release-authority record → the manifest with the same `deploymentId`) and `RA3` (mainnet
manifest → the record that covers it). They run after the whole tree has been read, and each error is attached
to the document that has to change. A comparison whose other document is not in the tree is skipped rather than
guessed at, except `CH4` and `RA3`, where a missing chain record or a missing release authority is itself the
failure. Release-authority records are matched by `deploymentId`, so their file name is free; the checked-in
fixture uses the chain slug.
