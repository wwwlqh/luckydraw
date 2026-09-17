// The one control a round state offers (SPEC §6.2 state table, §9.6 control table, §9.1 X3).
//
// Each branch builds its calldata with the matching `prepare*` builder and sends it through the surface's
// `useTransaction`, so the decoded summary shown before the wallet prompt is built from the same arguments
// that were encoded (§9.6). Every one of these calls is permissionless, so each carries the caller-gas
// explanation: whoever sends it pays the network fee and nothing is taken from the pot.
//
// The Drawing rows have no control at all, and this component renders none: no fake timer, no animation and
// no result before Settled (§9.1 X2, §9.6).

import {
  type Address,
  formatCountdown,
  prepareClaimRefund,
  prepareCloseRound,
  prepareExpireUnrequested,
  prepareRequestDraw,
  prepareSettle,
  type RoundView,
  renderMessage,
  type StateCatalogEntry,
  stateCatalog,
} from "@luckydraw/client";
import {useCallback} from "react";
import {useDeployment} from "../../lib/deployment/DeploymentProvider.tsx";
import type {Lifecycle, LifecycleAction} from "../../lib/rounds/derive.ts";
import {cutoffText} from "../../lib/rounds/format.ts";
import type {TransactionHandle} from "../../lib/tx/useTransaction.tsx";
import {useWriteGate} from "../../lib/wallet/useWriteGate.ts";
import {fill} from "../../strings/en.ts";
import {rounds} from "../../strings/rounds.ts";
import {Button, TxLiveRegion, TxStepper} from "../index.ts";
import "./rounds.css";

const ACTION_LABELS: Readonly<Record<Exclude<LifecycleAction, null | "enter">, string>> = {
  close: rounds.lifecycle.closeRound,
  request: rounds.lifecycle.requestDraw,
  expire: rounds.lifecycle.expire,
  settle: rounds.lifecycle.settle,
  claim: rounds.lifecycle.claim,
};

const TX_LABELS: Readonly<Record<Exclude<LifecycleAction, null | "enter">, string>> = {
  close: rounds.lifecycle.label.close,
  request: rounds.lifecycle.label.request,
  expire: rounds.lifecycle.label.expire,
  settle: rounds.lifecycle.label.settle,
  claim: rounds.lifecycle.label.claim,
};

export type LifecycleControlProps = {
  round: RoundView;
  lifecycle: Lifecycle;
  account: Address | null;
  tx: TransactionHandle;
};

export function LifecycleControl({round, lifecycle, account, tx}: LifecycleControlProps) {
  const {verified, chain} = useDeployment();
  const gate = useWriteGate();
  const entry: StateCatalogEntry = stateCatalog[lifecycle.catalogKey];
  const action = lifecycle.action;

  const send = useCallback(async () => {
    if (verified === null || account === null || action === null || action === "enter") return;
    const prepared =
      action === "close"
        ? prepareCloseRound(verified, round.id)
        : action === "request"
          ? prepareRequestDraw(verified, round.id)
          : action === "expire"
            ? prepareExpireUnrequested(verified, round.id)
            : action === "settle"
              ? prepareSettle(verified, round.id)
              : prepareClaimRefund(verified, round.id, account);
    await tx.send(prepared, {
      account,
      label: fill(TX_LABELS[action], {roundId: round.id.toString()}),
    });
  }, [verified, account, action, round.id, tx]);

  const message = renderMessage(entry, {
    cutoff: cutoffText(round.closesAt),
    requestedAt: round.requestedAt === 0n ? "—" : cutoffText(round.requestedAt),
    requestAge: formatCountdown(lifecycle.requestAgeSeconds ?? 0n),
  });

  return (
    <div className="stack">
      <TxLiveRegion state={tx.state} />
      <p>{message}</p>
      {entry.note === undefined ? null : <p className="small muted">{entry.note}</p>}
      {action === "enter" ? null : action === null ? (
        <p className="small muted">{rounds.lifecycle.noAction}</p>
      ) : (
        <>
          <p className="small muted">{rounds.round.callerGas}</p>
          <Button
            variant="primary"
            block
            loading={tx.busy}
            disabledReason={gate.allowed ? null : gate.reason}
            onClick={() => void send()}
          >
            {ACTION_LABELS[action]}
          </Button>
        </>
      )}
      {tx.state.failure === null ? null : (
        <p className="notice notice--error small" role="alert">
          {fill(rounds.round.requestFailure, {reason: tx.state.failure.message})} {tx.state.failure.funds}.{" "}
          {tx.state.failure.nextAction}.
        </p>
      )}
      <TxStepper state={tx.state} chain={chain} />
    </div>
  );
}
