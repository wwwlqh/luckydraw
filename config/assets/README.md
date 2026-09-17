# `config/assets/`

One record per asset per chain, at `config/assets/<chainId>/<lowercase symbol>.json`, validated
against `config/schema/asset.schema.json` (the SPEC §15 Asset record, embedding the Price record).

`31337/` holds two clearly labeled local mocks for the anvil chain. `56/` holds one real-network
record: `usdt.json`, Binance-Peg USDT (ADR 037), written from facts read off chain 56 on 2026-09-17 and
kept at `status: "candidate"` because its admission is unfinished — the feed's p99.9 update interval is
still unmeasured and its exact-transfer evidence is still null, which rules `P6`–`P8` and `A7`–`A8` turn
into a hard failure the moment a mainnet manifest tries to list it. **No asset record may be added by
guessing, and a record's presence here is not admission.** Admission is an operator process (SPEC §3.1)
that ends with a human recording verified facts, not a convenience default.

## What a record must contain before an asset can be admitted

**Identity.** Address (or the `0x0000…0000` native sentinel), symbol, name and decimals. Only
exact-transfer, non-rebasing ERC-20s with 0–18 decimals and callable balance/transfer APIs qualify;
native BNB uses 18. A record's `native` flag, address and decimals must agree.

**Issuer review** (`issuerReview`). Upgradeability, freeze or blocklist powers, mint authority and
rebasing behaviour, with the date and source of the review. Deposit and withdrawal check exact
receipt and exact debit, which rejects taxed behaviour — but those checks cannot undo an issuer
freeze, a rebase, a seizure, a depeg or a later malicious upgrade. That residual risk is what this
review is for.

**Exact-transfer evidence** (`exactTransferEvidence`). What was actually observed, not an assertion
that the token "should" behave. A mainnet manifest is rejected if a non-native asset has none.

**A reference feed** (`price`). A Chainlink AggregatorV3-compatible official feed proxy, with chain,
quote direction, decimals, heartbeat, status and asset association verified at deployment:

- `feedDecimals` 0–18, equal to the value the feed reports.
- `heartbeatSeconds` H, with its verification source and date.
- `maxPriceAge` = `max(2H, 3600)`, and never outside 60–172,800 seconds (ADR 020). A feed whose
  heartbeat cannot fit this policy is ineligible for v1.
- `observedP999IntervalSeconds`, the measured p99.9 update interval, recorded by operators.
- `minAnswer`/`maxAnswer`, the aggregator's circuit-breaker bounds — or
  `answerBoundsConfirmedAbsent: true` to record that the absence was checked rather than skipped. An
  answer clamped at a bound is not a market price.
- `referenceKind`. Prefer `ExactToken`, a feed for the exact wrapped token. `UnderlyingAsset` is
  allowed only with a recorded `pegAssumption` and a visible `displayLabel` such as "USD estimate
  uses ETH reference price; Binance-Peg ETH can trade differently." The manifest supplies the
  wording; the frozen on-chain enum makes the app and Verify page show it.

No suitable reference feed means the asset is not enabled. USD 1 is defined by the disclosed
reference price, not by a guaranteed realizable sale value.

**Status and source.** `status` is one of `mock-local`, `candidate`, `approved`, `suspended`,
`rejected`, with a source URL and date. `mock-local` and `isMock` must agree, and neither may appear
on a real network. A mainnet manifest lists only `approved` assets.

## What lives here versus in a manifest

This record is the asset's identity and evidence. Its pool — `poolId`, `seedAmount`, `targetsUsd`
and `firstRoundIds` — is a deployment fact and belongs in
`config/deployments/<chainId>/<draw address>.json`, not here. A local mock whose address is assigned
when the deployment runs records `asset: null` and `price.feed: null`; a manifest always carries the
real addresses.
