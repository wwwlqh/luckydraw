// Every string the `/wallet` and `/entries` surfaces show (SPEC §9.7: "English only in v1 with every string
// in one externalized catalog").
//
// This module is the wallet/entries half of that catalog; `strings/en.ts` holds the app chrome and the lead
// re-exports this one from there. What is deliberately NOT here: any message for a contract revert, a Panic,
// a QuoteReason or a round state. Those live in `@luckydraw/client`'s catalog and are read through
// `catalogEntryFor` / `stateCatalog`, so a sentence SPEC §9.6 fixes exists in exactly one place.
//
// Copy rules from §9.1 X7 and §9.7: sentence case, plain words ("entry", "your share", "prize", "refund",
// "fee"), never "bet", "jackpot" or "guaranteed", and never a claim of certainty the chain has not produced.
// Nothing here formats a number: `{placeholders}` are filled with already-formatted strings by `fill`.

export const walletEn = {
  wallet: {
    title: "Wallet",
    intro:
      "Deposits and withdrawals are yours alone: LuckyDraw charges no fee on either, and a withdrawal " +
      "always goes to the address that signs it.",
    columnWallet: "In your wallet",
    columnLuckyDraw: "In LuckyDraw balance",
    available: "Available",
    committed: "Committed to rounds",
    committedHint: "Entered in a round that has not finished. It is not available to withdraw or re-enter.",
    committedUnknown: "Still reading your rounds",
    committedScanning: "Counting the rounds you have entered…",
    committedError: "Committed amounts could not be read. Available balance and withdrawal are unaffected.",
    detailsHeading: "Asset and network details",
    detailContract: "Token contract",
    detailNative: "Native coin of this network, so it has no token contract",
    detailDecimals: "Decimals",
    detailNetwork: "Network",
    detailVault: "Held by",
    detailDepositsOn: "Deposits are open",
    detailDepositsOff: "Deposits are paused for this asset",
    gasHeading: "Network fees",
    gasBody:
      "Every transaction on this page costs {symbol} from your wallet as network gas. That is paid to the " +
      "chain, not to LuckyDraw.",
    gasMissing: "Your wallet holds no {symbol}, so a transaction cannot be sent until you add some.",
    unlistedNotice: "This asset is not listed on this deployment, so it cannot be deposited.",
    connectPrompt: "Connect a wallet to see your balances and to deposit or withdraw.",
    topUpHeading: "Top up for a round",
    topUpBody:
      "The amount below is prefilled from the round you came from. Nothing is entered into that round here: " +
      "deposit first, then confirm the entry on the round page.",
    topUpBack: "Back to round",
    topUpUnknownAsset: "That link named an asset this deployment does not have, so nothing was prefilled.",
  },

  deposit: {
    heading: "Deposit",
    amountLabel: "Amount to deposit",
    amountHint: "Use a full stop for decimals. Up to {decimals} decimal places.",
    max: "Use wallet balance",
    review: "Review deposit",
    confirm: "Confirm in wallet",
    cancel: "Change amount",
    previewHeading: "Before you sign",
    previewAmount: "Deposit",
    previewBalanceAfter: "LuckyDraw balance afterwards",
    previewWalletAfter: "Wallet balance afterwards",
    previewNextStep: "Next step",
    stepsHeading: "Steps",
    stepApproveReset:
      "Set the existing allowance to zero. This token refuses a new approval while an old one stands.",
    stepApprove: "Approve exactly {amount} to the Vault. Never an unlimited amount, and never to the Draw.",
    stepDeposit: "Deposit {amount} into your LuckyDraw balance.",
    stepDepositNative: "Deposit {amount}. Native deposits are a single transaction.",
    stepDone: "Done",
    stepCurrent: "Now",
    stepWaiting: "Waiting",
    approvalSkipped: "Your existing allowance already covers this amount, so no approval is needed.",
    allowanceHeading: "Outstanding allowance",
    allowanceBody: "The Vault may still take up to {amount} from this token under an earlier approval.",
    revoke: "Revoke allowance",
    revokeConfirm: "Confirm in wallet",
    revokeConfirmLabel: "Confirm setting the Vault allowance for {symbol} to zero",
    revokeCancel: "Keep the allowance",
    revokePreviewHeading: "Before you sign",
    revokePreviewBody:
      "This sets the Vault's {symbol} allowance to zero. Nothing moves and your balances do not change; " +
      "a later deposit will ask for a fresh approval of its exact amount.",
    revokeLabel: "Set the Vault allowance for {symbol} to zero",
    success: "Available to use now; shown as final once the chain finalizes it, usually within seconds.",
    refusedTitle: "Deposit refused before anything was signed",
    // SPEC §9.6 requires a decoded summary before every wallet prompt. If the live allowance moves between
    // Review and Confirm, the first step can change, so the step on screen is no longer the step that would
    // be signed and nothing is sent.
    allowanceChanged:
      "The allowance changed while you were reviewing. Check the updated step before signing.",
    allowanceChangedNext: "Read the updated step above, then confirm again.",
    amountEmpty: "Enter an amount to deposit.",
    amountTooManyDecimals: "This asset has {decimals} decimal places; remove the extra digits.",
    amountComma: "Use a full stop as the decimal separator.",
    amountNegative: "Enter a positive amount.",
    amountInvalid: "Enter digits and at most one full stop.",
    amountTooLarge: "That amount is larger than this asset can represent.",
    amountAboveWallet: "Your wallet holds {available}; this deposit asks for {amount}.",
    label: "Deposit {amount}",
    approveLabel: "Approve {amount}",
    revokeTxLabel: "Revoke the {symbol} allowance",
  },

  withdraw: {
    heading: "Withdraw",
    amountLabel: "Amount to withdraw",
    max: "Use full balance",
    review: "Review withdrawal",
    confirm: "Confirm in wallet",
    cancel: "Change amount",
    noMinimum: "There is no minimum and no withdrawal fee. Any amount you hold can leave.",
    destinationLabel: "Destination",
    destinationNote: "Withdrawals go only to this address; send onward from your wallet afterwards.",
    copyDestination: "Copy the destination address",
    contractWarningTitle: "This address is a contract",
    contractWarningBody:
      "The connected address holds code, and {symbol} arrives as a plain transfer. If that contract does " +
      "not accept a plain {symbol} transfer, the transaction fails, nothing leaves and your balance stays " +
      "where it is.",
    previewHeading: "Before you sign",
    previewAmount: "Withdraw",
    previewBalanceAfter: "LuckyDraw balance afterwards",
    previewDestination: "Arrives at",
    amountAboveBalance: "Your LuckyDraw balance is {available}; this withdrawal asks for {amount}.",
    label: "Withdraw {amount}",
    nothingToWithdraw: "You have no {symbol} in your LuckyDraw balance yet.",
  },

  entries: {
    title: "My entries",
    intro: "Every round this account has entered, read from the chain.",
    connectPrompt: "Connect a wallet to see the rounds this account has entered.",
    tabsLabel: "Entry state",
    tabActive: "Active",
    tabAwaiting: "Awaiting result",
    tabWon: "Won",
    tabRefunds: "Refunds",
    tabPast: "Past",
    tabCount: "{label} ({count})",
    emptyActive: "No open round has an entry from this account.",
    emptyAwaiting: "No round of yours is waiting for a result.",
    emptyWon: "No round of yours has been settled in your favour yet.",
    emptyRefunds: "No round of yours is refunding.",
    emptyPast: "No round of yours has finished yet.",
    emptyAll: "This account has not entered a round on this deployment.",
    loading: "Reading the rounds this account has entered…",
    scanning: "Scanning the chain for your entries: {done} of {total} blocks.",
    partialTitle: "Showing what has been found so far",
    partialBody:
      "The history scan is still running, so a round you entered may not be listed yet. Nothing shown is " +
      "wrong; the list only grows.",
    errorTitle: "Your entries could not be read",
    errorRetry: "Scan again",
    rowRound: "Round {roundId}",
    rowGross: "Entered",
    rowShare: "Your share",
    rowShareOpen: "current share, changes until cutoff as others enter",
    rowShareFinal: "share at the draw",
    rowView: "Open round",
    rowClaim: "Claim refund",
    rowClaimed: "Refund credited to your balance",
    rowGoToWallet: "Go to Wallet",
    rowPrize: "Prize credited to your balance",
    rowNotSelected: "Not selected. Your entry was not drawn.",
    rowUnsettled: "No result yet.",
    // SPEC §9.6 Void: "No player entries; when the round was seeded, the operator seed was returned to the
    // seed account in the closing transaction. No player funds were committed."
    rowVoid: "No player entries; the operator seed was returned",
    rowPrizeAmount: "Prize",
    rowRefundCredited: "Refund credited",
    claimLabel: "Claim the refund for round {roundId}",
    refundHeading: "Refund",
    refundClaimable: "Anyone can send this claim; it credits your LuckyDraw balance and costs only gas.",
    refundNoFee: "Refunds return the full entry, the 3% fee included. No fee is charged on a refund.",
    refundAmount: "Refund due",
    refundReview: "Review claim",
    refundConfirm: "Confirm in wallet",
    refundCancel: "Cancel",
    refundPreviewHeading: "Before you sign",
    refundBalanceAfter:
      "This credits {amount} to your LuckyDraw balance. Withdraw it from Wallet whenever you like.",
    // Short badge labels for the SPEC §6.2 states. The full sentence for each state lives in the client's
    // `stateCatalog`; these are the two-or-three words a badge can carry next to its glyph (SPEC §9.3).
    stateLabels: {
      Open: "Open",
      AwaitingRequest: "Closed, waiting for a request",
      Drawing: "Waiting for randomness",
      Ready: "Ready to settle",
      Settled: "Settled",
      Refunding: "Refunding",
      Void: "Void",
    },
  },

  // SPEC §9.4 requires a count badge on the My entries and Wallet navigation items for claimable refunds and
  // for prize or refund credits since the account last acknowledged them, plus a dismissible banner on `/`.
  // Both are deferred with the acknowledgement store they need; this is the marked slot they fill.
  deferred: {
    unclaimedBadgeSlot: "unclaimed-money-badge",
  },
} as const;

export type WalletStrings = typeof walletEn;
