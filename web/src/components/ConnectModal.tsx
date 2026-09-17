// The connect dialog (SPEC §9.2, §9.7).
//
// §9.7 requires "dialogs with focus trap and focus return", so: focus moves to the dialog on open, Tab and
// Shift+Tab cycle inside it, Escape closes it, and focus returns to the control that opened it. The backdrop
// is not clickable on purpose — a stray tap should not dismiss a money-adjacent dialog, and a click target
// that is not a control would be an accessibility problem of its own.
//
// "The control that opened it" is often gone by the time the dialog closes: a successful connect replaces the
// Connect button with the account chip, and focusing a detached node silently drops focus to <body>, which
// leaves a keyboard user at the top of the page with no idea what happened. So the stored node is used only
// while it is still in the document, and the account chip is the fallback.
//
// Ordering and badging are decided in `lib/wallet/connectors.ts` and only rendered here.

import {useCallback, useEffect, useId, useRef} from "react";
import {walletSaid} from "../lib/wallet/errors.ts";
import type {Connector} from "../lib/wallet/types.ts";
import {en} from "../strings/en.ts";
import {ACCOUNT_CHIP_ATTRIBUTE} from "./AccountChip.tsx";
import {Button} from "./Button.tsx";

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type ConnectModalProps = {
  open: boolean;
  connectors: readonly Connector[];
  connectingId: string | null;
  /** The last connection failure, already in plain words. */
  error: string | null;
  onConnect: (connectorId: string) => void;
  onClose: () => void;
};

export function ConnectModal({open, connectors, connectingId, error, onConnect, onClose}: ConnectModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<Element | null>(null);
  const titleId = useId();
  const introId = useId();

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    return () => {
      const target = returnTo.current;
      if (target instanceof HTMLElement && target.isConnected) {
        target.focus();
        return;
      }
      document.querySelector<HTMLElement>(`[${ACCOUNT_CHIP_ATTRIBUTE}]`)?.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal__header">
          <h2 id={titleId}>{en.wallet.modalTitle}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={en.app.close}>
            ✕
          </button>
        </div>
        <p id={introId} className="small muted">
          {en.wallet.modalIntro}
        </p>

        {/* The app says what happened in its own voice; the wallet's text is labelled as the wallet's and
            capped, because an extension writes it and an unlabelled alert reads as LuckyDraw speaking. */}
        {error === null ? null : (
          <div className="notice notice--error small" role="alert">
            <p>{en.wallet.errorReported}</p>
            {walletSaid(error) === null ? null : (
              <p className="small muted">
                {en.wallet.errorSaidLabel} {walletSaid(error)}
              </p>
            )}
          </div>
        )}

        {connectors.length === 0 ? (
          <p className="muted">{en.wallet.noConnectors}</p>
        ) : (
          <ul className="connector-list">
            {connectors.map((connector) => (
              <li key={connector.id}>
                {connector.kind === "install" ? (
                  <a
                    className="connector"
                    href={connector.installUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <ConnectorIcon connector={connector} />
                    <span className="connector__name">{connector.name}</span>
                    <span className="badge badge--accent">{en.wallet.recommendedBadge}</span>
                    <span className="badge badge--neutral">{en.wallet.installAction}</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    className="connector"
                    onClick={() => onConnect(connector.id)}
                    disabled={connectingId !== null}
                  >
                    <ConnectorIcon connector={connector} />
                    {/* A wallet's name is whatever it announced, and two extensions can announce the same
                        one. The rdns is the id the session is stored under, so it is shown here: it is the
                        only thing on the row that tells two "MetaMask" entries apart (SPEC §9.2). */}
                    <span className="connector__name">
                      {connector.name}
                      {/* `style` goes through CSSOM and is not gated by the CSP; app.css belongs to
                          another owner this wave, so the one layout bit lives here. */}
                      <span className="smallest muted" style={{display: "block"}}>
                        {connector.id}
                      </span>
                    </span>
                    {connector.recommended ? (
                      <span className="badge badge--accent">{en.wallet.recommendedBadge}</span>
                    ) : null}
                    {connector.detected && !connector.recommended ? (
                      <span className="badge badge--neutral">{en.wallet.detectedBadge}</span>
                    ) : null}
                    {connectingId === connector.id ? (
                      <span className="small muted">{en.wallet.connecting}</span>
                    ) : null}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <Button variant="ghost" onClick={onClose}>
          {en.app.close}
        </Button>
      </div>
    </div>
  );
}

function ConnectorIcon({connector}: {connector: Connector}) {
  if (connector.icon === null) {
    return (
      <span className="asset-badge__mark" aria-hidden="true">
        {connector.name.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return <img className="connector__icon" src={connector.icon} alt="" />;
}
