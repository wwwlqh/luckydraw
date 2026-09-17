// Strings for the pools page, the round page and the entry flow (SPEC §9.4, §9.5, §9.6, §9.7).
//
// A second module next to `en.ts` rather than an edit of it: `en.ts` is the foundation's chrome catalog and
// two builders extend it concurrently. Everything here is still one externalized catalog in the §9.7 sense —
// no page or component in `components/rounds/` or `lib/rounds/` holds a user-facing sentence of its own.
//
// What is NOT here, deliberately: every message for a revert, a Panic, a QuoteReason, a SeedSkipReason or a
// round state. Those live in `@luckydraw/client`'s catalog (`catalogEntryFor`, `stateCatalog`) and are traced
// to SPEC §9.6 by that package's tests. Duplicating one here would let the two drift.
//
// Copy rules of §9.1 X7 and §9.7: sentence case, plain words ("entry", "your share", "prize", "refund",
// "fee"), never "bet", "jackpot" or "guaranteed", `≈` before every USD estimate.

export const rounds = {
  home: {
    title: "Pools",
    intro: "Deposit, enter before the UTC cutoff, and winnings are credited to your LuckyDraw balance.",
    listLabel: "Open rounds",
    loading: "Loading pools",
    empty: "No pool is open on this deployment yet.",
    emptyBody: "When the operator adds a pool, its rounds appear here.",
    unclaimedSlot: "Unclaimed money banner",
    howItWorks: {
      title: "How it works",
      dismiss: "Got it",
      dismissLabel: "Dismiss the how it works steps",
      steps: [
        {
          heading: "1. Deposit",
          body: "Move an asset into your LuckyDraw balance. There is no deposit fee and no withdrawal fee.",
        },
        {
          heading: "2. Enter before the cutoff",
          body: "Enter a round with any amount worth at least USD 1. 3% of every entry is reserved as the platform fee.",
        },
        {
          heading: "3. Winnings are credited",
          body: "A round draws as soon as its USD target is reached, and at its UTC cutoff at the latest. The prize is credited to the winner's balance.",
        },
      ],
    },
    filters: {
      label: "Filters",
      assetLabel: "Asset",
      tierLabel: "Tier",
      all: "All",
      // Since ADR 036 a pool has seven tiers, so eight chips on one row wrap to five or six lines on a
      // 375 px screen. The tier chips are grouped by cadence instead, one labelled row each, and inside a
      // row the cadence is already said by the row label, so the chip only needs its target.
      cadenceLabels: {
        day: "Daily · USD",
        week: "Weekly · USD",
        month: "Monthly · USD",
      },
      // Short form of `card.kinds.*`: the row label carries both the cadence and the "USD", so the chip
      // carries only the target. `card.kinds.*` stays the accessible name, so nothing is lost to a reader
      // that meets the chip outside its row.
      tierTargets: {
        Day100: "100",
        Day1k: "1,000",
        Day10k: "10,000",
        Week1k: "1,000",
        Week10k: "10,000",
        Week100k: "100,000",
        Month100k: "100,000",
      },
      clear: "Clear filters",
      none: "No round matches these filters.",
      noneBody: "Clear a filter to see the other pools.",
    },
  },

  card: {
    // "USD 1,000 · draws when reached · latest Mon 00:00 UTC in 2 d 3 h" (SPEC §9.4).
    tier: "USD {target} · draws when reached · latest {cutoff} in {remaining}",
    tierClosed: "USD {target} · draws when reached · cutoff {cutoff} has passed",
    tierNoRound: "USD {target} · draws when reached",
    // One label per `Kind` (SPEC §5, ADR 036): three daily tiers, three weekly tiers, one monthly tier.
    kinds: {
      Day100: "Daily · USD 100",
      Day1k: "Daily · USD 1,000",
      Day10k: "Daily · USD 10,000",
      Week1k: "Weekly · USD 1,000",
      Week10k: "Weekly · USD 10,000",
      Week100k: "Weekly · USD 100,000",
      Month100k: "Monthly · USD 100,000",
    },
    potLabel: "Prize pot",
    potUsd: "≈ USD {usd}",
    potUsdUnavailable: "USD estimate unavailable while the price reference is not usable",
    includesSeed: "Includes operator seed",
    participants: "{players} entered",
    participantsOne: "1 entered",
    participantsNone: "No player has entered yet",
    seedSeparate: "plus the operator seed",
    yourShare: "Your share",
    yourShareNone: "You have not entered this round",
    shareNote: "current share, changes until cutoff as others enter",
    enter: "Enter",
    view: "View round",
    open: "Open",
    stateActive: "Open",
    stateAwaitingAction: "Closed, waiting for an action",
    stateDisabled: "Pool disabled",
    stateUnavailable: "Entries unavailable",
    disabledBody: "The operator disabled this pool. Existing rounds finish normally and no new round opens.",
    unavailableBody: "Entries are paused for this pool or its price reference is not usable right now.",
    noRound: "No round is open for this tier yet.",
    progressLabel: "Progress toward the USD {target} target",
    progressValue: "≈ USD {usd} of USD {target}",
    progressUnknown: "Progress is unknown while the price reference is not usable.",
  },

  round: {
    title: "Round {roundId}",
    heading: "{symbol} · {kind} · round {sequence}",
    backToPools: "All pools",
    wrongChain:
      "This link is for chain {linkChain}, but this build is pinned to {deploymentChain} ({chainName}). " +
      "Nothing was read for the other chain.",
    wrongChainTitle: "This round belongs to another chain",
    notFound: "No round with this id exists on this deployment.",
    invalidId: "A round id must be a positive whole number.",
    loading: "Loading this round",
    sequence: "Round {sequence} of this pool's {kind} sequence",
    cutoffLabel: "Latest cutoff",
    targetLabel: "Target",
    targetValue: "USD {target}",
    potHeading: "Pot and prize",
    potTotal: "Pot entered",
    feeReserve: "3% fee reserve",
    prizeNow: "Prize if it drew now",
    prizeSettled: "Prize",
    prizeNote: "The prize is the pot minus the 3% fee reserve.",
    usdEstimate: "≈ USD {usd}",
    seedLine: "Includes the operator seed of {amount}.",
    // Factual, not a promise: whether the seed actually enters depends on its own authorization and balance
    // at that moment (SPEC §5.4), which only the entry panel's reading knows.
    seedPendingLine: "This pool's operator seed is {amount} per round. It has not entered this round yet.",
    unseededLine: "This round has no operator seed.",
    timelineLabel: "Round status",
    timelineOpen: "Open",
    timelineClosed: "Closed",
    timelineRequested: "Randomness requested",
    timelineResult: "Result",
    timelineDone: "done",
    timelineCurrent: "current",
    timelineWaiting: "not yet",
    positionHeading: "Your position",
    positionNone: "You have not entered this round.",
    positionConnect: "Connect a wallet to see your position in this round.",
    positionGross: "Entered",
    positionShare: "Your share",
    positionRefunded: "Refunded",
    holdersHeading: "Holders",
    holdersTop: "Top ten by gross entered",
    ledgerHeading: "Entry ledger",
    ledgerNote: "Every entry in the order the contract recorded it. Ranges decide the winner.",
    feeOddsHeading: "Fees and odds",
    feeOddsBody:
      "3% of every entry is reserved as the platform fee when the entry is made; the rest is the prize. " +
      "Your chance of winning is your share of the round's gross, and it changes until the cutoff as others enter.",
    feeOddsSeed:
      "The operator seed pays the same 3% fee and wins on the same odds per unit as any entry, so the draw goes ahead at the cutoff.",
    verifyLink: "How this round is verified",
    explorerLink: "View the contract on the block explorer",
    callerGas:
      "Anyone can send this transaction. Whoever sends it pays the network fee; it is not a platform fee and nothing is deducted from the pot.",
    requestAge: "Requested {requestedAt}, {age} ago.",
    requestFailure: "The randomness service refused this request: {reason}",
    settleHeading: "Winning calculation",
    settleWords: "Verified randomness words",
    settleIndex: "Winning index",
    settleFormula: "The winning index is the two verified words reduced across the round's gross of {gross}.",
    resultWinner: "You won this round.",
    resultWinnerPrize: "Prize credited to your LuckyDraw balance: {prize}",
    resultOther: "Not selected",
    resultOtherBody: "Your entry was not drawn. Your share was {share}.",
    resultWinnerAddress: "Winner",
    resultFee: "Fee earned by the fee account",
    refundHeading: "Refund",
    refundCredited: "Refund credited to your balance.",
    refundClaim: "Claim refund",
    refundPending: "The keeper credits every buyer within minutes. Claim it yourself if you prefer.",
    refundNoPosition: "You have no entry in this round, so there is nothing to claim.",
    voidSeedReturned: "The operator seed was returned to the seed account in the closing transaction.",
    lonePlayerSeeded: "No other player yet; the operator seed guarantees the draw.",
    lonePlayerUnseeded:
      "If nobody else enters before the cutoff this round refunds your full entry automatically.",
    successorLink: "Go to the round that is open now",
    // One short state name per row of the client's `stateCatalog`, for the badge next to the header.
    stateLabels: {
      Open: "Open",
      OpenAfterCutoff: "Closing",
      AwaitingRequest: "Awaiting randomness request",
      AwaitingRequestExpired: "Request window closed",
      Drawing: "Randomness requested",
      DrawingDelayed: "Randomness requested",
      Ready: "Ready to settle",
      Settled: "Settled",
      Refunding: "Refunding",
      Void: "Void",
    },
    countdownLabel: "Time until the cutoff",
    countdownClosed: "The cutoff has passed.",
    // Announced only at the SPEC §9.7 thresholds, never every second.
    announceHour: "One hour left before this round's cutoff.",
    announceTenMinutes: "Ten minutes left before this round's cutoff.",
    announceMinute: "One minute left before this round's cutoff.",
    announceClosed: "This round's cutoff has passed.",
  },

  holders: {
    account: "Account",
    entered: "Gross entered",
    share: "Share",
    seedRow: "Operator seed",
    you: "You",
    empty: "No entry has been recorded yet.",
    tooLarge: "This round has more entries than the app pages in one read. Use Verify for the full ledger.",
    rank: "#",
  },

  ledger: {
    index: "#",
    buyer: "Account",
    amount: "Entry",
    cumulative: "Cumulative gross",
    empty: "No entry has been recorded yet.",
  },

  pagination: {
    label: "Pagination",
    previous: "Previous",
    next: "Next",
    page: "Page {page} of {pages}",
    showing: "Showing {from}–{to} of {total}",
  },

  entry: {
    heading: "Enter this round",
    openSheet: "Enter",
    closeSheet: "Close",
    sheetLabel: "Entry panel",
    amountLabel: "Amount",
    amountHintAsset: "Amount in {symbol}. Use “.” as the decimal separator.",
    amountHintUsd: "Amount in estimated USD. Use “.” as the decimal separator.",
    modeAsset: "Enter in {symbol}",
    modeUsd: "Enter in USD",
    presetsLabel: "Quick amounts",
    preset: "USD {usd}",
    max: "Max",
    maxHint: "Your available LuckyDraw balance",
    balance: "Available balance",
    review: "Review entry",
    confirm: "Confirm entry",
    confirming: "Confirming…",
    edit: "Change amount",
    retrySameAmount: "Try again with the same amount",
    grossDebit: "You pay",
    feeReserved: "3% reserved fee",
    feeExpand: "Show full precision",
    feeCollapse: "Hide full precision",
    netAddition: "Added to the prize",
    balanceAfter: "Balance after",
    shareBefore: "Your share now",
    shareAfter: "Your share after this entry",
    shareNote: "current share, changes until cutoff as others enter",
    priceAge: "Reference price is {age} old (checked against a {max} limit).",
    priceWaiting: "The reference price is close to its age limit. Waiting for a fresh reading…",
    cutoff: "Cutoff {cutoff}",
    zone: "Your time zone is {zone}.",
    seeded:
      "The operator seed of {amount} is in this round and wins on the same odds per unit as your entry, so the draw goes ahead at cutoff.",
    seedPending:
      "The operator seed of {amount} enters with this purchase and wins on the same odds per unit as your entry, so the draw goes ahead at cutoff.",
    unseeded: "If nobody else enters, the full amount including the fee is refunded automatically.",
    final: "Entries are final until cutoff and cannot be withdrawn.",
    tenMinutes:
      "A result is normally credited within about ten minutes after cutoff, but that is not guaranteed.",
    acceptedRequest:
      "Once a randomness request is accepted the round cannot be canceled and there is no timeout refund.",
    chance: "This is a game of chance: if you do not win, your entry is not returned.",
    gas: "Estimated network fee {gas}",
    gasUsd: "≈ USD {usd}",
    gasLabel: "network gas, not a platform fee",
    gasUnavailable: "The network fee could not be estimated right now.",
    gasWarning:
      "The network fee is more than a quarter of this entry. Consider entering a larger amount, or a round with a lower fee at the time.",
    finalSeconds:
      "Less than two minutes remain. A transaction included after the cutoff reverts: nothing is debited, but the gas is spent.",
    reachesTarget:
      "Your entry reaches the USD {target} target: the draw starts right after this transaction, which also opens the next round while the pool stays enabled, so the network fee is higher.",
    reachesTargetGas: "Estimated network fee for that larger transaction: {gas}",
    fallbackSeed:
      "This transaction also enters the operator seed of {amount} for this round, which raises its network fee.",
    noTimeLeft: "The cutoff is too close to enter safely: no deadline shorter than the cutoff remains.",
    responsible: "18+ only. Only enter what you can afford to lose.",
    responsibleLink: "Responsible play and help",
    topUp: "Add funds and come back",
    topUpBody:
      "Your LuckyDraw balance is {available}; this entry needs {gross}. Deposit {shortfall} to enter.",
    insufficient: "Your balance does not cover this entry.",
    parseEmpty: "Enter an amount.",
    parseCommaSeparator: "Use “.” as the decimal separator, not “,”.",
    parseNegative: "An entry cannot be negative.",
    parseMultipleDots: "An amount has at most one decimal point.",
    parseInvalidCharacter: "Use digits and at most one “.” — no signs, spaces or exponents.",
    parseTooManyFractionDigits: "{symbol} has {decimals} decimals; this amount has more.",
    parseAboveMaxUint256: "That amount is larger than the chain can represent.",
    parseTooManyUsdDigits: "A USD amount has at most 2 decimals.",
    quoteStale: "The amount, the round or the account changed, so this preview no longer applies.",
    planMoved:
      "The round or your balance changed while you were reviewing, so these figures are no longer the ones " +
      "you approved. Review this entry again before confirming.",
    entryWindowClosed: "This round closed while you were entering. Nothing was debited.",
    label: "Enter round {roundId}",
    disclosuresLabel: "What you are about to sign",
  },

  lifecycle: {
    closeRound: "Close round",
    requestDraw: "Request draw",
    expire: "Enable refunds",
    settle: "Settle round",
    claim: "Claim refund",
    label: {
      close: "Close round {roundId}",
      request: "Request the draw for round {roundId}",
      expire: "Expire round {roundId} into refunds",
      settle: "Settle round {roundId}",
      claim: "Claim the refund for round {roundId}",
    },
    noAction: "No action is needed here.",
  },
} as const;

export type RoundStrings = typeof rounds;
