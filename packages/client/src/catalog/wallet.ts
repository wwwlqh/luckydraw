// Catalog rows for the wallet, network and data conditions that are not contract reverts (SPEC §9.2, §9.6).
//
// These cover the branches of the §9.6 transaction state machine that never reach a decoded revert: the user
// cancelling, a wallet without gas, a nonce or replacement report, the `wallet-unreachable` branch, the
// network guard, no connection at all, revert data the client cannot decode, and degraded reads.

import type {CatalogEntry} from "./types.ts";

export const walletCatalog = {
  // SPEC §9.6 verbatim: the "Wallet rejected" row.
  WalletRejected: {
    message: "You canceled in your wallet.",
    funds: "Nothing sent",
    nextAction: "Try again",
  },
  // SPEC §9.6 verbatim: the "Insufficient BNB for gas" row.
  InsufficientGas: {
    message: "You need about {gas} BNB for network fees.",
    funds: "Nothing sent",
    nextAction: "Link to getting BNB",
    params: ["gas"],
  },
  // SPEC §9.6 verbatim: the "Nonce, replacement or RPC timeout" row.
  NonceOrReplacement: {
    message: "Your wallet reports a pending or replaced transaction.",
    funds: "Unknown until receipt",
    nextAction: "Track by nonce; never resend automatically",
  },
  // SPEC §9.6 verbatim: the `wallet-unreachable` branch sentence.
  WalletUnreachable: {
    message: "Wallet disconnected before a signature was received; nothing is confirmed sent",
    funds: "Unknown until receipt",
    nextAction:
      "Reconnect; the app checks your account nonce and pending transactions before offering to send again",
  },
  // SPEC §9.2 network guard: one action, "Switch to {chain}". `{chain}` is the deployment chain record's
  // `displayName` ("BNB Smart Chain" on 56, "BNB Smart Chain Testnet" on 97): naming mainnet verbatim here
  // would send a testnet player to the wrong network. The next action names no chain: the message just did.
  WrongChain: {
    message: "Your wallet is on a different network. LuckyDraw runs on {chain}.",
    funds: "Nothing sent",
    nextAction: "Switch your wallet to that network; your input is kept and rechecked after the switch",
    params: ["chain"],
  },
  Disconnected: {
    message: "No wallet is connected, so nothing can be sent.",
    funds: "Nothing sent",
    nextAction: "Connect a wallet; your input is kept",
  },
  // SPEC §9.6: "unknown revert data shows a generic message with the copyable selector, data and transaction
  // hash". The three values are rendered next to this row as copyable fields; the catalog never formats them.
  UnknownRevert: {
    message:
      "This transaction failed for a reason the app does not recognize, so nothing about it was applied.",
    funds: "No change",
    nextAction: "Copy the selector, data and transaction hash shown here and send them to support",
  },
  // The Wallet page maps a decoded `InsufficientBalance` from `withdraw` to this row: the verbatim SPEC 9.6
  // `InsufficientBalance` row describes an entry, and a withdrawal is not an entry.
  WithdrawAboveBalance: {
    message: "Your LuckyDraw balance is {available} {symbol}; this withdrawal asks for {amount}.",
    funds: "Nothing transferred",
    nextAction: "Lower the amount, or use Max",
    params: ["available", "symbol", "amount"],
  },
  // A custom error that came from the ERC-20 token itself (an approval step, or the token call inside a
  // deposit or withdrawal), not from LuckyDraw: it must not be read as a LuckyDraw balance or state.
  TokenReverted: {
    message: "The token contract refused this operation, so nothing was transferred.",
    funds: "Nothing transferred",
    nextAction: "Check the token's own rules and your wallet balance of it, then try again",
  },
  RpcUnavailable: {
    message: "LuckyDraw cannot reach the network right now, so balances and rounds may be out of date.",
    funds: "No change",
    nextAction:
      "Retry in a moment; if a transaction was already sent, check it by its hash before sending again",
  },
  IndexerDegraded: {
    message:
      "History and totals are behind the chain right now. Balances, rounds and entries still read from the chain.",
    funds: "No change",
    nextAction: "Retry history in a moment; money actions are unaffected",
  },
} satisfies Record<string, CatalogEntry>;

export type WalletCatalogKey = keyof typeof walletCatalog;
