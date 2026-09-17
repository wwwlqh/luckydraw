// The floating transaction status, and the two live regions of SPEC §9.7.
//
// "Announce transaction progress through a polite live region and failures through an assertive one."
// Both regions are always in the DOM — a region inserted at the same time as its text is announced
// unreliably — and only their contents change.

import type {ChainRecord} from "../lib/deployment/records.ts";
import type {TxState} from "../lib/tx/types.ts";
import {en} from "../strings/en.ts";
import {Button} from "./Button.tsx";
import {isTerminal, phaseMessage, TxStepper} from "./TxStepper.tsx";

const FAILURE_PHASES: ReadonlySet<TxState["phase"]> = new Set([
  "rejected",
  "reverted",
  "replaced",
  "dropped",
  "walletUnreachable",
]);

/** Polite progress, assertive failures. Rendered once, near the root, and never unmounted (SPEC §9.7). */
export function TxLiveRegion({state}: {state: TxState}) {
  const failed = FAILURE_PHASES.has(state.phase);
  const message = state.phase === "idle" ? "" : phaseMessage(state);
  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite">
        {failed ? "" : message}
      </div>
      <div className="visually-hidden" role="alert" aria-live="assertive">
        {failed ? message : ""}
      </div>
    </>
  );
}

export type TxToastProps = {
  state: TxState;
  chain: ChainRecord;
  onDismiss: () => void;
};

export function TxToast({state, chain, onDismiss}: TxToastProps) {
  if (state.phase === "idle") return null;
  return (
    <div className="toast">
      {state.label === null ? null : <p className="card__title">{state.label}</p>}
      <TxStepper state={state} chain={chain} />
      {isTerminal(state.phase) ? (
        <Button variant="ghost" onClick={onDismiss}>
          {en.tx.dismiss}
        </Button>
      ) : null}
    </div>
  );
}
