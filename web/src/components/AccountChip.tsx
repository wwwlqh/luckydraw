// The account chip of SPEC §9.2: identicon, truncated address, chain badge, copy, explorer link, Disconnect.
//
// The identicon is generated from the address itself, so nothing is fetched and no third party learns which
// address is connected (§9.7 privacy). It is decorative: the address next to it is the real identification,
// and the SVG is hidden from assistive technology.

import {useCallback, useState} from "react";
import {explorerAddressUrl} from "../lib/deployment/provider.ts";
import type {ChainRecord} from "../lib/deployment/records.ts";
import {en, fill} from "../strings/en.ts";
import {StateBadge} from "./StateBadge.tsx";

/** `0x1234…cdef`: enough of both ends to compare against a wallet, short enough for a 360 px layout. */
export function truncateAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * A deterministic 5x5 mirrored block pattern from the address, in the palette's accent and info hues.
 * Purely decorative; identical addresses always produce an identical mark.
 */
export function Identicon({address, size = 24}: {address: string; size?: number}) {
  const hex = address.replace(/^0x/, "");
  const cells: string[] = [];
  const cell = size / 5;
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 5; row += 1) {
      const index = (column * 5 + row) % hex.length;
      const nibble = Number.parseInt(hex[index] ?? "0", 16);
      if (nibble % 2 === 0) continue;
      const fillColor = nibble > 7 ? "var(--accent)" : "var(--info)";
      for (const x of column === 2 ? [2] : [column, 4 - column]) {
        cells.push(`${x}:${row}:${fillColor}`);
      }
    }
  }
  return (
    <svg
      className="account-chip__identicon"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect width={size} height={size} fill="var(--surface-sunken)" />
      {cells.map((entry) => {
        const [x, y, color] = entry.split(":") as [string, string, string];
        return (
          <rect
            key={entry}
            x={Number(x) * cell}
            y={Number(y) * cell}
            width={cell}
            height={cell}
            fill={color}
          />
        );
      })}
    </svg>
  );
}

/**
 * Marks the chip so the connect dialog can hand focus to it when the control that opened the dialog — the
 * Connect button this chip replaced — is no longer in the document (SPEC §9.7 focus return).
 */
export const ACCOUNT_CHIP_ATTRIBUTE = "data-account-chip";

export type AccountChipProps = {
  address: string;
  chain: ChainRecord;
  /** The wallet's chain, which may differ from the deployment's. */
  walletChainId: bigint | null;
  onDisconnect: () => void;
};

export function AccountChip({address, chain, walletChainId, onDisconnect}: AccountChipProps) {
  const [copied, setCopied] = useState(false);
  const explorer = explorerAddressUrl(chain, address);
  const onChain = walletChainId === chain.chainId;

  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(address)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => setCopied(false));
  }, [address]);

  return (
    // Focusable only programmatically (`tabIndex={-1}`), so it never adds a stop to the tab order; the
    // buttons inside it are the real stops. No role and no aria-label: a focused container reads out its own
    // contents, which are the address and the chain, and the connection itself is announced by the polite
    // live region in WalletButton.
    <span className="account-chip" {...{[ACCOUNT_CHIP_ATTRIBUTE]: ""}} tabIndex={-1}>
      <Identicon address={address} />
      <span className="account-chip__address" title={address}>
        {truncateAddress(address)}
      </span>
      <StateBadge
        tone={onChain ? "info" : "pending"}
        label={
          onChain
            ? chain.displayName
            : fill(en.wallet.unknownChain, {chainId: walletChainId === null ? "?" : String(walletChainId)})
        }
      />
      <span className="account-chip__actions">
        <button type="button" className="icon-button" onClick={copy} aria-label={en.wallet.copyAddress}>
          {copied ? en.app.copied : en.app.copy}
        </button>
        {explorer === null ? null : (
          <a
            className="icon-button"
            href={explorer}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={en.app.openInExplorer}
          >
            ↗
          </a>
        )}
        <button type="button" className="icon-button" onClick={onDisconnect}>
          {en.wallet.disconnect}
        </button>
      </span>
    </span>
  );
}
