# Mainnet operator checklist (chain 56)

Every step below needs **your own key or your own Safe**. Nothing else does: the read-only half of
`docs/runbooks/mainnet-launch.md` — the chain identity, the Multicall3 proof, the BNB/USD feed verification and
its measured update interval, the VRF coordinator and lane verification, the gas measurement and the
deployment plan — is already done and committed (`config/chains/56.json`, `config/assets/56/bnb.json`,
`config/deployments/56/mainnet.plan.json`). This page is the remainder, in order. The full reasoning for each
item stays in `mainnet-launch.md`; the section number is on every row.

`<PLACEHOLDER>` tokens are yours to replace. `<your signer flags>` is the `--ledger`, `--trezor`,
`--interactive` or `--account <keystore-name>` flag you normally use. **Never put `--private-key` on a command
line, and never put a key, a seed phrase or a keyed RPC URL in this repository.**

Session setup, once per shell:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
export LUCKYDRAW_OPS_RPC_URL="https://<your keyed BSC mainnet endpoint>"
export LUCKYDRAW_RPC_URL="$LUCKYDRAW_OPS_RPC_URL"
npx pnpm@12.3.4 install --frozen-lockfile
```

## What has to hold BNB, and how much

Estimated from the chain 97 figures in `docs/ACCEPTANCE.md` — one settled round cost **33,446,400,000,000 wei**
of keeper gas across its seed, close, request and settle transactions and **273,060,800,000,000 wei** of VRF
payment — and from the plan's sizing note: a quiet month is **104 funded rounds** (3 daily tiers × 30 + 3 weekly
tiers × 4.35 + 1 monthly). Chain 97's gas price is higher than BSC mainnet's, so the keeper figure is an upper
bound. Hold these before step 1.

| Account | Amount | Where it comes from |
|---|---|---|
| Deploying account | **0.1 BNB** | Two contract creations plus `Configure`'s seven-sequence `addPool` is single-digit millions of gas; 0.1 BNB is roughly a 10× multiple of that at 1 gwei |
| VRF subscription | **1.5 BNB** | `requestDraw` refuses while the balance is below `(pendingRequests + 1) × maxRequestCostNative`, and `maxRequestCostNative` is **0.16 BNB**. All seven sequences can have a request in flight at once (the three daily tiers share a cutoff), so the floor is 8 × 0.16 = **1.28 BNB** before any headroom. 1.5 BNB covers that plus far more than §1.4's "30 draws", whose real cost is about 0.00027 BNB each. **Fund with BNB, not LINK**: the plan sets `nativeBilling: true`. LINK is needed only if you flip that to `false`, and then the whole derivation changes |
| Seed Safe, deposited into the Vault | **0.35 BNB** | 104 × the plan's `seedAmount` of 0.003 BNB = 0.312 BNB for one month, rounded up. Nothing comes back from a round that settles |
| Treasury Safe | **0.5 BNB, held and not spent** | The plan's `makeWholeReserve`. §7.3 commits you to paying out of it; `/verify` publishes it |
| Keeper account | **0.1 BNB** | 104 × 0.0000334 BNB ≈ 0.0035 BNB a month, with a ~30× multiple for gas spikes, retries and the occasional duplicate that reverts |
| Your ordinary MetaMask account | **0.05 BNB** | The shakedown entries and their gas |

Top the subscription and the Vault seed balance up **on a schedule, not on an alert**.

---

## The steps

### 1. Fund the deploying account and the keeper account — §1.1, §1.8

Five different accounts on purpose. The keeper key is created for this and nothing else and is never the owner,
treasury or seed Safe, and never the VRF subscription owner.

Check what you sent:

```bash
cast balance <YOUR_DEPLOYER_ADDRESS> --rpc-url "$LUCKYDRAW_OPS_RPC_URL" --ether
cast balance <KEEPER_SIGNER_ADDRESS>  --rpc-url "$LUCKYDRAW_OPS_RPC_URL" --ether
```

Expected: the amounts from the table above, in BNB.

### 2. Create three Safes on chain 56 and read their configuration off the chain — §1.2

In the Safe interface at `app.safe.global`, on BNB Smart Chain: **three separate Safes** — owner, treasury and
seed — each **2-of-3** with independently generated hardware keys, no enabled modules, no custom guard, and the
three seed backups physically separated. Take the deployment addresses from `docs.safe.global`, not a search
result.

Then, for each of the three:

```bash
cast code <SAFE_ADDRESS> --rpc-url "$LUCKYDRAW_OPS_RPC_URL" | head -c 20
cast call <SAFE_ADDRESS> "VERSION()(string)"      --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast call <SAFE_ADDRESS> "getOwners()(address[])" --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast call <SAFE_ADDRESS> "getThreshold()(uint256)" --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast call <SAFE_ADDRESS> "getModulesPaginated(address,uint256)(address[],address)" \
  0x0000000000000000000000000000000000000001 10 --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
cast storage <SAFE_ADDRESS> 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8 \
  --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
```

Expected: code that is not `0x`; three addresses from `getOwners()`; `2` from `getThreshold()`; an empty module
list; and the guard slot reading all zeros.

### 3. The recovery drill, on these three Safes, before anything is deployed — §1.3, SPEC §10.5

Five checks on **each** Safe: a zero-value `execTransaction` to the Safe's own address executes; two signers
execute with one unavailable; one signature alone does not execute; `swapOwner` replaces a "lost" owner and
then swaps it back (`getOwners()` and `getThreshold()` confirmed on chain after each); and — later, at step 13
— the treasury Safe pulls a real withdrawal out of the Vault.

Keep the transaction hashes and the date. You cannot write the record yet: it is keyed by the Draw address.
**This is the one item that cannot be added to a running deployment afterwards.**

### 4. Create and fund the VRF subscription — §1.4

At `vrf.chain.link`, on BNB Chain mainnet, with the **owner Safe** as the subscription owner. Fund it with
**1.5 BNB** (see the table). Note the subscription id.

Confirm against the chain what the plan already records:

```bash
cast call 0xd691f04bc0c9a24edb78af9e005cf85768f694c9 "getSubscription(uint256)" <SUBSCRIPTION_ID> \
  --rpc-url "$LUCKYDRAW_OPS_RPC_URL"
```

Expected: a balance at or above 1.5 BNB in wei, and the owner Safe as the subscription owner. (The coordinator
address and the 200 gwei key hash `0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4` were
already verified against both public endpoints on 2026-09-18 and are in the plan; re-read them if the date has
moved on.)

### 5. Replace the placeholders in the plan and re-validate — §2

Edit `config/deployments/56/mainnet.plan.json` and replace exactly these five things (the file's own `notes`
lists them, and rule `PL9w` prints them):

| Field | Current placeholder | Replace with |
|---|---|---|
| `ownership.finalOwner` | `0x504c414345484f4c444552000000000000000001` | the **owner** Safe, lowercase |
| `ownership.feeAccount` | `0x504c414345484f4c444552000000000000000002` | the **treasury** Safe, lowercase |
| `ownership.seedAccount` | `0x504c414345484f4c444552000000000000000003` | the **seed** Safe, lowercase |
| `vrf.subscriptionId` | `"0"` | your subscription id, as a decimal **string** |
| the keeper signer | not a field of this document | `/etc/luckydraw/keeper.env` at step 14, and nowhere in `config/` |

Confirm `ownership.makeWholeReserve` (0.5 BNB) and `makeWholeCap` (0.25 BNB) are the figures you will actually
hold, and `assets[0].pool.seedAmount` (0.003 BNB) is an amount you are willing to lose 104 times a month. Then
fill `ownership.safes[]` with the sanitised configurations from step 2 — role, threshold, signer count,
hardware keys, distinct key holders, implementation, fallback-handler code hash, `modulesEnabled: false`. **No
signer address, seed or backup location ever goes into `config/`** (§15).

```bash
npx pnpm@12.3.4 validate:config
```

Expected: `config/deployments/56/mainnet.plan.json` reported `ok`, with **no `PL9w` line**. While a `PL9w` line
is still printed, a placeholder is still in the file.

### 6. Deploy — §3 step 1, `contracts/README.md`

```bash
cd contracts
LUCKYDRAW_PLAN=../config/deployments/56/mainnet.plan.json \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
```

Expected: `Deploy: draw    0x…` and `Deploy: manifest ../config/deployments/56/<lowercase draw address>.json`.
Then `export M=../config/deployments/56/<lowercase draw address>.json`.

Write the release-authority record now, from the drill evidence of step 3, at
`config/release-authority/<name>.json` — the template is in §1.3. `chainId` is 56, `safes` must equal the
manifest's three roles exactly and lowercase, the drill `date` must not be later than the manifest's
`createdAtUtc` date, and `treasuryWithdrawalProven` stays **`false`** until step 13.

### 7. Add the Draw as a VRF consumer (Safe transaction) — §3 step 2

At `vrf.chain.link`, open the subscription, add the Draw address as a consumer. This is signed by the
subscription owner, so it is a 2-of-3 transaction from the **owner** Safe. `Configure` will not create a pool
until this is done, and rule `D22` fails a mainnet manifest without it.

### 8. Configure — §3 step 3

```bash
LUCKYDRAW_MANIFEST=$M \
  forge script script/Configure.s.sol:Configure --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast <your signer flags>
```

Expected: `Configure: Vault ownership transfer started to <owner Safe>` and the same for the Draw. It is
idempotent — if it stopped halfway, or you ran it before step 7, just run it again.

### 9. Finalize — §3 step 4

```bash
LUCKYDRAW_MANIFEST=$M LUCKYDRAW_BROADCAST=broadcast/Deploy.s.sol/56/run-latest.json \
  forge script script/Finalize.s.sol:Finalize --rpc-url "$LUCKYDRAW_RPC_URL"
```

Expected: `Finalize: vault block <n>`, `Finalize: draw block <n>`, `Finalize: startBlock <n>`.

### 10. Verify — §3 step 5

```bash
LUCKYDRAW_MANIFEST=$M forge script script/Verify.s.sol:Verify --rpc-url "$LUCKYDRAW_RPC_URL"
```

Expected: `Verify: OK` and `Verify: checks failed 0`, exiting zero. **Nothing proceeds until it passes.**

### 11. Verify the source on BscScan — §3 step 6

Publish verified source for both the Vault and the Draw on `bscscan.com`, using the pinned toolchain from
`contracts/foundry.toml` (solc 0.8.28, `evm_version = paris`, via_ir, 600 optimizer runs, no metadata hash) or
the bytecode will not reproduce. Expected: MetaMask shows a readable method name before a signature.

### 12. `validate:config` on the manifest — §3 step 7

```bash
cd .. && npx pnpm@12.3.4 validate:config
```

Expected: every document `ok`, 0 failed. On a mainnet manifest this additionally enforces `O1` (three Safes),
`O4` (nonzero reserve and cap), `D22` (registered consumer), `CH4` (the chain record — already satisfied),
`P6`–`P8` (the observation window — already satisfied) and `RA2`/`RA3` (the drill record). Commit and push the
manifest and the release-authority record: the Pages build reads them from the repository and never from the
chain.

### 13. Safe steps, from the Safe interface — §4

Each is a 2-of-3 signature with **independent** verification of the decoded calldata on each device. Never
approve blind data.

| # | Safe | Target | Function |
|---|---|---|---|
| a | owner | Vault address | `acceptOwnership()` |
| b | owner | Draw address | `acceptOwnership()` |
| c | seed | Vault address | `depositNative()` with a BNB value of **0.35 BNB** |
| — | **stop here and do step 14** — this is the only point where the `SeedNotAuthorized` alert can be produced without breaking anything | | |
| d | seed | Vault address | `authorizeSeed(0x0000000000000000000000000000000000000000, 6000000000000000)` |
| e | treasury | Vault address | `withdraw(0x0000000000000000000000000000000000000000, <amount>)`, after the first settled round of step 15 has credited the fee |

The seed account must send (d) itself: nobody, including the owner, can authorize spending of the seed Safe's
balance on its behalf. After (e), and only then, set `custody.recoveryDrill.treasuryWithdrawalProven: true` in
the release-authority record and re-run `validate:config`.

Also **hold** the 0.5 BNB make-whole reserve in the treasury Safe, unspent, and rehearse
`setBuysPaused(true)` from the owner Safe before you need it (§8).

### 14. The keeper on its host, and the alert proof — §7, §4

Between 13c and 13d. Install from `keeper/deploy/`: create the `luckydraw-keeper` system account, put the
dedicated keeper key in `/etc/luckydraw/keeper-private-key` (root:root, 0600 — **not** in the environment
file, systemd hands it over with `LoadCredential=`), copy `luckydraw-keeper.env.example` to
`/etc/luckydraw/keeper.env` (0600) and fill in:

```
KEEPER_RPC_URL=<https://your-keyed-operational-endpoint>
KEEPER_CHAIN_ID=56
KEEPER_DRAW_ADDRESS=<lowercase draw address>
KEEPER_HEARTBEAT_URL=<https://your-monitor.example/ping/<UUID>>
KEEPER_ALERT_WEBHOOK=<https://your-chat-webhook>
```

Both URLs are **mandatory for this launch** (ADR 040), not optional. Rehearse once with `KEEPER_DRY_RUN=1` in
the foreground, then:

```bash
sudo systemctl enable --now luckydraw-keeper
journalctl -u luckydraw-keeper -f
```

Expected, in order: a `started` line showing `keySource=credential`, your expected `signer`,
`multicall3=0xca11bde05977b3631167028862be2a173976ca11`, `alerts=on` and `heartbeat=GET` or `POST`; then
`round_idle … skip=SeedNotAuthorized` for every Open round (seven per pool); then exactly one
`event=alert_sent cause=SeedNotAuthorized`; then the `cycle` line.

**Then look at the destination**, not at the log: the alert must be visible where you would see it at 03:00 —
the chat channel on your phone. If nothing arrived the gate is not met: fix the URL, restart the unit (the
once-per-cause-per-hour limiter is per process, so a restart pages again at once) and look again. Record the
date, the cause, the delay between `alert_sent` and the alert appearing, and where it appeared, in
`docs/ACCEPTANCE.md`.

Do the heartbeat half too: stop the unit, confirm the dead-man's-switch monitor alerts you when the pings
stop, start it again. A keeper that cannot start pages nothing, and only the heartbeat monitor sees that.

Now go back and send 13d. Expected on the next cycle: no second alert, and `event=action_sent … action=seedRound`.

### 15. The shakedown, on the local dev server — §5a, §5b, §5c

`release.customerLaunch` is false, so the chain 56 **build** is refused and nothing can be published. The dev
server is not gated:

```bash
cp web/.env.mainnet.example web/.env   # draw address, the PUBLIC rpc origin, the jurisdiction sentence
npx pnpm@12.3.4 --filter @luckydraw/web dev
# http://localhost:5173/luckydraw/   (leave --host off: localhost only)
```

**5a, one settled round:** keeper seeds it; you enter from MetaMask with an amount that will not reach the USD
100 target, so the round closes at its UTC cutoff; keeper closes, requests, the coordinator fulfils after 200
confirmations, keeper settles; you withdraw, and the treasury Safe does 13e. Take off the chain:
`callbackGasUsed` from the fulfilment receipt (compare it with the plan's Foundry figure of **67,184**; a large
gap is a finding), `requestToFulfilmentSeconds`, and `costPerDrawNativeWei` from the keeper's
`event=draw_cost round=<id> keeperGasWei=<wei> vrfPaymentWei=<wei>` line — their sum, and never a line carrying
a `note=`. Also stop and restart the keeper mid-round and note what you saw.

**5b, the refund:** `setSeedAmount(<poolId>, 0)` from the owner Safe; one entry from one address into the next
daily round; wait for the cutoff; `closeRound` puts it in `Refunding`; `claimRefund(roundId, account)` returns
the full gross including the 3%; then `setSeedAmount(<poolId>, 3000000000000000)` from the owner Safe to
restore it **before** the next `Verify`.

**5c, the MetaMask journey**, in one sitting on a desktop browser: locked wallet → connect → wrong network on
purpose → an under-USD-1 refusal, then a real entry with its preview → the entry on the round page → a
withdrawal → a deliberate *Reject*. Screenshots (a)–(g) per §5c, kept with your evidence. Nothing showing a
seed phrase, a private key or a keyed RPC URL.

### 16. Record `release.shakedown`, with `customerLaunch` still false — §5d

Add to the manifest at `config/deployments/56/<lowercase draw address>.json`:

```json
"release": {
  "customerLaunch": false,
  "shakedown": {
    "performed": true,
    "date": "<YYYY-MM-DD>",
    "roundIds": [<settled>, <refunded>],
    "callbackGasUsed": <measured>,
    "requestToFulfilmentSeconds": <measured>,
    "costPerDrawNativeWei": "<decimal wei>"
  }
}
```

```bash
LUCKYDRAW_MANIFEST=$M forge script script/Verify.s.sol:Verify --rpc-url "$LUCKYDRAW_RPC_URL"
npx pnpm@12.3.4 validate:config
```

Expected: `Verify: OK`, and validation clean. Rule `D27` rejects a measurement a real fulfilment could not have
produced. Add the same numbers to the `docs/ACCEPTANCE.md` evidence ledger and commit.

### 17. Flip `customerLaunch` — §6 step 1

Read §6's checklist back first; the flip is the **last** mandatory item and nothing follows it. Set
`release.customerLaunch` to `true`, run `npx pnpm@12.3.4 validate:config`, commit. Do not re-run `Configure`
after this without saving and restoring the `release` object.

### 18. Publish — §6 steps 2–5

GitHub *Settings → Secrets and variables → Actions → **Variables***: `LUCKYDRAW_CHAIN_ID=56`,
`LUCKYDRAW_DRAW_ADDRESS=<lowercase draw address>`, `LUCKYDRAW_RPC_URL=<a public origin, no API key, no query
string>`, `LUCKYDRAW_JURISDICTION_NOTICE=<your sentence>`. *Settings → Pages → Source: **GitHub Actions***, and
*Settings → Environments → github-pages* with **Deployment branches** set to `main` only. Push to `main`.

Expected: the run prints `https://<your-github-user>.github.io/luckydraw/`. Any refusal is one line beginning
`Mainnet build refused:`. Then open a deep link such as `/round/56/1` **directly** in a fresh tab and reload
it — both must load the app, not a GitHub 404 — check `/verify` shows the Draw and Vault addresses, code
hashes, BscScan links, reserve and cap that match your manifest by eye, and scroll `/entries` back far enough
to see the partial-history notice appear.

### 19. One live MetaMask entry on the published site — §6 step 8, §5c

Repeat the §5c journey against the published bundle, desktop and phone, with the screenshots, **before any
link is shared**. This is the first use of the published bundle and the second half of ADR 040's gate (e).
Record in `docs/ACCEPTANCE.md` where each journey was taken.

### 20. Share — §8

Start with a small invited group for three days: a dozen people you can talk to, on mainnet, with real money,
before any public post. Tell them the limitations in §8 in your own words — the accepted-request escrow risk,
the capped and voluntary make-whole payment, no cash-out outside the contract, no audit, one keeper on one
machine, and your jurisdiction sentence. Watch the keeper alerts, the subscription balance, the seed balance
and the oldest Drawing age over those three days.
