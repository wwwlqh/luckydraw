// Completeness and register tests for the string catalog (SPEC §8.1, §9.6, §9.7).
//
// SPEC §9.6: "Every §8.1 custom error, Panic code and §5.1 QuoteReason has an entry in the string catalog
// giving the message, the funds effect and the next action." These tests read the contracts themselves, so a
// new error, a renamed error or a reordered enum fails here instead of reaching a user as a raw selector.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {test} from "node:test";

import {luckyDrawAbi, luckyVaultAbi} from "../abi/index.ts";
import {QuoteReasonNames, SeedSkipReasonNames, StateNames} from "../types/generated.ts";

import {errorCatalog} from "./errors.ts";
import {PANIC_CODES, panicCatalog, panicCatalogKey} from "./panics.ts";
import {quoteReasonCatalog, quoteReasonCatalogKey} from "./quoteReasons.ts";
import type {CatalogKey} from "./render.ts";
import {CATALOG_KEYS, catalog, catalogEntryFor, hasCatalogEntry, renderMessage} from "./render.ts";
import {seedSkipCatalog, seedSkipCatalogKey} from "./seedSkips.ts";
import {STATE_CATALOG_KEYS_BY_STATE, stateCatalog, stateCatalogKeyFor} from "./states.ts";
import type {CatalogEntry} from "./types.ts";
import {FUNDS_PHRASES} from "./types.ts";
import {walletCatalog} from "./wallet.ts";

// ---------------------------------------------------------------------------
// Contract sources, resolved from this file, never from the working directory
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const CONTRACTS = join(REPO_ROOT, "contracts");
const ERRORS_SOL = join(CONTRACTS, "src", "Errors.sol");
const TYPES_SOL = join(CONTRACTS, "src", "Types.sol");
/** The generated ABIs, committed and checked against `contracts/out` by `pnpm abi:check`. */
const GENERATED_ABIS: readonly {label: string; abi: readonly {type: string; name?: string}[]}[] = [
  {label: "luckyDrawAbi", abi: luckyDrawAbi},
  {label: "luckyVaultAbi", abi: luckyVaultAbi},
];

/** Error names declared by `contracts/src/Errors.sol`. */
const declaredErrors = (): string[] => {
  const source = readFileSync(ERRORS_SOL, "utf8");
  const names = [...source.matchAll(/^error\s+([A-Za-z0-9_]+)\s*\(/gm)].map((match) => match[1] ?? "");
  assert.ok(names.length > 40, `expected around fifty errors in Errors.sol, parsed ${names.length}`);
  return names;
};

/** Members of a Solidity enum in `contracts/src/Types.sol`, in declaration (ABI) order. */
const enumMembers = (name: string): string[] => {
  const source = readFileSync(TYPES_SOL, "utf8");
  const match = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source);
  if (match === null) throw new Error(`enum ${name} not found in ${TYPES_SOL}`);
  return (match[1] ?? "")
    .replace(/\/\/[^\n]*/g, "")
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
};

/** Error names carried by a generated ABI, project errors and dependency errors alike. */
const abiErrorNames = (abi: readonly {type: string; name?: string}[]): string[] =>
  abi.filter((entry) => entry.type === "error").map((entry) => entry.name ?? "");

/** Errors that reach the ABIs from OpenZeppelin rather than from Errors.sol. */
const DEPENDENCY_ERRORS = [
  "OwnableUnauthorizedAccount",
  "OwnableInvalidOwner",
  "ReentrancyGuardReentrantCall",
  "SafeERC20FailedOperation",
];

const WALLET_CONDITIONS = [
  "WalletRejected",
  "InsufficientGas",
  "NonceOrReplacement",
  "WalletUnreachable",
  "WrongChain",
  "Disconnected",
  "UnknownRevert",
  "WithdrawAboveBalance",
  "TokenReverted",
  "RpcUnavailable",
  "IndexerDegraded",
];

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

test("every custom error declared in Errors.sol has a catalog entry", () => {
  for (const name of declaredErrors()) {
    assert.ok(hasCatalogEntry(name), `no catalog entry for error ${name}`);
    assert.ok(Object.hasOwn(errorCatalog, name), `error ${name} is missing from errorCatalog`);
  }
});

test("every error in the generated LuckyDraw and LuckyVault ABIs has a catalog entry", () => {
  const seen = new Set<string>();
  for (const {label, abi} of GENERATED_ABIS) {
    for (const name of abiErrorNames(abi)) {
      seen.add(name);
      assert.ok(hasCatalogEntry(name), `no catalog entry for ABI error ${name} (${label})`);
    }
  }
  for (const name of declaredErrors()) {
    assert.ok(seen.has(name), `Errors.sol declares ${name} but neither ABI carries it`);
  }
  for (const name of DEPENDENCY_ERRORS) {
    assert.ok(seen.has(name), `expected dependency error ${name} in one of the ABIs`);
  }
});

test("the error catalog holds no key that no contract declares", () => {
  const known = new Set([...declaredErrors(), ...DEPENDENCY_ERRORS]);
  for (const key of Object.keys(errorCatalog)) {
    assert.ok(known.has(key), `errorCatalog key ${key} matches no declared error`);
  }
});

test("every QuoteReason member has an entry, in Types.sol order", () => {
  const members = enumMembers("QuoteReason");
  assert.deepEqual(members, [...QuoteReasonNames], "QuoteReason member order drifted from Types.sol");
  members.forEach((name, index) => {
    const key = `Quote:${name}`;
    assert.ok(hasCatalogEntry(key), `no catalog entry for QuoteReason ${name}`);
    assert.equal(
      quoteReasonCatalogKey(index),
      key,
      `QuoteReason ${name} does not resolve from ABI value ${index}`,
    );
    assert.equal(quoteReasonCatalogKey(BigInt(index)), key);
  });
  assert.equal(
    quoteReasonCatalogKey(members.length),
    undefined,
    "an unknown QuoteReason value must not resolve",
  );
  assert.equal(Object.keys(quoteReasonCatalog).length, members.length);
});

test("QuoteReason None reads as admissible and the other reasons mirror their error rows", () => {
  assert.equal(catalogEntryFor("Quote:None").message, "This entry can go ahead.");
  const mirrored = [
    "EntryWindowClosed",
    "BuysPaused",
    "PriceUnavailable",
    "PriceInvalid",
    "PriceStale",
    "PriceDecimalsChanged",
    "BelowMinimum",
    "InsufficientBalance",
    "SeedAccountCannotBuy",
  ] as const;
  for (const name of mirrored) {
    assert.equal(
      catalogEntryFor(`Quote:${name}`),
      catalogEntryFor(name),
      `Quote:${name} must reuse the ${name} row so the quote and the revert read alike`,
    );
  }
});

test("every SeedSkipReason member has an entry, in Types.sol order", () => {
  const members = enumMembers("SeedSkipReason");
  assert.deepEqual(members, [...SeedSkipReasonNames], "SeedSkipReason member order drifted from Types.sol");
  members.forEach((name, index) => {
    const key = `SeedSkip:${name}`;
    assert.ok(hasCatalogEntry(key), `no catalog entry for SeedSkipReason ${name}`);
    assert.equal(seedSkipCatalogKey(index), key);
  });
  assert.equal(seedSkipCatalogKey(members.length), undefined);
  assert.equal(Object.keys(seedSkipCatalog).length, members.length);
});

test("every Panic code the client decodes has an entry", () => {
  const expected = [0x00n, 0x01n, 0x11n, 0x12n, 0x21n, 0x22n, 0x31n, 0x32n, 0x41n, 0x51n];
  assert.deepEqual([...PANIC_CODES], expected);
  for (const code of expected) {
    const key = panicCatalogKey(code);
    if (key === undefined) throw new Error(`no catalog key for Panic(0x${code.toString(16)})`);
    assert.ok(hasCatalogEntry(key), `no catalog entry for ${key}`);
  }
  assert.equal(Object.keys(panicCatalog).length, expected.length);
  assert.equal(
    panicCatalogKey(0x99n),
    undefined,
    "an undecoded Panic code must fall through to UnknownRevert",
  );
  assert.equal(panicCatalogKey(-1), undefined);
  assert.equal(catalogEntryFor("Panic:0x11").funds, "No change");
});

test("every wallet condition has an entry", () => {
  for (const name of WALLET_CONDITIONS) {
    assert.ok(hasCatalogEntry(name), `no catalog entry for wallet condition ${name}`);
  }
  assert.deepEqual(Object.keys(walletCatalog).sort(), [...WALLET_CONDITIONS].sort());
});

test("the combined catalog is the union of its parts, with no key lost to a collision", () => {
  const parts = [errorCatalog, panicCatalog, quoteReasonCatalog, seedSkipCatalog, walletCatalog];
  const total = parts.reduce((sum, part) => sum + Object.keys(part).length, 0);
  assert.equal(CATALOG_KEYS.length, total, "two catalog parts share a key");
  assert.equal(Object.keys(catalog).length, total);
  assert.ok(!hasCatalogEntry("NoSuchError"));
});

// ---------------------------------------------------------------------------
// Register: every row is complete, plain and placeholder-consistent
// ---------------------------------------------------------------------------

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1] ?? "");

test("every entry has a non-empty message, funds effect and next action", () => {
  for (const key of CATALOG_KEYS) {
    const entry: CatalogEntry = catalogEntryFor(key);
    assert.ok(entry.message.trim().length > 0, `${key} has no message`);
    assert.ok(entry.funds.trim().length > 0, `${key} has no funds effect`);
    assert.ok(entry.nextAction.trim().length > 0, `${key} has no next action`);
    assert.ok(
      (FUNDS_PHRASES as readonly string[]).includes(entry.funds),
      `${key} funds "${entry.funds}" is outside the SPEC §9.6 vocabulary`,
    );
  }
});

test("every message declares the placeholders it uses, and uses the ones it declares", () => {
  for (const key of CATALOG_KEYS) {
    const entry = catalogEntryFor(key);
    const used = placeholders(entry.message);
    const declared = entry.params ?? [];
    for (const name of used) {
      assert.ok(declared.includes(name), `${key} uses {${name}} without declaring it in params`);
    }
    for (const name of declared) {
      assert.ok(used.includes(name), `${key} declares param ${name} that its message never uses`);
    }
    assert.deepEqual(placeholders(entry.funds), [], `${key} must not put a placeholder in the funds effect`);
    assert.deepEqual(
      placeholders(entry.nextAction),
      [],
      `${key} must not put a placeholder in the next action`,
    );
  }
});

test("no entry shouts, blames or leaks a raw revert", () => {
  for (const key of CATALOG_KEYS) {
    const entry = catalogEntryFor(key);
    for (const text of [entry.message, entry.funds, entry.nextAction]) {
      assert.ok(!text.includes("!"), `${key} uses an exclamation mark: ${text}`);
      assert.ok(!/\b0x[0-9a-fA-F]{4,}\b/.test(text), `${key} shows raw revert data: ${text}`);
      assert.ok(!/\brevert(ed)?\b/i.test(text), `${key} uses the word revert: ${text}`);
    }
  }
});

// ---------------------------------------------------------------------------
// SPEC §9.6 verbatim rows
// ---------------------------------------------------------------------------
// Copied from the "Representative entries" table in docs/SPEC.md §9.6. The table wraps each message in
// typographic quotes as delimiters; the message itself is the ASCII text inside them.

const SPEC_9_6_ROWS: {keys: CatalogKey[]; message: string; funds: string; nextAction: string}[] = [
  {
    keys: ["EntryWindowClosed", "Quote:EntryWindowClosed"],
    message: "This round has closed: its target was reached or its cutoff passed.",
    funds: "Nothing debited",
    nextAction: "Link to the current round",
  },
  {
    keys: ["DeadlineExpired"],
    message: "Your quote expired before the transaction was included.",
    funds: "Nothing debited",
    nextAction: "Re-quote with the same amount",
  },
  {
    keys: ["BelowMinimum", "Quote:BelowMinimum"],
    message: "The minimum entry is now {min} {symbol} (USD 1 at the current reference price).",
    funds: "Nothing debited",
    nextAction: "Input preserved; Use minimum",
  },
  {
    keys: ["NetContributionTooLow"],
    message: "Fee rounding moved by more than one unit; please re-quote.",
    funds: "Nothing debited",
    nextAction: "Re-quote",
  },
  {
    keys: [
      "PriceUnavailable",
      "PriceInvalid",
      "PriceStale",
      "PriceDecimalsChanged",
      "Quote:PriceUnavailable",
      "Quote:PriceInvalid",
      "Quote:PriceStale",
      "Quote:PriceDecimalsChanged",
    ],
    message:
      "The price reference is unavailable or stale; entries pause until it updates. Deposits and withdrawals still work.",
    funds: "Nothing debited",
    nextAction: "Auto-refresh; retry when fresh",
  },
  {
    keys: ["BuysPaused", "PoolDisabled", "Quote:BuysPaused"],
    message: "Entries are paused for this pool.",
    funds: "Nothing debited",
    nextAction: "Withdraw stays available",
  },
  {
    keys: ["InsufficientBalance", "Quote:InsufficientBalance"],
    message: "Your LuckyDraw balance is {available} {symbol}; this entry needs {gross}.",
    funds: "Nothing debited",
    nextAction: "Top-up with intent preserved",
  },
  {
    keys: ["SeedAccountCannotBuy", "Quote:SeedAccountCannotBuy"],
    message: "This account is authorized for operator seeding and cannot make player entries.",
    funds: "Nothing debited",
    nextAction: "Use a player account, or revoke this asset's seed authorization before re-quoting",
  },
  {
    keys: ["Quote:ArithmeticOverflow"],
    message: "This amount or the round value is too large to quote.",
    funds: "Nothing debited",
    nextAction: "Reduce the amount and re-quote; if it persists, contact support",
  },
  {
    keys: ["DepositsPaused", "DepositsDisabled"],
    message: "Deposits for this asset are paused.",
    funds: "Nothing transferred",
    nextAction: "Balance and withdraw unaffected",
  },
  {
    keys: ["TransferMismatch", "TransferFailed"],
    message: "The token did not transfer the exact amount; the transaction was canceled.",
    funds: "No change",
    nextAction: "Help link",
  },
  {
    keys: ["RoundNotClosed", "RequestWindowStillOpen"],
    message: "Too early for this action",
    funds: "No change",
    nextAction: "Show when it becomes available",
  },
  {
    keys: ["RequestWindowClosed"],
    message: "Too late for this action",
    funds: "No change",
    nextAction: "Show when it becomes available",
  },
  {
    keys: ["AlreadyClaimed"],
    message: "This refund was already credited to your balance.",
    funds: "No change",
    nextAction: "Go to Wallet",
  },
  {
    keys: ["WalletRejected"],
    message: "You canceled in your wallet.",
    funds: "Nothing sent",
    nextAction: "Try again",
  },
  {
    keys: ["InsufficientGas"],
    message: "You need about {gas} BNB for network fees.",
    funds: "Nothing sent",
    nextAction: "Link to getting BNB",
  },
  {
    keys: ["NonceOrReplacement"],
    message: "Your wallet reports a pending or replaced transaction.",
    funds: "Unknown until receipt",
    nextAction: "Track by nonce; never resend automatically",
  },
];

test("the representative SPEC §9.6 rows are reproduced verbatim", () => {
  for (const row of SPEC_9_6_ROWS) {
    for (const key of row.keys) {
      const entry = catalogEntryFor(key);
      assert.equal(entry.message, row.message, `${key} message drifted from SPEC §9.6`);
      assert.equal(entry.funds, row.funds, `${key} funds drifted from SPEC §9.6`);
      assert.equal(entry.nextAction, row.nextAction, `${key} next action drifted from SPEC §9.6`);
    }
  }
});

test("the wallet-unreachable branch uses the SPEC §9.6 sentence", () => {
  assert.equal(
    catalogEntryFor("WalletUnreachable").message,
    "Wallet disconnected before a signature was received; nothing is confirmed sent",
  );
});

test("the network guard offers the SPEC §9.2 action, naming the deployment chain rather than mainnet", () => {
  const entry = catalogEntryFor("WrongChain");
  assert.match(entry.nextAction, /^Switch your wallet to that network/);
  assert.deepEqual(entry.params, ["chain"]);
  assert.doesNotMatch(entry.message, /BNB Smart Chain/);
  assert.equal(
    renderMessage(entry, {chain: "BNB Smart Chain Testnet"}),
    "Your wallet is on a different network. LuckyDraw runs on BNB Smart Chain Testnet.",
  );
});

// ---------------------------------------------------------------------------
// State table (SPEC §9.6)
// ---------------------------------------------------------------------------

test("every State member maps to at least one state row", () => {
  const members = enumMembers("State");
  assert.deepEqual(members, [...StateNames], "State member order drifted from Types.sol");
  for (const name of members) {
    const keys = STATE_CATALOG_KEYS_BY_STATE[name as keyof typeof STATE_CATALOG_KEYS_BY_STATE];
    assert.ok(keys.length > 0, `no state row for ${name}`);
    for (const key of keys) {
      assert.ok(Object.hasOwn(stateCatalog, key), `state row ${key} is missing`);
    }
  }
  const mapped = Object.values(STATE_CATALOG_KEYS_BY_STATE).flat();
  assert.deepEqual(mapped.slice().sort(), Object.keys(stateCatalog).sort(), "a state row is unreachable");
});

test("every state row has a primary action and a message, with declared placeholders", () => {
  for (const [key, entry] of Object.entries(stateCatalog)) {
    assert.ok(entry.primaryAction.trim().length > 0, `${key} has no primary action label`);
    assert.ok(entry.message.trim().length > 0, `${key} has no message`);
    const declared: readonly string[] = "params" in entry ? entry.params : [];
    assert.deepEqual(
      placeholders(entry.message).sort(),
      [...declared].sort(),
      `${key} placeholders and params differ`,
    );
    const note = "note" in entry ? entry.note : "";
    assert.deepEqual(placeholders(note), [], `${key} must not put a placeholder in its note`);
    for (const text of [entry.primaryAction, entry.message, note]) {
      assert.ok(!text.includes("!"), `${key} uses an exclamation mark`);
    }
  }
});

test("the time boundaries pick the right state row", () => {
  assert.equal(stateCatalogKeyFor("Open"), "Open");
  assert.equal(stateCatalogKeyFor("Open", {pastBoundary: true}), "OpenAfterCutoff");
  assert.equal(stateCatalogKeyFor("AwaitingRequest"), "AwaitingRequest");
  assert.equal(stateCatalogKeyFor("AwaitingRequest", {pastBoundary: true}), "AwaitingRequestExpired");
  assert.equal(stateCatalogKeyFor("Drawing", {requestAgeSeconds: 600n}), "Drawing");
  assert.equal(stateCatalogKeyFor("Drawing", {requestAgeSeconds: 86_399n}), "Drawing");
  assert.equal(stateCatalogKeyFor("Drawing", {requestAgeSeconds: 86_400n}), "DrawingDelayed");
  assert.equal(stateCatalogKeyFor("Ready"), "Ready");
  assert.equal(stateCatalogKeyFor("Void"), "Void");
});

test("the Drawing rows follow SPEC §7.3: an estimate before 24 hours, none after", () => {
  assert.match(stateCatalog.Drawing.message, /usually about ten minutes after cutoff/);
  assert.ok(
    !stateCatalog.DrawingDelayed.message.includes("ten minutes"),
    "after 24 hours the app stops promising a result time (SPEC §7.3)",
  );
  assert.match(stateCatalog.DrawingDelayed.note, /7 days/);
});

test("the Void row keeps the SPEC §5.4 operator seed wording", () => {
  assert.match(stateCatalog.Void.message, /No player funds were committed\./);
  assert.match(stateCatalog.Void.note, /operator seed was returned to the seed account/);
});
