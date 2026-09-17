# Operator privacy and origin isolation

Status: required deployment design, not an applied configuration or a verified live-host audit. SPEC §10.4 is authoritative. A publicly visible hosting IP is not the operator's home IP. This design limits exposure to visitors and a compromised application VM; it does not promise anonymity against providers, endpoint malware or correlated public records.

## Target connections

```text
Visitor -> managed static CDN                         -> signed release artifacts
Visitor -> public API hostname -> Cloudflare Tunnel  -> loopback nginx -> loopback API
Operator -> full-tunnel VPN -> Access + SSH identity -> admin tunnel   -> loopback SSH
Keeper VM -> cloud egress -> blockchain RPC
Canary on independent host -> static CDN + independent release record
```

Never serve production or staging from the operator's home/office connection. Production static assets have no operator-VM origin; the VM's public API uses an outbound tunnel. Public API access remains available without operator login, with rate limits; SSH, staging and operational dashboards require Access authentication, hardware-key MFA and a separate SSH identity. Public /admin UI may prepare calldata, but it grants no infrastructure access or contract authority.

The application, indexer, keeper, database and cloudflared use distinct unprivileged service identities with narrowly scoped filesystem permissions. A shared `luckydraw` service user does not isolate service credentials. The keeper's runtime credential is accessible to that service and a sufficiently privileged host attacker; encryption at rest cannot change that fact.

## Safe cutover sequence

1. Record current firewall, listeners, DNS, certificate renewal and recovery access in the private operations inventory. Recheck patch/listener state; historical package counts are not current evidence. Do not print credentials or publish origin identifiers.
2. Establish and test provider-console recovery and backups first. Keep the current SSH session while testing a second session on the replacement path. No blind firewall reset or remote reboot.
3. Configure the operator's VPN on the admin device with fail-closed routing for IPv4, IPv6 and DNS, no split tunneling for admin/browser/RPC traffic, and no fallback when the tunnel drops. Test a drop before opening an admin session. A VPN provider still knows the connecting IP; device compromise bypasses this protection.
4. Publish the static client through restricted CI/CD credentials. Pin the trusted release manifest or signature in an independently managed canary configuration. The origin's own displayed hash is not the trust anchor. Keep staging behind Access.
5. Create separate API and administration tunnel credentials, limited to their routes. Store them as service credentials; do not put tokens in command lines, browser bundles or repository files. Authenticate administration with an explicit operator allow policy, short sessions and hardware-key MFA. Preserve SSH host-key checking and passphrase/hardware-protected client keys; disable agent forwarding, password authentication and root SSH login.
6. Test API routing and a new SSH session through Access from the VPN. Test an unauthenticated client: admin/SSH must be denied; the public API must expose only intended read endpoints. A public hostname does not make the SSH service public to unauthenticated users.
7. Bind nginx/API/PostgreSQL/SSH to loopback or their specifically defined private interfaces. Deny unsolicited Internet ingress in both OCI NSGs/security lists and host firewall, for IPv4 and IPv6: public 22/80/443/5432/metrics/debug listeners must no longer be reachable. Allow outbound tunnel, DNS, time, updates, RPC and telemetry through reviewed routes. A private VM with NAT egress is preferred when provisioned; a retained public NIC is not a reason to leave inbound ports open.
8. Retire old IP-encoded staging hostnames and direct-origin DNS records. Remove their routing and obsolete HTTP-01 renewal dependencies only after replacement TLS works. Cloudflare manages public-edge certificates; any required origin/private certificate uses DNS-based validation or a private issuance path. No port-80 exception solely for old certificate renewals. Do not put broad DNS-zone API tokens on the VM.
9. Test bypass from a network outside the trusted operator environment, including direct IPv4/IPv6 with Host/SNI overrides, obsolete names and all known published origin addresses. Test fail-closed administration and reboot/restart recovery in an agreed maintenance window.
10. Record configuration and test evidence privately, with a redacted pass/fail summary for release. Requirements U30–U37 remain not run until this evidence exists. Actual changes to live DNS, firewalls, keys, billing or services are separate deployment actions.

## Publication and record hygiene

Public DNS, bundles, maps, error responses, documentation, release archives, CI logs and screenshots must not contain origin addresses, instance IDs, private hostnames, operator device paths, personal email/address or access credentials. Publish contract addresses, fee flows and verified source normally; those are transparency data. Release CI uses an explicit allowlist, not an upload of the repository root.

`/.private/` is excluded from Git and release output. It is not encrypted storage, and this workspace is inside OneDrive: ignoring a file does not remove cloud-sync copies or historical Git/chat copies. The private inventory contains infrastructure records only; keys, personal home IP and account recovery secrets belong in an operator-managed store outside repositories and cloud-synced workspaces. Do not append raw IPs to public acceptance reports.

Old DNS, certificate transparency and cached files may retain origin relationships. Current proxying does not erase them. Migrate a previously exposed origin to fresh/private infrastructure if reducing future origin linkage is required; firewall isolation must still hold even when an attacker knows the address. Do not promise retrospective deletion.

Use registrar privacy/redaction where available, accurate required registration details, dedicated project contact channels and hardware-key MFA. DNSSEC authenticates DNS data; it does not hide it. Provider billing/KYC records and lawful obligations remain. A dedicated treasury avoids casual personal-address reuse but exchange withdrawals, timing and on-chain flows can still be linked; none is an anonymity guarantee.

## Logging and identity exposure

Keep security logs, but protect them. Restricted off-host security logs retain raw source/auth data only for the agreed incident window (30 days by default), then expire; public dashboards and app analytics use redaction or aggregation. Public app DB stores chain events, not admin authentication logs. Do not disable audit logs merely to hide access.

The administrator VPN must be active for the website, cloud console, DNS/CI/Access console, SSH and browser wallet/RPC activity. Observe a controlled test endpoint and restricted audit logs to verify the expected VPN egress, IPv6/DNS behavior and WebRTC exposure. Providers may still infer device identity and account location. An Access proxy alone can record the client IP; do not assume it makes the operator anonymous to Cloudflare.

Disable unsolicited browser geolocation permission on operator profiles; strip EXIF/location from public images, avoid screenshots with personal identifiers, use dedicated project contact/commit identities, and review recovery-email exposure. These controls reduce accidental disclosure; they cannot protect a device already controlled by an attacker.

## Correct compromise boundary

A VM compromise cannot directly acquire contract-owner privileges merely by running the API/keeper. It can steal usable keeper credentials and any runtime secrets on the VM, read/alter local data, fake local logs, deny service and serve malicious API/staging content. A static origin, DNS, CI or operator-device compromise can still phish signatures; never treat in-page hashes or decoded text alone as trustworthy. Independent wallet/hardware verification remains necessary.

A dead keeper is handled by other public executors, with possible races and wasted gas. Refund after the request deadline applies only when no request was accepted. An accepted VRF request has no deadline refund. Database corruption can influence users' decisions even when contract balances are read independently; verify round/asset/amount/recipient against trusted chain state at signing.

## Primary references

- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/): outbound origin connection; no public inbound listener required.
- [Origin protection](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/): historical DNS and other origin disclosures.
- [Access-protected SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/): separate authenticated administration.
- [IP geolocation limitations](https://support.maxmind.com/knowledge-base/articles/maxmind-geolocation-accuracy): IP-derived location is not a precise home address.
