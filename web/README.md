# `@luckydraw/web`

The LuckyDraw web app: a static React/TypeScript build with no server session and no keys (SPEC §9). This
wave is the foundation — wallet connection, the network guard, the app shell, the deployment and read
context, the transaction state machine, the string catalog, the design tokens and the base components. The
routed pages are placeholders that two follow-on builders replace.

Everything money-related comes from `@luckydraw/client`: the ABIs, the bigint types, the read adapters, the
calldata builders, the revert decoder and the §9.6 string catalog. Nothing in `web/` re-implements any of it,
and nothing here does floating-point arithmetic on an amount.

## Running it

```bash
# From the repository root.
npx pnpm@12.3.4 install
npx pnpm@12.3.4 --filter @luckydraw/web dev       # http://localhost:5173
npx pnpm@12.3.4 --filter @luckydraw/web test
npx pnpm@12.3.4 --filter @luckydraw/web build     # tsc --noEmit, then vite build into web/dist
npx pnpm@12.3.4 --filter @luckydraw/web preview
```

The root `npx pnpm@12.3.4 lint | typecheck | test | build` are recursive and already cover this package; CI
runs them in the `client` job.

### Against a local anvil

`contracts/README.md` has the full flow; the short version:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
anvil --port 8545 --chain-id 31337 &
cd contracts
M=../config/deployments/31337/local.plan.json
forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 --broadcast ...
# Finalize writes config/deployments/31337/<lowercase draw address>.json
```

A fresh anvil with the default mnemonic reproduces the committed addresses, so the checked-in
`config/deployments/31337/0x610178da211fef7d417bc0e6fed39f05609ad788.json` usually matches a fresh local
deploy and needs no regeneration. Point the app at it and start:

```bash
cd web && npx pnpm@12.3.4 dev
```

## Environment

| Variable | Meaning |
|---|---|
| `VITE_LUCKYDRAW_CHAIN_ID` | Decimal chain id. With the address below it selects `config/deployments/<chainId>/<address>.json`. |
| `VITE_LUCKYDRAW_DRAW_ADDRESS` | Lowercase Draw address; it is the manifest's file name (SPEC §12). |
| `VITE_LUCKYDRAW_RPC_URL` | Public read RPC. One or more, whitespace- or comma-separated; the first is used for reads and every origin is admitted by the CSP. **No credentials and no query string**: this value ships to every visitor and `wallet_addEthereumChain` hands it to the wallet verbatim, so a keyed endpoint would be published twice over. Both are refused at parse time (SPEC §10.4). |
| `VITE_LUCKYDRAW_BLOCK_POLL_MS` | Optional. How often the head is polled. Default 3000 (SPEC §10.1 keeps an idle tab under 30 requests a minute). |
| `VITE_LUCKYDRAW_JURISDICTION_NOTICE` | The operator's jurisdiction sentence (SPEC §14), rendered as plain text — never as HTML — on the help and verify pages and next to the entry panel. Optional on 31337 and 97; **required and non-empty on chain 56**, where the build refuses without it. |

Each of these is also accepted under its un-prefixed name (`LUCKYDRAW_CHAIN_ID`, `LUCKYDRAW_DRAW_ADDRESS`,
`LUCKYDRAW_RPC_URL`, `LUCKYDRAW_JURISDICTION_NOTICE`), which is what the GitHub repository variables are
called; the `VITE_` spelling wins and two spellings that disagree are refused.

`web/.env.example` holds the local anvil defaults **and is the committed default**: `vite build` and
`vite dev` fall back to it variable by variable, so a clean checkout builds with no setup. Copy it to
`web/.env` (untracked) to point at chain 56 or a local chain — `web/.env.mainnet.example` is the chain 56
form. That fallback is all-or-nothing: once a build asks for any chain but 31337, the chain id, the Draw
address and the RPC URL must all come from the environment, so a half-set configuration can never publish a
"chain 56" page pinned to the anvil contract. The build fails loudly — in `buildStart`, before a single
module is transformed — when the pair does not name a manifest that exists, when the address is not
lowercase, when the manifest's own `deploymentId` disagrees, or when there is no chain record for the chain.

### The chain 56 release gate

A build with chain id 56 is a publication to real customers, so `src/lib/build/releaseGate.ts` decides
whether it may proceed and `vite.config.ts` enforces the decision with a non-zero exit and one reason line
(SPEC §14, ADR 034). It refuses unless the selected manifest exists and is `environment: "mainnet"`, flags no
mock anywhere (`isMock`, `coordinatorIsMock`, `feedIsMock`), sets `release.customerLaunch: true` — an absent
`release` means false — and `node scripts/validate_config.ts` passes, and unless the jurisdiction sentence is
non-empty. Chain 31337 keeps its local fallback and chain 97 is unchanged. The decision is a pure function
over parsed JSON, so every branch of it is unit-tested in `src/lib/build/releaseGate.test.ts`.

Note a deliberate departure from the brief's wording: `config/chains/<chainId>.json` carries **no** RPC URL,
only the *name* of the variable that should hold one (`rpcEnvVars.public`). `VITE_LUCKYDRAW_RPC_URL` is
therefore required rather than an override, and the app says so when it is missing. Everything else the brief
expected from the chain record is there and is used: `explorerUrl`, `nativeSymbol`, `confirmationDepth`,
`finalityTag` and `networkIdentity.multicall3`.

## Module map

```
web/
  index.html                     CSP meta tag; connect-src written at build time from the RPC origins
  vite.config.ts                 client-source alias, deployment guard, CSP plugin, vitest config
  src/
    main.tsx                     entry; no inline script anywhere
    app/
      App.tsx                    provider composition (theme > deployment > block > wallet) and the router
      AppShell.tsx               banner, top nav, thumb-reach bottom bar, theme toggle, NetworkGuard, outlet
      ErrorBoundary.tsx          render failures, with the honest funds statement
    pages/
      pages.tsx                  the routed pages; `/verify` and `/help` are real (minimal), the rest placeholders
      Placeholder.tsx            the shared placeholder body and the live `DeploymentProbe`
    components/                  Button, Card, Skeleton, EmptyState, ErrorState, AssetBadge, StateBadge,
                                 AccountChip, Identicon, WalletButton, ConnectModal, NetworkGuard,
                                 DataFreshness, TxStepper, TxToast, TxLiveRegion (barrel: components/index.ts)
    lib/
      config/env.ts              parses and validates the VITE_ variables
      deployment/records.ts      loads config/deployments and config/chains at build time (import.meta.glob)
      deployment/provider.ts     ethers JsonRpcProvider + the client's ReadProvider / VerifyProvider adapters
      deployment/DeploymentProvider.tsx   verification, ReadContext, `useDeployment()`
      data/BlockProvider.tsx     one head poller and one 1 Hz monotonic ticker for the whole app
      data/useSnapshot.ts        the block-keyed read cache
      wallet/types.ts            Connector and the EIP-1193 surface
      wallet/eip6963.ts          announcement discovery
      wallet/connectors.ts       ordering, badging, the install/deep-link entry, session reads
      wallet/errors.ts           WalletError and the 4001 / 4902 / 4900 classification
      wallet/WalletProvider.tsx  `useWallet()`: session, events, network guard
      wallet/useWriteGate.ts     `useWriteGate()`
      wallet/useSigner.ts        `useSigner()`
      tx/types.ts                phases, steps, failures, and the narrow chain interfaces
      tx/machine.ts              `runWrite` / `resumeIntent`: the whole state machine, React-free
      tx/failure.ts              revert and wallet error -> the §9.6 message / funds / next action
      tx/intent.ts               the pending intent in session storage
      tx/ethersAdapters.ts       the only place ethers meets the machine
      tx/useTransaction.tsx      `useTransaction()`
      theme/ThemeProvider.tsx    system / light / dark, stored locally
    strings/en.ts                every app string; the §9.6 catalog stays in @luckydraw/client
    styles/tokens.css            the design tokens of §9.3
    styles/app.css               layout and every component state
    test/harness.tsx             a verifiable synthetic deployment, a fake EIP-1193 wallet, a render helper,
                                 and `Providers`: the same stack as a component, so a test can rerender it
```

## The contracts the page builders consume

Import components from `../components/index.ts` and hooks from their own modules.

### Deployment and reads

```ts
useDeployment(): {
  manifest: DeploymentManifest;       // parsed by the client's parseManifest; every integer a bigint
  chain: ChainRecord;                 // chainId, name, nativeSymbol, explorerUrl, confirmationDepth,
                                      // finalityTag, multicall3, publicRpcEnvVar
  environment: "local" | "testnet" | "mainnet";
  env: WebEnv;                        // the build's VITE_ values
  provider: JsonRpcProvider;          // the app's read provider, pinned network, never probes
  status: "verifying" | "ready" | "failed";
  verified: VerifiedDeployment | null;    // only verifyDeployment produces one; writes require it
  verifyFailure: VerifyFailure | null;
  verifyFailureText: string | null;       // one user-showable sentence
  readCtx: ReadContext | null;            // null until verified; pass it to any client read adapter
  retryVerification(): void;
}
```

`readCtx` pins the snapshot tag: `latest` on chain 31337 (anvil reports `finalized` as block 0), the §10.1
`finalized -> safe -> depth` walk elsewhere, with `multicall3` from the chain record when it has one.

**The chain-id assertion reaches the node.** The read provider is built with `staticNetwork`, which makes
`provider.getNetwork()` answer out of the pinned `Network` object with no request at all. Both adapters in
`lib/deployment/provider.ts` therefore send `eth_chainId` themselves and parse the hex quantity; anything else
would hand `verifyDeployment` the chain id the manifest already claims and the SPEC §12 assertion would be
comparing the manifest with itself. The test harness's `fakeNode` has no `getNetwork` for the same reason: the
only way for a double to answer the assertion is over the wire.

```ts
useSnapshot<T>(key: string, readFn: (ctx: ReadContext) => Promise<Snapshot<T>>, options?: {
  deps?: readonly unknown[];   // what the read asks for; a change drops the cached snapshot
  enabled?: boolean;
  pinBlock?: boolean;          // default true: share the epoch's block; false for a head-of-chain read
}): {
  status: "idle" | "loading" | "ready" | "error";
  snapshot: Snapshot<T> | null;   // identity is stable while the block hash is unchanged
  value: T | null;                // the last good value, kept while a later read fails
  error: Error | null;
  refresh(): void;
}
```

Runs once per new block. A read that comes back at the same block hash does **not** replace the snapshot, so
memoize on `snapshot` (or `snapshot.blockHash`) and your list will not re-render (SPEC §9.3).

Every read in one block epoch is handed the same already-resolved block on `ctx.block`, so two panels on one
page cannot sit under one freshness label while reading two different blocks (SPEC §10.1 "Related direct
reads use one blockTag"). The block is resolved with the context's own tag policy. Pass `pinBlock: false` for
a read whose value has to come from the head rather than from the displayed block — an entry quote, a
withdraw amount — so the client's own `actionBlockOf` applies (SPEC §9.6: buy, withdraw and claim act on the
latest on-chain state). On a chain whose `ReadContext` already pins `tag: "latest"` — 31337 — the two are the
same block and the flag changes nothing.

A read that becomes disabled (`enabled: false`, or a null `readCtx`) resets to `idle` with a null snapshot,
so a disconnected account's balance cannot keep rendering (SPEC §9.2 "Disconnect clears account-sensitive
caches and queries").

`useBlock()` gives `{blockNumber, blockEpoch, error, refresh, tickMs}`; `useSecondsTick()` is the single 1 Hz
monotonic ticker every countdown must use (never `Date.now()` deltas).

### Wallet

```ts
useWallet(): {
  status: "disconnected" | "connecting" | "connected";
  account: Address | null;            // lowercase
  chainId: bigint | null;             // the wallet's chain, not necessarily the deployment's
  connector: Connector | null;
  connectors: readonly Connector[];   // MetaMask first, then detected wallets by name
  accountEpoch: number;               // key every account-scoped cache on this
  error: WalletError | null;
  target: WalletTarget;
  onDeploymentChain: boolean;
  connect(connectorId: string): Promise<void>;
  disconnect(): void;
  switchToDeploymentChain(): Promise<void>;   // switch, then add as the fallback
  clearError(): void;
}

useWriteGate(): {
  allowed: boolean;
  code: "ok" | "deploymentVerifying" | "deploymentUnverified" | "disconnected" | "wrongChain";
  reason: string | null;       // one sentence, from the client catalog where §9.6 defines it
  nextAction: string | null;
}

useSigner(): {
  ready: boolean;
  requestSigner(expectedAccount: Address): Promise<JsonRpcSigner>;   // refuses any other account
}
```

Every control that moves funds must read `useWriteGate()` and pass `reason` to `<Button disabledReason=…>`.
Every write must pass the account its quote was read for; the signer refuses a mismatch (SPEC §9.5).

Four things the wallet layer does that are not visible in those signatures:

- **the provider behind a connection is fixed for the life of that session.** EIP-6963 discovery keeps the
  *first* announcement for an `rdns` and ignores later ones, and if the provider object behind the connected
  id changes identity anyway, the session ends with a "reconnect before signing" error rather than signing
  through the newcomer. A connector that *vanishes* from the list ends the session the same way: the generic
  `window.ethereum` entry exists only while nothing has announced itself, so a wallet announcing a moment
  after the user connected through it used to leave `status` at "connected" with a null connector — no event
  listeners, no signer, and a chip still showing an address nothing was watching;
- **"Recommended" is the exact rdns `io.metamask`, never a prefix.** `rdns` is self-declared, so a prefix
  match let anything announcing `io.metamask.*` take the Recommended row *and* filter the real MetaMask out
  of the list. Flask, Institutional and anything else in that namespace list as ordinary detected wallets
  under their own names, and every row shows its rdns under the name so two "MetaMask" entries are
  distinguishable;
- **wallet-authored text is never the app's sentence.** `error.message` is written by a browser extension.
  `ConnectModal`, `NetworkGuard` and `TxStepper` show the app's own line first ("Your wallet reported an
  error.") and the wallet's words underneath, labelled "Wallet said:" and capped at 200 characters
  (`walletSaid` in `lib/wallet/errors.ts`; `TxFailure.walletText` carries it through the state machine);
- **`requestSigner` asks the wallet for `eth_chainId` every time**, immediately before building the signer,
  and refuses with the §9.6 `WrongChain` message when it disagrees with the deployment. The write gate reads
  React state, which only moves when the wallet emits `chainChanged`; this does not.

Disconnecting, and an account change to a different address, clear the pending transaction intent in session
storage along with the session (SPEC §9.2 "Disconnect clears account-sensitive caches and queries").
`useTransaction` reattaches to a persisted intent on the first *settled* session, never while the account is
still null, so one tab's transaction cannot be shown to whoever connects next.

The stored intent is **untrusted input**: session storage is writable by anything in this origin. Every field
is shape-checked on the way back in (address and 32-byte-hash regexes, even-length hex `data`, decimal
`value`, a finite `startedAt`), any malformed value is removed rather than kept — an absent `startedAt` used
to throw inside `Intl.DateTimeFormat` and take `TxStepper` into the error boundary on every reload — and an
intent whose `to` is not the manifest Vault, Draw or one of the manifest's own assets is dropped instead of
resumed. A resume that throws clears the intent rather than failing again on the next mount.

### Transactions

```ts
useTransaction(options?: {
  runtime?: TxRuntime;                    // tests only
  resume?: boolean;                       // default true: reattach to a persisted hash on mount
  formatParams?: (decoded: DecodedRevert) => Record<string, string>;   // formatted values for {placeholders}
}): {
  state: TxState;                        // phase, summary, label, account, chainId, hash, nonce,
                                         // blockNumber, steps, failure, provisional
  busy: boolean;
  send(prepared: PreparedWrite, options: {account: Address; label: string; formatParams?}): Promise<TxState>;
  reset(): void;
}
```

Phases: `idle -> preview -> walletConfirmation -> submitted -> included -> confirmed`, with `rejected`,
`reverted`, `replaced`, `dropped` and `walletUnreachable`. `send` estimates gas against current state with
the full calldata every time (a revert found there never opens the wallet), persists the intent as soon as a
hash exists, and never resends anything. `included` sets `provisional: true`; `confirmed` waits for the
§10.1 policy — the chain record's finality tag, then `safe`, then `confirmationDepth` (200) behind the head.
On chain 31337 no finality tag answers, so a local run stops at `included` until 200 more blocks are mined;
that is the honest reading of §10.1, not a bug.

`send` writes the deployment's `chainId` into the transaction the wallet is asked to sign, and refuses a
response signed for any other chain with the §9.6 `WrongChain` row. The gate and `useSigner`'s live
`eth_chainId` are both *checks*; a wallet can switch network between the last check and the prompt, and only
a chain-bound request is refused by the wallet itself rather than signed wherever it happens to be.

A failure raised **before** any signature exists — a gas estimate that could not reach the node, a wallet
without enough BNB — reports "Nothing sent" with "Retry; nothing was signed or sent", not "Unknown until
receipt". ethers' `INSUFFICIENT_FUNDS` (and a node that only says it in words) maps onto the catalog's
`InsufficientGas` row.

Seven properties of the tracking loop worth knowing about:

- **the receipt is re-read on every poll, `included` included.** A receipt that disappears rolls the state
  back to a provisional `submitted` and re-enters the receipt loop; a receipt that turns up in another block
  moves `blockNumber` with it and confirmation restarts against the new one. Nothing is called confirmed on
  the strength of a receipt the node no longer has (SPEC §9.6 "On reorg roll back confirmation and UI state
  and reconcile");
- **an RPC call that throws is "unknown", never "gone".** The receipt read, the `getTransaction` read and the
  nonce read are three separate `try` blocks, so one failing node call cannot turn a live transaction into a
  `dropped` one;
- **the poll interval backs off.** It starts at `receiptPollMs` and doubles to a 15 s ceiling
  (`DEFAULT_MAX_POLL_MS`, or the runtime's own `maxPollMs`) while a transaction is pending or provisionally
  included, so a tab left open on a slow transaction settles to four RPC calls a minute rather than sixty
  (SPEC §10.1). Tests keep it deterministic through the injected `sleep`;
- **`replaced` and `dropped` need three consecutive absent polls and a final receipt re-read.** One answer is
  not evidence: a load-balanced public RPC puts several nodes behind one URL, and a request that lands on a
  node a second behind answers `null` for a transaction sitting in the next block. `dropped` additionally
  requires that the account nonce never moved past this transaction's — the nonce observation is sticky,
  because an account nonce does not go backwards. Both verdicts **keep** the intent: they are "Unknown until
  receipt", so the next mount resumes and looks again;
- **what the node returns under the hash is compared with what this app prepared.** `to` and `from` on every
  receipt, and `to`/`from`/`data` on the first transaction body, are checked against the request; a
  disagreement stops the run with "The transaction under this hash is not the one this app prepared", funds
  "Unknown until receipt", and the intent kept. Nothing is ever called included or confirmed on a receipt
  that belongs to somebody else's transaction;
- **the intent slot is cleared by hash, and an orphaned loop is aborted.** `clearIntentFor(storage, hash)`
  removes the stored intent only when it is the one under that hash, so a run reaching a terminal state
  cannot delete a live intent a newer run just persisted. `TxRuntime.signal` is an `AbortSignal`
  `useTransaction` creates per run and aborts on `reset()`, on a superseding `send` and on unmount; `track`
  checks it at the top of every iteration and returns without emitting or touching storage.

`walletUnreachable` has one sub-case worth knowing about: ethers' `JsonRpcSigner.sendTransaction` broadcasts
first and polls afterwards, and when that poll fails it rejects with the hash it already has on
`error.info.sendTransactionHash`. The machine keeps that hash, puts it on the state, and persists the intent
under it with a null nonce, so a reload reattaches; the message says the transaction was signed and broadcast
rather than that nothing was sent.

Pass `formatParams` whenever a catalog message has placeholders you can fill (`{min}`, `{symbol}`,
`{available}`): without it the app prints an em dash rather than a brace next to money.

Render `<TxStepper state={state} chain={chain} />` inline and `<TxToast state={state} chain={chain}
onDismiss={reset} />` floating; render `<TxLiveRegion state={state} />` **once** near the root of the surface
that owns the transaction, so progress is announced politely and failures assertively (SPEC §9.7).

### Components

`Button` (`variant`, `loading`, `disabledReason`, `block`), `Card` (`title`, `aside`, `footer`, `raised`),
`Skeleton` (`width`, `height`, `label`), `EmptyState`, `ErrorState` (`body`, `funds`, `nextAction`, `detail`,
`onRetry`), `AssetBadge` (manifest asset only — never a fetched logo), `StateBadge` (`tone` + `label`, always
a glyph and a label so colour is never the only signal), `AccountChip`, `Identicon`, `WalletButton`,
`ConnectModal`, `NetworkGuard`, `DataFreshness` (`snapshot`), `TxStepper`, `TxToast`, `TxLiveRegion`.

Style with the tokens in `styles/tokens.css` and the classes in `styles/app.css`. For a dynamic width or
colour use React's `style` prop, which goes through CSSOM and is not gated by the CSP; never
`setAttribute("style")`, and never an inline `<script>`.

## Deferred (decided for this wave, not dropped)

| Deferred | Note |
|---|---|
| WalletConnect v2 | The `Connector` interface exists precisely so it can be added as one more connector with no change to any money flow. SPEC §9.2 still requires it. |
| `/activity` | SPEC §9.4. Needs the indexer. |
| `/leaderboard` | SPEC §9.4. Needs the indexer. |
| `/admin` | SPEC §9.4. Multisig calldata preview and operational status. |
| Full `/verify` | Only the deployment identity, the trust statements and the wallet list ship now. The custody equation, the price-reference explanation, the winning calculation, the fee allocation and the round evidence JSON download are not built. |
| Full `/help` | A minimal static version ships. The inline links to getting BNB, withdrawing from an exchange and the full privacy section are not built. |
| Official-domain phishing line | A placeholder that says the domain is not published yet. Replace it with the real domain once it exists; do not invent one (SPEC §16). |
| Storybook component catalog | SPEC §9.3. `src/components/components.test.tsx` renders each component's states in the meantime. |
| Lighthouse and axe budgets in CI | SPEC §9.3, §9.7. The bundle size is reported by hand for now. |
| Release manifest, tamper canary | SPEC §9.6, §10.3. Mainnet gate work (§12.1). |
| Analytics and the access notice | SPEC §9.7. Both are off and unbuilt by decision. |
| `frame-ancestors` and `X-Frame-Options` | A browser ignores `frame-ancestors` in a `<meta>` policy, so clickjacking protection has to be a response header from whatever serves the static build (§10.3 hosting). The meta policy carries everything else, including `connect-src`. |
| Unclaimed-money badges and banner | SPEC §9.4. Belongs with the pages that own entries and refunds. |
| AccountChip balance summary | SPEC §9.2 lists a balance summary on the account chip. The chip ships with the identicon, the address, the chain badge, copy, the explorer link and Disconnect; the balance needs a per-asset Vault read on every header render and belongs with the wallet page's own balance reads, not in the app shell. |

## Performance

Measured on the local build (`vite build`, gzip sizes reported by Vite):

| Chunk | Raw | Gzipped |
|---|---|---|
| `index-*.js` (app, React, router) | 394.70 kB | 114.61 kB |
| `ethers-*.js` | 250.41 kB | 92.91 kB |
| `rolldown-runtime-*.js` | 0.71 kB | 0.42 kB |
| **Initial JS for `/`** | | **207.94 kB** |
| `index-*.css` | 14.02 kB | 3.37 kB |

The §9.3 budget for `/` is 250 kB gzipped. ethers is split into its own chunk so it caches across deploys;
the pages that need charts or WalletConnect must lazy-load them.
