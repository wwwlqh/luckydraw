// Catalog rows for the SPEC §9.6 state table: the primary action label and the message for each round state.
//
// Three states need two rows because the same `State` value reads differently on either side of a time
// boundary: Open before and after the cutoff, AwaitingRequest before and at the 24-hour request deadline,
// and Drawing before and after 24 hours (SPEC §7.3 replaces the estimate with the waiting notice then).
// `STATE_CATALOG_KEYS_BY_STATE` maps each Solidity `State` member to the rows that can apply to it.
//
// `note` is the second line the page shows under the message when it applies. For Refunding it is the line
// that replaces the message once this buyer's refund is credited; for Settled it is the line a buyer who was
// not selected sees; for Void it applies when the round was seeded.

import type {StateCatalogEntry, StateName} from "./types.ts";

const NO_ACTION = "No action needed";

export const stateCatalog = {
  Open: {
    primaryAction: "Enter",
    message: "Entries are open until this round's cutoff at {cutoff}.",
    note: "If entries are paused or the price reference is unavailable, the reason is shown here and Withdraw stays available.",
    params: ["cutoff"],
  },
  OpenAfterCutoff: {
    primaryAction: "Close round",
    message: "Closing… the keeper usually closes a round within two minutes of its cutoff.",
    note: "Anyone can close it, and whoever sends that transaction pays the network fee.",
  },
  AwaitingRequest: {
    primaryAction: "Request draw",
    message: "This round is closed and waiting for its randomness request.",
    note: "Anyone can send the request. If the randomness service reports a problem, the reason is shown here.",
  },
  AwaitingRequestExpired: {
    primaryAction: "Enable refunds",
    message: "The 24-hour request window has passed, so this round refunds in full instead of drawing.",
    note: "Anyone can expire it; after that every buyer's full entry, fee included, becomes claimable: the keeper credits every buyer within minutes and Claim refund is the fallback.",
  },
  Drawing: {
    primaryAction: NO_ACTION,
    message:
      "Waiting for verified randomness. Requested at {requestedAt}, {requestAge} ago; usually about ten minutes after cutoff.",
    params: ["requestedAt", "requestAge"],
  },
  DrawingDelayed: {
    primaryAction: NO_ACTION,
    message:
      "Waiting for verified randomness. The request was accepted {requestAge} ago and no result has arrived, so there is no estimate to give.",
    note: "Once a request is accepted the round cannot be canceled and there is no timeout refund. The operator is watching it. If the round is still waiting after 7 days, the operator makes a voluntary payment (not a release of the locked escrow) of every entry, fee included, by direct transfer from the treasury Safe to your own address within 3 business days, from the published make-whole reserve; beyond that reserve's cap, reimbursement is best effort.",
    params: ["requestAge"],
  },
  Ready: {
    primaryAction: "Settle",
    message:
      "The randomness is verified and the winning calculation is shown in full. Anyone can settle this round.",
    note: "Balance credit pending settlement.",
  },
  Settled: {
    primaryAction: "Go to Wallet",
    message:
      "This round is settled: the prize is credited to the winner's LuckyDraw balance and the 3% fee to the fee account.",
    note: "Not selected: your entry was not drawn. Your share and the full calculation stay on Verify.",
  },
  Refunding: {
    primaryAction: "Claim refund",
    message:
      "This round refunds every entry in full, including the 3% fee; the keeper credits every buyer within minutes.",
    note: "Refund credited to your balance",
  },
  Void: {
    primaryAction: NO_ACTION,
    message: "No player entered this round, so there was nothing to draw. No player funds were committed.",
    note: "The operator seed was returned to the seed account in the closing transaction.",
  },
} satisfies Record<string, StateCatalogEntry>;

export type StateCatalogKey = keyof typeof stateCatalog;

/** Which rows can apply to each Solidity `State` member (SPEC §5.1 order). */
export const STATE_CATALOG_KEYS_BY_STATE = {
  Open: ["Open", "OpenAfterCutoff"],
  AwaitingRequest: ["AwaitingRequest", "AwaitingRequestExpired"],
  Drawing: ["Drawing", "DrawingDelayed"],
  Ready: ["Ready"],
  Settled: ["Settled"],
  Refunding: ["Refunding"],
  Void: ["Void"],
} satisfies Record<StateName, readonly StateCatalogKey[]>;

/** Seconds after which the Drawing row switches to the SPEC §7.3 waiting notice. */
export const DRAWING_WAITING_NOTICE_SECONDS = 86400n;

/**
 * The row for a round, given its state and the two time facts the caller already holds: whether a chain
 * timestamp has passed the cutoff (Open) or the request deadline (AwaitingRequest), and how long an accepted
 * request has been outstanding (Drawing). The client clock never authorizes anything (SPEC §9.6): the caller
 * derives both from a recent chain timestamp.
 */
export const stateCatalogKeyFor = (
  state: StateName,
  timing: {readonly pastBoundary?: boolean; readonly requestAgeSeconds?: bigint} = {},
): StateCatalogKey => {
  switch (state) {
    case "Open":
      return timing.pastBoundary === true ? "OpenAfterCutoff" : "Open";
    case "AwaitingRequest":
      return timing.pastBoundary === true ? "AwaitingRequestExpired" : "AwaitingRequest";
    case "Drawing":
      return timing.requestAgeSeconds !== undefined &&
        timing.requestAgeSeconds >= DRAWING_WAITING_NOTICE_SECONDS
        ? "DrawingDelayed"
        : "Drawing";
    default:
      return state;
  }
};
