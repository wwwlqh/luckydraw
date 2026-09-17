# Oracle Cloud server runbook

Status: documentation baseline; no host connection or configuration change was performed in this privacy revision. Historical host observations are not evidence of current patch/listener state. SPEC §10.3–§10.4 and `operator-privacy.md` define the target.

## Private inventory and access

Exact cloud region, instance identifiers, public address, legacy IP-encoded hostname, certificate lineage and previous cleanup observations were removed from publishable docs. A historical infrastructure-only snapshot is retained in ignored `/.private/ops/oracle-inventory-before-privacy.md`. This is not encrypted and can be OneDrive-synced; never store home IP, private keys or recovery secrets there. The provider console and an operator-managed private inventory are the current source of deployment facts.

The local alias `ssh luckydraw-oracle` must be repointed to the authenticated tunnel path before production use. Keep SSH host-key verification. Keys remain outside repositories/cloud sync; no agent forwarding, password login or root login. Hardware/passphrase-protected key creation and passphrases are handled on the operator's own trusted device.

## Target service layout

- Production client: managed static CDN with restricted CI deployment and an independently authenticated release manifest.
- VM: indexer, read API, keeper and access-protected staging. Separate unprivileged identities for each service and each tunnel connector; systemd units with reviewed sandbox exceptions.
- PostgreSQL/API/nginx/SSH: loopback or explicitly private interfaces. Public API reaches nginx via outbound cloudflared; administration requires Access identity plus SSH authentication. No public origin ports after cutover.
- Keeper: separate limited-balance EOA; runtime key is stealable by root/service compromise despite encrypted storage. Owner/treasury keys never enter the VM. External monitor checks target, selector, value and gas spending.
- Off-host logs, backups, heartbeat and canary are independent of this VM; backup keeper and bounded Automation work cover historical unresolved rounds too.

## Required deployment checklist

- [ ] Reinspect current OS, packages, listeners, firewall, credentials and certificate dependencies; do not reuse an old package count as present evidence.
- [ ] Verify cloud-console recovery, backup and a second admin session before firewall changes; schedule any reboot separately.
- [ ] Follow the ordered migration in `operator-privacy.md`; test fail-closed operator VPN, authenticated API/admin routes and public bypass denial for IPv4/IPv6.
- [ ] Patch OS and enable security updates; retain password/root SSH prohibition and host-key checking.
- [ ] Create separate service users, deploy restricted unit files and review sandbox exposure reports; retain only necessary write paths and privileges.
- [ ] Release artifacts verified against independently authenticated CI metadata; limited deploy identity; no repo-root upload.
- [ ] Retire IP-encoded staging and old public HTTP-01 paths only after replacement TLS/routing is proven; DNS-zone credentials do not belong on the VM.
- [ ] Test external canary/heartbeats, runtime-key exposure assumptions, off-host log retention and DB restore/re-derivation.
- [ ] Configure registrar/DNS protections and scan public artifacts for origin/personal metadata.
- [ ] Record U25–U37 evidence, dates and owners privately; publish redacted pass/fail only. Nothing is marked done solely because it is listed here.

## Incident and compromise boundary

Revoke exposed keeper/tunnel/deploy credentials, isolate/rebuild compromised services from verified artifacts, preserve off-host evidence, and verify the independent static origin. Keep legitimate financial exit routes available through trusted clients. New credentials and changed DNS/firewall/keys require an explicit deployment action with tested recovery.

VM access grants no direct contract-owner authority, but can steal hot credentials, alter history/API/staging responses, mislead users and deny service. A compromised page can phish signatures; balances being on-chain is not a blanket theft guarantee. Public functions allow pre-request timeout refunds only. Accepted randomness requests have no deadline refund and may remain locked, as SPEC §7.3 states.
