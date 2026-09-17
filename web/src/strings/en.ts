// The app's externalized string catalog (SPEC §9.7: "English only in v1 with every string in one
// externalized catalog").
//
// What is NOT here: every message for a contract revert, a Panic, a QuoteReason, a SeedSkipReason, a wallet
// condition or a round state. Those live in `@luckydraw/client`'s catalog, are traced to SPEC §9.6 by that
// package's tests, and are read through `catalogEntryFor` / `stateCatalog`. Duplicating one here would let
// the two drift, so this file holds only the chrome: navigation, labels, empty states and the app's own
// notices.
//
// Copy rules from §9.7 and §9.1: sentence case, plain words ("entry", "your share", "prize", "refund",
// "fee"), never "bet", "jackpot" or "guaranteed", and no claim of certainty the chain has not produced.

/** Substitutes `{name}` placeholders. Values are already-formatted strings; this never formats a number. */
export function fill(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) => params[name] ?? match);
}

export const en = {
  app: {
    name: "LuckyDraw",
    skipToContent: "Skip to main content",
    mainLandmark: "Main content",
    loading: "Loading…",
    retry: "Try again",
    close: "Close",
    copy: "Copy",
    copied: "Copied",
    openInExplorer: "View on the block explorer",
    explorerUnavailable: "This chain has no block explorer configured.",
  },

  banner: {
    local: "Local, no real value",
    testnet: "Testnet, no real value",
    detail: "This build is pinned to {environment} deployment {deploymentId}. Nothing here is real money.",
  },

  nav: {
    label: "Main",
    pools: "Pools",
    entries: "My entries",
    wallet: "Wallet",
    verify: "Verify",
    help: "Help",
  },

  theme: {
    label: "Theme",
    system: "Match system",
    light: "Light",
    dark: "Dark",
    toggleTo: "Switch to {mode} theme",
  },

  wallet: {
    connect: "Connect wallet",
    connecting: "Connecting…",
    disconnect: "Disconnect",
    modalTitle: "Connect a wallet",
    modalIntro:
      "LuckyDraw never asks for a seed phrase or a message signature. Your wallet shows the contract and " +
      "the amount before you approve anything.",
    recommendedBadge: "Recommended",
    detectedBadge: "Detected",
    installAction: "Install",
    installHint: "MetaMask is not in this browser yet.",
    deepLinkHint: "Open this page in the MetaMask app to connect.",
    noConnectors: "No wallet was found in this browser.",
    accountLabel: "Connected account",
    connected: "Wallet connected: {address}",
    providerChanged:
      "The wallet behind this connection was replaced while it was connected, so the session was ended. " +
      "Reconnect before signing anything.",
    copyAddress: "Copy address",
    chainLabel: "Network",
    unknownChain: "Chain {chainId}",
    // A wallet extension writes its own error text. The app says what happened in its own voice first, and
    // the wallet's words are shown underneath, labelled, so they never read as LuckyDraw speaking (§9.7).
    errorReported: "Your wallet reported an error.",
    errorSaidLabel: "Wallet said:",
  },

  network: {
    guardTitle: "Wrong network",
    switchAction: "Switch to {chain}",
    switching: "Waiting for your wallet…",
    readsStillWork: "Pools and history keep loading; only actions that move funds are disabled.",
  },

  gate: {
    verifying: "Checking this deployment against the chain before anything can be signed.",
    verifyFailed: "This deployment did not pass its checks, so nothing can be signed: {detail}",
    verifyFailedTitle: "Deployment check failed",
    recheck: "Check again",
  },

  data: {
    freshnessLabel: "Chain data",
    block: "Block {block}",
    age: "{age} old",
    ageNow: "just now",
    confidenceFinalized: "Finalized",
    confidenceSafe: "Safe",
    confidenceLatest: "Provisional",
    confidenceLatestDepth: "Provisional, {depth} blocks behind",
    unavailable: "Chain data is unavailable right now.",
  },

  tx: {
    stepperLabel: "Transaction progress",
    stepPreview: "Review",
    stepWalletConfirmation: "Confirm in wallet",
    stepSubmitted: "Submitted",
    stepIncluded: "Included",
    stepConfirmed: "Confirmed",
    stateIdle: "Nothing in progress.",
    statePreview: "Check the amounts, then confirm in your wallet.",
    stateWalletConfirmation: "Confirm in your wallet.",
    stateSubmitted: "Sent to the network. Waiting for it to be included in a block.",
    stateIncluded: "Included in a block. Shown as final once the chain confirms it.",
    stateConfirmed: "Confirmed by the chain.",
    stateRejected: "You canceled in your wallet.",
    stateReverted: "The transaction failed on chain.",
    stateReplaced: "This transaction was replaced by another one from your wallet.",
    stateDropped: "The network no longer has this transaction.",
    stateWalletUnreachable: "Wallet disconnected before a signature was received; nothing is confirmed sent.",
    walletUnreachableWithHash:
      "Your wallet lost contact after sending this transaction, so it was signed and broadcast. It is not " +
      "confirmed yet. Check it by the hash below; do not send it again.",
    hashMismatch: "The transaction under this hash is not the one this app prepared.",
    provisional: "Provisional",
    neverResend: "LuckyDraw never resends a transaction for you. Check it by its hash before sending again.",
    resume: "Checking a transaction this browser had in progress.",
    dismiss: "Dismiss",
    timestamp: "at {time}",
    hashLabel: "Transaction hash",
    selectorLabel: "Error selector",
    dataLabel: "Error data",
    funds: "Funds: {funds}",
    nextAction: "Next: {next}",
    estimating: "Checking this transaction against the current state of the chain…",
  },

  /**
   * The limitations SPEC §14 requires the app to state in the same terms as the contracts, and the §7.3
   * availability limitation with its make-whole commitment. Shown on the help page and on every round page.
   * Plain words, no reassurance the chain has not produced (§9.7).
   */
  limits: {
    heading: "Limits and risks",
    intro: "The same limitations the contracts have, in plain words. They apply to every round.",
    // A visible word, not a colour, is what marks these as the serious part of the page (§9.3).
    noticeLabel: "Important",
    drawing:
      "Once a round's randomness request has been accepted, the round stays in Drawing until the oracle " +
      "fulfils it. There is no timeout and no refund after that point. If fulfilment never arrives, that " +
      "round's escrow, the reserved fee included, stays locked and no one can release it.",
    makeWhole:
      "Make-whole commitment: if a round has been in Drawing for more than 7 days, the operator reimburses " +
      "every affected buyer's gross entry, fee included, by direct transfer from the treasury within 3 " +
      "business days and records the transaction hashes on Verify. It is a voluntary payment out of " +
      "operator funds, not a release of the locked escrow, and it does not reopen the round.",
    makeWholeAmounts:
      "Reserve published in this deployment: {reserve}. Stated cap: {cap}. Beyond the cap, reimbursement " +
      "is best effort.",
    makeWholeUnfunded:
      "This deployment's manifest records no make-whole reserve and no cap yet, so no reimbursement amount " +
      "is published and reimbursement is best effort.",
    uncapped:
      "There is no maximum entry and no maximum pot. Someone can enter far more than you did, which lowers " +
      "your share of the round, and the pot can grow without limit.",
    noCashOut:
      "There is no cash-out. Funds move only through the contract: deposit, enter, withdraw. An entry " +
      "cannot be sold, cancelled or bought back, and LuckyDraw holds no other way to pay you.",
    seedIsAnEntry:
      "The operator seeds a funded round with an entry of its own so that a lone player gets a draw " +
      "instead of a refund. That seed is an ordinary entry: it takes a share of the round and it can win.",
    entryFee:
      "3% of every entry is deducted when the entry is made and reserved as the platform fee. It is " +
      "deducted whether you win or lose. A refund returns it along with the rest of your entry.",
    pause:
      "The operator can pause new entries at any time, for one pool or for all of them. A pause never " +
      "stops withdrawals, refunds, or a round that is already drawing.",
  },

  /** The operator's own jurisdiction sentence (SPEC §14). Rendered as plain text, never as markup. */
  jurisdiction: {
    heading: "Where this is available",
    label: "Availability",
  },

  states: {
    // Pairs with an icon and a label; never colour alone (SPEC §9.3).
    pending: "Pending",
    failed: "Failed",
    done: "Done",
    info: "Information",
  },

  empty: {
    title: "Nothing here yet",
    body: "When there is something to show, it appears here.",
  },

  error: {
    title: "Something went wrong",
    body: "The page could not finish loading. Nothing was sent and no funds moved.",
    boundaryTitle: "This page stopped working",
    boundaryBody:
      "Nothing was sent and no funds moved. Reload the page; if it keeps happening, copy the detail below.",
    reload: "Reload the page",
    detail: "Detail",
  },

  pages: {
    placeholderNote:
      "This route is a placeholder in the current build. The deployment, read and wallet layers below are " +
      "live, so the page that replaces it has nothing left to wire up.",
    home: {
      title: "Pools",
      intro: "Deposit, enter before the UTC cutoff, and winnings are credited to your LuckyDraw balance.",
    },
    round: {title: "Round {roundId}", missing: "This route needs a chain id and a round id."},
    wallet: {title: "Wallet"},
    entries: {title: "My entries"},
    notFound: {title: "Page not found", body: "That address does not match any page in this app."},
    verify: {
      title: "Verify",
      intro: "Everything this app claims can be checked against the chain and the explorer.",
      deploymentHeading: "This deployment",
      trustHeading: "What the contracts guarantee",
      domainHeading: "Official domain",
      domainPlaceholder:
        "The official domain is not published yet. Until it is, treat any site claiming to be LuckyDraw " +
        "as unverified, and check that the contract address your wallet shows before you approve anything " +
        "is the one on the Verify page.",
      walletsHeading: "Tested wallets",
      walletsBody:
        "MetaMask on the Chrome, Brave, Firefox and Edge extensions, in the MetaMask mobile in-app browser, " +
        "and through the MetaMask mobile deep link. Other injected wallets connect through EIP-6963.",
      trust: [
        "Funds are held by the LuckyVault contract, not by the operator. The operator cannot move your balance.",
        "The 3% entry fee is fixed in the contract. The operator cannot change it, pick winners, or stop withdrawals.",
        "Token approvals are for the exact deposit amount and always to the Vault, never to the Draw contract.",
        "The app never asks for a seed phrase and never asks you to sign a message to log in.",
        "Every round's winner comes from Chainlink VRF randomness that is verified on chain.",
      ],
      fields: {
        deploymentId: "Deployment id",
        environment: "Environment",
        chain: "Chain",
        draw: "Draw contract",
        vault: "Vault contract",
        codeHashDraw: "Draw code hash",
        codeHashVault: "Vault code hash",
        compiler: "Compiler",
        checks: "Checks that passed",
      },
      // The contract card: the manifest this build was made from, field by field, each one copyable and,
      // where the chain record names an explorer, linked to it (SPEC §9.2, §12).
      contractsHeading: "Contracts in this build",
      contractsIntro:
        "Read from the deployment manifest this build was compiled against, not from the chain. Compare " +
        "each address with the one your wallet shows before you approve anything.",
      drawHeading: "Draw",
      vaultHeading: "Vault",
      addressLabel: "Address",
      codeHashLabel: "Code hash",
      deployBlockLabel: "Deployed in block",
      explorerAddress: "Contract on the block explorer",
      explorerBlock: "Block on the block explorer",
      copyField: "Copy {field}",
      makeWholeHeading: "Make-whole reserve",
      makeWholeReserve: "Published reserve",
      makeWholeCap: "Stated cap",
      notRecorded: "Not recorded in this deployment's manifest",
    },
    help: {
      title: "Help",
      intro: "Plain answers. Nothing here is legal or financial advice.",
      sections: [
        {
          heading: "How it works",
          body:
            "Deposit an asset into your LuckyDraw balance, enter a round before its UTC cutoff, and the " +
            "winner's prize is credited back to their balance. You withdraw whenever you like.",
        },
        {
          heading: "Fees",
          body:
            "3% of every entry is reserved as the platform fee when the entry is made. There is no deposit " +
            "fee and no withdrawal fee. Network gas is paid to the chain, not to LuckyDraw.",
        },
        {
          heading: "Cutoffs and time zones",
          body:
            "Every cutoff is a fixed UTC time: daily at 00:00, weekly on Monday at 00:00, and monthly on " +
            "the first of the month at 00:00. A round can also draw earlier, as soon as its USD target is reached.",
        },
        {
          heading: "Refunds",
          body: "If a round cannot draw, every entry is refunded in full, fee included, to your LuckyDraw balance.",
        },
        {
          heading: "Security and trust",
          body:
            "The contracts are not upgradeable and the operator holds no key that can move your balance. " +
            "Check the contract address shown in your wallet against the one on the Verify page before approving.",
        },
        {
          heading: "Responsible play",
          body:
            "This is a game of chance for adults only: 18+. Only enter what you can afford to lose. " +
            "If you do not win, your entry is not returned.",
        },
        {
          heading: "Privacy",
          body:
            "There is no account and no sign-in. Your wallet activity is public on the chain, and the RPC " +
            "provider this app reads through observes the address you connect.",
        },
      ],
    },
  },
} as const;

export type Strings = typeof en;

// The catalog is one place with per-area modules: the pages import their own module, and this file
// re-exports every module so a reviewer can find every user-facing string from here (SPEC section 9.7).
export {type RoundStrings, rounds as roundsEn} from "./rounds.ts";
export {type WalletStrings, walletEn} from "./wallet.ts";
