# `@luckydraw/keeper`

A deliberately small keeper for the mainnet MVP (ADR 034): **one Node process, one loop, no database, no
metrics endpoint**. It exists so the deployment advances on its own — seed, close, request, settle,
refund — while the web app is being used. It is still **not** the full production keeper of SPEC §10.2;
what that adds is listed under [Deferred](#deferred).

Wave 7 made it durable enough to leave running on a host with real money behind it: a hardened
[systemd unit](#running-it-under-systemd) whose signing key arrives through a systemd credential, an optional
[heartbeat and alert webhook](#heartbeat-and-alerts), a [per-draw cost meter](#cost-meter) for the shakedown
record, [Multicall3 batching](#chain-record-and-multicall3), and a start-up refusal to act against any mock
on chain 56.

Every lifecycle method it calls is public (SPEC §2: the keeper has "no privileged access to funds or
outcomes"), so anyone, including the app, can perform the identical calls. Losing the keeper delays rounds;
it never puts funds at risk.

## What it does each cycle

Every `KEEPER_INTERVAL_MS` (default 15,000) the keeper resolves the head block **once** and reads everything
at it (SPEC §10.1: "related direct reads use one blockTag"), so one cycle is one consistent view and the
timestamp that drives every decision is the block's, never the host clock's.

It then walks **every pool** and every kind (`Day100`, `Day1k`, `Day10k`, `Week1k`, `Week10k`, `Week100k`,
`Month100k` — seven sequences per pool, ADR 036), tracks their current round ids,
and applies the table below to every round it is tracking. A **disabled** pool is walked too: SPEC §6.1 says
its existing round "finishes normally and then has zero current", so its Open, AwaitingRequest and Ready
rounds are closed, requested and settled exactly like an enabled pool's. What disablement changes is that no
seed budget is read for it, so no seed is ever attempted, and its zero pointers are left alone rather than
opened — for a disabled pool zero is the end state, and `ensureCurrent` rejects it anyway.

Tracking outlives `current`: closing a
round advances `current` to its successor in the same transaction (SPEC §6.1), so a round still waiting to be
requested, settled or refunded is no longer current. A round is dropped when it reaches `Settled`, `Void`, or
`Refunding` with `refundedGross == grossTotal`.

That covers a round this process watched while it was current. A round closed **before** it started — by the
operator, by the app, or by the keeper itself before a restart — is named by no pointer and appeared in no
cycle, so it would sit in `AwaitingRequest` until its 24-hour deadline and expire into refunds with a keeper
running (observed on chain 97, round 1, 2026-09-18). So the **first cycle**, and every
`DISCOVERY_EVERY_CYCLES` (20, five minutes at the default interval) after it, walks round ids
`1..roundCount()` through `getRound` in pages of `DISCOVERY_PAGE_SIZE` (50) and tracks every round that is
not terminal, logging `event=discovered_round` per round and one `event=discovery` per pass. Terminality is
not a second state table: it is `decide` returning `done`, so exactly the rounds the cycle drops are the
rounds the scan skips. The work is bounded twice — by the page size, and by the highest id already judged,
because SPEC §6.2's "Settled/Void never transition" means a terminal round can never become unresolved again,
so a periodic pass only reads ids created since the last one. A failed page is
`event=discovery_failed`/`discovery_round_failed` at warn level and an unchanged high-water mark, never a
failed cycle: the pass only ever adds to the tracked set, and the next one resumes where this one stopped.
This is the in-memory form of SPEC §10.2's persisted "round IDs seen in `RoundOpened` that have not reached
Settled or Void", rebuilt from `getRound` rather than from a store — which is what SPEC §10.2 means by
"keeper state is fully reconstructible from chain".

At most **one transaction per round per cycle**, and every call is simulated with `eth_estimateGas` first
(SPEC §10.2: "before each send the keeper simulates the call ... and skips it on revert"). A failed
simulation is a logged skip with the contract's own decoded custom-error name; nothing is sent.

A **failed send** is contained the same way. The simulation passed and the node still refused the
transaction — a nonce gap, an underpriced replacement, a socket timeout, a keeper account out of gas — so the
action becomes `event=action_skipped skip=SendFailed:<the node's message>` and the cycle carries on with the
next round. Unattended that throw would cost every later round in the cycle its turn and count towards the
ten consecutive failures that exit the process, which is the opposite of what one bad nonce deserves. Two
details: a send failure is never reported as a `requestDraw` pre-check failure and never triggers that
back-off, because it says nothing about the key hash or the subscription; and when the error still carries a
transaction hash (ethers broadcasts, *then* compares hashes and reads the block number, so its `BAD_DATA`
"returned hash did not match" is raised with the raw transaction already on the wire) the hash is logged and
the action is recorded in flight, so the next cycle does not race a duplicate against it.

A sent transaction is also **not sent again** while it is unmined. A cycle is shorter than inclusion, so
without that the same action would be re-derived from unchanged chain state every cycle and every duplicate
would revert on chain (`AlreadySeeded`, `RoundNotOpen`, `AlreadyClaimed`) at full gas cost. The keeper
remembers each `(round, action)` it sent — `(round, action, account)` for a refund, so one buyer's unmined
claim never holds up another's — and skips the repeat with `event=action_deferred skip=InFlight`. The memory
is dropped as soon as the chain shows the precondition changed (the round advanced, or is now seeded, or that
position is refunded), when the round reaches a terminal state, or after `IN_FLIGHT_MS` (120,000), which is
what makes a *dropped* transaction retried rather than waited on forever.

### Decision table (SPEC §6.2), in order per round

| # | Round state | Condition | Action |
|---|---|---|---|
| 1 | `Open` | not seeded, `block.timestamp < closesAt`, pool `seedAmount > 0`, a seed account is set, that account authorized **this asset** for at least `seedAmount`, and its available balance covers every seed already committed for that pool this cycle plus this one | `seedRound(id)` |
| 1a | `Open` | not seeded, any seed precondition missing | quiet skip, named `SeedNotConfigured` / `SeedNotAuthorized` / `InsufficientSeedBalance` |
| 2 | `Open` | `block.timestamp >= closesAt` | `closeRound(id)` |
| 2a | `Open` | seeded, before the cutoff | nothing (`OpenBeforeCutoff`) |
| 3 | `AwaitingRequest` | `block.timestamp < requestDeadline` | `requestDraw(id)`, retried at most once per minute after a failed simulation |
| 4 | `AwaitingRequest` | `block.timestamp >= requestDeadline` | `expireUnrequested(id)` |
| 5 | `Drawing` | — | nothing; the coordinator's authenticated callback owns the transition (SPEC §7.1, §7.3) |
| 6 | `Ready` | — | `settle(id)` |
| 7 | `Refunding` | some buyer of the round is not yet refunded and has no claim in flight | `claimRefund(id, buyer)` for one buyer |
| 8 | `Refunding` | `refundedGross == grossTotal` | stop tracking |
| 9 | `Settled` / `Void` | — | stop tracking |
| — | any | the identical action was sent less than `IN_FLIGHT_MS` ago and the chain has not moved | nothing (`action_deferred`, `skip=InFlight`) |

Three refinements the table itself forces. Two are in `src/decide.ts`:

* the seed is attempted only while the round is Open **before** its cutoff. SPEC §5.4 says a seed succeeds
  only then, and `seedRound` past the cutoff reverts `EntryWindowClosed`. Without the guard an unseeded round
  past its cutoff would spend its one action per cycle on a call that can never be mined, and would never be
  closed.
* `requestDraw` backs off for 60 seconds after a failed simulation. SPEC §6.2's pre-checks (the key hash still
  registered on the coordinator, and the subscription's native balance at least
  `(pendingRequests + 1) x maxRequestCostNative`) are chain state that a retry loop cannot change; the failure
  is logged as `event=request_precheck_failed` with the decoded reason, for the operator to act on.

The third is in `src/keeper.ts`: the seed account's balance is read once per pool per cycle, but a pool has
seven kinds, so one balance can be asked for seven seeds in the same cycle. The keeper counts the seeds it has
committed for a pool this cycle and requires `balance >= seedAmount x (issued + 1)` before the next one, so a
balance that covers exactly one seed funds exactly one round and the other six are named
`InsufficientSeedBalance` skips. The per-asset `seedMaxPerRound` check stays a separate comparison against one
`seedAmount`, because `Vault.lockSeed` enforces that cap per round, not per cycle.

`ensureCurrent(poolId, kind)` is called **only** when an *enabled* pool's `current` pointer is zero, which SPEC
§6.1 says happens after a re-enable. Normal operation never needs it: the contracts open the successor
themselves in every closing branch. It carries the same in-flight suppression as the round actions, keyed by
pool and kind rather than by round, because the pointer stays zero until that send is mined.

### Refunds

`claimRefund(roundId, account)` names the account, so the round's buyers have to be enumerated. They come from
that round's `EntryBought` and `SeedEntered` logs, decoded with the client's `decodeLog`, which drops any log
whose emitter is not the manifest Draw (SPEC §10.1: "ignore look-alike emitters"). The scan runs from the
manifest's `chain.startBlock` to the snapshot block, paged `KEEPER_LOG_WINDOW` blocks at a time because BSC
public RPCs cap `eth_getLogs` ranges. A `Refunding` round accepts no new entries, so the list is discovered
once per round and reused — but only while the round's own accounting agrees with it. When every buyer on the
list is refunded and `refundedGross` is still below `grossTotal`, the list is short: somebody entered the
round and the scan that produced the list did not see them. The cached list is therefore dropped, the keeper
logs `event=refund_buyers_incomplete` at warn level with the list length, `refundedGross` and `grossTotal`,
and the next cycle rescans — at most once a minute per round, because a rescan re-reads the whole history
from `chain.startBlock` and the same symptom is produced by a log node that is merely lagging and will catch
up. Without that check a single short page would be cached for the life of the round and every later cycle
would log the reassuring `refund_idle NoUnrefundedBuyer` while a buyer's refund was never credited.

Public RPCs cap that call two ways, and SPEC §10.1 treats both as errors: the block range, which fails loudly,
and the number of logs returned, which does not — a capped provider answers 200 OK with the first 10,000 logs
and says nothing. So the scan halves the window and re-reads the **same start** both on a thrown error and on
a page that comes back at `MAX_LOGS_PER_PAGE`, and a page that still fails, or still fills, at a single block
raises `LogScanError` rather than returning a short buyer list — a buyer missing from that list is somebody's
refund never credited. The narrowed window is kept for the rest of that scan.

A refund scan that fails is contained to its own round: it is logged as `event=refund_scan_failed` with the
provider's message and the cycle carries on with the other rounds, which is why one unreachable log page
cannot stop a `Ready` round from being settled or count towards the ten-failed-cycle exit.

The in-memory refunded set is an optimisation, never an authority: `getPosition(roundId, account)` is read
before every claim, so a restart mid-refund re-reads the truth from the chain instead of re-sending claims
that would revert `AlreadyClaimed`.

## Signing and secrets

**No key is ever written, logged or committed by this package.** Exactly one of two modes must be selected, or
the keeper refuses to start:

| Variable | Mode | Where the signature comes from |
|---|---|---|
| `KEEPER_UNLOCKED_ADDRESS` | local anvil (`--unlocked`) | the node signs `eth_sendTransaction`; no key exists anywhere in this process |
| `KEEPER_PRIVATE_KEY` | non-local, from a shell | an ethers `Wallet`, read once in `src/sender.ts` at construction and never echoed |
| the `keeper-private-key` systemd credential | non-local, under systemd | the same `Wallet`, read once from `$CREDENTIALS_DIRECTORY` (see [systemd](#running-it-under-systemd)) |

The credential and the variable select the same mode; when both are present the **credential wins**, because
an operator who installed the unit must sign with the key the unit was given and not with whatever a shell
still exports. Which of the two was used is in the `started` line as `keySource=credential|environment`. The
key is not.

The two address variables sit next to `KEEPER_PRIVATE_KEY` in every command below, so a key can land in the
wrong one. Neither `KEEPER_UNLOCKED_ADDRESS` nor `KEEPER_DRAW_ADDRESS` is ever echoed when its value is
rejected: the refusal names the variable and how many characters it received, never the characters, because
`main` prints that message as `refused_to_start` to a terminal and often to a file.

Supply `KEEPER_PRIVATE_KEY` from the operator's own shell for a **dedicated, low-balance keeper key** — never
the owner Safe, never the seed Safe, never the fee account, never the VRF subscription owner (SPEC §10.2,
§10.5). Do not put it in a file in this repository, in a shell rc file, or in a process argument. The key is
never placed in the configuration object, so nothing a log line or an error message can reach ever holds it;
`src/config.test.ts` asserts that.

Start-up refuses, in this order:

1. both or neither signing mode set;
2. the manifest is missing, unparseable, or records a different chain id or Draw address than the environment;
3. `KEEPER_PRIVATE_KEY` against a manifest whose `environment` is `local`;
4. on chain 56, a manifest that names **any** mock: a labeled mock artifact in `mocks`, `vrf.coordinatorIsMock`,
   an asset's `isMock` or a price record's `feedIsMock`. `parseManifest` already refuses those when the
   manifest's own `environment` says `testnet` or `mainnet`; this gate keys on the **chain id** instead,
   which is what catches a manifest still labelled `local` — a copy of an anvil run, or a file an older
   script wrote — whose `chain.chainId` has been changed to 56. The keeper is the component that acts, so it
   is the one that must not seed, close and settle rounds priced by a mock feed against customer deposits;
5. a raw `eth_chainId` request differs from `KEEPER_CHAIN_ID` or from the manifest chain id (SPEC §12: "every service asserts
   eth_chainId equals the manifest chainId at start-up"). The gate sends that request itself and refuses an
   answer that is not a hex quantity, and `verifyDeployment` is handed the same raw answer for its own chain
   check. Neither may use `provider.getNetwork()`: the provider is built with `staticNetwork: true` — which is
   what stops ethers re-detecting the network before every call — and a static network answers `getNetwork`
   from `KEEPER_CHAIN_ID` without a request, so both checks would be comparing the configuration with itself
   and an RPC URL pointed at the wrong chain would pass them;
6. `verifyDeployment` fails — no code, a code hash that differs from the manifest's, or a broken Vault/Draw
   binding (SPEC §15).

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `KEEPER_RPC_URL` | yes | — | JSON-RPC endpoint |
| `KEEPER_CHAIN_ID` | yes | — | must equal the manifest's and the node's |
| `KEEPER_DRAW_ADDRESS` | yes | — | lowercase; selects `config/deployments/<chainId>/<address>.json` |
| `KEEPER_UNLOCKED_ADDRESS` | one of the two | — | node-held account (local anvil) |
| `KEEPER_PRIVATE_KEY` | one of the two | — | dedicated low-balance keeper key (non-local); under systemd the `keeper-private-key` credential replaces it |
| `KEEPER_INTERVAL_MS` | no | `15000` | cycle period |
| `KEEPER_LOG_WINDOW` | no | `2000` | blocks per `eth_getLogs` page |
| `KEEPER_DRY_RUN` | no | off | `1` simulates everything and sends nothing |
| `KEEPER_HEARTBEAT_URL` | no | — | dead-man's-switch ping after every healthy cycle; unset sends nothing |
| `KEEPER_HEARTBEAT_METHOD` | no | `GET` | `GET` or `POST`; `POST` carries a small JSON cycle summary |
| `KEEPER_ALERT_WEBHOOK` | no | — | where alerts are POSTed as JSON; unset sends nothing |
| `KEEPER_DEPLOYMENTS_DIR` | no | `<repo>/config/deployments` | manifest tree root; only for tests and for a manifest outside the repository |
| `KEEPER_CHAINS_DIR` | no | `<repo>/config/chains` | chain-record root; where Multicall3 is read from |

`KEEPER_HEARTBEAT_URL` and `KEEPER_ALERT_WEBHOOK` are **credentials** — for most monitors and for every chat
webhook the token *is* the path — so they are validated (absolute `http(s)` only), never echoed when
rejected (the refusal says how many characters it received), and covered by the same log redaction as
`KEEPER_RPC_URL`. The `started` line says only `heartbeat=GET|POST|off` and `alerts=on|off`.

Logs are one line per decision, `key=value`, on stdout:

```
ts=2026-09-15T13:53:34.175Z level=info event=action_sent round=1 state=AwaitingRequest action=requestDraw tx=0x55cb… gas=419552
ts=2026-09-15T13:53:32.045Z level=warn event=action_skipped round=9 state=Open action=seedRound skip=AlreadySeeded
ts=2026-09-15T13:53:47.061Z level=info event=action_deferred round=1 state=AwaitingRequest action=requestDraw skip=InFlight
ts=2026-09-15T13:54:02.418Z level=warn event=action_skipped round=7 state=Open action=closeRound skip="SendFailed:nonce has already been used"
ts=2026-09-15T13:54:02.420Z level=warn event=refund_buyers_incomplete round=4 state=Refunding buyers=1 refundedGross=50 grossTotal=100 rescan=true
ts=2026-09-16T00:12:41.903Z level=info event=subscription subscription=1234… nativeBalanceWei=2000000000000000000 thresholdWei=1000000000000000000 low=false
ts=2026-09-16T00:14:10.552Z level=info event=draw_cost round=12 keeperGasWei=590000000000000 vrfPaymentWei=250000000000000 requestId=777
```

No log line can carry the RPC endpoint. An operator RPC URL usually *is* a credential — the API key sits in
its path or query — and ethers quotes the request URL inside the message of a provider error, which the keeper
prints verbatim as `refused_to_start`, `cycle_failed`, `fatal` or an undecodable skip reason. Every string a
log line formats therefore has any absolute `http(s)://…` replaced with `<rpc>`; `src/main.test.ts` proves it
against a real ethers error rather than a hand-written string.

`SIGINT` (and `SIGTERM`) finish the cycle in flight and exit cleanly. An RPC failure in one cycle is logged and
the loop continues; ten consecutive failed cycles exit non-zero.

## Heartbeat and alerts

Both are off until the operator sets a URL, and neither can affect a decision: every request is started and
never awaited by the cycle, carries a 5-second `AbortSignal.timeout`, and can only ever produce another log
line. A monitor that is down, slow or misconfigured cannot delay a `closeRound`.

**Heartbeat** (`KEEPER_HEARTBEAT_URL`) is sent once after each cycle that *completed* — every skip in the
decision table is a decision, so only a cycle that threw is unhealthy and silent. Two missed pings is what a
dead-man's-switch monitor should alert on, independently of this host's own alerting (SPEC §10.3). `GET` by
default; `KEEPER_HEARTBEAT_METHOD=POST` sends `{"ok":true,"block":…,"tracked":…,"pools":…}`.

**Alerts** (`KEEPER_ALERT_WEBHOOK`) are POSTed as
`{"text": "<one line>", "cause": "<cause>", "detail": {…}}` — the `text` is what a chat webhook renders.
Rate-limited to **one alert per cause per hour**: these conditions hold for every round of every pool on
every cycle, so without the limit an unauthorized seed account would page the operator four times a minute
forever. The condition itself is still logged every cycle it holds; a suppressed alert adds no line, a sent
one adds `event=alert_sent cause=…`.

**The hour is per process, not per cause.** The limiter is in memory, so a cause that outlives the process
pages again as soon as the process is new. For the one cause that exits — `consecutive_cycle_failures` —
that is not theoretical: ten failed cycles at a 15-second interval take about 2.5 minutes, the unit exits,
`Restart=on-failure` with `RestartSec=30` starts it again, and a cause that is still true pages again about
**three minutes later, indefinitely** — roughly 20 pages an hour, not one. The other four causes do not exit
the process, so they do keep to one an hour while it runs. Nothing here is persisted on purpose (a keeper
that writes no file is what `ProtectSystem=strict` buys); the operator-facing consequence is that a paging
policy must treat a repeating `consecutive_cycle_failures` as one incident, not one incident per page.

Every string in an alert body — and in a `POST` heartbeat body — is passed through the same `<rpc>`
redaction the logs use, because the fields carry node error messages and an operator RPC URL usually *is* a
credential.

| Cause | Raised when | Also logged as |
|---|---|---|
| `consecutive_cycle_failures` | the tenth consecutive failed cycle, immediately before the process exits non-zero | `cycle_failed`, then `fatal` |
| `request_precheck_failed` | a `requestDraw` **simulation** reverted: the key hash is no longer registered, or the subscription cannot cover `(pending + 1) × maxRequestCostNative` | `request_precheck_failed` |
| `SeedNotAuthorized` | the seed account has not authorized this asset for at least `seedAmount`, so rounds are running unseeded | `round_idle skip=SeedNotAuthorized` |
| `InsufficientSeedBalance` | the seed account's Vault balance no longer covers a seed | `round_idle skip=InsufficientSeedBalance` |
| `subscription_below_threshold` | `getSubscription(subId).nativeBalance < vrf.lowFundingThresholdNative` | `subscription … low=true` |

A **failed send** never raises `request_precheck_failed`: a nonce gap or a socket timeout says nothing about
the key hash or the subscription, and paging somebody for it would train them to ignore the alert that
matters.

The subscription balance is read from the coordinator at most every **5 minutes**, pinned to the cycle's
snapshot block. It is a warning to top up, not a safety mechanism — SPEC §6.2's own pre-check is what
actually refuses a request the subscription cannot pay for — so a coordinator that does not answer
`getSubscription` is `event=subscription_check_failed` and the cycle carries on. The alert fires only on a
balance that was actually read and was actually low.

On the ten-failure exit the process drains the notifier before calling `process.exit`, so the alert is on the
wire before the process is gone.

## Cost meter

`release.shakedown.costPerDrawNativeWei` in the deployment manifest has to be filled from a real draw, so per
settled round the keeper logs:

```
event=draw_cost round=<id> keeperGasWei=<wei> vrfPaymentWei=<wei|null> requestId=<id|null> [lostReceipts=<n>] [note=<reason>]
```

* `keeperGasWei` is `gasUsed × effectiveGasPrice` summed over **every transaction this process sent for that
  round** — seed, close, request and settle — read from each receipt. Never from the padded gas limit
  (`estimate × 1.3`), which is an upper bound and not a cost.
* `vrfPaymentWei` is `payment` from the coordinator's `RandomWordsFulfilled` (SPEC §7.1), found by the
  `requestId` the keeper's own `requestDraw` receipt carries in `DrawRequested` and searched for from that
  block forward on the coordinator's address.

Both are best effort and say so rather than guessing, because a number that is missing can be recovered from
the explorer and a number that is quietly wrong ends up in the manifest. `note` names the reason there is no
payment: `RequestNotObserved` (a restart, or somebody else — the app can call `requestDraw` too — sent it),
`FulfilmentNotFound` (which is also what a **local anvil run** reports, because the labeled mock coordinator
emits a shorter, differently-hashed `RandomWordsFulfilled` with no `payment` at all),
`FulfilmentSearchFailed:<message>`, or `FulfilmentSearchDisabled`. `lostReceipts` appears when the node never
produced a receipt for one of the keeper's transactions within 10 minutes, so the total is known to be short.

Like everything else this process keeps, it is memory: a restart loses the sends whose receipts it had not
collected, and those rounds report nothing rather than something wrong.

## Chain record and Multicall3

`config/chains/<chainId>.json` is read once at start-up and `networkIdentity.multicall3`, when it is not
null, batches the cycle's reads (SPEC §10.1). The reads are **grouped** into three `aggregate3` calls, not
one per adapter (`src/reads.ts`):

| Stage | Calls in the batch |
|---|---|
| 1 | `getPools(0, 100)` and `getSeedAccount()` |
| 2 | per pool: `seedMaxPerRound` and `balanceOf` for its asset, and `getCurrent` for the seven kinds |
| 3 | `getRound` for every tracked round |

The discovery pass adds, on the cycles it runs, one batch for `roundCount()` and one per page of
`DISCOVERY_PAGE_SIZE` `getRound` calls.

Grouping is the whole point of the address: a one-item `aggregate3` is one `eth_call`, so a cycle built from
the client's per-call adapters would send the same number of requests with Multicall3 as without it. Measured
on the two-pool, six-round fixture in `src/keeper.test.ts`, one cycle is **8 requests with Multicall3 against
23 without** (`eth_call` plus the block reads a snapshot costs), and the gap widens with every pool. Public
BSC endpoints rate-limit exactly the unbatched shape, and a throttled cycle is a round that closes late.

A missing record, or a null `multicall3` (which is what `config/chains/56.json` carries until the operator
verifies the address against the live chain), is not an error: the keeper runs unbatched — the same three
batches, as individual `eth_call`s — and the `started` line says `multicall3=none`. A record **for another
chain** *is* an error, because the address inside it is a contract on a different network, and a `chainId`
that is not a number is refused as that rather than compared.

A configured Multicall3 is **verified at start-up** like the Vault and the Draw are (gate 6): it must have
code, and it must answer one real `aggregate3` probe through the same `readBatch` the cycles use. Without
that gate one transposed character in the record passed start-up and then failed every cycle forever —
`Restart=on-failure` brings the unit straight back, so the keeper would never close another round. The
refusal names Multicall3, the file the address came from, and the option of setting it to null.

## Running it

Three commands from the operator's own shell, with the key never leaving it:

```bash
npx pnpm@12.3.4 install
read -rs KEEPER_PRIVATE_KEY && export KEEPER_PRIVATE_KEY   # typed, not echoed, not stored
KEEPER_RPC_URL="$LUCKYDRAW_OPS_RPC_URL" KEEPER_CHAIN_ID=56 KEEPER_DRAW_ADDRESS=0x<lowercase draw> \
  npx pnpm@12.3.4 --filter @luckydraw/keeper start
```

Prefix the third command with `KEEPER_DRY_RUN=1` for a rehearsal: every call is still simulated and logged,
and nothing is sent. The key is needed even then, because start-up requires exactly one signing mode and the
simulation needs the keeper's `from` address — but it is only ever used to derive that address. Fund the
address with a small gas balance and nothing else, and give it no other role.

Against local anvil, after `contracts/README.md`'s `DeployLocal` → `Finalize` → `Verify`:

```bash
KEEPER_RPC_URL=http://127.0.0.1:8545 KEEPER_CHAIN_ID=31337 \
KEEPER_DRAW_ADDRESS=0x<lowercase draw> KEEPER_UNLOCKED_ADDRESS=0x15d34aaf54267db7d7c367839aaf71a00a2c6a65 \
KEEPER_INTERVAL_MS=2000 npx pnpm@12.3.4 --filter @luckydraw/keeper start
```

## Running it under systemd

`keeper/deploy/` holds the unit and the environment template. Nothing in either file is a secret, and the
signing key is in neither: it reaches the process through a systemd credential.

```bash
# 1. an account that owns nothing, has no home and cannot log in
sudo useradd --system --no-create-home --shell /usr/sbin/nologin luckydraw-keeper

# 2. the signing key, root-owned and unreadable by anyone else
sudo install -d -m 0700 -o root -g root /etc/luckydraw
sudo install -m 0600 -o root -g root /dev/null /etc/luckydraw/keeper-private-key
sudo sh -c 'read -rs KEY && printf "%s" "$KEY" > /etc/luckydraw/keeper-private-key'   # typed, not echoed

# 3. the configuration, likewise root-owned: it holds the RPC, heartbeat and alert URLs
sudo install -m 0600 -o root -g root keeper/deploy/luckydraw-keeper.env.example /etc/luckydraw/keeper.env
sudo "$EDITOR" /etc/luckydraw/keeper.env        # replace every <...> placeholder

# 4. the built JavaScript: the unit runs `node --jitless dist/keeper/src/main.js`, not src/main.ts
npx pnpm@12.3.4 --filter @luckydraw/keeper build      # repeat after every git pull

# 5. the unit; edit WorkingDirectory, ExecStart and User if your paths differ
sudo install -m 0644 keeper/deploy/luckydraw-keeper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now luckydraw-keeper
journalctl -u luckydraw-keeper -f
```

### Jitless on hardened hosts

The unit runs `node --jitless dist/keeper/src/main.js`. Both halves of that are load-bearing on an
SELinux-enforcing host (found on Oracle Linux 9.7 aarch64, Node v24.21.0, 2026-09-18). The exact strings, so
the next operator can grep for them:

| What you see | Why | What fixes it |
| --- | --- | --- |
| `# Fatal error in , line 0` / `# Check failed: 12 == (*__errno_location ()).`, a SIGTRAP inside `node::NewIsolate`, while the same binary starts fine in an interactive shell | V8 cannot get its JIT/code-range mapping inside the unit's SELinux domain, with `NoNewPrivileges` and the rest of the sandbox | `--jitless`. A keeper spends its time waiting on sockets, so it costs nothing |
| `ERR_WEBASSEMBLY_NOT_SUPPORTED` from `src/main.ts` | jitless Node has no WebAssembly, and Node's TypeScript type stripping needs it | run the built JavaScript: `pnpm --filter @luckydraw/keeper build`, then `dist/keeper/src/main.js` |
| `refused_to_start reason="eth_chainId could not be read: "` — an empty reason | Node's global `fetch` is undici, whose HTTP parser is a WebAssembly module, so ethers' `FetchRequest` failed with a `TypeError: fetch failed` whose real explanation (`WebAssembly is not defined`) was in `cause` and not in `message` | fixed in the keeper: `src/transport.ts` registers a `node:https` transport for every request, and the reason now falls through to the cause when the message is empty |
| a refusal naming a manifest path with `dist` in it | — | fixed: the keeper finds the checkout root by walking up to `pnpm-workspace.yaml`, so `src/` and `dist/` resolve the same `config/` tree. Only a `dist/` deployed without the workspace file above it needs `KEEPER_DEPLOYMENTS_DIR` |

`src/transport.ts` is installed unconditionally, not behind a flag: the transport the operator's host runs is
then the one the tests and the local dry-run exercise, and undici's behavioural differences leave the picture
entirely. It is also what the heartbeat and the alert webhook go through, for the same reason — under the
global `fetch` a jitless host would log `heartbeat_failed` every cycle, which is a dead man's switch that is
itself dead. It never puts the request URL into an error message; the worst it can surface is what `node:net`
says, a host and a port.

`LoadCredential=keeper-private-key:/etc/luckydraw/keeper-private-key` makes systemd copy the file into a
per-invocation tmpfs readable only by the service user and export that directory as `$CREDENTIALS_DIRECTORY`;
`src/credentials.ts` reads `$CREDENTIALS_DIRECTORY/keeper-private-key`. **That is the whole point of the
unit**: the key is then in no process argument (`ps`), no environment (`/proc/<pid>/environ`,
`systemctl show -p Environment`), no shell history, no rc file and no log line. Putting `KEEPER_PRIVATE_KEY`
into the `EnvironmentFile` instead would defeat every one of those; the template says so too.

`CREDENTIALS_DIRECTORY` is set for *any* `LoadCredential=`, so its presence alone is not taken as proof: the
keeper uses the credential when the **file** exists and falls back to `KEEPER_PRIVATE_KEY` otherwise. An
empty credential file is a refusal, never a silent fallback to whatever the environment holds.

The hardening in the unit: `User=`/`Group=` (an unprivileged, non-login system account), `NoNewPrivileges`,
`ProtectSystem=strict` (the keeper writes no file at all), `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
`ProtectProc=invisible`, `ProtectClock`, `ProtectHostname`, `ProtectKernelTunables`/`Modules`/`Logs`,
`ProtectControlGroups`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`,
`RemoveIPC`, an empty `CapabilityBoundingSet`, `SystemCallArchitectures=native`,
`SystemCallFilter=@system-service` and `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK`
(outbound HTTPS only, no listening socket, no private network namespace). `MemoryDenyWriteExecute` is
deliberately **not** set: V8 maps its JIT pages writable and then executable, so it would kill the process at
startup. `MemoryHigh=384M`, `MemoryMax=512M` and `TasksMax=64` turn a leak into a restart rather than an OOM
on the host.

`Restart=on-failure` with `RestartSec=30` and **no** start rate limit (`StartLimitIntervalSec=0`): the
ten-failure exit is usually an RPC outage that outlasts five minutes, and a burst limit would make systemd
give up permanently and stop the rounds. A refusal to start loops too, visibly, as a repeating
`refused_to_start` line. The same loop is what makes a persistent failure page about every three minutes
rather than once an hour (see [Heartbeat and alerts](#heartbeat-and-alerts)): the alert limiter dies with
the process. `SIGTERM` finishes the cycle in flight, drains a pending heartbeat and exits
cleanly.

## Development

```bash
npx pnpm@12.3.4 --filter @luckydraw/keeper typecheck
npx pnpm@12.3.4 --filter @luckydraw/keeper test
LUCKYDRAW_ANVIL=1 npx pnpm@12.3.4 --filter @luckydraw/keeper test   # also runs the anvil journey
npx pnpm@12.3.4 --filter @luckydraw/keeper build
```

Like `packages/client`, the sources run directly under Node's type stripping, so they stay inside the erasable
syntax subset and relative imports carry the `.ts` extension. `@luckydraw/client` publishes itself through an
exports map pointing at a gitignored `dist/`, so `src/client.ts` re-exports the client's **sources** by
relative path instead — one file, no `paths` alias and no `--import` loader, and `typecheck`, `test` and
`start` all work without ever building the client. The consequence is that `build` compiles the client's
sources too, so `tsconfig.build.json` sets `rootDir: ".."` and the output lands at `dist/keeper/src/` beside
`dist/packages/client/src/`.

The anvil journey (`src/e2e/anvil.test.ts`) reuses the client's process harness unchanged: it starts a
throwaway anvil on a free port, runs `DeployLocal` and `Finalize` into
`contracts/test/script/tmp/<run>/`, starts this keeper in unlocked mode against the manifest they wrote, makes
two player entries, warps past the UTC cutoff, and asserts the keeper seeds, closes, requests, settles (with
the labeled mock coordinator's `fulfill` played by the test, since real delivery is asynchronous) and credits
a single-player successor round's refund. It also runs the cost meter against the real node, so
`parseReceipt` is fed anvil's own `eth_getTransactionReceipt` answer and the settled round's `draw_cost`
line is asserted (with `vrfPaymentWei=null note=FulfilmentNotFound`, because the labeled mock coordinator's
same-named event has a different signature and carries no payment). It asserts `config/deployments/31337` is
unchanged byte for byte.

## Deferred

Everything below is SPEC §10.2 / §12.1 production keeper work this one deliberately does **not** do. None of
it is scheduled here.

* **Backup instance.** A second keeper with its own key on an independent host, acting only when an eligible
  action has waited more than 120 seconds, plus the leased lock (PostgreSQL advisory lock or equivalent) that
  makes exactly one instance active per key.
* **Chainlink Automation upkeep.** The third executor: a `LuckyDrawUpkeep` contract with no funds and no
  privileged role, registered as a custom-logic upkeep.
* **The rest of the alert table.** Five of the §10.3 signals exist (see [Heartbeat and alerts](#heartbeat-and-alerts));
  still missing are oldest Drawing/Ready age, delayed cutoff action, RPC health, PriceStale rate, the
  per-signal severity and owner columns, and the on-chain monitor that alerts on keeper transactions outside
  the Draw target/selector allowlist.
* **Gas policy.** EIP-1559 type 2 with `maxPriorityFeePerGas = max(node suggestion, configured floor)` and a
  configured `maxFeePerGas` ceiling, replacement of a transaction not included within 60 seconds at the same
  nonce with a fee at least 12.5% higher, and the alert when the ceiling is reached. This keeper only pads and
  caps the gas *limit* (`estimate x 1.3`, capped at 600,000) and lets the node choose fees.
* **Simulate-before-send with a policy.** This keeper simulates and skips, and suppresses an identical repeat
  while the first send is unmined. The production one additionally backs every failed `(round, action)` pair
  off exponentially from 30 seconds to 10 minutes and raises a warning after three consecutive failures, and
  keeps a 20-action-per-cycle budget with fair round-robin scheduling across pools so no pool starves.
* **Restart and reorg handling.** A persisted cursor and in-flight transaction set, reconciliation of persisted
  hashes against receipts and the pending nonce before any send, never reusing a nonce whose outcome is
  unknown, and consecutive nonces sent without awaiting receipts. This keeper keeps everything in memory. It
  no longer loses sight of older unresolved rounds across a restart — the discovery scan above rebuilds that
  set from `roundCount()` and `getRound` — but its in-flight set is memory, so a restart can re-send an action whose first
  transaction is still pending (the duplicate reverts, costing gas, never funds), and it holds no transaction
  hashes to reconcile against receipts. It also awaits each send, so it is slower under load.
* **Extra cycle at 00:00:01 UTC**, and the 30-day gas budget with refill-on-alert. (The systemd unit with
  credential key custody in `keeper/deploy/` is no longer deferred; see
  [Running it under systemd](#running-it-under-systemd).)
