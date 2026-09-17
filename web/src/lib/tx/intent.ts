// The pending intent, persisted in session storage (SPEC §9.6).
//
// "the pending intent (type, parameters, account, chain, expected nonce, hash if known) is persisted in
// session storage [...] Deep-link returns and tab restores reattach to any persisted hash and resume receipt
// tracking". Session storage, not local storage, because the intent belongs to this tab's visit; and never a
// key or a signature (§9.6: "local storage contains no keys or signatures"; the same holds here).
//
// Every integer is written as a decimal string: `JSON.stringify` cannot serialize a bigint, and a JS number
// would silently lose precision on `value`.

import type {WriteAction, WriteTarget} from "@luckydraw/client";

export const INTENT_STORAGE_KEY = "luckydraw.tx.pending";

export type PendingIntent = {
  action: WriteAction;
  contract: WriteTarget;
  /** The Solidity function, needed to decode a revert against the right contract (`decodeOptionsForWrite`). */
  function: string;
  label: string | null;
  /** Lowercase signer address. */
  account: string;
  /** Decimal chain id. */
  chainId: string;
  to: string;
  data: string;
  /** Decimal wei. */
  value: string;
  nonce: number | null;
  hash: string | null;
  startedAt: number;
};

export type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Session storage is writable by anything that runs in this origin, and by the user's own devtools. A stored
// value is therefore untrusted input, not a value this app wrote: every field is shape-checked before it is
// handed to the state machine or to a component. The field that made this a defect rather than a theory is
// `startedAt`: `TxStepper` formats it with `Intl.DateTimeFormat`, which throws a RangeError on an invalid
// date, and a throw during render reaches the error boundary on every reload for as long as the value stays.
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HEX_PATTERN = /^0x([0-9a-fA-F]{2})*$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Strict shape check. Anything that does not match is treated as hostile and removed by `loadIntent`. */
export function isIntent(value: unknown): value is PendingIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.action)) return false;
  if (!isNonEmptyString(record.contract)) return false;
  if (!isNonEmptyString(record.function)) return false;
  if (record.label !== null && typeof record.label !== "string") return false;
  if (typeof record.account !== "string" || !ADDRESS_PATTERN.test(record.account)) return false;
  if (typeof record.chainId !== "string" || !DECIMAL_PATTERN.test(record.chainId)) return false;
  if (typeof record.to !== "string" || !ADDRESS_PATTERN.test(record.to)) return false;
  if (typeof record.data !== "string" || !HEX_PATTERN.test(record.data)) return false;
  if (typeof record.value !== "string" || !DECIMAL_PATTERN.test(record.value)) return false;
  if (record.nonce !== null && !(typeof record.nonce === "number" && Number.isSafeInteger(record.nonce))) {
    return false;
  }
  if (typeof record.nonce === "number" && record.nonce < 0) return false;
  if (record.hash !== null && !(typeof record.hash === "string" && HASH_PATTERN.test(record.hash))) {
    return false;
  }
  return typeof record.startedAt === "number" && Number.isFinite(record.startedAt);
}

/**
 * True when the intent's `to` is one of the addresses this build is allowed to talk to: the manifest Vault,
 * the manifest Draw, or one of the manifest's own asset tokens (an ERC-20 `approve` is sent to the token).
 *
 * SPEC §15 "Load only listed deployment assets": an intent naming anything else was not written by this app,
 * and resuming it would put a foreign contract's address behind this app's own progress UI.
 */
export function intentTargetsDeployment(intent: PendingIntent, allowed: readonly string[]): boolean {
  const to = intent.to.toLowerCase();
  return allowed.some((address) => address.toLowerCase() === to);
}

export function saveIntent(storage: IntentStorage | null, intent: PendingIntent): void {
  try {
    storage?.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // Storage can be unavailable (private mode, blocked site data). Losing the reattach is acceptable;
    // failing the transaction because of it is not.
  }
}

/**
 * The stored intent for this chain and account, or null. A foreign one is dropped rather than shown.
 *
 * A null `account` means the caller does not know whose session this is yet, and it returns null: an intent
 * names an account, and resuming one before the session has settled would reattach another address's
 * transaction to whoever connects next (SPEC §9.6).
 */
export function loadIntent(
  storage: IntentStorage | null,
  chainId: bigint,
  account: string | null,
): PendingIntent | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(INTENT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearIntent(storage);
    return null;
  }
  if (!isIntent(parsed)) {
    clearIntent(storage);
    return null;
  }
  if (parsed.chainId !== chainId.toString()) return null;
  if (account === null || parsed.account !== account.toLowerCase()) return null;
  return parsed;
}

export function clearIntent(storage: IntentStorage | null): void {
  try {
    storage?.removeItem(INTENT_STORAGE_KEY);
  } catch {
    // See saveIntent.
  }
}

/**
 * Clears the stored intent **only when it is the one under `hash`**.
 *
 * There is one intent slot and more than one thing that can reach a terminal state in it: several
 * `useTransaction` instances can be mounted at once, and a `track` loop belonging to a superseded run can
 * still be walking when a newer run persists its own intent. An unconditional clear at every terminal site
 * therefore deletes whichever intent happens to be stored, including a live one whose hash nobody has
 * finished watching — and that is exactly the intent a reload needs in order to reattach (SPEC §9.6).
 *
 * A stored value that is malformed is removed rather than kept: it can never be reattached to anyway.
 */
export function clearIntentFor(storage: IntentStorage | null, hash: string): void {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(INTENT_STORAGE_KEY) ?? null;
  } catch {
    return;
  }
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearIntent(storage);
    return;
  }
  if (!isIntent(parsed)) {
    clearIntent(storage);
    return;
  }
  if (parsed.hash === hash) clearIntent(storage);
}
