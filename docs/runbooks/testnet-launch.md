# Testnet launch runbook

For the operator. This takes a fresh checkout to a working LuckyDraw on **BSC testnet (chain 97)**, with the
web app published on GitHub Pages at `https://<your-github-user>.github.io/luckydraw/` and the keeper running
on your own machine. It is an interest test: real people, play money, no real value anywhere.

Two rules that override anything below:

- **Never put a private key, a seed phrase or an RPC key in this repository**, in a `.env` file that is
  committed, in a GitHub secret used by the Pages workflow, or in a command you paste into a chat. The
  deployment scripts and the keeper are built so they never need one to be written down.
- Everything the web build contains is **public**. It is a static bundle every visitor downloads. A keyed RPC
  endpoint put into it is published to the world twice over, and the app refuses one for that reason.

Work through the sections in order, skipping what the note below says is already done for the deployment that
exists. Nothing later works if something earlier was skipped.

> **Before you start: chain 97 is already deployed, and this runbook is now mostly a record of how.**
>
> The seven-kind (ADR 036) deployment was made on 2026-09-17 and its manifest is
> `config/deployments/97/0x25c41f9921e51b120f971e25181c55b1dcaf1d41.json` (Draw
> `0x25c41f9921e51b120f971e25181c55b1dcaf1d41`, Vault `0x2a7420b755aaae6503212bc6df41f36d70b30d19`). It records the
> handover as complete — `ownership.ownershipAccepted` true, both contracts owned by the operator Safe
> `0xcde8a0e1f0d682771ec8c76da8d2bb89c89d5079` — and the native BNB pool as pool 1 with `firstRoundIds` 1 to 7, one
> round per kind. `Verify` passes against it and `pnpm validate:config` accepts it; the ACCEPTANCE evidence ledger
> records the row as PASS.
>
> So **sections 1 to 4 are done for this deployment**. Read them to see what was done, or follow them if you ever
> deploy chain 97 again — a new deployment lands at a new address, gets a new manifest file name, and `web/.env` and
> the keeper environment must both be repointed at it. What is *not* done, and what you would actually run next, is
> **section 4a**, the USDT pool. It uses the manifest named above as `$M` and needs nothing from sections 2 and 3.
>
> The plan, `config/deployments/97/testnet.plan.json`, is still the document sections 2 to 4a read figures out of: a
> plan says what you intend to deploy, not what is deployed. It now carries two assets, native BNB and the chain 97
> faucet USDT of section 4a.
>
> History: an earlier three-kind Draw at `0x29f8158114fa56a438a36600e988c4348979aeac`, from before ADR 036 gave every
> pool seven concurrent sequences instead of three, is retired to `docs/evidence/stale/` where no tool loads it, and
> must never be reused.

---

## 1. Prerequisites

1. **MetaMask** in your browser. Add the BNB Smart Chain testnet network (chain id 97). The app offers to add
   it for you when a visitor is on the wrong chain, so you do not have to type the parameters by hand.
2. **Testnet BNB.** Get it from the official BNB Chain testnet faucet, reached from `bnbchain.org` (the
   testnet faucet page; do not use a faucet you found in a search result or a message — faucet phishing is
   common). You need testnet BNB in three places: your deploying account, the Safe (for the seed balance),
   and the keeper account. Testnet BNB has no value and cannot be bought; if the faucet rate-limits you, wait.
3. **A Gnosis Safe on BSC testnet.** For the testnet run one Safe holds all three privileged roles (owner,
   treasury/fee account, seed account) with your own MetaMask as its only owner; SPEC §12.1 allows that on
   testnet and requires three separate Safes with 2-of-3 hardware keys before mainnet.

   This is not optional. `Deploy` **refuses** a plan that gives `ownership.finalOwner`, `feeAccount` or
   `seedAccount` an address with no code on any chain other than local anvil. A plain MetaMask address in
   those fields will stop the deployment, by design: the fee account is frozen into every round at creation
   and cannot be changed afterwards.

   The Safe web interface (`app.safe.global`) lists BNB Chain **mainnet only** — its chain list has 56 and no
   97 (checked 2026-09-16) — so you cannot create this Safe there. The Safe v1.4.1 contracts themselves are
   deployed on chain 97, and `contracts/script/TestnetSafe.s.sol` creates a real 1-of-1 Safe through them from
   your own shell. It needs the three canonical v1.4.1 addresses for chain 97, which you read from Safe's own
   deployment records (`github.com/safe-global/safe-deployments`, `src/assets/v1.4.1/`: `safe_proxy_factory`,
   `safe_l2` and `compatibility_fallback_handler`, each listing chain 97 under `networkAddresses`) and check
   against the chain before you trust them:

   ```bash
   export LUCKYDRAW_RPC_URL="https://<your BSC testnet endpoint>"
   export PATH="$HOME/.foundry/bin:$PATH"
   cd contracts
   cast code <proxy factory>     --rpc-url "$LUCKYDRAW_RPC_URL" | head -c 20   # not "0x"
   cast call <safe_l2 singleton> "VERSION()(string)" --rpc-url "$LUCKYDRAW_RPC_URL"   # "1.4.1"
   cast code <fallback handler>  --rpc-url "$LUCKYDRAW_RPC_URL" | head -c 20   # not "0x"

   SAFE_PROXY_FACTORY=<proxy factory> SAFE_SINGLETON=<safe_l2 singleton> SAFE_FALLBACK_HANDLER=<fallback handler> \
     forge script script/TestnetSafe.s.sol:TestnetSafe --sig "create()" \
     --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
   ```

   The script checks each address has code and reports version 1.4.1, creates the Safe with your signer as the
   sole owner and threshold 1, reads the owners, threshold, version and module list back from the chain, and
   prints the **Safe address**. That address goes into the plan's three ownership fields. The script refuses to
   run on any chain but 97, so it cannot be used to shortcut the mainnet Safes.

   There is no tBNB to send to the Safe yet: section 4 tops it up from your deploying account when it deposits
   the seed balance.
4. **A Chainlink VRF v2.5 subscription on BSC testnet.** Create it at `vrf.chain.link` with your MetaMask
   account as the subscription owner, and fund it. The plan template sets `nativeBilling: true`, so fund it
   with **testnet BNB**; if you switch to LINK billing you must set that flag to `false` and fund with testnet
   LINK instead. Keep the subscription id, the coordinator address and the key hash (the "gas lane") of the
   lane you choose — you need all three in the plan, and all three are fixed into the Draw at construction
   with no setter.
5. **The BNB/USD price feed address on BSC testnet**, from the Chainlink data-feeds address list
   (`docs.chain.link/data-feeds/price-feeds/addresses`, BNB Chain testnet). Copy it from that page; this
   repository deliberately records no feed address it has not been given.
6. **Tooling**: Node 24 (`.nvmrc`), pnpm 12.3.4 (`npx pnpm@12.3.4 …` works without installing it), and
   Foundry 1.8.1 (`export PATH="$HOME/.foundry/bin:$PATH"` in Git Bash). Then, from the repository root:

   ```bash
   npx pnpm@12.3.4 install --frozen-lockfile
   ```

---

## 2. Fill in the deployment plan

Copy the blank form and fill it in:

```bash
mkdir -p config/deployments/97
cp contracts/script/templates/testnet.plan.example.json config/deployments/97/testnet.plan.json
```

Then edit `config/deployments/97/testnet.plan.json`:

- delete the `"template": true` line — every script and the validator refuse a document while it is there;
- `"name"` must equal the file name without `.plan.json`, so `"name": "testnet"` for the path above;
- leave `chain` and `toolchain` as they are: those are already the recorded facts for chain 97.

Every `null` below has to become a value **you verified on the live chain today**, not a value from a blog
post or from this document:

| Field | Where it comes from |
|---|---|
| `vrf.coordinator` | the VRF v2.5 coordinator address for BSC testnet, from the Chainlink supported-networks page |
| `vrf.subscriptionId` | your subscription id from `vrf.chain.link` |
| `vrf.keyHash` | the gas lane you picked, on the same page |
| `vrf.maxRequestCostNative` | the most one randomness request can cost, in wei; the Draw enforces it forever |
| `vrf.maxRequestCostDerivation.*` | `maxGasPriceWei`, `verificationGasOverhead`, `premiumPercentage`, `flatFeeNativeWei` — the numbers you multiplied to get the line above, so the figure can be re-checked |
| `vrf.lowFundingThresholdNative` | the subscription balance below which `Configure` refuses to open a pool |
| `vrf.measuredCallbackGasUsed` | gas the settlement callback actually used, measured; the plan's `callbackGasLimit` is 300000 |
| `vrf.source.date` | the date you read the Chainlink page |
| `ownership.finalOwner`, `feeAccount`, `seedAccount` | your Safe address in all three (testnet only) |
| `ownership.makeWholeReserve`, `makeWholeCap` | the §10.5 make-whole reserve and per-incident cap; `0` and `0` are acceptable for an interest test and say plainly that there is none |
| `assets[0].source.url` / `.date` | where you confirmed the asset, and when — for native BNB the chain's own documentation |
| `assets[0].price.feed` | the BNB/USD feed address from step 1.5 |
| `assets[0].price.heartbeatSeconds` | the feed's documented heartbeat |
| `assets[0].price.observedP999IntervalSeconds` | the update interval you actually observed, not the documented one |
| `assets[0].price.minAnswer` / `maxAnswer` | the feed's answer bounds; if the deployed aggregator has none, set `answerBoundsConfirmedAbsent: true` and say so |
| `assets[0].price.displayLabel` | what the UI calls the reference, e.g. `BNB/USD` |
| `assets[0].price.pegAssumption` | `null` for BNB: nothing is assumed to be pegged |
| `assets[0].price.verifiedOn` | the date you checked the feed against the chain |
| `assets[0].pool.seedAmount` | the operator seed entry, in wei of BNB, put into every funded round so a lone player gets a draw instead of a refund |
| `assets[0].pool.seedAuthorizedMaxPerRound` | the per-round cap you will authorize from the Safe; must be at least `seedAmount` |

`pool.targetsUsd` is already the seven spec defaults — `Day100` 100, `Day1k` 1000, `Day10k` 10000, `Week1k`
1000, `Week10k` 10000, `Week100k` 100000 and `Month100k` 100000 (SPEC §6.1, ADR 036). A round draws as soon as its target is reached, and at its fixed UTC cutoff at the latest.

Keep the plan modest. A large `seedAmount` on testnet just means the faucet runs out.

---

## 3. Deploy the contracts

All of this is from `contracts/README.md`; run it from the `contracts/` directory. The scripts never read a
key — the signature comes from **your own** signing flow, which is the `--ledger`, `--trezor`,
`--interactive` or `--account <keystore-name>` flag you normally use with `forge script`. Below that is
written as `<your signer flags>`. Do not put `--private-key` on a command line.

Set the endpoint for the session (a keyed operator endpoint is fine here; it never reaches the browser):

```bash
export LUCKYDRAW_RPC_URL="https://<your BSC testnet endpoint>"
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts
```

**Step 1 — Deploy.** Creates the Vault/Draw pair and writes the first manifest.

```bash
LUCKYDRAW_PLAN=../config/deployments/97/testnet.plan.json \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
```

It refuses a plan whose chain id is not the connected chain, whose `environment` does not match chain 97,
that names a coordinator without `s_provingKeys(bytes32)`, or that gives any privileged role a plain address.
Note the **Draw address** it prints; the manifest is
`config/deployments/97/<lowercase draw address>.json`.

```bash
export M=../config/deployments/97/<lowercase draw address>.json
```

**Step 2 — add the Draw as a VRF consumer.** Go back to `vrf.chain.link`, open your subscription, and add the
Draw address as a consumer. Do this now: `Configure` refuses to create a pool until the Draw is a registered
consumer and the subscription is above `lowFundingThresholdNative`, so a `Configure` run before this one lists
the assets and then stops without opening pools.

**Step 3 — Configure.** Lists the assets, opens the pools, and starts the two-step ownership transfer to the
Safe.

```bash
LUCKYDRAW_MANIFEST=$M \
  forge script script/Configure.s.sol:Configure --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
```

`Configure` is idempotent: every step reads the live state first and is skipped when it already matches. If
you ran it before registering the consumer, or it stopped halfway, **just run it again** — nothing is
duplicated and nothing is destroyed. It also refuses a manifest whose recorded coordinator, subscription id,
key hash or `maxRequestCostNative` differs from the deployed Draw's own immutables.

**Step 4 — Finalize.** Records the exact creation blocks and transaction hashes from the broadcast file and
the authenticated RPC receipts.

```bash
LUCKYDRAW_MANIFEST=$M LUCKYDRAW_BROADCAST=broadcast/Deploy.s.sol/97/run-latest.json \
  forge script script/Finalize.s.sol:Finalize --rpc-url "$LUCKYDRAW_RPC_URL"
```

**Step 5 — Verify.** Read-only, and exits non-zero on any mismatch. Nothing proceeds until it passes.

```bash
LUCKYDRAW_MANIFEST=$M forge script script/Verify.s.sol:Verify --rpc-url "$LUCKYDRAW_RPC_URL"
```

Optionally verify the source on `testnet.bscscan.com` as well, so MetaMask shows a readable contract and
method name before every signature (SPEC §9.2 trust signals).

---

## 4. Safe steps (through the Safe, from your shell)

The Safe web interface cannot drive a chain 97 Safe (section 1.3), so the four owner transactions of this section
go through the Safe's own `execTransaction` from the same script, signed by your signer as the Safe's sole owner.
Run it once `Configure` has offered ownership to the Safe (it refuses before that):

```bash
LUCKYDRAW_MANIFEST=$M SEED_DEPOSIT_WEI=<wei of tBNB to deposit> \
  forge script script/TestnetSafe.s.sol:TestnetSafe --sig "ops()" \
  --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
```

What it does, as the Safe, reading the live state first and skipping any step already done:

1. **Accept ownership of the Vault**: `acceptOwnership()` on the Vault.
2. **Accept ownership of the Draw**: `acceptOwnership()` on the Draw. Ownership is two-step, so until both are
   accepted the Safe is not yet the owner.
3. **Deposit the seed balance**: `depositNative()` on the Vault with `SEED_DEPOSIT_WEI` — every seeded round
   spends `seedAmount` from this balance, and rounds that settle return nothing to it, so give it at least a few
   times `seedAmount`. When the Safe holds less than that, your deploying account first tops the Safe up with a
   plain transfer, so one faucet balance covers everything. `SEED_DEPOSIT_WEI` unset or `0` deposits nothing;
   a second run with a value deposits again, because a deposit is an amount, not a state.
4. **Authorize the seed, per asset**: `authorizeSeed(asset, maxPerRound)` on the Vault for every asset in the
   manifest. The cap is **per asset**, because one raw number cannot be right for two of them — a cap in wei of BNB
   and a cap in raw units of an 18-decimal token differ by orders of magnitude. For each asset the script takes, in
   this order:

   1. `SEED_MAX_PER_ROUND_<SYMBOL>` (for example `SEED_MAX_PER_ROUND_USDT`), when you set it;
   2. that asset's `pool.seedAuthorizedMaxPerRound` in the **manifest**, when it is there and not zero — which is
      what `Configure` recorded from the chain, so a re-run leaves an already-authorized asset exactly as it is;
   3. `SEED_MAX_PER_ROUND`, the single global override, and **only** for assets that got this far. If it would land
      on more than one asset the run is refused, naming them, rather than setting two different assets' caps to the
      same raw number;
   4. that asset's `seedAmount`.

   A cap below `seedAmount` is refused wherever it came from. The seed account has to call this itself — nobody,
   including the owner, can authorize spending of the Safe's balance on its behalf — which is why it goes through
   the Safe.

Then run `Configure` again (idempotent): it re-reads the chain and records `ownershipAccepted` and the
authorized cap in the manifest, which `Verify` then checks. Run `Verify` again after that.

Without 3 and 4 the keeper logs `SeedNotAuthorized` or `InsufficientSeedBalance` every cycle and no round is
ever seeded, which means a round with one player refunds instead of drawing.

An ERC-20 asset, if the plan lists one, gets its seed balance by hand: `approve(vault, amount)` on the token
followed by `deposit(asset, amount)` on the Vault, both as the Safe; the approval is for the exact amount and
never to the Draw. The default plan lists native BNB only.

---

## 4a. Adding the USDT pool

Optional, and only worth doing after section 4 works. It puts a second pool on the same deployment, playing the
chain 97 **faucet** USDT token `0x337610d27c682e347c9cd60bd4b3b107c9d34ddd` ("USDT Token", 18 decimals) against the
Chainlink USDT/USD feed `0xeca2605f0bcf2ba5966372c99837b1f182d3d620`, so the ERC-20 path is exercised on a real
chain before mainnet: `approve` then `deposit` instead of one `depositNative`, the Vault's exact-receipt and
exact-debit checks against a real token, the withdrawal debit, and the §9.5 allowance handling (ADR 038).

This token is **not** Binance-Peg USDT. It is a faucet token with no issuer, no reserves and no value, and its mint
authority is one anonymous account that can mint without limit. Everything verified about it is in
`config/assets/97/usdt.json`, which is a `candidate` record and not an admission.

Get the tokens from the **official BNB Chain faucet**, the same testnet faucet page reached from `bnbchain.org`
that section 1.2 uses for tBNB: it offers test tokens besides tBNB, and this is one of them. Do not use a faucet you
found in a search result or a message. Send them to the Safe — the Safe is the seed account, and the seed balance
has to be the Safe's.

**`Configure` cannot do this.** Every mutating step in `Configure.s.sol` is guarded by "the broadcaster is the
owner", and after section 4 the owner is the Safe, so a `Configure` run against a manifest carrying an unlisted
asset stops at `listAsset` with `Configure: the broadcaster is not the owner and cannot list USDT`. The steps below
do the same work through the Safe instead, and `Configure` is still run afterwards — with nothing left to change it
simply records what the chain now has.

1. **Put the asset in the plan.** `config/deployments/97/testnet.plan.json` already carries the USDT entry beside
   BNB, with its price record and a 5 USDT seed under a 10 USDT per-round cap. Nothing to do unless you want
   different figures.
2. **Put the asset in the manifest.** The Safe steps and `Verify` read the manifest, not the plan, and the manifest
   was written before the asset existed. Copy the plan's second `assets[]` entry into
   `config/deployments/97/<lowercase draw address>.json`, adding `"listed": false` and leaving `pool.poolId` at `0`
   with `pool.firstRoundIds` all `0` — step 3 fills them in. Copy the entry whole, including
   `pool.seedAuthorizedMaxPerRound` (step 4 reads that number) and `requiresZeroReset` (SPEC §9.5; `Configure` now
   carries it through every rewrite). This is the one hand edit in this runbook; step 5 rewrites the file from the
   chain afterwards, which is what makes it safe.
3. **List the asset and open the pool, as the Safe.** From `contracts/`, with `$M` still pointing at the manifest:

   ```bash
   LUCKYDRAW_MANIFEST=$M TOKEN_DEPOSIT=<raw units of USDT to deposit> \
     forge script script/TestnetSafe.s.sol:TestnetSafe --sig "assets()" \
     --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
   ```

   As the Safe, reading the live state first and skipping any step already done, it runs `listAsset`,
   `setDepositsEnabled`, `addPool`, `setSeedAmount`, `setTargetUsd` and `setPoolEnabled` for every asset in the
   manifest — the same steps in the same order as `Configure`, with the same VRF-readiness check before `addPool`,
   so a pool still cannot open against a subscription that cannot pay for a draw. Then, for each non-native asset
   and only when `TOKEN_DEPOSIT` is set, it sends `approve(vault, TOKEN_DEPOSIT)` on the token (resetting a stale
   allowance to zero first) and `deposit(asset, TOKEN_DEPOSIT)` on the Vault, and **asserts the Vault credited
   exactly what was deposited and that no allowance was left behind**. The approval is to the Vault, never to the
   Draw, and only ever for the exact amount. A deposit that simulates cleanly and then reverts on chain can leave
   that approval standing, which is why re-running the step resets the allowance to zero before approving again.
   `TOKEN_DEPOSIT` is in the token's raw units — 18 decimals here, so 20 USDT is `20000000000000000000` — and it is
   one amount, so the script **refuses it** when the manifest names more than one non-native asset: raw amounts are
   not comparable between tokens. With two or more tokens, run this step with `TOKEN_DEPOSIT` unset and deposit each
   token's seed balance by hand as the Safe (`approve(vault, amount)` on the token, then `deposit(asset, amount)` on
   the Vault). A second run with a value deposits again, because a deposit is an amount and not a state. The script
   refuses to run before the Safe owns both contracts and refuses a mainnet manifest.

   Give it several times `seedAmount`: every seeded round spends `seedAmount` and rounds that settle return nothing
   to the seed balance.
4. **Authorize the seed for the new asset.** Re-run section 4's `ops()`. It is idempotent, and it now finds a
   second asset in the manifest and calls `authorizeSeed(USDT, cap)` for it. Consent does not cross assets: the BNB
   authorization says nothing about USDT.

   ```bash
   LUCKYDRAW_MANIFEST=$M SEED_DEPOSIT_WEI=0 \
     forge script script/TestnetSafe.s.sol:TestnetSafe --sig "ops()" \
     --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
   ```

   No `SEED_MAX_PER_ROUND` here, and with two assets that matters. By section 4's order, BNB keeps the
   `pool.seedAuthorizedMaxPerRound` the manifest already records (`2000000000000000` wei) and USDT takes the
   `10000000000000000000` its hand-copied entry carries, so both land at the plan's figures in one run. A single
   global `SEED_MAX_PER_ROUND` cannot produce both — the number that gives USDT its cap would raise BNB's 5,000-fold
   — so the script refuses it here rather than applying it. Name the asset instead if you need to override one:
   `SEED_MAX_PER_ROUND_USDT=<raw units>`.
5. **Finalize and Verify.** `Configure` first, to record the new `poolId`, `firstRoundIds`, `listed` flag and
   authorized cap in the manifest; then `Finalize` and `Verify` exactly as in section 3, steps 3 to 5. `Verify`
   exits non-zero on any mismatch, which is what checks the hand edit of step 2. Then run
   `npx pnpm@12.3.4 validate:config` from the repository root, commit the manifest and push, so the Pages build
   picks the new pool up.

Then play a USDT round end to end and **record what you observed**: the exact amount credited on deposit, the exact
amount debited on withdrawal, and whether your wallet needed one `approve` or two. That observation is what fills
`exactTransferEvidence` in `config/assets/97/usdt.json`, and it is the whole reason for this section.

---

## 4b. Registering the upkeep

Optional, and independent of everything above: the Chainlink Automation upkeep is a **third executor** beside your
keeper (SPEC §10.3, ADR 039). It does not replace the keeper and nothing breaks without it. What it buys you is
that the lifecycle keeps running when your keeper host is down, rebooting or out of gas — a round still closes, a
draw is still requested, an unrequested round still expires into refunds, and a Ready round is still settled.

`LuckyDrawUpkeep` holds no funds, has no owner and has no role on the Draw. It calls exactly four public Draw
methods that any address may already call. Deploying it changes nothing about custody, so it is safe to run after
the Safe handover of section 4.

1. **Deploy it.** From `contracts/`, with the manifest you finished in section 4 (or 4a):

   ```bash
   LUCKYDRAW_MANIFEST=../config/deployments/97/<lowercase draw address>.json      forge script script/DeployUpkeep.s.sol:DeployUpkeep --rpc-url "$LUCKYDRAW_RPC_URL"      --broadcast --account <your signer>
   ```

   It refuses a manifest whose chain, environment or Draw code hash does not match the chain you are connected
   to, and it refuses to run twice. It writes `contracts.upkeep` into the manifest with the executor's address
   and code hash, and leaves `registry` and `upkeepId` null: those are yours to fill in below.

2. **Correct the deployment block and transaction hash.** A script cannot see its own creation, so
   `contracts.upkeep.deployBlock` is the simulation block and `deployTx` is null. Take both from the broadcast
   receipt (`contracts/broadcast/DeployUpkeep.s.sol/97/run-latest.json`, or the explorer) and edit them into the
   manifest. `Verify` checks them against the chain's own receipt.

3. **Look up the registry address for chain 97.** Chainlink publishes the Automation registry and registrar
   addresses per chain in its own documentation (`docs.chain.link`, Automation → Supported Networks). **Read it
   from there and copy it.** Nothing in this repository knows the address and no value here should be taken on
   trust; a wrong registry address is an upkeep that never runs.

4. **Register a custom-logic upkeep.** Go to `automation.chain.link`, connect the wallet that will own the
   upkeep, choose **Register new upkeep → Custom logic**, and give it:

   - **Target contract address**: the `contracts.upkeep.address` from step 1.
   - **Gas limit**: 500,000 is comfortable. The most expensive single action is `closeRound` on a round that has
     to open its successor; `performUpkeep` performs exactly one action, so this is not a batch budget.
   - **Check data**: leave it empty. Empty means "the first 16 pools and the newest 256 round ids", which covers
     this deployment several times over. A deployment with more than 16 pools registers a second upkeep with
     `checkData` set to `abi.encode(poolCursor, poolLimit, roundCursor, roundLimit)` for the next page.
   - **Starting balance**: LINK. You need testnet LINK on chain 97 from `faucets.chain.link`, and the upkeep is
     funded in LINK even though the Draw's VRF subscription is billed in native BNB. These are two separate
     balances: draining one does not touch the other.

5. **Record what registration produced.** Put the registry address in `contracts.upkeep.registry` and the
   registry's upkeep id in `contracts.upkeep.upkeepId` (a decimal string). The validator's rule `D28` requires
   both or neither, so a half-filled record fails section 5.

6. **Check it.** Re-run `Verify` (section 3) and watch the upkeep's history in the Automation app. With the
   keeper also running, most actions will be the keeper's: the two race and the loser reverts with a named error,
   which costs gas and nothing else. Seeing the upkeep perform occasionally is the point; seeing it perform
   *every* action means your keeper is not running.

Keep an eye on the LINK balance. An upkeep that runs out of LINK stops silently, and its only job is to be there
when the keeper is not.

---

## 5. Validate the configuration

From the repository root:

```bash
npx pnpm@12.3.4 validate:config
```

It needs no network access and reads no secrets. Fix anything it reports before going further; a manifest that
does not validate is a manifest the web build will also refuse.

Commit the new manifest (`config/deployments/97/<lowercase draw address>.json`) and push it. The Pages build
reads it from the repository — it does not talk to the chain — so the site cannot be built until the manifest
is committed.

---

## 6. Publish the web app

1. **Repository variables.** In GitHub: *Settings → Secrets and variables → Actions → Variables* (the
   **Variables** tab, not Secrets — none of these is a secret). Add:

   | Variable | Value |
   |---|---|
   | `LUCKYDRAW_CHAIN_ID` | `97` |
   | `LUCKYDRAW_DRAW_ADDRESS` | the lowercase Draw address, exactly as in the manifest file name |
   | `LUCKYDRAW_RPC_URL` | a **public** BSC testnet RPC origin, with no API key and no query string |

   The last one is the one to be careful about. It is compiled into the bundle and handed to every visitor's
   wallet by `wallet_addEthereumChain`, so it must be an endpoint you are happy to publish. Pick a public BSC
   testnet endpoint yourself; the repository does not choose one for you, and `config/chains/97.json`
   deliberately records only the *name* of this variable. Keep your keyed endpoint in your own shell as
   `LUCKYDRAW_OPS_RPC_URL` for the deployment scripts and the keeper. The build fails outright on a value
   carrying credentials or a query string.

   Until you set these three, the workflow still runs and publishes a page built against the committed local
   anvil manifest — useful for proving the Pages setup works, useless as an app.

2. **Enable Pages.** *Settings → Pages → Build and deployment → Source: **GitHub Actions***. Do not pick
   "Deploy from a branch".

3. **Push to `main`.** `.github/workflows/pages.yml` builds and deploys on every push to `main`, and can also
   be run by hand from the Actions tab ("Run workflow"). The finished run prints the site URL,
   `https://<your-github-user>.github.io/<repository name>/`. The base path comes from the repository name
   automatically, so a repository named `luckydraw` is served at `/luckydraw/` with no extra configuration.

4. **Check it.** Open the URL, then open a deep link such as
   `https://<your-github-user>.github.io/luckydraw/round/97/1` **directly** and reload it. Both must load the
   app rather than a GitHub 404 page: that is what the `404.html` copy in the build is for.

A local rehearsal of exactly the same build, before pushing:

```bash
cp web/.env.testnet.example web/.env    # then fill in the two placeholders
npx pnpm@12.3.4 --filter @luckydraw/web build
npx pnpm@12.3.4 --filter @luckydraw/web preview
```

`web/.env` is untracked and must stay that way.

---

## 7. Run the keeper

The keeper advances rounds — seed, close, request, settle, refund — while people are using the app. Every
call it makes is public: anyone, including the app itself, can make the identical calls, so losing the keeper
delays rounds and never puts funds at risk. Full detail is in `keeper/README.md`.

Use a **dedicated, low-balance key** created for this and nothing else. Never the Safe, never the VRF
subscription owner, never an account holding anything you care about. Fund it with a small amount of testnet
BNB for gas and give it no other role. From your own shell, on the machine that will keep running:

```bash
npx pnpm@12.3.4 install --frozen-lockfile
read -rs KEEPER_PRIVATE_KEY && export KEEPER_PRIVATE_KEY     # typed, not echoed, not stored
KEEPER_RPC_URL="$LUCKYDRAW_OPS_RPC_URL" KEEPER_CHAIN_ID=97 \
KEEPER_DRAW_ADDRESS=0x<lowercase draw address> \
  npx pnpm@12.3.4 --filter @luckydraw/keeper start
```

Prefix the last command with `KEEPER_DRY_RUN=1` for a rehearsal first: everything is simulated and logged and
nothing is sent. The key never goes into a file, a shell rc file or a process argument, and the keeper never
logs it or the RPC URL.

For the long-running install, use the systemd unit in `keeper/deploy/` (`keeper/README.md`, "Running it under
systemd"). Build it first — the unit runs the compiled JavaScript under `--jitless`, because on an
SELinux-enforcing host V8 cannot get its JIT mapping inside the sandbox and Node dies at start-up, and jitless
Node cannot type-strip TypeScript:

```bash
npx pnpm@12.3.4 --filter @luckydraw/keeper build      # repeat after every git pull
# the unit's line, for reference:
#   ExecStart=/usr/local/bin/node --jitless dist/keeper/src/main.js
```

The symptom strings for each part of that are in `keeper/README.md`, "Jitless on hardened hosts".

Watch the first few cycles. `event=action_sent … action=seedRound` means section 4 worked. Repeated
`skip=SeedNotAuthorized`, `skip=InsufficientSeedBalance` or `event=request_precheck_failed` means the seed
authorization, the Safe's Vault balance or the VRF subscription needs attention. Ten consecutive failed cycles
exit the process; restart it after fixing the cause.

---

## 8. Share it

Send people the Pages URL. Tell them, in your own words, roughly this:

> It runs on the BNB Smart Chain **test** network, so nothing here is real money and nothing can be cashed
> out. You need MetaMask (browser extension, or the MetaMask app's built-in browser on a phone). The site
> asks your wallet to switch to BSC testnet — accept it. You then need a little free testnet BNB from the
> official BNB Chain testnet faucet for the entry and the network fee. Browsing costs nothing and needs no
> wallet at all; a wallet is only needed to enter a draw.

On a phone in an ordinary browser rather than in a wallet app, the connect button opens MetaMask through its
deep link, which is built from the page's own address — so it carries the `/luckydraw/` path automatically and
needs no configuration.

---

## 9. What this deliberately does not include

An interest test, not a launch. None of the following is built, and the absence is a decision, not an
oversight:

- **No indexer, no API, no database.** The app reads the chain directly. There is no `/activity` and no
  `/leaderboard`, and history beyond what a direct read gives is not shown.
- **No `/admin`.** Owner actions are done from the Safe by hand, as in section 4.
- **No host hardening, no origin isolation, no off-host logs, no tamper canary, no release manifest, no
  monitoring or alerting.** GitHub Pages serves the files; it sends none of the §9.6 response headers, so
  `frame-ancestors` and `X-Frame-Options` are absent.
- **No backup keeper and no Chainlink Automation upkeep.** One process on one machine; if it stops, rounds
  stall until it is restarted or somebody calls the public methods.
- **No external audit and no independent review of the contracts.** The test suites pass; that is not an
  audit.
- **No legal determination** (SPEC §14), so nothing here may be offered anywhere as a real-money product.
- **Not for real money.** The §14 gates for mainnet are unmet and no mainnet deployment exists. Do not point
  this build, these scripts or this workflow at chain 56, and do not tell anyone that testnet BNB is worth
  anything.

If the interest test goes well, the mainnet gate work is the middle column of SPEC §12.1, and it is
substantial.
