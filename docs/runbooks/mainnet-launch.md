# Mainnet launch runbook

For the operator. This takes a fresh checkout to a working LuckyDraw on **BSC mainnet (chain 56)**, with the
web app published on GitHub Pages at `https://<your-github-user>.github.io/luckydraw/` and the keeper running
as a service on your own machine. Unlike `docs/runbooks/testnet-launch.md`, everything here is **real money**:
real BNB, real entries from real people, real losses if something is wrong.

ADR 035 put a BSC testnet trial first, and it happened: chain 97 has run the seven-kind build live since
2026-09-18, one round settled through a real VRF fulfilment and one refunded. What it does not prove is chain
56's own coordinator, feed and finality, so the private shakedown of section 5 is still where those are first
observed **on mainnet, with your own funds**. That shakedown is not optional and no link is shared before it is
recorded.

**ADR 040 is the sequence this runbook follows.** It defers seven gates, each an operator-accepted risk you own
the response and the funding for: the paid audit, the legal and jurisdiction determination, the §10.4 privacy
controls U30–U37, Chainlink Automation upkeep registration and LINK funding, the archive-capable RPC or
indexer, the ADR 037 Binance-Peg USDT admission, and the three-day soak. It also fixes what is **not** deferred,
and this runbook is that list in order:

| # | Mandatory before `release.customerLaunch` becomes true | Section |
|---|---|---|
| 1 | Safe configuration verified and the §10.5 recovery drill performed **on the real mainnet Safes, before `Deploy` is signed** | 1.2, 1.3 |
| 2 | deploy → configure → finalize → verify → `validate:config`, with `Verify` exiting zero | 3, 4 |
| 3 | The private shakedown: one settled round and one refund, with measured callback gas, request-to-fulfilment latency and cost per draw in `release.shakedown` | 5 |
| 4 | The keeper on its host with `KEEPER_HEARTBEAT_URL` and `KEEPER_ALERT_WEBHOOK` set and **one alert actually received** | 7 |
| 5 | One manual real-wallet MetaMask entry on the live web app (chain 97 before the flip, chain 56 straight after it) | 5c |
| 6 | The flip itself, and nothing after it | 6 |

Four rules that override anything below:

- **Never put a private key, a seed phrase or an RPC key in this repository**, in a `.env` file that is
  committed, in a GitHub secret used by the Pages workflow, or in a command you paste into a chat. The
  deployment scripts and the keeper are built so they never need one to be written down.
- Everything the web build contains is **public**. It is a static bundle every visitor downloads. A keyed RPC
  endpoint put into it is published to the world twice over, and the app refuses one for that reason.
- **This repository records no mainnet address it has not been given.** Every coordinator, key hash, feed
  proxy, Multicall3 and Safe address below is a value *you* read from its source page and verify against the
  live chain on the day, and record with the `source.url` and `source.date` that say where and when. A value
  copied from a blog post, from a search result, from a chat message or from this document would be a value
  nobody checked.
- A mainnet manifest may reference **no mock**. A chain, subscription or feed problem fails the release; it is
  never quietly replaced with a mock (SPEC §12, `config/README.md`).

Work through the sections in order. Nothing later works if something earlier was skipped.

---

## 1. Prerequisites

### 1.1 Wallet and funds

**MetaMask** in your browser, with the BNB Smart Chain mainnet network (chain id 56). The app offers to add
the network when a visitor is on the wrong chain, so you do not have to type the parameters by hand.

Real BNB has to be in five places, and they are five different accounts on purpose:

| Account | Why it holds BNB |
|---|---|
| Your deploying account | gas for `Deploy`, `Configure` and `Finalize` |
| The VRF subscription | pays the coordinator per fulfilment (native billing) |
| The seed Safe, deposited into the Vault | the operator seed entry in every funded round |
| The treasury Safe | the §10.5 make-whole reserve, held and not spent |
| The keeper account | gas only, a small balance, nothing else |

### 1.2 Three Safes

Create **three separate Gnosis Safes on chain 56** — owner, treasury (fee account) and seed — each **2-of-3**
with independently generated hardware-wallet keys (SPEC §10.5). The owner and treasury Safes are the two that
can move money and their keys must be hardware keys; do not weaken the seed Safe either, it holds the balance
every seeded round spends. Do not reuse one Safe for two roles: `validate:config` rule `O1` fails a mainnet
manifest whose three roles are not three distinct addresses, and the fee account is frozen into every round at
creation and can never be changed for rounds that already exist.

Separate the three seed backups physically. Never put a quorum of keys or backups on one device, one cloud
account, one password manager or one recovery path. Record whether **distinct people** hold the keys: one
person holding every key is not protection against that person's coercion or mistake.

Use a **pinned, verified Safe deployment**, with no enabled modules and no custom guard. Take the deployment
addresses for chain 56 from Safe's own published deployment records (`docs.safe.global`, the deployments
section), not from a search result, and then check them against the chain yourself before you trust the Safe:

```bash
export LUCKYDRAW_OPS_RPC_URL="https://<your keyed BSC mainnet endpoint>"
export PATH="$HOME/.foundry/bin:$PATH"

cast code <safe address> --rpc-url "$LUCKYDRAW_OPS_RPC_URL" | head -c 20   # not "0x"
cast call <safe address> "VERSION()(string)"            --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast call <safe address> "getOwners()(address[])"       --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast call <safe address> "getThreshold()(uint256)"      --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast call <safe address> "getModulesPaginated(address,uint256)(address[],address)" \
  0x0000000000000000000000000000000000000001 10        --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
```

`getOwners()` must list three addresses, `getThreshold()` must be 2 and `getModulesPaginated` must come back
empty. Record the sanitised result — role, threshold, signer count, hardware keys, distinct key holders,
implementation address, fallback-handler code hash, `modulesEnabled: false` — in the plan's optional
`ownership.safes` array (`config/schema/ownership.schema.json`). Signer addresses, seeds and backup locations
are never written into `config/`; §15 says the public record holds the sanitised configuration only.

Every signer verifies each transaction from an independent device against the written change record: chain,
Safe address, nonce, operation, target, value, calldata, refund fields. Never approve blind data. Two hardware
wallets reading the same false summary off one shared workstation is not independent verification.

### 1.3 The recovery drill, on these Safes, before anything is deployed

SPEC §10.5 requires the drill on the **mainnet** Safes themselves, performed **before the contracts are
deployed**. The chain 97 Safe of ADR 035 was driven from the command line by `TestnetSafe.s.sol` and proves
nothing about these three, so the drill has no earlier stage to hide in. ADR 040 keeps it mandatory while it
defers other gates: this is the one item that cannot be added to a running deployment afterwards.

Start from the configuration you read off the chain in section 1.2, not off the screen you created the Safes
on. Write down, per Safe: the three owner addresses and which hardware device holds each, the threshold (**2**),
the version, and that the module list is **empty** — a module is a second door into the Safe and there is no
reason for one here. Three owners on three separate devices; a Safe whose three "signers" are three accounts in
one wallet has a threshold of 2 and the security of 1.

Then five checks, run **on each of the three Safes**:

1. **A zero-value `execTransaction` executes.** Queue a transaction to the Safe's own address, value 0, empty
   data. Collect both signatures and execute it. It moves nothing and costs only gas, and it proves the whole
   path — proposing, signing on each device, collecting, executing — works before it is holding money. Keep the
   transaction hash.
2. **One signer unavailable.** The remaining two independently verify and execute an authorized action.
3. **One signer alone cannot act.** A single signature does not execute.
4. **A lost signer can be replaced.** Rehearse the loss: with one device set aside as "lost", the remaining two
   send `swapOwner` to replace that owner with a fresh address, confirm `getOwners()` and `getThreshold()` on
   chain afterwards, and then — if the "lost" device was only set aside — swap it back the same way. Doing it
   twice is the point: the recovery path is the one you will use under stress, and the second swap proves it is
   reversible rather than one-way.
5. **The treasury Safe can pull money out of the Vault.** This one cannot be done yet; it is step 5 of
   section 4, after the Vault exists, and it is what sets `treasuryWithdrawalProven`.

Keep the transaction hashes and the date. You cannot write the record yet — it is keyed by the Draw address,
which does not exist until section 3 — so keep the evidence and write the record straight after `Deploy`, in
`config/release-authority/<name>.json`. Write it before you run `validate:config` again: rule `RA3` fails every
mainnet manifest that has no release-authority record with its `deploymentId`, and a record that covers a mainnet
manifest must itself say `"environment": "mainnet"`. The drill `date` must be on or before the day of the
manifest's `createdAtUtc`, which doing section 1 before section 3 gives you.

```json
{
  "schemaVersion": 1,
  "deploymentId": "56:<lowercase draw address>",
  "environment": "mainnet",
  "custody": {
    "separateSafes": true,
    "recoveryDrill": {
      "performed": true,
      "date": "<YYYY-MM-DD of the drill>",
      "chainId": 56,
      "safes": {
        "owner": "<lowercase owner Safe>",
        "treasury": "<lowercase treasury Safe>",
        "seed": "<lowercase seed Safe>"
      },
      "unavailableSignerPassed": true,
      "compromisedSignerBlocked": true,
      "signerReplacementPassed": true,
      "treasuryWithdrawalProven": true,
      "receiptRefs": ["restricted: recovery-drill (Safe transactions, dated in this record)"]
    }
  },
  "review": {
    "reviewerDistinctFromAuthor": true,
    "selfApprovalDisabled": true,
    "adminBypassDisabled": true,
    "untrustedPullRequestsIsolated": true,
    "actionsPinnedToCommitSha": false
  }
}
```

`actionsPinnedToCommitSha` is a claim about your repository, not a setting: today every `uses:` in
`.github/workflows/*.yml` is a version tag (`@v4`), which a compromised tag can move. Leave it `false` until you
have replaced each tag with the full 40-character commit SHA of the release you reviewed; then flip it.

Two things about that record:

- `chainId` must be 56 and the three addresses in `safes` must equal the manifest's
  `ownership.finalOwner`, `feeAccount` and `seedAccount` exactly, lowercase. Rule `RA2` in
  `scripts/validate_config.ts` compares them and fails the run otherwise: a drill on some other chain's Safes,
  or on Safes that do not hold the roles, proves nothing about the ones that hold the money.
- `treasuryWithdrawalProven` cannot honestly be `true` until the Vault exists. That proof is **step 5 of
  section 4**, and until you have done it the field is `false` and `validate:config` fails the record, which is
  the correct state of the world. Set it to `true` only after the treasury Safe has actually pulled a
  withdrawal out of the Vault.
- `receiptRefs` holds **pointers**, not receipts: a reference to your private evidence file, or a count plus an
  explorer link. Never publish seeds, backup locations or private inventory (§10.4, §15).

### 1.4 VRF v2.5 subscription

Create the subscription at `vrf.chain.link` on BNB Chain mainnet, with the **owner Safe** as the subscription
owner. If for a practical reason it is owned by something else on day one, write the reason and the date into
the manifest `notes` and transfer it to the Safe before the customer link; the VRF subscription must never be
owned by the keeper or any hot key (SPEC §7.3).

The plan sets `nativeBilling: true`, so fund it with **BNB**. If you switch to LINK billing you must set that
flag to `false` and fund with LINK instead.

Fund it above `vrf.lowFundingThresholdNative` **plus at least 30 draws** of headroom. Two reasons that number
is not conservative padding: `Configure` refuses to open a pool while the subscription is below the threshold,
and `requestDraw` refuses while the balance is below `(pendingRequests + 1) x maxRequestCostNative`. A round
that is accepted and never fulfilled raises that floor by one `maxRequestCostNative` **permanently**, with no
on-chain clearing path (SPEC §7.3) — treat a stuck round as a permanent increase in the funding floor, not as
a one-off cost.

Take the coordinator address and the key hash of the lowest-gas lane from the Chainlink supported-networks page
(`docs.chain.link/vrf/v2-5/supported-networks`, BNB Chain mainnet) and note the date you read it. Then check
both against the chain before they go into the plan — all three of coordinator, subscription id and key hash
are fixed into the Draw at construction and have no setter:

```bash
cast code <coordinator> --rpc-url "$LUCKYDRAW_OPS_RPC_URL" | head -c 20        # not "0x"
cast call <coordinator> "s_provingKeys(bytes32)(bool,uint64)" <key hash> --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast call <coordinator> "getSubscription(uint256)" <subscription id>     --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
```

The first return value of `s_provingKeys` must be `true`: that is the lane being registered. `Deploy` asserts
both getters exist and reverts otherwise, but it cannot tell you that you picked the wrong lane.

### 1.5 The BNB/USD price feed

Take the feed **proxy** address for BNB/USD on BNB Chain mainnet from the Chainlink data-feeds address list
(`docs.chain.link/data-feeds/price-feeds/addresses`), with the date you read it, and the documented heartbeat
from the same page. Then confirm it against the chain:

```bash
cast call <feed proxy> "decimals()(uint8)"        --rpc-url "$LUCKYDRAW_OPS_RPC_URL"   # expect 8
cast call <feed proxy> "description()(string)"    --rpc-url "$LUCKYDRAW_OPS_RPC_URL"   # expect BNB / USD
cast call <feed proxy> "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
  --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast call <feed proxy> "aggregator()(address)"    --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
```

The answer must be a plausible BNB price at 8 decimals and its `updatedAt` must be recent. Then read
`minAnswer()` and `maxAnswer()` on the **aggregator** the proxy points at; if the deployed aggregator has no
bounds, set `answerBoundsConfirmedAbsent: true` in the plan and say so rather than inventing numbers.

### 1.6 Observed feed interval

The plan's `observedP999IntervalSeconds` is the interval you **measured**, never the documented heartbeat, and
a mainnet price record additionally carries the `observationWindow` the measurement was computed over. Both
come from the feed observation script:

```bash
npx pnpm@12.3.4 observe:feed --rpc-url "$LUCKYDRAW_OPS_RPC_URL" --feed <feed proxy> --days 30 --heartbeat <documented H>
```

Always pass `--heartbeat`: without it the script reports the interval but cannot check it against
`maxPriceAge`. On a rate-limited public endpoint add `--concurrency 2`; the script aborts on a rate limit
rather than quietly shortening the history it measured.

It is read-only. It walks the aggregator's round history through the proxy, prints p50, p99 and p99.9 update
intervals, the observed minimum and maximum answer, and the exact JSON fragment to paste into the plan's
`assets[0].price` — `observedP999IntervalSeconds` and `observationWindow: {fromBlock, toBlock, samples}`. It
also prints the `maxPriceAge = max(2H, 3600)` the spec requires and flags the case where p99.9 exceeds it. If
it flags that, stop and resolve it: `maxPriceAge` below the interval the feed actually achieves means the app
goes stale on an ordinary day.

### 1.7 Chain record for chain 56

`config/chains/56.json` exists with `networkIdentity.genesisHash` and `networkIdentity.multicall3` null. Rule
`CH4` fails `validate:config` the moment a mainnet manifest exists and either is still null, so fill them
before section 5. Get the fragment from the chain-identity script — it reads `eth_chainId`, the block 0 hash
and the code at the Multicall3 address you give it, compares them with the record, prints the fragment and
**refuses to write the file itself**:

```bash
npx pnpm@12.3.4 check:chain --rpc-url "$LUCKYDRAW_OPS_RPC_URL" --chain-id 56 --multicall3 <address>
```

SPEC §10.3 does not name a canonical Multicall3 address and neither does this repository, so `--multicall3` is
your input: take it from the Multicall3 project's own deployment list, and the script then proves the address
has code and answers `getBlockNumber()` and `aggregate3` consistently with the head. Paste the fragment into
`config/chains/56.json` by hand, including `networkIdentity.source.url` and `.date`.

This one is worth doing properly rather than leaving null: without a Multicall3 address the round page issues
roughly 42 RPC requests per block epoch, which a public BSC endpoint will throttle.

### 1.8 Keeper key, RPC endpoints, and the legal sentence

- **A dedicated keeper key**, created for this and nothing else, funded with a small gas balance. Never the
  owner Safe, never the treasury Safe, never the seed Safe, never the VRF subscription owner.
- **A keyed operational RPC endpoint** in your own shell as `LUCKYDRAW_OPS_RPC_URL`, for the deployment
  scripts and the keeper. It never reaches the browser.
- **A public RPC origin** for the web build, with no API key and no query string. It is compiled into the
  bundle and handed to every visitor's wallet by `wallet_addEthereumChain`; the build refuses a value carrying
  credentials or a query string.
- **The jurisdiction determination** from qualified advisers (SPEC §14) and the one-sentence notice you will
  publish as its outcome. The build requires that sentence on chain 56 and fails without it. This spec defines
  an unrestricted on-chain baseline; it is not a claim of legal permission, and a frontend-only restriction is
  not enforcement if mandatory controls require contract enforcement.

### 1.9 Tooling and review gates

Node 24 (`.nvmrc`), pnpm 12.3.4 (`npx pnpm@12.3.4 …` works without installing it) and Foundry 1.8.1
(`export PATH="$HOME/.foundry/bin:$PATH"` in Git Bash). From the repository root:

```bash
npx pnpm@12.3.4 install --frozen-lockfile
```

Before you sign `Deploy`, the §12.1 MVP gate also requires the Slither triage with no untriaged
medium-or-higher finding, the Codex cross-check and the Fable review of the release diff (`docs/REVIEW.md`).
They are review work, not deployment steps, but they come first.

---

## 2. Fill in the deployment plan

There is no mainnet plan template. Copy the testnet form and convert it — that is deliberate, so the chain
facts pass through your hands:

```bash
mkdir -p config/deployments/56
cp contracts/script/templates/testnet.plan.example.json config/deployments/56/mainnet.plan.json
```

Then edit `config/deployments/56/mainnet.plan.json`:

- delete the `"template": true` line — every script and the validator refuse a document while it is there;
- `"name"` must equal the file name without `.plan.json`, so `"name": "mainnet"` for the path above;
- `"environment"` becomes `"mainnet"`. Rule `E1` requires mainnet to be chain 56, and `Deploy` refuses a plan
  whose `environment` disagrees with the connected chain;
- replace the whole `chain` block with the chain 56 facts already recorded in `config/chains/56.json`:
  `chainId` 56, `name` `bsc-mainnet`, `nativeSymbol` `BNB`, `explorerUrl` `https://bscscan.com`,
  `confirmationDepth` 200, and the same `rpcEnvVars` names. A plan carries no `startBlock`; `Deploy` records
  it;
- replace the `notes` text with your own, and fix the two testnet references in `ownership.note`;
- leave `toolchain` as it is: those are the pins in `contracts/foundry.toml` and rule `T1` checks them.

Every `null` below has to become a value **you verified against the live chain today**. Rows marked
**mainnet-only** have no equivalent on testnet or are values a testnet run was allowed to leave empty.

| Field | Where it comes from |
|---|---|
| `vrf.coordinator` | the VRF v2.5 coordinator for BNB Chain mainnet, section 1.4, checked with `cast code` |
| `vrf.subscriptionId` | your subscription id from `vrf.chain.link` |
| `vrf.keyHash` | the lowest-gas lane you picked, confirmed registered by `s_provingKeys` |
| `vrf.maxRequestCostNative` | the most one randomness request can cost, in wei; the Draw enforces it forever |
| `vrf.maxRequestCostDerivation.*` | `maxGasPriceWei`, `verificationGasOverhead`, `premiumPercentage`, `flatFeeNativeWei` — the numbers you multiplied to get the line above, so rule `V1` can re-check it |
| `vrf.lowFundingThresholdNative` | the subscription balance below which `Configure` refuses to open a pool |
| `vrf.measuredCallbackGasUsed` | **pre-deploy**: the Foundry gas measurement, see below — *not* a mainnet number |
| `vrf.source.date` | the date you read the Chainlink page |
| `ownership.finalOwner` | the **owner** Safe (mainnet-only: three distinct Safes, rule `O1`) |
| `ownership.feeAccount` | the **treasury** Safe — frozen into every round at creation, never changeable for existing rounds |
| `ownership.seedAccount` | the **seed** Safe |
| `ownership.makeWholeReserve` | **mainnet-only, nonzero**: the §7.3 make-whole reserve in wei, actually held in the treasury Safe |
| `ownership.makeWholeCap` | **mainnet-only, nonzero**: the per-incident cap you publish |
| `ownership.safes[]` | the sanitised Safe configurations from section 1.2 |
| `assets[0].source.url` / `.date` | where you confirmed the asset and when — for native BNB the chain's own documentation |
| `assets[0].price.feed` | the BNB/USD proxy from section 1.5 |
| `assets[0].price.heartbeatSeconds` | the feed's documented heartbeat |
| `assets[0].price.observedP999IntervalSeconds` | **measured**, from section 1.6 |
| `assets[0].price.observationWindow` | **mainnet-only**: `{fromBlock, toBlock, samples}` from the same run |
| `assets[0].price.maxPriceAge` | `max(2 x heartbeatSeconds, 3600)`, within 60..172,800 (rule `P1`) |
| `assets[0].price.minAnswer` / `maxAnswer` | the aggregator's bounds, or `answerBoundsConfirmedAbsent: true` |
| `assets[0].price.displayLabel` | what the UI calls the reference, e.g. `BNB/USD` |
| `assets[0].price.pegAssumption` | `null` for BNB: nothing is assumed to be pegged |
| `assets[0].price.verifiedOn` | the date you checked the feed against the chain |
| `assets[0].pool.seedAmount` | the operator seed entry, in wei of BNB — see the sizing note below |
| `assets[0].pool.seedAuthorizedMaxPerRound` | the per-round cap you will authorize from the seed Safe; at least `seedAmount` (rule `D15`) |

`pool.targetsUsd` is already the seven spec defaults — `Day100` 100, `Day1k` 1000, `Day10k` 10000, `Week1k`
1000, `Week10k` 10000, `Week100k` 100000 and `Month100k` 100000 (SPEC §6.1, ADR 036). A round draws as soon as its target is reached, and at its fixed UTC cutoff at the latest.

### `measuredCallbackGasUsed` before there is a mainnet to measure on

This field cannot be measured on mainnet before the deployment that would measure it, and there is no testnet
run to take it from. Use the **Foundry gas measurement from the contract suite**, which ACCEPTANCE records
under the contract unit/invariant/gas row, against the §11.2 ceiling of 150,000 within the configured 300,000
`callbackGasLimit`:

```bash
cd contracts
FOUNDRY_OUT=out/mainnet-gas FOUNDRY_CACHE_PATH=cache/mainnet-gas \
  forge test --match-test test_Gas_CloseRequestSettleAndCallback -vv
```

The line reported for `callback (two nonzero words, cold)` is the number. Note in the plan's `notes` that it is
a Foundry measurement, not a mainnet observation. The **mainnet** number is measured in the shakedown and goes
into `release.shakedown.callbackGasUsed` (section 5), which is a different field on purpose: one is what the
compiler produced, the other is what the coordinator actually paid for.

### Sizing the seed

The seed is **your stake in every funded round**, not a fee. It is a real entry in the pool that can win, and
when it loses, the money goes to the winner. Nothing comes back to the seed balance from a round that settles.

Each of the three daily kinds draws **every day**, and a pool has seven kinds, so a month of ordinary
operation is 90 daily rounds (3 tiers x 30 days) plus 13 weekly (3 tiers x 4.35 weeks = 13.05, rounded down)
and 1 monthly — **104 funded rounds**, each costing one `seedAmount` out of the Vault balance the seed Safe
deposited. On top of that, each draw costs one VRF fulfilment out of the subscription plus the
keeper's gas for the seed, close, request and settle transactions.

So pick `seedAmount` by working backwards from a month:

> `104 x seedAmount` + `104 x (VRF cost per draw + keeper gas per draw)` is what a quiet month costs you,
> and it must be an amount you are willing to lose.

Start small. A seed that is a meaningful fraction of a USD 100 daily target is also a meaningful fraction of
the prize you are paying for; a seed that is small relative to the target is a cheap guarantee that a lone
player gets a draw instead of a refund, which is the only thing the seed exists for. You can raise it later
from the owner Safe with `setSeedAmount`; you cannot get back what a settled round paid out.

Keep at least a month of seeds in the Vault balance and top it up on a schedule, not on an alert.

---

## 3. Deploy the contracts

All of this is from `contracts/README.md`; run it from the `contracts/` directory. The scripts never read a
key — the signature comes from **your own** signing flow, which is the `--ledger`, `--trezor`,
`--interactive` or `--account <keystore-name>` flag you normally use with `forge script`. Below that is
written as `<your signer flags>`. Do not put `--private-key` on a command line.

Set the endpoint for the session (a keyed operator endpoint is fine here; it never reaches the browser):

```bash
export LUCKYDRAW_RPC_URL="$LUCKYDRAW_OPS_RPC_URL"
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts
```

**Step 1 — Deploy.** Creates the Vault/Draw pair and writes the first manifest.

```bash
LUCKYDRAW_PLAN=../config/deployments/56/mainnet.plan.json \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
```

It refuses a plan whose chain id is not the connected chain, whose `environment` does not match chain 56, that
names a coordinator without `s_provingKeys(bytes32)` and `getSubscription(uint256)`, that gives any privileged
role a plain address with no code, or that names any address whose deployed code matches one of the
repository's labeled mocks. Note the **Draw address** it prints; the manifest is
`config/deployments/56/<lowercase draw address>.json`.

```bash
export M=../config/deployments/56/<lowercase draw address>.json
```

**Step 2 — add the Draw as a VRF consumer.** Go back to `vrf.chain.link`, open the subscription, and add the
Draw address as a consumer. This is a transaction from the subscription owner, so it is a Safe transaction if
the owner Safe owns the subscription. Do it now: `Configure` refuses to create a pool until the Draw is a
registered consumer and the subscription is above `lowFundingThresholdNative`, and rule `D22` fails a mainnet
manifest without a registered consumer.

**Step 3 — Configure.** Lists the assets, opens the pools, and starts the two-step ownership transfer to the
owner Safe.

```bash
LUCKYDRAW_MANIFEST=$M \
  forge script script/Configure.s.sol:Configure --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
```

`Configure` is idempotent: every step reads the live state first and is skipped when it already matches. If you
ran it before registering the consumer, or it stopped halfway, **just run it again** — nothing is duplicated
and nothing is destroyed. It also refuses a manifest whose recorded coordinator, subscription id, key hash or
`maxRequestCostNative` differs from the deployed Draw's own immutables.

`Configure` and `Finalize` carry the manifest's `release` object (`customerLaunch`, `shakedown`) through their
rewrites, so a re-run after section 5 keeps your shakedown numbers. Re-run `validate:config` and `Verify`
afterwards all the same.

**Step 4 — Finalize.** Records the exact creation blocks and transaction hashes from the broadcast file and the
authenticated RPC receipts.

```bash
LUCKYDRAW_MANIFEST=$M LUCKYDRAW_BROADCAST=broadcast/Deploy.s.sol/56/run-latest.json \
  forge script script/Finalize.s.sol:Finalize --rpc-url "$LUCKYDRAW_RPC_URL"
```

**Step 5 — Verify.** Read-only, and exits non-zero on any mismatch. Nothing proceeds until it passes.

```bash
LUCKYDRAW_MANIFEST=$M forge script script/Verify.s.sol:Verify --rpc-url "$LUCKYDRAW_RPC_URL"
```

**Step 6 — verify the source on BscScan.** Not optional on mainnet. Publish the verified source for both the
Vault and the Draw on `bscscan.com`, so that MetaMask shows a readable contract and method name before every
signature (SPEC §9.2 trust signals) and so that anyone can read what they are sending money to. Use the pinned
toolchain from `contracts/foundry.toml` — solc 0.8.28, `evm_version = paris`, via_ir, 600 optimizer runs, no
metadata hash — or the verification will not reproduce the bytecode.

**Step 7 — validate.** From the repository root:

```bash
npx pnpm@12.3.4 validate:config
```

It needs no network access and reads no secrets. On a mainnet manifest it additionally enforces three Safes
(`O1`), a nonzero make-whole reserve and cap (`O4`), a registered VRF consumer (`D22`), the chain record's
`genesisHash` and `multicall3` (`CH4`), the price record's `observationWindow`, and the recovery drill's chain
and Safes (`RA2`). Fix everything it reports; a manifest that does not validate is a manifest the web build
will also refuse.

Commit the manifest, the chain record fragment and the release-authority record, and push. The Pages build
reads them from the repository — it never talks to the chain — so the site cannot be built until they are
committed.

---

## 4. Safe steps (from the Safe interface, as the Safes)

These are sent **by the Safes**, not by your deploying account. In the Safe interface use "New transaction →
Transaction builder" and enter the Vault or Draw address with the function below. Each is a 2-of-3 signature
with independent verification of the decoded calldata.

1. **Accept ownership of the Vault** — `acceptOwnership()` on the Vault address, from the **owner** Safe.
2. **Accept ownership of the Draw** — `acceptOwnership()` on the Draw address, from the **owner** Safe.
   Ownership is two-step, so until both are accepted the Safe is not yet the owner and rule `D16` fails.
3. **Deposit the seed balance** — `depositNative()` on the Vault, from the **seed** Safe, with a BNB value of
   at least a month of seeds (section 2). Every seeded round spends `seedAmount` from this balance and rounds
   that settle return nothing to it.
4. **Authorize the seed, per asset** — `authorizeSeed(asset, maxPerRound)` on the Vault, from the **seed**
   Safe, once for each asset in the plan, with `maxPerRound` equal to the plan's `seedAuthorizedMaxPerRound`.
   Use `0x0000000000000000000000000000000000000000` as `asset` for native BNB. The seed account has to call
   this itself — nobody, including the owner, can authorize spending of the Safe's balance on its behalf.
5. **Prove a treasury withdrawal** — SPEC §10.5 requires the treasury Safe to pull a real withdrawal out of the
   Vault through the actual Safe and its pinned receiving configuration, once the Vault exists and **before any
   customer link is shared**. Do it as part of the shakedown in section 5, after the first settled round has
   credited the fee: `withdraw(asset, amount)` on the Vault from the **treasury** Safe. Only then set
   `custody.recoveryDrill.treasuryWithdrawalProven: true` and re-run `validate:config`.

Without 3 and 4 the keeper logs `SeedNotAuthorized` or `InsufficientSeedBalance` every cycle and no round is
ever seeded, which means a round with one player refunds instead of drawing.

**Hold the make-whole reserve.** `ownership.makeWholeReserve` is not a number in a file; it is BNB that must
actually be sitting in the treasury Safe, unspent, at least equal to the recorded figure. §7.3 commits you to
reimbursing every affected buyer's gross entry from that Safe within 3 business days if a round has been in
Drawing for more than 7 days, up to the published `makeWholeCap`, and the app publishes the reserve, the cap
and the current sum of gross in Drawing and Ready. Do not recycle the reserve into the seed balance; the seed
Safe is a different Safe for exactly this reason.

---

## 5. Private shakedown, with `release.customerLaunch` false

This is the §14 gate that replaces the testnet stage. **No link is shared with anyone until it is recorded.**
You play alone, with your own money, against the real coordinator and the real feed.

At this point the manifest has no `release` object, which means `customerLaunch` is false, which means the
mainnet web build refuses to publish. That is what keeps section 6 from happening early. Leave it that way.

Start the keeper first (section 7 sets up the service; for the shakedown a foreground run in your own shell is
fine), and watch its log lines.

### 5a. One daily round, end to end

1. **Seed.** The keeper seeds the open daily round: `event=action_sent … action=seedRound`. If it does not,
   fix section 4 before going further.
2. **Your own entry.** Buy into that round from MetaMask on the site, or from the Safe-free account you use for
   ordinary play. A whole-USD target of 100 will not be reached by one small entry, which is what you want: the
   round should close at its **UTC cutoff**, not on target.
3. **Cutoff and close.** At the cutoff the keeper sends `closeRound`. Record the block timestamp.
4. **Request.** The keeper sends `requestDraw`. Record the transaction hash and the timestamp.
5. **Fulfilment.** The coordinator delivers after 200 confirmations. Record the fulfilment timestamp and the
   transaction hash. **`requestToFulfilmentSeconds` is the gap between steps 4 and 5.**
6. **Settle.** The keeper sends `settle`. The winner is credited an internal balance; the fee is credited to
   the treasury Safe's balance.
7. **Withdraw.** Withdraw the winnings to the winning address, and separately do section 4 step 5: the
   **treasury Safe** withdraws the fee from the Vault. That is the §10.5 proof and it belongs here.

Numbers to take off the chain while you are there:

- **`callbackGasUsed`** — the gas the settlement callback actually used, from the fulfilment transaction's
  receipt on BscScan (the consumer's portion, against the 150,000 ceiling and the 300,000 limit). Compare it
  with the Foundry figure in `vrf.measuredCallbackGasUsed`; a large gap is a finding, not a rounding error.
- **`requestToFulfilmentSeconds`** — step 4 to step 5.
- **`costPerDrawNativeWei`** — the VRF `payment` from the coordinator's `RandomWordsFulfilled` event in the
  fulfilment receipt's logs, **plus** the keeper's own gas for the seed, close, request and settle
  transactions of this round. The keeper's per-draw cost meter logs both halves.
  The keeper logs one line per settled round: `event=draw_cost round=<id> keeperGasWei=<wei> vrfPaymentWei=<wei|null> requestId=<id|null>`.
  `keeperGasWei` is the gas the keeper paid across seed, close, request and settle; `vrfPaymentWei` is the `payment`
  from the coordinator's `RandomWordsFulfilled` event. `costPerDrawNativeWei` is their sum. A `note=` on the line
  means one of the two could not be read; do not record a partial figure.

Also observe, on these same rounds, what a restart does: stop the keeper mid-round and start it again. It
rediscovers the pools' current rounds from the chain and keeps going; an in-flight transaction it has forgotten
can be re-sent and the duplicate reverts (costing gas, never funds). Note what you saw.

### 5b. The refund path

An accepted request that is never fulfilled cannot be forced, so it is **not** the refund evidence. The refund
evidence is a round that closes with fewer than two addresses in it:

1. **Pause seeding for the pool.** From the **owner** Safe, `setSeedAmount(poolId, 0)` on the Draw. This stops
   both the keeper's `seedRound` and the fallback seed inside `buy`; with the seed still on, your single entry
   would be joined by the seed and the round would draw instead of refunding.
2. **Make a single entry** into the next daily round, from one address.
3. **Wait for the cutoff.**
4. **`closeRound`.** The keeper will send it; you can also send it yourself, every lifecycle method is public.
   With one address and no seed, the round goes to `Refunding`.
5. **`claimRefund(roundId, account)`.** The keeper credits it, or you call it. The full gross comes back,
   including the 3% — a cancelled round earns no fee.
6. **Restore the seed**: `setSeedAmount(poolId, <the plan's seedAmount>)` from the owner Safe. Do this before
   `Verify`, which compares the live pool configuration with the manifest.

### 5c. The manual MetaMask journey

ADR 040 makes **one entry made by hand, from a real wallet, on the published web app** a gate of its own. Every
test in this repository drives a fake EIP-1193 provider; none of them has ever seen MetaMask's own confirmation
dialog, its chain-switch prompt, or what the page does while a real wallet is thinking.

There is an ordering problem, and it is real rather than a documentation slip: `web/src/lib/build/releaseGate.ts`
refuses **any** chain 56 build — including a local `pnpm build` and `preview` — while `release.customerLaunch`
is false. So on chain 56 this journey cannot be taken before the flip. Take it in both places:

- **Before the flip, on chain 97**, against the live testnet site. Same code, same wallet layer, same flows,
  faucet money.
- **Immediately after the flip, on chain 56**, before the link is given to anybody. If anything here is wrong,
  you have a published page nobody has been sent yet, which is a recoverable position.

The journey, in one sitting, on a desktop browser and then repeated on a phone in the MetaMask app's own
browser:

1. Open the site with the wallet **locked**. Browse the home page and a round page. Nothing should demand a
   wallet to read.
2. **Connect.** MetaMask appears in the list first. Accept.
3. **Wrong network on purpose.** Switch MetaMask to some other chain. The app must refuse to sign and offer to
   switch back; accept its prompt and confirm the chain id it lands on.
4. **Quote and enter.** Type an amount under USD 1 and read the refusal. Then enter a real amount, read the
   preview (gross, 3%, prize contribution), and send it. Watch the pending state, then the confirmed state.
5. **Your entry appears** on the round page and in your positions, with the correct gross.
6. **Withdraw** a balance, if you have one.
7. **Reject something on purpose** — open a transaction and hit *Reject* in MetaMask. The app must return to a
   usable state with a plain message, not a spinner that never ends.

Screenshot, at full window, and keep them with the shakedown evidence: (a) the round page before connecting;
(b) MetaMask's connect prompt with the site origin visible; (c) the wrong-network refusal; (d) the entry
preview showing the amount, the 3% and the prize contribution; (e) MetaMask's own confirmation dialog for the
entry, with the amount and the contract address visible; (f) the confirmed entry on the round page; (g) the
rejected-transaction state; (h) the phone browser's version of (d) and (f). Redact nothing except your address
if you would rather not publish it — these are evidence for you, not for the repository, and **no screenshot of
a seed phrase, a private key or a keyed RPC URL ever goes anywhere**.

Note the chain id and the date next to each set. Record in ACCEPTANCE which chain each journey was taken on;
the chain 97 set is the evidence that exists before the flip, and the chain 56 set is taken straight after it.

### 5d. Record it

Add the `release` object to the manifest at `config/deployments/56/<lowercase draw address>.json`, keeping
`customerLaunch` **false** for now:

```json
"release": {
  "customerLaunch": false,
  "shakedown": {
    "performed": true,
    "date": "<YYYY-MM-DD>",
    "roundIds": [<the settled round>, <the refunded round>],
    "callbackGasUsed": <measured on chain>,
    "requestToFulfilmentSeconds": <measured>,
    "costPerDrawNativeWei": "<decimal string of wei>"
  }
}
```

Then re-run both checks and add the same numbers to the ACCEPTANCE evidence ledger, which is where §14 says
they live before any customer link is shared:

```bash
LUCKYDRAW_MANIFEST=$M forge script script/Verify.s.sol:Verify --rpc-url "$LUCKYDRAW_RPC_URL"
npx pnpm@12.3.4 validate:config
```

Rule `D26` refuses `customerLaunch: true` without `shakedown.performed: true`, and `D27` refuses a shakedown
whose numbers are impossible: gas of zero or above `vrf.callbackGasLimit`, zero latency, a cost of `"0"`, or a
date before the manifest's `createdAtUtc`. Record what you measured, not a placeholder. Commit the manifest.

---

## 6. Open it to customers

Only now, and the flip is the **last** thing on ADR 040's mandatory list. Everything else is already done, or
this section does not start. Read the list back before you touch the manifest:

- [ ] Three Safes on chain 56, configuration read off the chain, and the §10.5 drill of section 1.3 performed
      on those Safes **before `Deploy` was signed** — including the zero-value `execTransaction` and the
      signer-replacement rehearsal — with `custody.recoveryDrill` written and `treasuryWithdrawalProven: true`.
- [ ] deploy → configure → finalize → verify → `validate:config`, with `Verify` exiting zero.
- [ ] The shakedown of section 5: one settled round, one refund, and `release.shakedown` carrying the measured
      `callbackGasUsed`, `requestToFulfilmentSeconds` and `costPerDrawNativeWei`.
- [ ] The keeper under systemd with `KEEPER_HEARTBEAT_URL` and `KEEPER_ALERT_WEBHOOK` set, and **one alert seen
      at its destination** (section 7), with the date recorded.
- [ ] The manual MetaMask journey of section 5c taken on the live chain 97 site, screenshots kept.

Because the chain 56 build refuses while `release.customerLaunch` is false, the flip and the publish are one
motion: nothing below can be rehearsed against chain 56 beforehand, and the first thing after publishing is the
same MetaMask journey again, on 56, before any link is shared.

1. **Flip the switch.** Set `release.customerLaunch` to `true` in the manifest, re-run `npx pnpm@12.3.4
   validate:config`, and commit. Remember the warning in section 3: do not re-run `Configure` after this
   without saving and restoring the `release` object.

2. **Repository variables.** In GitHub: *Settings → Secrets and variables → Actions → Variables* (the
   **Variables** tab, not Secrets — none of these is a secret). Set:

   | Variable | Value |
   |---|---|
   | `LUCKYDRAW_CHAIN_ID` | `56` |
   | `LUCKYDRAW_DRAW_ADDRESS` | the lowercase Draw address, exactly as in the manifest file name |
   | `LUCKYDRAW_RPC_URL` | a **public** BSC mainnet RPC origin, with no API key and no query string |
   | `LUCKYDRAW_JURISDICTION_NOTICE` | the one sentence from your advisers (section 1.8) |

   The workflow copies `LUCKYDRAW_JURISDICTION_NOTICE` into the build as `VITE_LUCKYDRAW_JURISDICTION_NOTICE`.
   The variables are all-or-nothing: once `LUCKYDRAW_CHAIN_ID` is set, the run refuses to publish if the Draw
   address, the RPC URL or (on chain 56) the notice is unset, and names the missing ones. With no
   `LUCKYDRAW_CHAIN_ID` at all it publishes the committed local anvil build, which is harmless and useless.

   The RPC one is the one to be careful about: it is compiled into the bundle and handed to every visitor's
   wallet by `wallet_addEthereumChain`, so it must be an endpoint you are happy to publish. Keep your keyed
   endpoint in your own shell as `LUCKYDRAW_OPS_RPC_URL`. The build fails outright on a value carrying
   credentials or a query string.

   On chain 56 the build additionally refuses to publish unless the referenced manifest is
   `environment: mainnet`, passes `validate:config`, references no mock and has `release.customerLaunch: true`,
   and unless the jurisdiction sentence is non-empty. It prints the reason and exits non-zero.
   Every refusal is one line beginning `Mainnet build refused:`.

3. **Enable Pages.** *Settings → Pages → Build and deployment → Source: **GitHub Actions***. Do not pick
   "Deploy from a branch". Then, under *Settings → Environments → github-pages*, set **Deployment branches** to
   `main` only. The workflow's deploy job already refuses any other ref; this makes GitHub refuse it too.

4. **Push to `main`.** `.github/workflows/pages.yml` builds and deploys on every push to `main`. It can also be
   run by hand from the Actions tab: from `main` that deploys; from any other branch it only builds, which is
   the way to dry-run the mainnet gate before merging. The finished run prints the site URL,
   `https://<your-github-user>.github.io/<repository name>/`. The base path comes from the repository name, so
   a repository named `luckydraw` is served at `/luckydraw/` with no extra configuration.

5. **Check it, including the deep links.** Open the site. Then open a deep link such as
   `https://<your-github-user>.github.io/luckydraw/round/56/1` **directly** in a fresh tab and reload it. Both
   must load the app rather than a GitHub 404 page: that is what the `404.html` copy in the build is for. A
   deep link that 404s is the failure people will hit first, because a deep link is what you paste into a chat.

   Check on a phone too. In an ordinary mobile browser the connect button opens MetaMask through its deep link,
   which is built from the page's own address, so it carries the `/luckydraw/` path automatically.

6. **Check the disclosures and `/verify`.** The help page and the round page must state the §7.3 and §14
   limitations — accepted-request escrow risk, uncapped exposure, no cash-out outside the contract, that the
   operator's seed is an entry that can win — and your jurisdiction sentence. `/verify` must show the Draw and
   Vault addresses, their code hashes and the BscScan links, read from the manifest the build was made from.
   Compare those addresses against your manifest by eye before you tell anyone the site is live.
   `/verify` also publishes the make-whole reserve and cap from the manifest, in BNB.

7. **Check what the history says about itself.** ADR 040 defers the archive-capable RPC and the indexer, so the
   app reads logs straight from the public endpoint in `LUCKYDRAW_RPC_URL`, and a public endpoint **prunes**:
   it answers "I no longer have those blocks" for anything below a rolling height (measured on chain 97:
   publicnode refuses ranges below a moving block with code `-32701`). Entry history older than that height is
   not missing data, it is data this deployment cannot read today. `/entries` and the positions view must show
   the labelled partial-history notice from the string catalog with the height below which history is
   unavailable — SPEC §10.1 — and never silently show a shorter list as if it were complete. Scroll back far
   enough on `/entries` to see that notice appear, on the published site, before you send anybody the link. If
   it does not appear, that is a bug to fix before launch, not a cosmetic issue: a player whose entry has
   scrolled out of the readable window must be told why, and every round's own state is read from contract
   storage and stays correct regardless.

8. **Repeat the MetaMask journey of section 5c, now on chain 56**, against the published site, with the
   screenshots. This is the first use of the real thing, and it is still private: the link exists but nobody
   has it. Only then, section 8.

A local rehearsal of exactly the same build, before pushing:

```bash
cp web/.env.mainnet.example web/.env    # then fill in the placeholders
npx pnpm@12.3.4 --filter @luckydraw/web build
npx pnpm@12.3.4 --filter @luckydraw/web preview
```

`web/.env` is untracked and must stay that way.

---

## 7. Run the keeper as a service

The keeper advances rounds — seed, close, request, settle, refund — while people are using the app. Every call
it makes is public: anyone, including the app itself, can make the identical calls, so losing the keeper delays
rounds and never puts funds at risk. Full detail is in `keeper/README.md`.

For mainnet it runs under **systemd**, not in a terminal: a terminal session ends, and a keeper that stopped at
02:00 means every round stalls until somebody notices. The unit, the environment-file template and the
credential handling are in `keeper/deploy/`.

Install the keeper as a service from `keeper/deploy/`: create the `luckydraw-keeper` system account, put the
dedicated keeper key in `/etc/luckydraw/keeper-private-key` (root:root, 0600; systemd hands it to the process
through `LoadCredential=`, so it must **not** go in the EnvironmentFile), copy `luckydraw-keeper.env.example` to
`/etc/luckydraw/keeper.env` (0600) and fill in `KEEPER_RPC_URL`, `KEEPER_CHAIN_ID=56`, `KEEPER_DRAW_ADDRESS`, and
optionally `KEEPER_HEARTBEAT_URL` (with `KEEPER_HEARTBEAT_METHOD=GET|POST`, default GET) and
`KEEPER_ALERT_WEBHOOK`. Then `systemctl enable --now luckydraw-keeper` and confirm in
`journalctl -u luckydraw-keeper` that the `started` line shows `keySource=credential`, the expected `signer` and
`multicall3=<address>`. Alerts fire at most once per cause per hour on: ten consecutive failed cycles, a failed
`requestDraw` simulation, `SeedNotAuthorized`, `InsufficientSeedBalance` and a VRF subscription balance below
`lowFundingThresholdNative`.
The one-alert-per-cause-per-hour limit is per process, so a fault that keeps failing cycles pages roughly every
three minutes (ten failed cycles, a non-zero exit, then `RestartSec=30`); treat a repeating
`consecutive_cycle_failures` as one incident, not one per page. On chain 56 the keeper also probes the chain
record's Multicall3 at start-up (code present, one `aggregate3` answered) and refuses to start on a wrong address.

What the unit must do (SPEC §10.3, §12.1):

- run as an **unprivileged user** created for this and nothing else, with `ProtectSystem=strict`,
  `NoNewPrivileges=yes`, a read-only filesystem apart from its own state directory, `Restart=on-failure` and
  `RestartSec=30`;
- take the keeper key through **systemd credentials** — `LoadCredential=keeper-key:/etc/luckydraw/keeper.key`
  with the file root-owned and mode 0600 — so the key reaches the process as a file the service user can read
  and **never** appears in a process argument, in the unit file, in the environment file or in a log line;
- read everything else from an `EnvironmentFile` that contains placeholders in the repository and real values
  only on the host.

The variables:

| Variable | Value on mainnet |
|---|---|
| `KEEPER_RPC_URL` | your keyed operational endpoint |
| `KEEPER_CHAIN_ID` | `56` |
| `KEEPER_DRAW_ADDRESS` | the lowercase Draw address |
| `KEEPER_HEARTBEAT_URL` | **required by ADR 040**; pinged after each healthy cycle |
| `KEEPER_ALERT_WEBHOOK` | **required by ADR 040**; posted on the failure conditions below |


The code treats both as optional — nothing is sent anywhere unless you set them (SPEC §14) — and ADR 040 makes
both mandatory for this launch, because they are the whole of the operational safety net that survived the
deferrals. Both are redacted in logs like every other URL. The heartbeat goes to a dead-man's-switch monitor
that alerts when the pings stop; the webhook receives the ten-consecutive-failure exit,
`request_precheck_failed`, `SeedNotAuthorized`, `InsufficientSeedBalance` and the subscription-below-threshold
signal. One alert channel you actually receive is a §12.1 MVP gate item; two channels you ignore are not.

**Prove one alert actually arrives.** Configured is not received: a webhook with a typo, a monitor that silently
drops unauthenticated POSTs and a chat app that never showed you the message all look identical from this side.
Do this once, deliberately, on the running service, and keep the timestamps:

1. Note the time, and watch with `journalctl -u luckydraw-keeper -f`.
2. Break the node the keeper talks to, for one fault only: edit `/etc/luckydraw/keeper.env` and point
   `KEEPER_RPC_URL` at a host that does not answer (a closed port on localhost, `http://127.0.0.1:1`, is the
   cleanest — it fails instantly and reaches nobody else's server), then `systemctl restart luckydraw-keeper`.
3. Every cycle now fails. After ten of them — about 2.5 minutes at the 15-second interval — the log shows
   `cycle_failed` ten times, then `event=alert_sent cause=consecutive_cycle_failures`, then `fatal`, and the
   unit exits non-zero. systemd restarts it 30 seconds later and it pages again, which is exactly the behaviour
   `keeper/README.md` warns about; that is your cue to stop, not a second incident.
4. **Look at the destination.** The alert must be visible where you would see it at 03:00 — the chat channel on
   your phone, not a webhook log you would have to go looking for. If nothing arrived, the gate is not met; fix
   the URL and repeat.
5. Restore the real `KEEPER_RPC_URL`, restart, and confirm healthy cycles and a heartbeat ping.
6. Record it: the date, the cause (`consecutive_cycle_failures`), the delay between the first `cycle_failed` and
   the alert appearing at the destination, and where it appeared. That line is the §14 "alerts received"
   evidence and belongs in ACCEPTANCE.

Do the heartbeat half too: stop the unit and confirm the dead-man's-switch monitor alerts you when the pings
stop, then start it again. A heartbeat nobody is watching is a URL, not a monitor.

On start-up the keeper asserts `eth_chainId == 56` against the node itself and refuses any manifest asset
flagged `isMock`, on top of the existing gates (manifest identity, `verifyDeployment`, exactly one signing
mode).
At start-up the keeper compares `KEEPER_CHAIN_ID` with the node's `eth_chainId` and the manifest, and on chain 56
refuses any manifest that names a mock coordinator, feed or asset.

Rehearse once in the foreground with `KEEPER_DRY_RUN=1` before enabling the unit: everything is simulated and
logged and nothing is sent. Then `systemctl enable --now luckydraw-keeper`, and watch the first cycles.
`event=action_sent … action=seedRound` means section 4 worked. Repeated `skip=SeedNotAuthorized`,
`skip=InsufficientSeedBalance` or `event=request_precheck_failed` means the seed authorization, the Vault
balance or the VRF subscription needs attention. Ten consecutive failed cycles exit the process; systemd
restarts it, and the alert tells you it happened, which is the part you must not miss.

---

## 8. Share it

Send people the Pages URL. Tell them, in your own words, roughly this:

> This runs on BNB Smart Chain **mainnet**. It is **real money**: real BNB goes in, the winner is picked on
> chain by Chainlink VRF, and there is no refund once a round has drawn. You need MetaMask (browser extension,
> or the MetaMask app's built-in browser on a phone) and some BNB for the entry and the network fee. Browsing
> costs nothing and needs no wallet; a wallet is only needed to enter a draw. 3% is deducted from each entry.
> I enter every funded round myself with an operator seed entry, which is a real entry that can win — it is
> there so that a round with only one player still draws instead of refunding. It is labelled everywhere.

Tell them the limitations too, not only the good parts:

> If Chainlink accepts a randomness request and then never delivers it, that round's money — including the
> fee — can stay locked in the contract indefinitely. There is no timeout refund after a request is accepted,
> because letting anyone cancel after seeing an unfavourable result would break the draw. I hold a make-whole
> reserve in the treasury and will reimburse affected buyers from my own funds up to a published cap if a round
> is stuck for more than 7 days, but that is a voluntary payment, not a guarantee, and it is capped.
> There is no cash-out outside the contract, no audit yet, one keeper on one machine, and no legal or
> regulatory protection beyond what my jurisdiction notice says. I can pause buys at any time; withdrawals of
> existing balances are not paused with them.

Pausing is `setBuysPaused(true)` on the Draw from the owner Safe (or `setPoolBuysPaused(poolId, true)` for one
pool). Know how to send it before you need it: rehearse the Safe transaction, do not read this paragraph for
the first time during an incident.

**Start with a small invited group for three days.** A dozen people you can talk to, on mainnet, with real
money, before any public post. The §14 operations row asks for three days of healthy service — alerts arriving,
rounds settling, no stalled round — and three days with a handful of friendly users is how you get that
evidence without discovering a problem in front of strangers. Watch the keeper alerts, the subscription
balance, the seed balance and the oldest Drawing age over those three days. Then, if nothing surprised you, go
public.

---

## 9. What this deliberately does not include

An MVP, not a finished product. None of the following is built, and the absence is a decision (SPEC §12.1
"after the MVP" and **ADR 040**, which names the deferred gates and records you as the owner of the risk and
the funding for each), not an oversight. Say so plainly to anyone who asks:

- **No indexer, no API, no database, and no archive RPC.** The app reads the chain directly, and the public
  endpoint prunes old logs, so entry history below its rolling height is labelled as unreadable rather than
  shown. There is no `/activity` and no `/leaderboard`.
- **No legal or jurisdiction determination.** Deferred per ADR 040. The published jurisdiction sentence is
  yours, not an adviser's, and deferring the determination does not create permission (SPEC §14).
- **No privacy or origin-isolation controls (U30–U37), and no three-day soak evidence.** Deferred per ADR 040.
- **No `/admin`.** Owner actions are done from the Safe by hand, as in section 4.
- **No registered Chainlink Automation upkeep and no backup keeper.** The upkeep contract of ADR 039 is built
  and deployable, but registering and funding it with LINK is deferred per ADR 040, so it is one process on one
  machine. If it stops, rounds stall until systemd restarts it, you restart it, or somebody calls the public
  lifecycle methods themselves — every one of them is public to every address.
- **No second RPC provider.** One endpoint; if it fails, the keeper's cycles fail and the site's reads fail.
- **No external audit.** Deferred per ADR 040. The test suites pass, the Slither triage on the real tree has no
  untriaged medium-or-higher finding, and the diff was reviewed. That is not an audit, and this runbook does
  not claim it is.
- **No production hosting.** GitHub Pages serves the files and sends none of the §9.6 response headers, so
  `frame-ancestors` and `X-Frame-Options` are absent. No static origin from CI, no release manifest, no tamper
  canary, no IPFS mirror, no off-host logs.
- **No mutation campaign, no full acceptance ledger.** The §11.2 suites and the shakedown numbers are the
  evidence that exists.
- **No recovery from a permanently unfulfilled request.** §7.3 is a design limitation, and the make-whole
  reserve is a voluntary capped payment, not a recovery mechanism.

The after-MVP column of SPEC §12.1 is the next body of work, and it runs against real usage rather than before
it.
