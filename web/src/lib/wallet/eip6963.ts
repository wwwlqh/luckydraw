// EIP-6963 wallet discovery (SPEC §9.2: "EIP-6963 announces every other injected wallet [...] with its own
// icon; never guess from a single `window.ethereum`").
//
// The protocol is: the page listens for `eip6963:announceProvider`, then dispatches `eip6963:requestProvider`;
// every wallet in the page answers with one announcement carrying its own uuid, name, icon and reverse-DNS
// id. Wallets injected later announce again on their own, so the listener stays attached.

import type {Eip1193Provider} from "./types.ts";

export type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  /** Data URI. Rendered as-is and never re-fetched: SPEC §9.3 forbids runtime logo fetches. */
  icon: string;
  /** Reverse-DNS identifier, for example `io.metamask`. This is the id the session persists. */
  rdns: string;
};

export type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
};

export const ANNOUNCE_EVENT = "eip6963:announceProvider";
export const REQUEST_EVENT = "eip6963:requestProvider";

/**
 * True for MetaMask's reverse-DNS id and for its Flask and Institutional variants.
 *
 * **Not** a test for "this is MetaMask": `rdns` is self-declared, so anything in the page can announce
 * `io.metamask.whatever` and pass. `buildConnectors` decides the Recommended row on the exact
 * `METAMASK_RDNS` instead; this stays for callers that want the family, such as a help string.
 */
export function isMetaMaskRdns(rdns: string): boolean {
  return rdns === "io.metamask" || rdns.startsWith("io.metamask.");
}

function isDetail(value: unknown): value is Eip6963ProviderDetail {
  if (value === null || typeof value !== "object") return false;
  const detail = value as {info?: unknown; provider?: unknown};
  const info = detail.info;
  if (info === null || typeof info !== "object") return false;
  const record = info as Record<string, unknown>;
  if (typeof record.uuid !== "string" || typeof record.rdns !== "string") return false;
  if (typeof record.name !== "string" || typeof record.icon !== "string") return false;
  const provider = detail.provider;
  return (
    provider !== null &&
    typeof provider === "object" &&
    typeof (provider as {request?: unknown}).request === "function"
  );
}

/**
 * Subscribes to announcements and asks every wallet in the page to announce itself.
 *
 * `onChange` is called with the full, de-duplicated list, keyed by `rdns`. **The first announcement for an
 * rdns wins and every later one for that rdns is ignored.** Last-writer-wins would let anything in the page
 * dispatch a second `eip6963:announceProvider` with a name and icon already on screen and have the provider
 * object behind a connected wallet quietly replaced, which is a signing surface, not a display detail. A
 * wallet that genuinely reloads its provider is handled by the session check in `WalletProvider`, which ends
 * the session rather than signing through the newcomer.
 */
export function discoverProviders(
  onChange: (details: readonly Eip6963ProviderDetail[]) => void,
  target: Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent"> = window,
): () => void {
  const byRdns = new Map<string, Eip6963ProviderDetail>();

  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isDetail(detail)) return;
    if (byRdns.has(detail.info.rdns)) return;
    byRdns.set(detail.info.rdns, detail);
    onChange([...byRdns.values()]);
  };

  target.addEventListener(ANNOUNCE_EVENT, listener);
  target.dispatchEvent(new Event(REQUEST_EVENT));
  return () => target.removeEventListener(ANNOUNCE_EVENT, listener);
}
