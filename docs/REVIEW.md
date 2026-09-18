# Specification review — 2026-09-11

Review scope: documentation and proposed architecture. No contracts or tests exist yet. The v4 source and the v7 draft were archived beside this file until 2026-09-11 and have since been removed; current requirements belong in `SPEC.md`.

## Pass 1: accounting and authority

| v4 finding | v5 resolution |
|---|---|
| Vault invariant referenced committed funds owned by Draw; totals unspecified | Vault owns available/per-round escrow totals with a conservation table. |
| Debit/credit omitted round ID required by events | Register/lock/release require round ID and bound releases to its escrow. |
| Price/fee recipient not snapshotted | Freeze both along with asset/rate/calendar terms. |
| Deposit delta treated taxed/rebasing tokens as safe | Exact-transfer allowlist and external-token limitations. |
| Absolute withdrawal/operator-independence claims | Explicit transfer assumptions and Draw's actual authority. |

## Pass 2: lifecycle and oracle failure

| v4 finding | v5 resolution |
|---|---|
| Failed request reverts draw/successor | Separate close/advance from request. |
| 24h refund can race an unfavorable exposed VRF result | No post-acceptance cancellation; indefinite-lock risk is a launch gate. |
| Timeout measured from close for late requests | Pre-request deadline; post-request alerts use requestedAt. |
| Callback searches/releases funds and can revert | Store word only; separate public settlement; duplicate/unknown authenticated callbacks return. |
| Backdated successor can already be expired | Actual creation time, next boundary, skip missed periods. |
| Exactly one Open conflicts with disabled pools | At most one; explicit zero-pointer and re-enable behavior. |
| Proportional cap rejects first buyer | No address cap; no person-level identity claims. |

## Pass 3: implementation structure and evidence

Order now follows scope, architecture, authority, custody, data, lifecycle, integration, clients, operations, verification, layout, decisions and delivery gates. History is separated from current requirements.

Added event/read contracts, pagination, raw-unit arithmetic, rounding, reorg cache handling, partial-history labels, transaction states and per-asset leaderboard definitions. Chose a coherent Foundry test layout. Distinguished state invariants from temporal progress tests; removed claims that contracts/tests/ADR files already exist.

Dependency authority must be reviewed against pinned VRF code. Confirmations/callback gas need value-at-risk review and measurement. One day of testnet operation does not test monthly/weekly calendars; local time travel supplies that coverage.

## Material design change

v5 preserves an accepted draw rather than guaranteeing a refund deadline. If VRF never delivers, escrow can remain locked indefinitely. This is a proposed design requiring launch acceptance, not recorded user approval. Assets/prices, exposure limits, fees, jurisdiction and contract-wallet limitations remain open.

This is a specification review, not a contract audit. Document checks validate section/property IDs and generated consistency; implementation behavior requires future tests.


## v6: user product clarification

User confirmed zero platform fees on deposits/withdrawals, USD 1 minimum bet, no maximum, and 1/3/7-day options followed by results/distribution. Removed the assumed 3% fee/5% ceiling and calendar-month scheduling. Purchase fee accounting, exact cutoff convention and USD enforcement remain explicit implementation questions. Existing one-winner/ticket representation remains a draft assumption. Prior v5 descriptions above are historical.


## v7: confirmed fee and schedule synchronization

The user confirmed 3% deducted at entry (1.00 gross = 0.97 pot + 0.03 fee) and fixed UTC calendar boundaries. Removed stale pending-rate/elapsed-duration language and owner fee changes. Defined explicit epoch-anchored 3-day and Monday weekly schedule defaults, without monthly resets. Corrected escrow property to account for fee reserves if adopted. Fee rounding/custody/refunds, USD valuation and entry weights remain unresolved; the document is not implementation-complete.


## v8: implementation baseline completed

The user delegated completion of the remaining specification choices. Resolved USD minimum using fresh reference feeds, continuous raw-asset ownership weights, cumulative 3% rounding, gross escrow, fees earned only at settlement and full gross refunds on pre-request cancellation. Fixed UTC anchors remain explicit. Removed provisional game/accounting language while preserving external release gates and admitted limitations.

Changed weights from uint96 to uint256 and specified two-word modular reduction so the no-product-cap policy does not silently create a large single-word modulo bias. Inspected the upstream V2Plus consumer: its non-virtual mutable coordinator setter prevents the previously suggested simple override. Specified a minimal immutable authentication adapter with pinned official request interfaces, explicit audit scope, 200 confirmations and a measured callback budget.

Added complete public/admin flows, transaction states, read/index API and reorg recovery, keeper operation, deployment records and traceable acceptance. Added independent math reference: 108,692 assertions passed for USD/freshness, fees, weighted ranges, 512-bit modulo, UTC cutoffs and settlement/refund conservation. Section/property/HTML-anchor checks passed. These are documentation/reference checks; contract, UI, real oracle and audit checks remain unimplemented. See SPEC_CHECKS.json and ACCEPTANCE.md.

The preceding v7 spec was archived as SPEC-v7.md and later removed. One-shot revision scripts were removed after use; only maintained render/reference tools remain. No product claim of perfect safety or guaranteed accepted-request recovery is made.

## v8 implementation-readiness pass (2026-09-11)

Read the whole specification as an implementer would and checked it against `ACCEPTANCE.md`, the reference script and the render checks. No financial, schedule or selection rule changed; the reference vectors pass unchanged. Findings and the resolutions applied to `SPEC.md`:

| Finding | Resolution |
|---|---|
| PricingConfig existed only in prose and included a free-text "pricing description" that every frozen round would have copied | Concrete one-slot struct with a `ReferenceKind` enum (ADR 019); peg wording moved to the deployment manifest; `referenceKind` added to RoundOpened and the §15 price record. |
| `quoteBuy` returned an unspecified "reason code" | `QuoteReason` enum defined in buy's check order; quote never reverts. |
| `buy` at or after cutoff had no matching error, and the error list named a coordinator setter that does not exist | Added `EntryWindowClosed` and `InvalidRequestId`; removed the setter wording. |
| `getRequest(id)` did not say which ID; Draw had no Vault getter for token decimals | `getRequest(requestId) returns (roundId)`; Vault `getAsset(asset)` added; `getPosition` fields listed. |
| "Advance current" and the successor's frozen terms were implied across §6.1 and §6.2 | Defined once in §6.1; every `closeRound` branch restates `now>=closesAt`; RoundNotClosed and EntryWindowClosed named. |
| playerCount increment rule, callback entry point, Draw immutables, Draw guard scope and `listAsset` decimals check were implicit | Stated in §5.3, §7.1, §5.1, §4.2 and §8.1. |

Stale archives `SPEC-v4.md` and `SPEC-v7.md` were deleted; this file keeps their history. `render_spec.py` and `spec_reference.py` now refresh their own fields in `SPEC_CHECKS.json`, so the recorded source hash cannot drift from the Markdown unnoticed.

Left as recorded tunables, not defects: maxPriceAge=2H is tight for 27-second heartbeats (a late feed round rejects a buy with PriceStale until the next update); 200 request confirmations add minutes of latency before fulfilment. Both are deployment parameters in §15.

## Product changes 2026-09-11: durations and customer experience

The user changed the three durations from 1-day/3-day/7-day to 1 day, 1 week and 1 calendar month (UTC). This supersedes the v6/v7 record above. Daily and weekly formulas are unchanged; the monthly cutoff is 00:00 UTC on the first of the next month, computed on-chain with Hinnant's civil-date algorithms and checked in `spec_reference.py` against Python's calendar for every day from 1970 to 2100. Section 9 was rewritten as a customer-experience and interface-design specification: experience principles, Polymarket-style wallet connection on BSC (EIP-6963 discovery, WalletConnect v2, chain switch and add), a design system, page layouts, entry disclosures, transaction feedback and accessibility. Email or social login with embedded wallets stays out of v1 because it adds third-party key custody. A public Help route was added. `ACCEPTANCE.md` gained U17–U19, A14 now covers week and month boundaries, and U11 counts eight public routes.

## Multi-aspect review 2026-09-11: security, latency, UX, operations, verification

Five independent reviews were run against the v8 text, one per lens, each instructed to drop anything the spec already covered and to propose pasteable text. Confirmed product rules were out of scope for challenge. Findings accepted into `SPEC.md`:

| Lens | Accepted changes |
|---|---|
| Latency and gas | Stated cutoff-to-credit timeline (about four to six minutes healthy, “usually within about ten minutes” in the app); display confirmation uses the `finalized` tag with a 200-block fallback and “included” unlocks the next user step; Multicall3 batching, refresh cadence and a 30-requests-per-minute idle budget; per-function gas targets; a mobile performance budget; keeper concurrency (consecutive nonces, extra cycle at 00:00:01 UTC); maxPriceAge = max(2H, 3600) (ADR 020); the 200-confirmation choice recorded as ADR 021; evidence JSON produced by the indexer with a list hash. |
| Operations | Keeper gas policy (type-2, priority floor, fee ceiling, 60-second replacement at +12.5%), start-up nonce reconciliation, single-instance lease, pre-send simulation with exponential backoff, tracking of non-current rounds; VRF subscription owned by the multisig with cancel/removeConsumer prohibited while rounds are pending and a configure-script consumer check before addPool; deploymentId definition, manifest schema and environment, foundry pins including evm_version, chainId assertion at start-up; alert table with severities, repeat and acknowledgement; read-only DB role, statement timeout, input validation, cache headers and rate limits; canonical raw_events with derivationVersion and forward-only migrations; required indexes and lowercase addresses; two RPC providers with failover and truncated-log detection; backup RPO/RTO and restore drills; per-round cost model. |
| Product and UX | Result-time expectation and near-cutoff warning; `wallet-unreachable` branch with persisted intents and deep-link reattachment; error and QuoteReason message catalog with funds effect and next action; share caveat and only-participant notice; allowance detection, resume and revoke; unclaimed-money badges and banner; withdraw destination shown read-only with a smart-wallet BNB warning; WCAG thresholds (320 px reflow, 3:1 non-text contrast, focus never obscured, live-region cadence); number and date formatting rules; opt-in analytics with no address collection; manifest-driven access notice component disabled by default. |
| Verification and structure | D8 invariant (sequence monotonicity, byRequest injectivity, refundedGross sum, schedule consistency); differential vectors written to `contracts/test/vectors/spec_vectors.json`; Slither, mutation testing and a CI definition; definition of a fuzz “action” with a ghost surplus term; fresh-seed policy; price-failure-to-error mapping; `CallbackIgnoreReason` enum; overflow reported as Panic(0x11) rather than a phantom custom error; diagram corrected to include registerRound; `scripts/trace_check.py` plus A33–A41, U20–U22 and a Spec column on every U row; config schema and validator in the layout. |

Left as deliberate positions: 200 request confirmations (now ADR 021) and the single-winner, no-post-acceptance-refund policy (§7.3, ADR 014). Security-lens findings are recorded below when that review completes.

## User decisions 2026-09-11: MetaMask first and treasury policy

The user asked for MetaMask as the preferred wallet so that a new platform inherits a wallet users already trust, and asked which wallet should receive the 3% fee given that on-chain movements can be traced. Resolution: MetaMask is recommended and listed first, tested on extension, in-app browser and deep link, with other wallets still available (ADR 022); a Trust signals row and experience principle X8 require every safety claim to link to its on-chain fact. For the fee, the spec now requires a dedicated operator treasury Safe used for nothing else (ADR 023, §10.3) and states plainly that fee flows remain public by design; the operator protects identity linkage (no personal or publicly attributed addresses, no exchange deposit address, funding from a fresh exchange withdrawal, scheduled withdrawals), and this does not replace the §14 legal determination.

## Security lens 2026-09-11

The security reviewer confirmed reentrancy and call ordering, owner powers, oracle handling, VRF authentication and settlement determinism, MEV and timestamp resistance, griefing bounds, arithmetic, token behaviour, escrow isolation and keeper design as adequately specified. Accepted findings:

| Severity | Finding | Resolution |
|---|---|---|
| High | The v2.5 coordinator does not validate the key hash at request time and bills at fulfilment, so a permissionless `requestDraw` after a lane retirement or with an underfunded subscription is accepted and never fulfilled, locking the pot instead of refunding it. | `requestDraw` now reverts KeyHashUnsupported unless the coordinator reports the key registered, and SubscriptionUnderfunded unless native balance covers (pendingRequests+1) × a constructor-fixed maxRequestCostNative; the critical alert moved to 60 minutes because a top-up inside the coordinator's retry window rescues an unfunded pending request (A42). |
| Medium | Subscription ownership by a hot key could brick every future draw. | Already required to be the multisig; now explicitly never the keeper or a hot key. |
| Low | Vault trusted Draw for every lock and refund. | V5: Vault records closesAt and per-user locked amounts, refuses late locks, locks after first release and over-refunds (A43). |
| Low | Aggregator circuit-breaker clamps pass as fresh prices. | PricingConfig freezes minAnswer/maxAnswer; a clamped answer is PriceInvalid (A44). |
| Low | Look-alike emitters could forge history or starve the keeper. | Indexer, keeper and client filter logs by manifest emitter address (A45). |
| Low | Signers could trust admin-page text; client supply chain; native sentinel in ERC-20 paths; fee account or asset equal to a system contract. | Signer calldata-decoding policy; decoded summary before every wallet prompt and frozen-lockfile installs; explicit InvalidAsset; Vault and Draw addresses rejected (A45). |

## Hosting decision 2026-09-11

The user asked to host LuckyDraw on their existing Oracle Cloud server, previously used by the hightempbot project. A read-only inspection found the bot removed, and the machine serving only “Copy One Line”, a small Flutter static site with light traffic. The spec now records that host for local-to-testnet and staging work (§10.3 Hosting, §15 Hosting record, ADR 024), requires that nothing runs from a home connection, and keeps the existing site untouched until the user decides to retire it. No code exists yet, so nothing was deployed; the SSH key stays outside the repository.

## Server cleanup 2026-09-11

On the user's instruction the Copy One Line site was removed from the Oracle Cloud host after a backup archive was taken (site, configs, cron, stats, logs and the bare-IP certificate; the sslip certificate and a generic ACME block were kept so renewals continue). The SSH key moved from the hightempbot folder in OneDrive to the operator's `~/.ssh` with the alias `luckydraw-oracle`; the hightempbot docs carry a pointer note. Server facts and procedures now live in `docs/runbooks/oracle-server.md`; the §15 Hosting record, §10.3 and ADR 024 were updated. Still open on the host: 385 pending OS updates, SSH reachable from any address, no automatic updates.

## Host-compromise mitigations 2026-09-11

The user asked how the residual host risks (tampered website, stopped keeper, database read, keeper gas theft) are solved rather than accepted. Added as requirements: the production app is served from a CI-built static origin with an IPFS mirror so no operator server sits in the signing path, with a release manifest and an off-host tamper canary (ADR 025); a backup keeper on an independent host acting after a 120-second lag, a Chainlink Automation upkeep contract before mainnet, and an external heartbeat monitor; the keeper key as a host-bound systemd encrypted credential with a capped balance and an outbound-transfer alert; localhost-only database and API with money views always read from RPC; a host-hardening checklist (patching, SSH restrictions, sandboxed services, CI-verified releases, auditd, off-host logs, DNS and registrar controls, laptop hygiene) in §10.3 and the runbook; a Host compromise row in the threat table; acceptance cases A46 and U25–U29; and the §14 operations gate now requires the checklist, canary, backup keeper and off-host logs.


## Operator privacy and corrected host-compromise claims

Added §10.4, ADR 026, privacy runbook and U30–U37. Target: independent static origin, outbound API/admin tunnels, authenticated SSH, no direct Internet origin listeners, fail-closed operator VPN and restricted/publication-safe records. Moved infrastructure identifiers from publishable spec/runbook into ignored infrastructure inventory; historical disclosures and OneDrive copies are not claimed erased. Corrected never-races backup wording, live-root credential limits, origin self-hash trust, and overbroad database/signature guarantees. The 24-hour refund remains pre-request only. No remote host, firewall, DNS, VPN, reboot or key changes were performed, and live acceptance stays not run. Existing product/calendar decisions were preserved.

## Safety review: custody and production release approval

Added §10.5, ADR 027 and U38–U41. Mainnet now requires separate owner and treasury Safes with 2-of-3 hardware keys, independent transaction verification and recovery evidence. Replaced the earlier optional threshold/shared-Safe choice; overlapping signers and one-person custody still carry common risks. Required verified Safe configuration without execution modules/custom guards, independently reviewed deployment approval, exact artifact promotion, provenance identity checks, independent rebuild and a separately controlled canary trust record. Tightened the acceptance campaign to include V5 consistently. No keys, provider accounts, contracts or live infrastructure changed. Uncapped economic exposure, accepted-request escrow lock, malicious signing pages and provider/endpoint privacy limits remain explicitly disclosed; implementation and independent review are still outstanding.

## Refund avoidance 2026-09-11

The user judged refunds destructive to customer confidence and asked to design them away. Three changes: (1) an operator seed entry in every funded pool (§5.4, ADR 028, D9): a fixed operator stake from a published seed Safe on the same odds per unit, so a lone player always gets a draw, seed-only rounds close Void with the seed returned in the same transaction, and the old one-address refund survives only as a fallback when a pool is unseeded; (2) `claimRefund(roundId, account)` callable by anyone (ADR 029), so the keeper credits every refund within a cycle and users never claim; (3) a make-whole commitment for rounds stuck in Drawing beyond 7 days, paid from a published treasury reserve with a cap (ADR 030). P3, P7 and P9 were revised accordingly, acceptance gained A47–A50 and U42–U43, and the make-whole reserve joined the alert table and the mainnet gate. Reviewed Codex's §10.4 and §10.5 additions: consistent with the design, checks pass, kept unchanged.

## Target tiers 2026-09-11

User decision: rounds should draw as soon as the pot reaches a USD target instead of always waiting for the cutoff, with the cutoff as the latest draw. Each of the three sequences per pool now carries a whole-USD target (defaults 100, 1,000, 10,000), frozen per round and owner-settable for future rounds. The purchase that lifts the pot's reference value to the target with at least two distinct addresses closes the round as TargetReached in the same transaction and opens the successor; a lone player or the seed alone never triggers a close; stale or invalid prices cannot; requestDeadline now runs from the actual close. P2, §3.2, §5.1, §5.3, §6.1, §6.2, §8.1, §8.2, §9.4, §9.5, D8, new D10, the threat table (oracle timing), ADR 031, the ownership record and acceptance rows A51–A54 and U44 were updated; the reference script gained the target-boundary math and vectors.

## Scope guard 2026-09-11

To prevent the accumulated safety requirements from being read as v1 build work, §12.1 now separates what to build for local and testnet from what is added only as a mainnet gate, and §17 records deferred features with their extension points without scheduling anything. Keeper redundancy and most host hardening are marked before-mainnet. No requirement was removed; the order of work was made explicit.

## Consistency re-check 2026-09-11

An independent pass over the whole document after the seed, target, refund-crediting and hosting changes found twenty text collisions and no design flaw. Fixed: the target formula now counts the buyer (playerCountAfter); a purchase that loses a target race reverts EntryWindowClosed and buy never reports WrongState; every closing branch sets closedAt and calls the new Vault.closeEscrow so V5 stays true for early closes; setTargetUsd has no feed read; seed outcomes are reported as operator seed, never player prize or refund; the canary targets the production and staging origins and has an alert row; releases are fetched by the server with a read-only token rather than pushed over SSH; the seed Safe joined the custody policy; D5 covers early closes; gas targets include the target-closing purchase; several acceptance rows and UI strings were aligned.

## Seed consent and refund queue 2026-09-11

A review of the seed design found that the owner could point the seed at any depositor and Draw would debit them. Consent now lives in the Vault: the seed Safe itself calls authorizeSeed(maxPerRound); Draw seeds only through Vault.lockSeed within that cap, once per round, and an authorized account can never be debited through the player path, so V5 and D9 are Vault-enforced for the seed while wrongful player-path debits remain the documented Draw trust boundary. Each round now stores the account that seeded it and returns the seed there on Void even if the pointer changed. The keeper keeps Refunding rounds in its work set until refundedGross equals grossTotal and credits buyers across cycles and restarts. Acceptance A47, A48 and A50 were rewritten and A55, A56 and U45 added.

## Contract build, wave 1 (2026-09-11)

Foundry 1.8.1 scaffold under `contracts/` with pinned solc 0.8.28, evm paris, OpenZeppelin 5.2.0, Chainlink contracts 1.3.0 and forge-std 1.9.7. Shared `Types.sol`, `Errors.sol` and `ILuckyVault.sol` were written first; three parallel agents then delivered `Schedule` and `PriceReader` (every reference vector matched exactly, 46 tests), `LuckyVault` (75 tests including reentrancy through every mutation, exact-delta transfer checks, V5 seed limits against a faulty Draw mock and a V1/V2 ghost-ledger fuzz) and `ImmutableVRFConsumer` with a coordinator mock (18 tests; the pinned coordinator source confirmed that requests for unregistered keys or underfunded subscriptions are accepted and never fulfilled). Follow-ups applied: the Vault event was renamed `RoundEscrowClosed` to avoid an ABI name collision with the error; `release` rejects the Vault and the Draw as recipients so a faulty Draw cannot strand funds; the answer-bound rule now requires non-negative bounds and ordering only when both are set; Vault error choices were recorded in §4.2. Measured: withdraw 50–66k gas, first lock 121k, callback floor 93k. Wave 2 (LuckyDraw) started.

## Contract build, wave 2 (2026-09-11)

`LuckyDraw` and `ILuckyDraw` landed with 99 tests (unit, vectors, gas, integration lifecycle with the real Vault and mocks); 238 tests pass in total. Two findings were resolved by decision: the contract exceeded the EIP-170 size limit under the legacy pipeline, so the pin moved to via_ir with 600 optimizer runs (23,502 bytes; CI now fails the build if a deployable contract exceeds the limit); and the operator seed, being a full second entry, put the player-paid paths over the pre-seed gas estimates, so round creation no longer seeds, the keeper seeds each new round through seedRound, the first-purchase seed remains as a fallback, and the §11.2 targets were reset to measured-informed values (all met; seedRound 385k against 400k). Deviation recorded: RoundOpened carries the frozen PricingConfig as one named tuple. Wave 3 (invariants and progress scenarios) started.

## Review fixes 2026-09-11

An external (Codex) review of waves 1 and 2 reproduced four findings, all fixed the same evening. CI's docs job compared the whole of `SPEC_CHECKS.json` after regenerating it, so the refreshed `checkedAtUtc` failed every run; `check_generated.py` now regenerates in a temporary copy, compares hashes, assertion counts, HTML and vectors, ignores only the timestamp, and has its own unit tests in CI. `quoteBuy` approved a purchase for an account with active Vault seed authorization that `buy` rejected; both now check `SeedAccountCannotBuy` after BelowMinimum and before InsufficientBalance (A57). Quoting `uint256.max` from an unfunded account panicked on the USD projection; rejected quotes now return before any projection, and an otherwise admissible amount whose gross addition or USD value cannot fit in uint256 reports the appended `QuoteReason.ArithmeticOverflow` through `PriceReader.tryUsdValue` instead of reverting (A58). The gas suite measured the fallback seed and the target close separately; the combined first purchase measures 764,822 execution gas, so §11.2 gained an explicit 800,000 target for that path with a failing-on-miss regression test (A59). One existing test read the pot value from a quote issued by an unfunded account and was corrected to quote from a funded one. Result: 247 tests pass under both profiles; the runtime grew to 23,949 bytes, 627 bytes under EIP-170, so any further Draw growth should first move `quoteBuy` and the paginated views into a lens contract (§12). Wave 3 (stateful invariants, D7 progress scenarios and real 100,000-range settlement evidence) started with two agents.

## Contract build, wave 3 (2026-09-11)

Two agents delivered the verification suites and the lead reviewed both line by line before recording anything. Agent B wrote 23 D7 progress scenarios (`test/integration/Progress.t.sol`), each asserting the reached state before printing an evidence row with its time steps, caller, VRF-delivery and oracle assumptions, and a scale suite (`test/unit/LuckyDrawScale.t.sol`) that appends 100,000 real ranges through `buy`, closes by the production target branch and settles with the production `settle` at 240,342 execution gas (17 iterations, about 2,525 gas per iteration, target 250,000), replacing the gas suite's extrapolation; a `scale` profile raises only the test gas limit and CI runs it. Agent A wrote the stateful campaign (`test/invariant/`): a 22-action handler, an independent ghost ledger with its own fee, USD, calendar-cutoff and winner arithmetic, and invariant functions for V1–V5, D1–D6 and D8–D10, with every round re-swept at the end of each run. Review method: two throwaway probes established that this Foundry runner silently discards an assertion that fails inside a handler call when reverts are tolerated but does detect one inside `afterInvariant`, so the suite's record-then-assert design was checked against that fact and the handler was confirmed to contain no assertion; every figure in both reports was reproduced by the lead, including the full 55-seed campaign, and the runner's own metrics show zero top-level reverts in every sequence. Lead additions: the D2 range comparison pages through every stored range instead of the first hundred, and a quote-parity property records an admissible quote that reverts or an inadmissible purchase the preview approved, the class of bug the earlier Codex review found. Findings, both recorded in SPEC: an accepted request that is never validly fulfilled stays in `pendingRequests` for the life of the deployment and raises the funding floor permanently (§7.3 and the alert table), and the 250,000-gas settlement target is a measurement at 100,000 ranges rather than an enforced cap (§11.2). No contract behaviour contradicting the spec was found. Recorded campaign: 55 sequences of depth 3,000 with seeds 0x2026091000 to 0x2026091054 under the new `campaign` profile, 107,641 non-reverting actions, 10,204 deliberate reverts (8.66% of protocol calls), 47,210 calls skipped for want of an eligible target, zero violations; the §11.2 wording now names that third bucket. Totals: 275 tests (273 passing, 2 skipped by design) under both profiles; runtime size unchanged at 23,949 bytes. A nightly fresh-seed workflow was added; no hosted CI run has occurred because the repository has no remote yet. Next: deployment scripts (`script/Deploy.s.sol`, Configure, Verify) for local and testnet.

## Contract build, wave 4 (2026-09-11)

Deployment and testnet tooling, two agents, both reviewed by the lead file by file with every run reproduced. Agent A wrote the Foundry scripts under `contracts/script/`: `Deploy` (chain-id and coordinator-getter preflight, Vault and Draw from a plan, binding asserts, first manifest), `Configure` (listing, deposits, consumer and low-funding guards before every `addPool`, seed amount, targets, two-step ownership handover; idempotent by reading live state first), `Finalize` (exact deploy blocks and hashes from Foundry's broadcast receipts, because a script cannot see its own creation block), `Verify` (read-only, 149 named checks, non-zero exit on any mismatch, refuses a non-local manifest that references a mock) and `DeployLocal` (labeled mocks on anvil through the same code paths), plus 27 in-process tests and a real anvil run with unlocked default accounts and no key anywhere. Agent B wrote twelve JSON schemas under `config/schema/`, the chain and local mock asset records, `scripts/validate_config.ts` with its cross-field rules and 50 tests, the pnpm workspace root with pinned versions and the CI steps. Lead decisions and corrections: manifests are named by the lowercase Draw address because the `chainId:address` identifier cannot be a Windows file name; the Draw record's constructor arguments are keyed `constructorArgs` to avoid the `Object.prototype` collision; the local mock token record said 18 decimals and was corrected to 2; the blank operator plan lives outside `config/` because the validator rejects templates by design. Spec corrections recorded: the section 15 Chain row records environment-variable names rather than endpoints, the Asset row carries the pool configuration and the dated issuer review, the remaining section 15 record directories were added to the layout, `setTargetUsd` cannot reach the three rounds `addPool` opens, and the testnet gate now names the deploy, configure, finalize, verify order. Known gap: `Finalize`'s receipt parsing has no in-process test and is exercised only by the live runs. Totals: 302 tests (300 passing, 2 skipped by design) under both profiles; runtime size unchanged at 23,949 bytes. Next: the shared client package (generated ABIs and types, quote and fee math mirrored from the vectors, manifest loader, error catalog).

## Wave 4 external review fixes (2026-09-12)

All four reproduced findings were fixed. Finalize and Verify now share RPC-backed creation-receipt checks: transaction hash, created address, success status, block number and canonical block hash must match. Verify compares the recorded deployment blocks and scan lower bound with those authenticated receipts; missing history fails closed, including on local Anvil. Finalize validates the broadcast receipt candidates before rewriting the manifest. Its parser and refusal to rewrite a forged receipt are now covered in process; test-only harnesses provide explicitly synthetic RPC responses.

DeploymentLib carries optional chain finality and network identity, Safe records, issuer reviews and notes through plan, Configure and Finalize rewrites. Configure recovers original sequence-1 round IDs from stored rounds after rollovers, including partially populated ID records. The configuration validator now distinguishes JSON parse failure from a valid null value and rejects every non-object root.

Validation: 34 deployment-script tests pass under default and CI profiles; 55 configuration tests pass. Preserved metadata plans/manifests also pass schema validation. The isolated Anvil runner passes real deployment, finalization and verification, and rejects an unfinalized manifest, late deployment/history blocks and an invented receipt. Added that runner to CI. Spec generation, reference math (215,529 assertions), trace and generated-artifact checks pass. Runtime contracts were not changed; the full stateful campaign was not rerun. Testnet/mainnet and hosted CI runs remain outstanding operator/repository actions.

## Shared client package, wave 5 (2026-09-12)

The lead first reproduced the wave 4 external-review fix pass end to end (34 script tests under both profiles, the live anvil harness with its three rejection cases, `forge fmt`, the generated-artifact and trace checks, the full suite at 307 passing and 2 skipped, runtime unchanged at 23,949 bytes) before starting. Wave 5 delivered `packages/client` through four Opus agents on disjoint directories, each reviewed line by line by the lead and then by three independent adversarial reviewers with distinct lenses; every reviewer claim was reproduced before it was fixed. Agent A wrote the generator (`scripts/generate.ts`, deterministic ABI and type modules from `contracts/out`, `Types.sol` and `Errors.sol`, with `--check` in CI), the manifest parser and pre-sign verifier, the revert decoder and the typed log decoder with the emitter filter. Agent B mirrored the spec math from `spec_reference.py` and the Solidity statement by statement (all 506 vectors, 1,626 assertions) and wrote the SPEC 9.7 formatters; its own reviewer found and it fixed the optional seed snapshot, a negative net delta on an inconsistent fee reserve and an over-strict civil-date bound. Agent C wrote the externalized catalog (82 keys plus the state table) with completeness tests against `Errors.sol`, `Types.sol` and the generated ABIs. Agent D wrote the snapshot reads (one block per snapshot, Multicall3 or per-call), the typed adapters, the write builders with the decoded wallet summary, the SPEC 9.5 entry guard and allowance matrix, and the anvil journey. Lead corrections during integration: the `Unauthorized` and `InvalidRecipient` rows named the wrong reverting sites; the make-whole wording omitted the reserve cap, the voluntary character and the direct-transfer channel of SPEC 7.3; `AwaitingRequestExpired` claimed refunds were already credited; the spec's TransferMismatch row moved to the fixed funds vocabulary and both documents now spell "canceled"; the manifest parser gained the constructor-Vault agreement and the uniqueness rules of the validator (a duplicate symbol would otherwise have let `assetBySymbol` resolve to a decoy token); the FundsLocked/EntryBought correlation key gained the account because a purchase with the fallback seed locks twice in one transaction; revert data is taken from message text only behind a data marker and only when ABI-shaped, because a bare address in a provider message could otherwise choose the catalog message a user sees; `verifyDeployment` returns provider failures instead of throwing, coerces a numeric chain id and records the pinned block; a field literally named `__proto__` and an out-of-range enum value no longer decode silently; `formatUtc` rendered years above 9999 in the expanded ISO form; the preview now uses one clock for the entry window and the price age and requires the frozen answer bounds; a share above the whole prints `>100%` rather than `100%`; decimal input above uint256 has its own reason. Reviewer sweeps of `previewEntry` against `quoteBuy` (24 boundary scenarios, a 40-row differential walk and the anvil journey) found zero field mismatches. Decisions: catalog keys for Panic, QuoteReason and SeedSkipReason are namespaced because six reason names collide with error names; the SPEC 9.6 Next action column names a control, not its label; `SafeERC20FailedOperation(address)` is a documented dependency error; the range-list hash of the evidence JSON is defined in SPEC 10.1 as concatenated 64-byte `abi.encode(address,uint256)` blocks; anvil's `finalized` tag returns block 0, so the reads accept a tag override and the journey pins `latest`; ethers' response cache is disabled for post-receipt reads. Recorded gaps for later waves: the manifest has no Multicall3 field (the chain record does), so the consumer passes it; branded `Address`/`Hex32` types were proposed and deferred; the anvil journey stops at AwaitingRequest and covers no ERC-20 pool. Workspace tooling: Biome lint at the root, root scripts, a CI `client` job that runs `forge build`, `abi:check`, lint, typecheck, the tests with the anvil journey and the build. Totals: 276 client tests (188 assertions in the journey); contracts unchanged. Next: the web app core (wallet connection with MetaMask first, round and entry flows) per the SPEC 12 order.

## Shared client package, wave 5 Fable review (2026-09-15)

The Fable review pass the wave 5 rule requires (Opus builds, Fable reviews) had failed twice on the usage limit on 2026-09-12. It ran on 2026-09-15 as two Fable reviewer agents with distinct lenses (the money path from a typed amount to signed calldata, and the trust boundaries: node, wallet, token, manifest and logs), each required to reproduce every claim with a probe before reporting it, plus the lead's own line-by-line read of the entry guard, the write builders, the quote, fee and price math, the deployment verifier, the revert and log decoders, the snapshot reader and the adapters. The lead re-verified the 2026-09-12 state first (ABI generation fresh, lint and typecheck clean, 276 tests, the anvil journey at 9 steps and 188 assertions). Findings, every one reproduced and fixed with regression tests: (1) high, `entryFromQuote` bound a quote to its gross only; `ILuckyDraw.Quote` carries no round id, buyer or asset, so a quote read for round A executed on its successor B (reproduced on Foundry: same pool, asset and cutoff, so the deadline and the guard both passed, the entry was final, the disclosures were A's and the buyer paid the fallback seed the disclosure denied), and a MetaMask account switch showed one account's balance and share for another's signature. The read adapters now stamp every quote with a `QuoteContext` (round id, buyer, asset and seeded flag, all from the quoted block; `quoteBuy` reads the round in the same batch and `readEntryPanel` exposes `quotedFor`), `entryFromQuote` takes the `QuotedBuy` and refuses a request that names another round, buyer or asset, addresses compare case-insensitively, and the plan's round id and asset are the quoted ones; SPEC 9.5 now states the binding. (2) medium, the fallback-seed disclosure came from a caller-supplied `seeded` flag and was wrong whenever the seed was unconfigured, unauthorized or unfunded, or the flag omitted; it is now derived from the quote itself (the pot delta above the gross is the seed `quoteBuy` modelled, exposed as `fallbackSeedGross`), and a seeded round whose quote models a seed is refused as a quote of another round. (3) medium, a token's revert bytes were attributed to the Vault or Draw whenever a selector collided with a project error (a Solady-style `InsufficientBalance()` bubbled through `Vault.deposit`'s SafeERC20 call would have shown the LuckyDraw-balance row): `decodeRevert` takes an `erc20` emitter for allowance steps and a `method`, and a project error the Vault's `deposit` or `withdraw` cannot raise itself (`VAULT_OWN_ERRORS`, checked against `Errors.sol` and the Vault ABI) is reported as the token's, with a new `TokenReverted` catalog row and `decodeOptionsForWrite` for a failed `PreparedWrite`. (4) medium, hex found inside an error object was taken as revert data without the ABI-shape rule the message-text path received on 2026-09-12, so an address under ethers' `value` decoded as a custom error; the rule now applies to nested hex, and a selector with a partial trailing word is `unknown`. (5) medium, a head-pinned snapshot (`latest` at depth 0, which the money views use) was read by block number with no check that the block still carried the hash the snapshot reports, so a one-block reorg between `getBlock` and the calls labelled fork-B state with fork-A's hash, the identity SPEC 10.1 keys caches on; `readBatch` re-reads the header afterwards and fails as `SnapshotReorged` on a change, and does not re-read `finalized`, `safe` or depth-200 blocks. (6) low, found by the lead: ethers masks a return word above its declared width while Solidity's decoder reverts, and `PriceReader.read` decodes outside its try/catch, so a feed answering `decimals()` above uint8 or a `roundId` above uint80 makes `quoteBuy` and `buy` revert with empty data while the client preview said "ok" (both halves reproduced, on Foundry and on ethers 6.17); `readFeed` now checks the raw words and fails the read as `DecodeFailed`, keeping empty return data as the no-code `PriceUnavailable`. (7) low, `verifyDeployment` threw on a malformed chain id or `getCode` result instead of returning `ProviderFailed`; `toBigInt` no longer reads `""` or `" "` as zero; a log with an empty or negative block number, log index or transaction index decodes to null. (8) low, the manifest parser accepted three documents the validator rejects: a native flag disagreeing with the zero-address sentinel, decimals above 18 (which made a formatter's `10n ** decimals` throw at render time) and a Draw sharing the Vault's address. (9) low, `prepareBuy` accepted any lowercase address as the summary's asset (now the deployment's assets only), a zero deadline and a zero chain timestamp built a transaction that is `DeadlineExpired` at any real block, and an ERC-20 deposit at or above 2^128 raw units was refused on the approval path only (now refused whatever the allowance). Declined: gating deposits on the manifest's `depositsEnabled`, because that switch and `depositsPaused` are live state the operator flips after the manifest is written, so the prompt-time gate is a live `getAsset` read (documented in `writes/prepare.ts`; the web app performs it, wave 6). Deferred with a documented caveat: the FundsLocked/EntryBought correlation key collides when one account locks twice for one round in one transaction, which only a batching contract wallet can do (the seed account cannot buy); the indexer pairs by log order. Proven by the reviewers and recorded rather than changed: the one-raw-unit `minNetContribution` tolerance is exactly sufficient for every reordering (exhaustive for g up to 400 and G up to 2,000, 20,000 random 128-bit pairs, seed-first and other-buyer-first traces); the deadline clamp has no off-by-one against the contract's `>` and `>=` checks; `previewEntry` and `classifyObservation` walk `quoteBuy` and `PriceReader.read` statement by statement with no mismatch class beyond the recorded sweeps; approvals are exact, Vault-only and never to the Draw. Totals after the pass: 288 client tests; the anvil journey at 9 steps and 195 assertions, now also proving that a quote read for the closed round is refused for its successor while a fresh quote is stamped with the successor, and that a quote read for player B is refused for player A; lint, typecheck, `abi:check` and build clean; contracts unchanged. Review cost: two Fable reviewers at roughly 200,000 tokens each, about ten minutes each, plus the lead's reading.

## Contract waves 1-4 Fable review and fixes (2026-09-15)

The first independent Fable review of the contract waves ran as three reviewer agents with distinct lenses (the money path; lifecycle, schedule and randomness; deployment tooling and configuration validation), each required to reproduce every claim with a probe before reporting it, and the lead verified every finding against the source before anything was changed. The first launch died on the user's usage limit and was relaunched. No fund-loss, conservation, randomness, lifecycle or calendar defect was found in the contracts: a fee-partition fuzz, a seventeen-knob differential fuzz between `quoteBuy` and `buy` with zero disagreements, the calendar edges through 2100, the full SPEC 6.2 transition set, target-at-cutoff races, VRF request authority and stale-id delivery, the selection edges over a seed range, expiry authority and the freezing of a round after rollover all held. Ten findings were reported, all reproduced, and all fixed the same day by Opus builder agents working on disjoint files with regression tests, each fix read line by line and re-run by the lead.

Deployment tooling, medium. (1) `Configure` compared code hashes and the Vault binding but never the manifest's VRF coordinator, subscription id, key hash and `maxRequestCostNative` against the Draw's immutables, so an edited manifest passed the readiness guard against the wrong subscription and opened live pools anyway; all four must now match. `Configure` also refuses a non-local manifest that references a mock. (2) The non-local mock rule read only the manifest's own `isMock`, `feedIsMock` and `coordinatorIsMock` flags, so a relabeled document defeated it; `DeploymentLib.isRepositoryMock` now compares deployed code with the repository's mock artifacts (extcodehash for `MockVRFCoordinatorV2Plus` and `MockAggregatorV3`; `MockERC20` carries an immutable, so it is matched byte-wise against the artifact ignoring the immutable slot) and `Deploy`, `Configure` and `Verify` all apply it. `Deploy` also refuses an `environment` that disagrees with the connected chain id (local only on 31337, testnet 97, mainnet 56), mirroring validator rule E1. (3) The configuration validator skipped the max(2H, 3600) staleness rule whenever `heartbeatSeconds` was null, on any environment, so a mainnet feed could carry a 48-hour `maxPriceAge` with no diagnostic; rule P1 now rejects a null or absent heartbeat outside `local` (five new tests, 60 configuration tests in total). (4) Nothing checked that `finalOwner`, `feeAccount` and `seedAccount` have code off-local, although SPEC 10.5 and 12.1 require Safes and `feeAccount` is frozen into every round at creation; `Deploy`'s preflight now requires code at all three outside `local` and `Verify` has three matching checks, taking it from 149 to 150 checks on a local manifest and 153 on a non-local one. Deployment tooling, low. (5) `Verify` checked that each manifest pool exists but not that the Draw has no extra pool; it now compares `poolCount` with the manifest's asset count, and compares `NUM_WORDS` with the Draw rather than with a library constant. (6) `Finalize` required the broadcast file's block to equal the canonical receipt's block, so a creation re-included at another height after a shallow reorg could never be finalized; the authenticated RPC receipt's block is now the authority, the broadcast file supplies only the transaction hash, and a disagreement logs a notice. Script tests went from 34 to 41, the live anvil harness passes, and the committed local manifest and plan were regenerated from a real DeployLocal, Finalize and Verify run at the same Draw address `0x6101...d788`; the TEST2 pool now records `seedAuthorizedMaxPerRound` "500" where the stale record said 1e16, which is finding 7 below visible in a committed artifact.

Contracts, low, both resolved as spec decisions. (7) `Vault.seedMaxPerRound` was one raw-unit cap per account shared by every asset, while `seedAmount` is per pool in that pool's raw units, so a cap of 1e18 sized for BNB was unlimited consent in a 2-decimal token pool: a compromised owner could set that pool's `seedAmount` to the Safe's whole balance and take it with one `seedRound` (reproduced). Consent is now per asset: `authorizeSeed(address asset, uint256 maxPerRound)` reverts InvalidAsset for an unlisted asset, `seedMaxPerRound(account, asset)` and `SeedAuthorized(account, asset indexed, old, new)` follow the asset, `lock` and `lockSeed` read the cap for `escrow.asset`, and `buy`, `quoteBuy` and the views read it for the round's asset, so an account with a cap on asset A is an ordinary player in asset-B pools. (8) `seedRound` ignored `setBuysPaused` and the pool pause, so during an incident freeze anyone could push the operator seed into every Open round; it now reverts BuysPaused while either pause is set. The fallback seed inside `buy` was already behind the check because `buy` itself reverts, and `quoteBuy` already reports BuysPaused before modelling a seed. Twelve new contract tests; the LuckyDraw runtime grew from 23,949 to 24,044 bytes, 532 bytes under EIP-170; 319 contract tests after this step. The shared client followed the ABI: regenerated ABI and types, `prepareAuthorizeSeed` takes the asset, `readSeedMaxPerRound` and `readEntryPanel` read the round asset's cap, catalog rows are per asset, 291 client tests, and the anvil journey grew to 10 steps and 209 assertions with a per-asset consent step. SPEC 4.1, 4.2, 5.4, 8.1, 9.6, 11.1 and ADR 032 record the decision.

Invariant suite, low. (9) The handler's catch blocks for `closeRound`, `requestDraw`, `expireUnrequested`, `settle` and `claimRefund` on a target the ghost ledger had judged eligible only bumped a revert counter, and no invariant asserted the 20% ceiling, so a bricked lifecycle function would have produced a zero-violation campaign (reproduced with `vm.mockCallRevert`). Those five branches now record a new D7 liveness property P_LIVE, with the `requestDraw` branch first recomputing the SPEC 6.2 coordinator pre-checks so deliberate coordinator faults stay bare; `invariant_D7_EligibleCallsNeverRevert` asserts no P_LIVE after every call and `afterInvariant` asserts the 20% ceiling over the whole run (the builder placed the ceiling in the per-call invariant, and the lead's rerun tripped it at 21 of the first 100 calls on healthy code under both the CI and campaign profiles, so it moved to the end-of-run check the ceiling actually describes); and `test/invariant/HandlerHonesty.t.sol` bricks `closeRound` and `settle` to prove that such a record reaches an invariant. A one-seed campaign after the change showed a 9.24% revert share and zero P_LIVE. The full suite after everything is 328 passed and 2 skipped; the lead is re-running the recorded 55-seed campaign and the ACCEPTANCE row carries a marked placeholder until those numbers exist.

Not fixed, recorded as open. (10) The ghost ledger reuses the production day and week cutoff expressions and the `addmod`/`mulmod` winner reduction, so D8 and D6 prove self-agreement for those cases; only the monthly walk and the linear range scan are independent. The handler never calls `authorizeSeed` and never sets a nonzero `minNetContribution`. Also noted and left open: `Deploy.run` and `Configure.run`, the operator entry points, are executed by nothing in CI; `Configure` rewrites the manifest at simulation time, before any transaction is broadcast; and the validator never reads `verifiedOn`, `consumerRegistrationTx` or `source.date`, while P2w, P4w and P6w only warn on mainnet, where SPEC 15 wants the evidence recorded.

Review cost: three Fable reviewers at roughly 250,000 to 310,000 tokens and fifteen to twenty minutes each, plus the lead's verification of every finding and every fix.

## Web app core, refund slice and throwaway keeper (2026-09-16)

Scope decision. On 2026-09-15 and 16 the user chose a reduced scope for a BSC testnet interest test instead of finishing the whole §12.1 left column: wave 6's web app core, the refund and withdraw slice of wave 7, and a throwaway keeper. The indexer, `/activity` and `/leaderboard`, the admin routes, every runbook beyond one launch runbook, the completion of the acceptance ledger and all of the §14 gates wait until the trial has produced a signal. The alternative, building the left column out first and showing nothing until it was done, was rejected because the interest signal is worth more before that work than after it and everything deferred is additive: no money rule, contract or confirmed user rule changes. ADR 033, a sentence under the §12.1 table and a paragraph at the end of §10.2 record it, and §10.2 names each production keeper property the throwaway one does not have.

Build model. Opus builder agents on disjoint directories, then three independent adversarial Opus reviewers with distinct lenses, then three Fable reviewers (the money path end to end; the trust boundaries; the keeper), which is the rule the wave 5 and contract passes established. Every reviewer had to reproduce a finding with a probe before reporting it, the lead confirmed each one in the source before a fix was written, and every fix landed with a regression test.

The web app (`web/`, @luckydraw/web) is React 19.3, react-router 8.3, Vite 8.3, vitest 5, TypeScript 5.9.3 and ethers 6.17.0, the client's own version, with plain CSS tokens per §9.3, one string catalog (`strings/en.ts` re-exporting per-area modules) and the client package aliased to its sources so root typecheck and test work without its `dist`. The foundation is EIP-6963 discovery with MetaMask first, a network guard with the switch and add-chain fallback taken from the chain record, a session that stores only the last connector id, the deployment manifest and chain record bundled at build time and verified at start-up before any write is allowed, a strict CSP meta with no inline script and `connect-src` limited to the RPC origins, a block-keyed read cache that runs adapters once per new block and shares one resolved block across an epoch, and the §9.6 transaction machine with its pending intent in session storage. The pages are `/` (how it works, persisted asset and tier filters, RoundCards sorted by closing soonest), `/round/:chainId/:roundId` (progress, status timeline, pot and prize card, entry panel as a bottom sheet under 600 px, position, holders with the seed as one labelled row, entry ledger, result or refund card, a successor link in every non-Open state and the §9.6 lifecycle control for each state), `/wallet` (two columns per asset, native one-step deposit, ERC-20 approve-then-deposit with the exact-allowance matrix and `requiresZeroReset`, Revoke with a review stage, withdraw to the connected address only with the contract-wallet BNB warning, and the top-up hand-off `?asset=&amount=&intent=`), `/entries` (five tabs, discovery from `EntryBought` logs by the indexed buyer under the emitter filter, every candidate confirmed with `readPosition`/`readRound` at one block, a two-stage refund claim) and minimal `/verify` and `/help`. The entry panel follows §9.5 exactly: `readEntryPanel` → `previewEntry` → a fresh `quoteBuy` → `entryFromQuote` → `prepareBuy`, with the plan derived at render from the entry key, the deadline and the agreement between the held quote and the live preview.

The keeper (`keeper/`, @luckydraw/keeper) is one Node process and one loop with no database and no systemd unit. The §6.2 decision table is a pure function; the cycle resolves the head once and reads everything at it, walks every pool including disabled ones (whose existing rounds §6.1 still advances), sends at most one transaction per round per cycle after simulating it, and suppresses an identical repeat through an in-flight map keyed `round:action[:account]` for 120 seconds or until the chain shows the precondition changed. Refund buyers come from the round's `EntryBought` and `SeedEntered` logs. There are two mutually exclusive signing modes, an anvil unlocked address and a `KEEPER_PRIVATE_KEY` read once inside the sender and never placed in the configuration object, refused against a local manifest; start-up gates cover manifest identity, a raw `eth_chainId` request and `verifyDeployment`; every log line has absolute URLs redacted; ten consecutive failed cycles exit non-zero.

Opus review round. Entry flow: one high, a preview that resolved after the amount or the account changed installed its plan anyway, so the calldata and the disclosures beside it disagreed; medium, a confirmed plan never expired and nothing re-quoted it, the pools card showed the round's gross where the prize belonged, and a purchase that lost a target race had no link to the successor; low, the native feed behind the gas figure was used without classifying it, so an unusable feed still produced a USD number. Wallet and discovery: medium, the manifest parser dropped `requiresZeroReset` so a token needing a zero reset was offered a plain `approve(amount)`, a deposit prompt could be a step whose summary had never been shown, a credited row offered no route to the money, and a truncated `getLogs` page was treated as a complete answer; low, a refund claim opened the wallet with no summary, the Vault's global `depositsPaused` was never read before a prompt, the Void copy was wrong, and the previous account's scan was briefly served after a switch. Keeper: medium, one failing log page aborted the whole cycle, every action was re-sent each cycle until it mined, and buyer discovery never halved its window; low, one balance check funded three seeds in a pool with three kinds, and the RPC URL reached the logs. Foundation: two highs, a reorg after inclusion still reported Confirmed, and a later EIP-6963 announcement replaced the provider behind a live connection; medium, the signer did not re-read the wallet's chain before building, a failing nonce read was reported as a dropped transaction, ethers' broadcast hash was discarded when its own poll failed, another account's intent was resumed, a disconnect left the last account's reads on screen, and two panels on one page could read two different blocks; low, the intent was not cleared on disconnect, focus was lost after a keyboard connect, a keyed RPC URL was accepted for add-chain, polling was unbounded, and the AccountChip balance summary was deferred rather than built. All were reproduced, confirmed and fixed with regression tests.

Fable review round, attacking those fixes. Trust boundaries: one high, start-up verification never asked the node for `eth_chainId` at all, because the read provider is built with `staticNetwork` and `getNetwork()` answers from the pinned network without a request, so the §12 assertion compared the manifest with itself and an RPC URL pointed at another chain passed it; medium-high, one intent slot was shared by several runs, so a run reaching a terminal state deleted the intent a newer run had just persisted; medium, a single stale answer from one node behind a load balancer produced a replaced or dropped verdict, a crafted session-storage intent crashed the page permanently on every reload, the signing request carried no chain id, and the transaction found under a hash was never compared with the request the app had prepared; medium-low, any `io.metamask.*` announcer took the Recommended row and filtered the real MetaMask out, and a connector that vanished from the list left a connected session with no provider; low, wallet-authored error text was rendered as the app's own sentence. Money path: medium, a held plan was never re-quoted while the live panel moved underneath it, so a stale balance-after and share-after were shown and Confirm sat beside a refusal, pre-signature failures were reported as “Unknown until receipt” when nothing had been signed, and the position scan cache never advanced its cursor; low, withdraw stayed confirmable after the balance dropped, the entry panel's clock came from the display block while its data came from the head, and Revoke opened the wallet without a summary. Keeper: medium-high, the same `staticNetwork` chain-id blind spot; medium, a disabled pool's rounds were never advanced, against §6.1, and a partial buyer list was cached for the life of the round so a missing buyer's refund would never be credited; low-medium, a secret pasted into one of the address variables was echoed to stdout in the refusal; low, a send that threw aborted the cycle. Both review rounds found the chain-id blind spot independently, one in the web app and one in the keeper. Every finding was reproduced with a probe, confirmed by the lead in source and fixed with a regression test.

Open items, recorded and not fixed. The round page issues about 42 RPC requests per block epoch on a chain record without a Multicall3 address (31337), above the §10.1 idle budget; a Multicall3 entry in the chain records would roughly halve it. A `readDepositsPaused` adapter belongs in `packages/client`; the web app reads that switch locally for now. The client's `closesAt-1` deadline refusal is one second more conservative than the contract requires. No test was run with two tabs, or against a real MetaMask update. And there is a rare one-block window in which Close round is offered before the mined block's timestamp has reached the cutoff; the call reverts honestly and nothing is debited.

Totals: 312 web tests under vitest and jsdom with a fake EIP-1193 wallet and a fake node, and 69 keeper tests including an opt-in anvil journey of 8 steps and 23 assertions that watches a seed, close, request, fulfilment, settlement and refund. Initial JavaScript for `/` is about 227 kB gzipped after route-level lazy loading, against the §9.3 budget of 250 kB, measured by hand rather than in CI. Contracts and the client package were not changed. Review cost: the three Opus reviewers at roughly 220,000 to 240,000 tokens each and the three Fable reviewers at roughly 210,000 to 330,000 tokens each, plus the lead's own reading; the Fable launch died once on the usage limit and was resumed.

## Static analysis (Slither) and Codex cross-check preparation (2026-09-16)

Wave 7 item 7. Slither 0.11.6 with solc 0.8.28 (the version `foundry.toml` pins), run over `src/` only through the
Foundry platform with `contracts/slither.config.json`: `filter_paths` drops `lib/`, `test/` and `script/`,
`exclude_dependencies` is on and no detector is excluded, so all 102 detectors ran at every severity. The run was
performed on this machine (Windows, `pip install slither-analyzer==0.11.6 solc-select==1.2.0`, `solc-select install
0.8.28`), and it is recorded here rather than deferred to CI. No contract source, test, SPEC or ACCEPTANCE file was
changed by this item; the one source change it proposes is written out below for the lead to apply.

**The first run was not evidence, and the reason is worth more than the findings.** Slither 0.11.6 cannot resolve a
custom error imported under an alias. `src/LuckyDraw.sol` imports `BuysPaused as BuysArePaused` and
`src/LuckyVault.sol` imports `EscrowClosed as EscrowIsClosed`, and the analyser printed `ERROR:ContractSolcParsing:
Missing function Variable not found: BuysArePaused() (context LuckyDraw)` and the matching Vault line, then carried
on and reported `. analyzed (24 contracts with 102 detectors), 30 result(s) found`. Those 30 are not a subset of the
truth. Because the enclosing functions were dropped from the analysis, the run invented findings that are flatly
false — `unused-state` on `_rounds`, `_byRequest`, `_lastSequence` and all six `SEED_*` constants, `constable-states`
on `roundCount` and `pendingRequests`, `uninitialized-state` on `_pools` and `_escrows` — while hiding every
`reentrancy-no-eth`, `reentrancy-benign`, `uninitialized-local` and `cyclomatic-complexity` result that the same code
produces once the alias is gone. A reviewer who read only that output would have chased nine phantom findings and
missed eight real reports. This is now written into `contracts/README.md` under "Static analysis (Slither)", into the
`_comment` block of `slither.config.json`, and into the CI job as a step that greps the log for
`ERROR:ContractSolcParsing` and fails on it.

The authoritative run was therefore taken on an alias-free copy of `src/` in a scratch directory, byte-identical to
the repository tree except that the two imports drop their `as` clauses and the five `revert` sites use the original
names. That copy compiles unchanged (`Compiling 28 files with Solc 0.8.28 / Compiler run successful!`, same
`via_ir`, `paris`, 600 runs) — the aliases were never needed for name resolution, only for reading — and Slither
reports no parser error and `. analyzed (24 contracts with 102 detectors), 37 result(s) found`: **8 Medium, 15 Low,
14 Informational, 0 High**. The proposed source diff is in the wave 7 item 7 report; it touches `src/LuckyDraw.sol`
lines 34, 419, 483 (a doc comment) and 488 and `src/LuckyVault.sol` lines 19, 331 and 417, and needs no test change
(`test/unit/LuckyVaultEscrow.t.sol` keeps its own local alias, which is filtered out of the analysis anyway). Until
it is applied, `fail_on` stays `none` and the CI job stays `continue-on-error`; both come off together with it, and
before the operator signs `Deploy`.

Triage of all 37, each reproduced in the source before it was classified. **Nothing was fixed, because nothing
needed fixing: no finding survived contact with the code as a defect.**

*Medium, `reentrancy-no-eth`, six instances (`addPool` twice, `buy` twice, `closeRound`, `ensureCurrent`) — false
positive.* Every external call the detector cites is to `VAULT`, the single `immutable ILuckyVault` fixed at
construction, and the five functions it names (`registerRound`, `lock`, `lockSeed`, `closeEscrow`, `release`) are all
`nonReentrant onlyDraw` in `LuckyVault` and make no external call of any kind: the Vault's only outbound interactions
are the native `.call` and the `SafeERC20` transfers inside `deposit` and `withdraw`, neither of which is in these
call graphs. There is no untrusted code in the path to hand control to, so the "state written after the call" the
detector lists cannot be observed by anyone. Independently, the guard is closed anyway: every state-mutating external
entry point of the Draw carries `nonReentrant` (checked one by one: `addPool`, `setNextPricing`, `setFeeAccount`,
`setSeedAccount`, `setSeedAmount`, `setTargetUsd`, `setPoolEnabled`, `setBuysPaused`, `setPoolBuysPaused`,
`seedRound`, `buy`, `closeRound`, `requestDraw`, `expireUnrequested`, `settle`, `claimRefund`, `ensureCurrent`), and
so does `_fulfillRandomWords`, so of the three cross-function targets Slither names, `quoteBuy` is a view,
`_requireRound` is private, and `_fulfillRandomWords` is unreachable while the guard is held. One related point is
recorded rather than changed: `rawFulfillRandomWords` in `ImmutableVRFConsumer` carries no guard of its own, which is
deliberate — the VRF callback must not revert, and a guarded callback would revert if it ever arrived inside another
of our transactions — and it delegates to the guarded `_fulfillRandomWords`. The only shape in which a re-entrant
callback could arrive is the coordinator calling back during `_requestRandomWords`; `requestDraw` writes
`_byRequest[requestId]` only after that call returns, so such a callback finds no round, emits
`CallbackIgnored(UnknownRequest)` and changes nothing.

*Medium, `uninitialized-local`, two instances (`closeRound.refunding`, `closeRound.refundReason`) — false positive.*
Both are read only under `if (refunding)`, and `refunding` is set true in exactly the two branches that also assign
`refundReason`. Solidity zero-initialises both, and the zero enum value is never written to storage on a path where
`refunding` is false.

*Low, `missing-zero-check`, two instances (`setFeeAccount`, `setSeedAccount`) — false positive.* Both call
`_requirePayable(account)` on the first line, which reverts `InvalidRecipient` for `address(0)`, for the Vault and
for the Draw itself. The detector does not follow private helpers.

*Low, `reentrancy-benign`, four instances — false positive*, for the reason above; the writes concerned are the
`_current[poolId][kind]` successor pointers, and the calls are to the same trusted, guarded, call-free Vault
functions.

*Low, `timestamp`, nine instances — accepted, by design, owner: unchanged product design.* The product is a scheduled
draw: SPEC §6.1 cutoffs are UTC wall-clock instants and the §6.2 request and expiry windows are timestamp windows, so
`block.timestamp` comparisons in `buy`, `closeRound`, `requestDraw`, `expireUnrequested`, `quoteBuy`, `_seedStatus`,
`LuckyVault.registerRound` and `LuckyVault._requireLockable` are the specification, not an oversight. A BSC validator
can move a timestamp by seconds; the exposure that buys is at most one further block of entries before a cutoff, and
it cannot touch the outcome, because the winner is derived from VRF words stored after the close from ranges frozen
at the close. Two of the nine entries are detector noise: under `settle` the "dangerous comparisons" listed are
`prize != 0` and `fee != 0`, which contain no timestamp.

*Informational, `cyclomatic-complexity`, `quoteBuy` at 14 — accepted, owner: contracts.* `quoteBuy` is the SPEC §9.5
preview and mirrors `buy` branch for branch; the 2026-09-15 review's seventeen-knob differential fuzz between the two
found zero disagreements, and the client's 40-row differential walk depends on that one-to-one shape. Splitting it
would trade a measured property for a metric. Revisit only if `buy` is restructured.

*Informational, `low-level-calls`, `LuckyVault.withdraw` — false positive.* `.call{value: amount}("")` is the correct
way to send BNB (`transfer`'s 2,300-gas stipend breaks contract wallets and does not survive gas repricings); the
result is checked (`if (!ok) revert TransferFailed()`), the caller is debited before the call, the function is
`nonReentrant`, and the recipient is always `msg.sender` (V4).

*Informational, `naming-convention`, eight instances — accepted, cosmetic.* Six are the Draw's `immutable`s (`VAULT`,
`SUBSCRIPTION_ID`, `KEY_HASH`, `REQUEST_CONFIRMATIONS`, `CALLBACK_GAS_LIMIT`, `MAX_REQUEST_COST_NATIVE`) in
SCREAMING_SNAKE_CASE. Slither wants mixedCase and `forge lint`'s `screaming-snake-case-immutable` wants exactly what
the code does; the two tools disagree and the repository follows `forge lint`, which runs in CI. The other two are
`IVRFCoordinatorV2_5Views`, named after Chainlink's own `IVRFCoordinatorV2Plus` family, and `s_provingKeys(bytes32)`,
whose name must match the deployed coordinator's public getter exactly or the call does not exist.

*Informational, `unindexed-event-address`, four instances (`FeeAccountSet`, `SeedAccountSet`, `BuysPausedSet`,
`DepositsPausedSet`) — accepted and recorded as open, owner: lead, post-MVP indexer wave.* These are the four global
administrative events; unlike the per-pool and per-round events they have no natural indexed key, and the `actor` is
always the owner Safe. Indexing it is an ABI change to events that are read by contract address and topic0, so it is
not worth making on the way to the MVP. What would change the decision: an indexer or alerting rule that needs to
filter administrative actions by actor.

What this run does not cover, stated plainly so the ledger is not read as more than it is. Only `src/` was analysed:
`script/` (the operator deployment scripts) and `test/` are filtered out, and `lib/` dependencies are excluded, so
OpenZeppelin, forge-std and the Chainlink contracts were not analysed here. Slither is a static analyser and finds
none of the classes this project's risk actually lives in — money conservation, schedule arithmetic, selection
fairness, VRF lifecycle races — which are covered by the unit, vector, integration, D7 progress, scale and stateful
invariant suites and by the Fable review passes above, and none of it substitutes for an audit, which SPEC §12.1
still lists and which the MVP is knowingly launching without. There was no run on a Linux CI machine at the time of
writing; `.github/workflows/ci.yml` gains a `slither` job (Ubuntu, `slither-analyzer==0.11.6` and `solc-select==1.2.0`
pinned, solc 0.8.28, `FOUNDRY_OUT=out/slither`, outputs written to the runner temp directory and uploaded as an
artifact) that is `continue-on-error` until the alias fix lands and every Medium finding is fixed or accepted with an
owner, with the flip condition written in the job's own comment. The pin matters: a Slither upgrade changes the
finding set, so the pin and this triage move in the same commit or not at all.

Codex cross-check preparation. `.claude/briefs/codex-crosscheck-wave1-6.md` is the brief the operator runs Codex
against, in the reviewer-brief format the 2026-09-15 passes used. It scopes waves 1 to 4 (contracts and their
2026-09-15 fixes), wave 5 (the shared client) and wave 6 (web app and keeper) to a file list with each file's
contract counterpart and the SPEC sections to grep; it lists every already-fixed finding and every recorded open gap
from the sections above so they are not re-reported as new; it asks eighteen numbered questions across the money
path (quote-to-entry parity, refund arithmetic, the per-asset seed cap), the lifecycle (request, expire and settle
races), deployment (`Configure`, `Finalize` and `Verify` against a real RPC), the client (quote binding), the web app
(the transaction machine and the network guard) and the keeper (the decision table); and it requires every claim to
be reproduced with a probe before it is reported, in a fixed report format. The brief is preparation only — the
operator runs Codex, and its output is recorded in a later section.

## Mainnet readiness, wave 7 (2026-09-16)

Scope decision. After wave 6 the user chose BSC mainnet as the first and only deployment target, with no testnet
stage, against the lead's advice for a two-day testnet rehearsal (ADR 034; SPEC §12.1 now carries an MVP-gate
column, §14 a "Private mainnet shakedown" row, §10.5 the drill on the mainnet Safes). Wave 7 is the build and
evidence work that stands in for the rehearsal. The brief is `.claude/briefs/wave7-mainnet-readiness.md`; the
lead reviewed it against the code before launch and recorded seven corrections there (existing drill fields kept,
`measuredCallbackGasUsed` is the Foundry number until the shakedown, SPEC names no canonical Multicall3 address,
VRF cost is `payment` from `RandomWordsFulfilled`, `release` must survive manifest rewrites, plain refund wording,
Slither may not run on Windows).

Build model. Eight Opus builders on disjoint files; the lead applied every cross-file change from their reports,
reviewed the money and trust paths itself (release gate, reserve display, credential loader, notifier, mock gate,
validator RA2) and ran every suite. Four builders were killed mid-work by the user's API usage limit and were
resumed with their context intact; the Slither builder's first run had produced a partial build artifact that a
clean run cleared.

What landed. (1) SPEC: ADR 034, §1, §9.1, §10.2, §10.3, §10.5, §11.2, §12, §12.1, §14, §15 (new Release record
row; make-whole reserve and cap pinned to wei of the native coin); ACCEPTANCE: U38 rewritten, new U46 and a
shakedown ledger row. (2) Validator: O4 (nonzero reserve and cap on mainnet), D26/D27 (`release.customerLaunch`
requires a performed shakedown with every number), P6/P7/P8 (observed p99.9 interval non-null, at or below
`maxPriceAge`, with its `observationWindow`), CH4 (chain record's Multicall3 and genesis hash non-null once a
mainnet manifest exists), RA2 rewritten (all five drill booleans, `chainId`, `safes` equal to the manifest's
ownership addresses by `deploymentId`, `receiptRefs` non-empty); schemas gained `release`, `observationWindow`,
`recoveryDrill.chainId`/`safes`; 61 to 95 config tests. (3) `scripts/observe_feed.ts`: raw JSON-RPC walk of a
Chainlink proxy's round history across phase boundaries, nearest-rank integer percentiles, `maxAge` check, prints
the price fragment; 37 tests on a synthetic aggregator. (4) `scripts/check_chain_record.ts`: chain id, genesis
hash, Multicall3 code and `aggregate3` consistency against the chain record, fragment printed and never written;
26 tests. Its audit showed the web app already batches from the chain record and the keeper never did; measured
round-page requests per epoch 42 to 29 on 31337 and 32 to 19 on chain 56 with Multicall3, now asserted in
`web/src/lib/rounds/rpcBudget.test.ts`. (5) Keeper: `LoadCredential` key custody with env fallback, systemd unit
with hardening and restart policy, heartbeat and five-cause alert webhook rate-limited to one per cause per hour,
per-draw cost meter (`event=draw_cost`, keeper gas from receipts plus VRF `payment` from the fulfilment),
subscription-balance check, chain-56 mock refusal, Multicall3 from the chain record; 69 to 120 tests, anvil
journey 9 steps and 26 assertions. (6) Web: `releaseGate.ts` (mainnet build refuses unless the manifest is
`mainnet`, carries no mock flag anywhere, has `release.customerLaunch` exactly true, the jurisdiction sentence is
non-empty and `validate_config` passes), all-or-nothing fallback pairing so a half-set Pages configuration cannot
publish the anvil manifest under a real chain id, `Disclosures` on the round, help and verify pages, the
jurisdiction notice, `/verify` with addresses, code hashes, explorer links and the make-whole reserve; 312 to 366
tests. (7) Slither 0.11.6 triage recorded in the previous section: 0 high, 8 medium and 15 low all reproduced as
false positives or accepted with reasons; the aliased-import parser trap it found is fixed in this wave (the
`as` aliases on `BuysPaused` and `EscrowClosed` removed in `LuckyDraw.sol` and `LuckyVault.sol`, no ABI change,
error selectors unchanged); a non-blocking Linux CI job with a parse-error step; a Codex cross-check brief at
`.claude/briefs/codex-crosscheck-wave1-6.md`. (8) `docs/runbooks/mainnet-launch.md`, nine sections, reconciled
by the lead against the landed flags and env names. Lead additions: `DeploymentLib` carries the manifest's
`release` object through Configure and Finalize rewrites (three attempts to get past the via-IR stack limit; the
call moved out of the metadata reader and the round-id array is read with `parseJsonUintArray`), a
`test_ReleaseRecordSurvivesConfigureAndFinalize` script test and a refusal test for the new
`contracts/script/templates/mainnet.plan.example.json`, whose structure validates with only operator-filled nulls
failing; `observe:feed` and `check:chain` root scripts with README sections; stale Multicall3 notes in the chain
records corrected.

Verification. Contracts: 330 passed, 0 failed, 2 skipped by design under the ci profile, 45 script tests. Client: 291 tests pass, 1 opt-in skipped, `abi:check` up to date. Keeper: 120
tests (119 plus the anvil journey). Web: 366 tests, typecheck and build. Config: 95 tests, `validate:config` 7
documents pass. Root `pnpm lint` over 282 files clean, `pnpm typecheck` clean. `render_spec`, `check_generated`
and `trace_check` pass (106 acceptance rows, 34 ADRs).

Open items, recorded and not fixed. No end-to-end passing chain-56 build has run, because that needs a mainnet
manifest; the passing path is unit-tested and the operator's first real build is its first execution. The
Slither CI job has not run on a Linux host and stays non-blocking until it has. `validate_config` runs in the web
build only for chain 56. The keeper's cost meter is memory-only across restarts. `unindexed-event-address` is
accepted until the indexer wave. The Codex cross-check and the Fable reviewer pass over items 2, 5 and 6 have not
run; the lead's own review is recorded above and the standing rule (Fable reviews the money path before the
operator signs Deploy) still applies. The `frame-ancestors` header gap on GitHub Pages noted in `web/README.md`
remains.

## Wave 7 Fable review and fixes (2026-09-16)

Two Fable reviewers ran after the wave landed, per the standing rule that the money path and the trust
boundary get an independent adversarial pass before the operator signs Deploy. Reproduce-before-report; probes
at `zz_probe_*` paths, deleted afterwards. The lead verified every finding against the source before assigning
fixes to three Opus builders on disjoint files, then reviewed the fixes and re-ran every suite.

Trust boundary (validator, web release gate, Pages workflow, `DeploymentLib` release preservation). **High:**
a mainnet manifest could open to customers with no recovery drill recorded anywhere, because RA2 ran only when
a release-authority record with `environment: mainnet` and a matching `deploymentId` happened to exist, and a
record labelled `testnet` exempted itself; three reproductions (record deleted; record relabelled testnet with
every drill flag false; record pointing at a nonexistent manifest) all passed the validator and the web gate.
Fixed with rule RA3: every mainnet manifest must be covered by a release-authority record with its
`deploymentId`, and any record covering a mainnet manifest must itself be mainnet. **Medium:**
`customerLaunch: true` passed with impossible shakedown numbers (zero gas, gas above `callbackGasLimit`, zero
latency, cost `"0"`, a date before deployment); fixed in D27 and the schema minimums. **Medium:**
`DeploymentLib` dropped `price.observationWindow` on the plan-to-manifest write and on every rewrite, so a
correctly filled mainnet plan would have produced a manifest failing P8 only after Deploy had spent gas; fixed
with a per-asset `priceExtras` carrier and three tests including a round trip of the shipped mainnet template.
**Medium:** the Pages workflow deployed from any branch a `workflow_dispatch` was started on, so a branch with an
unreviewed `customerLaunch: true` manifest could reach the production site; fixed with `if: github.ref ==
'refs/heads/main'` on the deploy job and a runbook instruction to restrict the `github-pages` environment to
`main`; the runbook's example release-authority record now says `actionsPinnedToCommitSha: false`, which is
the truth (every `uses:` is a tag) until the operator pins them. **Low:** `_metadataField` coerced
schema-illegal strings (`"customerLaunch": "true"`) into typed values on the next rewrite, after which both
gates passed; fixed by refusing text where a boolean or number belongs, a null `release`, and a shakedown
without `performed` (`vm.parseJsonString` also coerces, so the discriminator is the word count of
`vm.parseJson`). **Low:** RA2 accepted a drill dated after deployment and a mainnet record whose deploymentId was
on chain 97; both fixed. Found sound: sixteen malformed shakedown shapes rejected, RA2 address comparison,
mock detection between the two gates, the Pages variable resolution in three real builds, `_readRelease` on
every schema-legal input, the plan template, the reserve display and explorer links.

Money and operations (keeper, feed observation, chain record check). **Medium:** alert webhook bodies carried
the unredacted operational RPC URL, key included, because redaction lived only in the logger; fixed in the
notifier for every string field, the summary line and POST heartbeat bodies. **Medium:** the keeper's
Multicall3 reduced nothing, since every adapter call was its own single-item batch (38 requests per cycle with
or without it) while the README claimed otherwise; and a wrong Multicall3 in the chain record passed start-up
and put the keeper in a ten-failures-then-restart loop forever. Fixed both ways: a new `keeper/src/reads.ts`
groups each cycle into three batches over the client's public `readBatch` and normalizers (measured 8 requests
with Multicall3 against 23 without, asserted by test), and start-up gate 6 requires code at the address and one
answered `aggregate3` before the keeper runs. **Medium:** `check_chain_record` passed and printed the fragment
when `aggregate3` returned a well-formed empty result array; fixed. **Medium:** `observe_feed`'s
`latestRound()`-revert fallback bisected on single-round presence, so one hole at a probe point entered the
previous phase at the wrong top and silently dropped samples (p99.9 2,820 s instead of 600 s in the probe);
fixed with the walk's own miss tolerance, a step-down to the last present round and a WARNING; an inverted
`observationWindow` now prints FAIL instead of a fragment the validator would refuse. **Low:** a transport
failure in `eth_estimateGas` was paged as a `requestDraw` pre-check failure and set the 60 s back-off; now a
send failure with no alert. **Low:** `KEEPER_HEARTBEAT_METHOD` echoed its value in the refusal and
`loadConfig` ran outside `main`'s try, so refusals were stack traces; fixed, and a test-runner capture bug
that hid one TAP line per capturing test was found and fixed along the way. **Low:** the once-per-hour alert
limiter is per process, so a persistent fault pages about every three minutes across restarts; documented in
the README, unit file and runbook rather than persisted. **Low:** the non-numeric chain-record `chainId`
message named the wrong cause; fixed. Found sound: key custody end to end (directory, two-line file, empty
file, ethers' own redaction), log redaction on every event, the alert limiter and drain, the cost meter's
hash-keyed pending map and topic-plus-requestId matching of `RandomWordsFulfilled`, the subscription check at
the snapshot block, the mock and chain gates, Multicall3 block consistency, nearest-rank percentiles,
rate-limit handling in the feed walk.

Verification after the fixes. Contracts: 337 passed, 0 failed, 2 skipped by design under the ci profile (50 script tests), LuckyDraw runtime unchanged at 24,044 bytes. Config: 113 tests, `validate:config` 7 documents pass.
Keeper: 133 tests (132 plus the opt-in anvil journey, 9 steps and 26 assertions, `config/deployments/31337`
byte-identical afterwards). Operator scripts: 68 tests. Web: 366 tests. Client: 291 tests, `abi:check` up to
date. Root `pnpm lint` and `pnpm typecheck` clean; `render_spec`, `check_generated` and `trace_check` pass.

Still open. No passing chain-56 build has run. The Slither CI job has not run on Linux. The Codex cross-check
brief has not been run. Actions are tag-pinned, recorded honestly as `actionsPinnedToCommitSha: false`. The
keeper has one RPC URL and no failover, so nothing re-checks `eth_chainId` after a failover. The
`frame-ancestors` gap on GitHub Pages remains.

## Alias-free tree for Slither, and pruned-log handling in the web scan (2026-09-18)

The source diff proposed under "Static analysis (Slither) and Codex cross-check preparation (2026-09-16)" is
applied. No file under `src/` imports a custom error under an alias any more: `LuckyDraw.sol` imports
`BuysPaused` and `LuckyVault.sol` imports `EscrowClosed` under their own names, and the five revert sites use
those names. `test/unit/LuckyVaultEscrow.t.sol` dropped its own local `EscrowClosed as EscrowIsClosed` in the same
pass, so no alias survives anywhere in `contracts/`. The runtime bytecode is unchanged and was proved rather than
asserted: `forge inspect LuckyVault deployedBytecode | cast keccak` is
`0xb75270ba5311c3263d0c0c9076abd412792a4834a1d945472c6464e5a30e3f9b`, byte-identical to the `vault.codeHash` in
`config/deployments/97/0x25c41f9921e51b120f971e25181c55b1dcaf1d41.json`, before and after the change.
`LuckyDraw` hashes to `0x66ca11780ccd7db44e2b863feb96899915b3138bc5daef85760eff6af9bfe2ce` before and after, which
differs from the manifest's `draw.codeHash` only because the artifact carries zeroed immutable placeholders where
the deployed code carries the constructor's addresses; the before-equals-after comparison is the one that speaks to
this change, and it holds. Contracts: 359 passed, 2 skipped; `forge fmt --check` clean.

**The CI Slither run on the real tree is now the authoritative one.** The 2026-09-16 triage was taken on a scratch
alias-free copy because the repository tree could not be parsed; that stand-in is retired. The
`ERROR:ContractSolcParsing` guard in `.github/workflows/ci.yml` stays, now as a regression guard against
reintroducing an alias, and `continue-on-error: true` with `fail_on: none` stays until condition (b) alone --
every Medium finding fixed or accepted with a named owner -- is met. Note that the triage counts themselves are
still stale under ADR 036, as the wave 7 ACCEPTANCE row records.

Separately, the web entries scan learned that a provider can answer "I no longer have those blocks". Measured on
2026-09-18: publicnode (`https://bsc-testnet-rpc.publicnode.com`) prunes logs below a rolling height and answers
`-32701` for ranges below about block 131,577,900, while drpc's free plan refuses every `eth_getLogs` with code
`3`. The shared classifier in `packages/client/src/reads/providerError.ts` gained a fourth kind, `pruned`, and the
scan treats it as neither a range cap nor a rate limit: halving and retrying a window the node will never serve is
wasted budget, so the scan records the height below which history is unavailable on this RPC, advances the cursor
past the window and keeps reading the newest history. `usePositions` and `/entries` surface that height as a
labelled partial-history notice from the string catalog, per SPEC 10.1, never as the provider's own words. The
keeper treats `pruned` like `unknown` for now. SPEC 14 gains the matching mainnet gate: entry history must come
from an archive-capable RPC or the indexer.
