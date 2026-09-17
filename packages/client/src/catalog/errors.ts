// Catalog rows for every custom error a LuckyDraw deployment can revert with (SPEC §8.1, §9.6).
//
// Keys are the Solidity error names of `contracts/src/Errors.sol` plus the OpenZeppelin errors that appear
// in the compiled LuckyDraw and LuckyVault ABIs. The rows marked "SPEC §9.6 verbatim" reproduce the
// representative table in that section exactly; the rest are written in the same register: plain words, what
// happened, what happened to money, one next action. SPEC §8.1: "Reverts must not be shown as raw stack
// traces in the app."

import type {CatalogEntry} from "./types.ts";

// Shared rows. One object per SPEC §9.6 table row that covers several error names, so the texts cannot drift
// apart and `quoteReasons.ts` can mirror them by identity.

/** SPEC §9.6 verbatim: PriceUnavailable / PriceInvalid / PriceStale / PriceDecimalsChanged. */
const priceReference: CatalogEntry = {
  message:
    "The price reference is unavailable or stale; entries pause until it updates. Deposits and withdrawals still work.",
  funds: "Nothing debited",
  nextAction: "Auto-refresh; retry when fresh",
};

/** SPEC §9.6 verbatim: BuysPaused / PoolDisabled. */
const entriesPaused: CatalogEntry = {
  message: "Entries are paused for this pool.",
  funds: "Nothing debited",
  nextAction: "Withdraw stays available",
};

/** SPEC §9.6 verbatim: DepositsPaused / DepositsDisabled. */
const depositsPaused: CatalogEntry = {
  message: "Deposits for this asset are paused.",
  funds: "Nothing transferred",
  nextAction: "Balance and withdraw unaffected",
};

/** SPEC §9.6 verbatim: TransferMismatch / TransferFailed. */
const transferRejected: CatalogEntry = {
  message: "The token did not transfer the exact amount; the transaction was canceled.",
  funds: "No change",
  nextAction: "Help link",
};

/** SPEC §9.6 verbatim: RoundNotClosed / RequestWindowStillOpen. */
const tooEarly: CatalogEntry = {
  message: "Too early for this action",
  funds: "No change",
  nextAction: "Show when it becomes available",
};

/** SPEC §9.6 verbatim: RequestWindowClosed. */
const tooLate: CatalogEntry = {
  message: "Too late for this action",
  funds: "No change",
  nextAction: "Show when it becomes available",
};

/**
 * Vault per-round limit rows (SPEC §8.1 "the Vault per-round limit errors"). Only a faulty Draw can reach
 * these, so they say a safety limit stopped the call, that nothing moved, and to report it.
 */
const safetyLimitNextAction = "Report it with the transaction hash; do not send it again";

/** requestDraw pre-check rows (SPEC §6.2, §7.1): no player funds move and the round still refunds at its deadline. */
const requestRefundsNextAction =
  "The operator is alerted; if it is not resolved, the round refunds in full after its 24-hour window";

export const errorCatalog = {
  // --- Identity and configuration ------------------------------------------------------------------
  InvalidId: {
    message: "That round, pool or asset does not exist.",
    funds: "No change",
    nextAction: "Return to Pools and pick a round",
  },
  InvalidKind: {
    message: "This tier is not one of daily, weekly or monthly.",
    funds: "No change",
    nextAction: "Pick a tier from the pool page",
  },
  InvalidConfig: {
    message: "These settings are not valid, so nothing was changed.",
    funds: "No change",
    nextAction: "Check the values on the admin page and send it again",
  },
  InvalidAmount: {
    message: "This amount cannot be used here: it is zero, or the account it names has nothing to claim.",
    funds: "No change",
    nextAction: "Enter an amount above zero, or check the account you asked about",
  },
  InvalidRecipient: {
    message:
      "This address cannot be used for this action: the zero address and the LuckyDraw contracts are refused, and ownership can never be renounced.",
    funds: "No change",
    nextAction: "Use a different address",
  },
  InvalidAsset: {
    message: "This asset is not listed for LuckyDraw.",
    funds: "Nothing transferred",
    nextAction: "Pick a listed asset",
  },
  Unauthorized: {
    message:
      "This method accepts calls from one fixed contract only (the LuckyDraw contract for the Vault, the randomness coordinator for the draw callback), so the call was refused.",
    funds: "No change",
    nextAction: "Use the app's own controls; report it with the transaction hash if the app itself sent this",
  },
  AlreadyBound: {
    message: "The Vault is already bound to a LuckyDraw contract, and that binding is permanent.",
    funds: "No change",
    nextAction: "No action is possible; the binding cannot be changed",
  },
  AlreadyListed: {
    message: "This asset is already listed.",
    funds: "No change",
    nextAction: "Pick a different asset",
  },
  // SPEC §9.6 verbatim.
  AlreadyClaimed: {
    message: "This refund was already credited to your balance.",
    funds: "No change",
    nextAction: "Go to Wallet",
  },

  // --- State and time ------------------------------------------------------------------------------
  WrongState: {
    message: "This round has moved on, so this action no longer applies to it.",
    funds: "No change",
    nextAction: "Refresh the round and use the action it shows",
  },
  // SPEC §9.6 verbatim.
  EntryWindowClosed: {
    message: "This round has closed: its target was reached or its cutoff passed.",
    funds: "Nothing debited",
    nextAction: "Link to the current round",
  },
  RoundNotClosed: tooEarly,
  RequestWindowStillOpen: tooEarly,
  RequestWindowClosed: tooLate,
  // SPEC §9.6 verbatim.
  DeadlineExpired: {
    message: "Your quote expired before the transaction was included.",
    funds: "Nothing debited",
    nextAction: "Re-quote with the same amount",
  },

  // --- Pauses and enablement -----------------------------------------------------------------------
  DepositsPaused: depositsPaused,
  DepositsDisabled: depositsPaused,
  BuysPaused: entriesPaused,
  PoolDisabled: entriesPaused,

  // --- Balances and transfers ----------------------------------------------------------------------
  // SPEC §9.6 verbatim.
  InsufficientBalance: {
    message: "Your LuckyDraw balance is {available} {symbol}; this entry needs {gross}.",
    funds: "Nothing debited",
    nextAction: "Top-up with intent preserved",
    params: ["available", "symbol", "gross"],
  },
  TransferMismatch: transferRejected,
  TransferFailed: transferRejected,

  // --- Vault per-round limits (V5): only a faulty Draw reaches these ---------------------------------
  EscrowClosed: {
    message: "A contract safety limit stopped this: the round's escrow is already closed. Nothing moved.",
    funds: "No change",
    nextAction: safetyLimitNextAction,
  },
  RefundExceedsLocked: {
    message:
      "A contract safety limit stopped this: the refund asked for more than the round holds. Nothing moved.",
    funds: "No change",
    nextAction: safetyLimitNextAction,
  },
  SeedCapExceeded: {
    message:
      "A contract safety limit stopped this: the operator seed asked for more than the seed account authorized for this round's asset. Nothing moved.",
    funds: "No change",
    nextAction: safetyLimitNextAction,
  },
  SeedAlreadyLocked: {
    message:
      "A contract safety limit stopped this: this round's operator seed is already locked. Nothing moved.",
    funds: "No change",
    nextAction: safetyLimitNextAction,
  },
  // SPEC §9.6 verbatim.
  SeedAccountCannotBuy: {
    message: "This account is authorized for operator seeding and cannot make player entries.",
    funds: "Nothing debited",
    nextAction: "Use a player account, or revoke this asset's seed authorization before re-quoting",
  },

  // --- Price reference -----------------------------------------------------------------------------
  PriceUnavailable: priceReference,
  PriceInvalid: priceReference,
  PriceStale: priceReference,
  PriceDecimalsChanged: priceReference,
  // SPEC §9.6 verbatim.
  BelowMinimum: {
    message: "The minimum entry is now {min} {symbol} (USD 1 at the current reference price).",
    funds: "Nothing debited",
    nextAction: "Input preserved; Use minimum",
    params: ["min", "symbol"],
  },
  // SPEC §9.6 verbatim.
  NetContributionTooLow: {
    message: "Fee rounding moved by more than one unit; please re-quote.",
    funds: "Nothing debited",
    nextAction: "Re-quote",
  },

  // --- Randomness request pre-checks ----------------------------------------------------------------
  InvalidRequestId: {
    message:
      "The randomness service returned an identifier this round cannot use, so no request was recorded.",
    funds: "No change",
    nextAction:
      "Anyone can try the request again; if it keeps failing, the round refunds in full after its 24-hour window",
  },
  KeyHashUnsupported: {
    message: "The randomness service no longer lists the key this deployment uses, so no request was sent.",
    funds: "No change",
    nextAction: requestRefundsNextAction,
  },
  SubscriptionUnderfunded: {
    message:
      "The operator's randomness subscription does not hold enough BNB for this request, so no request was sent.",
    funds: "No change",
    nextAction: requestRefundsNextAction,
  },

  // --- Operator seed (seedRound; operator-facing) -----------------------------------------------------
  // `seedRound` also reverts `BuysPaused` while the global or the pool's buy stop is set, so the operator
  // sees the shared `entriesPaused` row above: a paused pool takes no entries at all, the operator seed
  // included (SPEC §5.4, §8.1).
  SeedNotConfigured: {
    message: "This pool has no operator seed amount set, so there is nothing to seed.",
    funds: "Nothing debited",
    nextAction: "Set a seed amount for the pool, or leave the round unseeded",
  },
  SeedNotAuthorized: {
    message:
      "The operator seed account has not authorized a debit this large in this round's asset, so no seed was taken.",
    funds: "Nothing debited",
    nextAction: "Raise the seed account's own authorization for this asset, then seed the round again",
  },
  InsufficientSeedBalance: {
    message: "The operator seed account does not have enough available balance for this pool's seed.",
    funds: "Nothing debited",
    nextAction: "Top up the seed account, then seed the round again",
  },
  AlreadySeeded: {
    message: "This round already has its operator seed.",
    funds: "No change",
    nextAction: "No action is needed",
  },

  // --- OpenZeppelin errors carried in the compiled ABIs ----------------------------------------------
  OwnableUnauthorizedAccount: {
    message: "The connected account is not the owner of this contract.",
    funds: "No change",
    nextAction: "Switch to the owner account, or prepare the call for the owner multisig",
  },
  OwnableInvalidOwner: {
    message: "This address cannot be the owner of this contract.",
    funds: "No change",
    nextAction: "Use a different owner address",
  },
  ReentrancyGuardReentrantCall: {
    message: "A re-entrant call was blocked. Nothing moved.",
    funds: "No change",
    nextAction: "Report it with the transaction hash",
  },
  SafeERC20FailedOperation: {
    message: "The token refused this transfer, so the transaction was canceled.",
    funds: "Nothing transferred",
    nextAction: "Check the token and the amount, then try again; report it if it repeats",
  },
} satisfies Record<string, CatalogEntry>;

/** Every custom error name the catalog covers. */
export type ErrorCatalogKey = keyof typeof errorCatalog;
