# Stale evidence, kept out of `config/`

Documents here are historical records that are **no longer true of any chain**. They are kept for audit
history and are deliberately outside `config/deployments/`, so that `scripts/validate_config.ts`, the web
build and the keeper cannot load them and cannot be made to assert something false.

Nothing in this directory may be copied back into `config/` without a real deployment behind it.

## `97-0x29f8158114fa56a438a36600e988c4348979aeac.three-kind-build.json`

The BSC testnet (chain 97) manifest as it stood before ADR 036.

The contract at `0x29f8158114fa56a438a36600e988c4348979aeac` on chain 97 is the **three-kind build**. Its
`addPool` receipt in `contracts/broadcast/Configure.s.sol/97/run-latest.json` carries seven logs — one
`PoolAdded` and three `RoundRegistered`/`RoundOpened` pairs — where the seven-kind build emits fifteen. Rounds
4 to 7 of that pool were never created and do not exist on chain.

When ADR 036 widened `Kind` from three members to seven, this manifest was hand-edited to the seven-kind
shape: `targetsUsd` gained the seven Kind keys and `firstRoundIds` was extended to `1`..`7`. Those edits were
never backed by a deployment. The record therefore asserted on-chain facts that are false — while continuing
to carry a genuine `deployTx`, `deployBlock` and `codeHash`, which is what made it convincing.

**Chain 97 must be redeployed from scratch with the seven-kind build** (`Deploy` → `Configure` → `Finalize` →
`Verify`, per `docs/runbooks/testnet-launch.md`) before any manifest for chain 97 exists in `config/` again.
The deployment plan `config/deployments/97/testnet.plan.json` is kept and is still correct: it is a statement
of intent, not of on-chain fact, and its chain, VRF, feed and Safe values were read from the live chain and
are unaffected by ADR 036. The redeployment will land at a **new address**, so the new manifest will have a
new file name.
