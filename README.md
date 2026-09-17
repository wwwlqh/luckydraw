# LuckyDraw

An on-chain lucky draw on BNB Smart Chain. Players deposit an asset into their own balance, enter a round with any
amount worth at least USD 1, and the round draws a winner with Chainlink VRF as soon as its USD target is reached,
or at its fixed UTC cutoff at the latest. 3% of every entry is reserved as the platform fee; deposits and withdrawals
carry no fee. Every funded pool gets an operator seed entry, so a lone player gets a draw instead of a refund.

Each pool runs seven target tiers: daily USD 100, 1,000 and 10,000; weekly 1,000, 10,000 and 100,000; monthly 100,000.

## Try it on testnet

**Live test site:** https://wwwlqh.github.io/luckydraw/

This is a **free test on the BNB Smart Chain testnet**. Nothing on it is real money and nothing can be cashed out.
It exists to find bugs and see whether people find the flow clear, not to win anything.

To try it you need:

1. **MetaMask**, as a browser extension or the MetaMask app's built-in browser on a phone.
2. **Free testnet BNB (tBNB)** from the official faucet: https://www.bnbchain.org/en/testnet-faucet. Paste your
   address; a small amount covers many entries and network fees.
3. Open the site, connect, and accept the wallet prompt to switch to BSC testnet. Deposit a little tBNB, then enter
   a round. Browsing needs no wallet; a wallet is only needed to enter.

**What to report.** Anything that breaks, stalls or confuses you: the page you were on, what you clicked, what you
expected, and the transaction hash if MetaMask gave you one. Open an issue on this repository.

Deployment on chain 97: Draw `0x25c41f9921e51b120f971e25181c55b1dcaf1d41`, recorded in
[`config/deployments/97/`](config/deployments/97/) and browsable on https://testnet.bscscan.com.

## How it works

- **Deposit.** Move an asset into your LuckyDraw balance in the Vault. No deposit fee, no withdrawal fee.
- **Enter before the cutoff.** Enter any open round with an amount worth USD 1 or more at the Chainlink reference
  price. 3% is reserved as the platform fee; the rest goes into the prize pot.
- **Draw.** A round draws when entries reach its USD target, and no later than its UTC cutoff (daily at 00:00,
  weekly on Monday 00:00, monthly on the 1st 00:00). The keeper closes the round, requests randomness from Chainlink
  VRF v2.5, and settles. Selection is weighted by amount.
- **Winnings are credited** to the winner's LuckyDraw balance and can be withdrawn at any time.
- **Refund.** A round with a single entrant and no seed refunds that entrant in full, fee included.

Every call the keeper makes is public: anyone can make the same calls, so losing the keeper delays rounds and never
puts funds at risk.

## Repository layout

| Path | What it holds |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | The design of record: rules, invariants, decisions (§13), mainnet gates (§14). |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | Requirements mapped to evidence. |
| [`docs/runbooks/`](docs/runbooks/) | Operator runbooks: testnet launch, mainnet launch, privacy, oracle server. |
| [`contracts/`](contracts/) | Foundry project: `LuckyVault` (custody, escrow), `LuckyDraw` (pools, rounds, VRF), deployment scripts, tests. |
| [`packages/client/`](packages/client/) | Shared TypeScript client used by the web app and the keeper. |
| [`web/`](web/) | The static web app, published to GitHub Pages by `.github/workflows/pages.yml`. |
| [`keeper/`](keeper/) | The round-advancing keeper: seed, close, request, settle, refund. |
| [`config/`](config/) | Chain records, asset records, deployment plans and manifests, JSON schemas, validator. |
| [`scripts/`](scripts/) | Spec reference math, trace checks, config validation, feed observation. |

## Development

Requirements: Node 24 or 25, pnpm 12.3.4 (or `npx pnpm@12.3.4`), Foundry 1.8.1, Python 3 with the `markdown` package.

```bash
npx pnpm@12.3.4 install --frozen-lockfile
npx pnpm@12.3.4 validate:config      # config records against their schemas and cross-field rules
npx pnpm@12.3.4 test                 # client, web and keeper tests
cd contracts && forge test           # contract unit, integration, progress and invariant suites
```

Deployments are operator-run from `contracts/script/` (Deploy, Configure, Finalize, Verify) after the gates in
SPEC §14; the testnet sequence is in [`docs/runbooks/testnet-launch.md`](docs/runbooks/testnet-launch.md). This
repository never holds private keys, seed phrases or keyed RPC URLs.

## Status and limits

- Testnet interest test. No mainnet deployment exists.
- Mainnet is gated on the items in SPEC §14: separate hardware-key Safes for owner, treasury and seed, an
  independent review, a private shakedown round, monitoring, and a jurisdiction determination by qualified
  advisers. This repository is an unrestricted on-chain baseline, not a claim of legal permission anywhere.
- Randomness depends on Chainlink VRF; a request the coordinator accepts but never fulfils holds that round's
  escrow until the deadline path runs. Prices depend on the Chainlink BNB/USD feed with a bounded maximum age.

## License

MIT.
