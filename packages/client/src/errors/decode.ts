// Revert decoding (SPEC §8.1: "the client decodes Panic codes as well as Vault and Draw custom errors" and
// "Reverts must not be shown as raw stack traces in the app").
//
// `decodeRevert` takes whatever the wallet, provider or ethers threw, digs the revert bytes out of it and
// classifies them. It never throws: a decoder that can itself fail would turn a failed transaction into a
// blank screen. `src/catalog/` maps the result onto a message, a funds effect and a next action.

import {type ErrorFragment, Interface, type Result} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {type Hex, isAddress} from "../types/common.ts";
import {drawErrorSelectors, projectErrorNames, vaultErrorSelectors} from "../types/generated.ts";

/** Where the decoded custom error was declared, or `token` when the bytes came from an ERC-20 call. */
export type RevertOrigin = "vault" | "draw" | "dependency" | "token";

export type DecodedRevertArgs = Record<string, bigint | string | boolean>;

export type DecodedRevert =
  | {kind: "custom"; contract: RevertOrigin; name: string; args: DecodedRevertArgs; selector: Hex}
  | {kind: "panic"; code: bigint; name: string}
  | {kind: "reason"; message: string}
  | {kind: "unknown"; selector: Hex; data: Hex}
  | {kind: "none"};

export type DecodeRevertOptions = {
  /**
   * Which contract the call was sent to. Selectors are global, so an error declared by both LuckyVault and
   * LuckyDraw (`WrongState`, `Unauthorized`, ...) cannot be attributed from the data alone. Without a hint
   * the Draw wins, because every game write goes to the Draw; deposits and withdrawals should pass "vault".
   * An allowance step is sent to the token itself: pass "erc20", and every custom error is the token's.
   */
  emitter?: "vault" | "draw" | "erc20";
  /**
   * The function the transaction called. A Vault write that calls into an untrusted token (`deposit`,
   * `withdraw`) bubbles the token's revert bytes verbatim through OpenZeppelin's SafeERC20, so a token that
   * declares, say, `InsufficientBalance()` collides with the Vault's own selector. With the method known, a
   * project error that function cannot raise itself is attributed to the token instead of to the Vault.
   */
  method?: string;
};

/** The decode options for a failed `PreparedWrite` (`writes/prepare.ts`): its target and the method it called. */
export function decodeOptionsForWrite(write: {
  contract: "vault" | "draw" | "erc20";
  function: string;
}): DecodeRevertOptions {
  return {emitter: write.contract, method: write.function};
}

/**
 * The project errors each token-calling Vault function raises itself, from `contracts/src/LuckyVault.sol`:
 * `deposit` runs `_requireDepositable` (WrongState, InvalidAsset, DepositsDisabled, DepositsPaused), then
 * rejects a zero amount and a wrong receipt (TransferMismatch); `withdraw` rejects an unlisted asset, a zero
 * amount, a short balance (InsufficientBalance) and a wrong debit or receipt (TransferMismatch,
 * TransferFailed). Any other project error decoded from one of these calls arrived through the token's
 * `transferFrom` or `transfer`. `hardening.test.ts` checks every name here against Errors.sol and the Vault
 * ABI; the reachability itself is read off the contract source above.
 */
export const VAULT_OWN_ERRORS: Readonly<Record<string, ReadonlySet<string>>> = {
  deposit: new Set([
    "WrongState",
    "InvalidAsset",
    "DepositsDisabled",
    "DepositsPaused",
    "InvalidAmount",
    "TransferMismatch",
  ]),
  withdraw: new Set([
    "InvalidAsset",
    "InvalidAmount",
    "InsufficientBalance",
    "TransferMismatch",
    "TransferFailed",
  ]),
};

/** Solidity `Panic(uint256)` codes, documented in the Solidity manual's "Panic via assert". */
export const PANIC_NAMES: Readonly<Record<string, string>> = {
  "0": "generic compiler panic",
  "1": "assertion failed",
  "17": "arithmetic overflow or underflow",
  "18": "division or modulo by zero",
  "33": "invalid enum conversion",
  "34": "invalid storage byte array encoding",
  "49": "pop on an empty array",
  "50": "array index out of bounds",
  "65": "memory allocation overflow",
  "81": "call to a zero-initialized internal function",
};

/** The name for one Panic code, or a generic label for a code Solidity has not defined. */
export function panicName(code: bigint): string {
  return PANIC_NAMES[code.toString()] ?? `unrecognized panic 0x${code.toString(16)}`;
}

const ERROR_STRING_SELECTOR = "0x08c379a0";
const PANIC_SELECTOR = "0x4e487b71";

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);
const errorStringInterface = new Interface(["error Error(string)", "error Panic(uint256)"]);

const PROJECT_ERRORS: ReadonlySet<string> = new Set(projectErrorNames);
const DRAW_ERRORS: ReadonlySet<string> = new Set(Object.keys(drawErrorSelectors));
const VAULT_ERRORS: ReadonlySet<string> = new Set(Object.keys(vaultErrorSelectors));

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
/**
 * Hex embedded in message text counts only when a data marker introduces it (`data="0x…"`, `Reverted 0x…`,
 * `revert data: 0x…`). A bare address or hash elsewhere in a message is never revert data: an attacker who
 * controls a token or spender address must not be able to choose the catalog message a user sees.
 */
const EMBEDDED_HEX_RE = /\b(?:data|reverted|revert data)\W{0,4}(0x(?:[0-9a-fA-F]{2}){4,})/i;

/** Revert data is a 4-byte selector followed by whole 32-byte words. */
function isAbiShaped(hex: string): boolean {
  const bytes = (hex.length - 2) / 2;
  return bytes === 4 || (bytes > 4 && (bytes - 4) % 32 === 0);
}

function isHexData(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

/** Keys providers and libraries hide revert data behind, in the order they are worth trying. */
const DATA_KEYS = [
  "data",
  "error",
  "info",
  "cause",
  "originalError",
  "result",
  "body",
  "value",
  "payload",
] as const;

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Object.hasOwn(value as object, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Pulls the revert bytes out of a raw hex string, an ethers `CallExceptionError`, or a JSON-RPC error whose
 * data hides under `error.data`, `error.error.data`, `info.error.data` or a nested JSON string body.
 * Returns null when there is nothing to decode, which is what a user-rejected wallet prompt looks like.
 */
export function extractRevertData(input: unknown, depth = 0, seen?: Set<object>): Hex | null {
  if (depth > 6) return null;
  if (isHexData(input)) {
    const hex = input.toLowerCase() as Hex;
    // A hex string found inside an error object counts only when it is revert-shaped: `0x` (a revert that
    // carried no data) or a selector plus whole words. ethers files the offending argument of an
    // INVALID_ARGUMENT or BAD_DATA error under `value`, and a 20-byte address there must not choose the
    // catalog message a user sees, which is the rule the message-text path below already follows. The
    // direct argument is passed through and classified by `decodeRevert`.
    if (depth > 0 && hex !== "0x" && !isAbiShaped(hex)) return null;
    return hex;
  }

  if (typeof input === "string") {
    // Some providers return the body as a JSON string, others embed the data in the message text.
    const trimmed = input.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractRevertData(JSON.parse(trimmed), depth + 1, seen);
      } catch {
        return null;
      }
    }
    const embedded = EMBEDDED_HEX_RE.exec(input);
    const candidate = embedded?.[1];
    if (candidate === undefined || !isAbiShaped(candidate)) return null;
    return candidate.toLowerCase() as Hex;
  }

  if (input === null || typeof input !== "object") return null;
  const visited = seen ?? new Set<object>();
  if (visited.has(input as object)) return null;
  visited.add(input as object);

  for (const key of DATA_KEYS) {
    const value = own(input, key);
    if (value === undefined || value === null) continue;
    const found = extractRevertData(value, depth + 1, visited);
    if (found !== null) return found;
  }
  return null;
}

function normalizeArg(value: unknown): bigint | string | boolean {
  if (typeof value === "bigint" || typeof value === "boolean") return value;
  if (typeof value === "string") return isAddress(value) ? value.toLowerCase() : value;
  if (typeof value === "number") return BigInt(value);
  return String(value);
}

function namedArgs(fragment: ErrorFragment, args: Result): DecodedRevertArgs {
  const out: DecodedRevertArgs = {};
  fragment.inputs.forEach((input, index) => {
    const key = input.name.length > 0 ? input.name : `arg${index}`;
    out[key] = normalizeArg(args[index]);
  });
  return out;
}

function classify(name: string, options: DecodeRevertOptions | undefined): RevertOrigin {
  // An allowance step is a call to the token: whatever it reverted with is the token's, even when the
  // selector happens to equal a project error's.
  if (options?.emitter === "erc20") return "token";
  // SPEC §8.1: "Dependency errors may be decoded directly when documented." Anything not declared in
  // contracts/src/Errors.sol comes from pinned OpenZeppelin code, so it is reported as a dependency error.
  if (!PROJECT_ERRORS.has(name)) return "dependency";
  // A Vault write that called into the token bubbles the token's bytes; a project error the function
  // cannot raise itself came from there.
  const method = options?.method;
  if (options?.emitter === "vault" && method !== undefined && Object.hasOwn(VAULT_OWN_ERRORS, method)) {
    const own = VAULT_OWN_ERRORS[method];
    if (own !== undefined && !own.has(name)) return "token";
  }
  const hint = options?.emitter === "vault" || options?.emitter === "draw" ? options.emitter : undefined;
  const inDraw = DRAW_ERRORS.has(name);
  const inVault = VAULT_ERRORS.has(name);
  if (inDraw && inVault) return hint ?? "draw";
  if (inDraw) return "draw";
  if (inVault) return "vault";
  return hint ?? "draw";
}

function selectorOf(data: string): Hex {
  return (data.length >= 10 ? data.slice(0, 10) : data).toLowerCase() as Hex;
}

/**
 * Classifies revert data. Never throws.
 *
 * - `custom` for a Vault, Draw or documented dependency error, with its arguments by name;
 * - `panic` for `Panic(uint256)`, including 0x11 arithmetic overflow, which SPEC §8.1 says is how execution
 *   overflow surfaces (there is deliberately no ArithmeticOverflow custom error);
 * - `reason` for `Error(string)`;
 * - `unknown` for data whose selector matches nothing, including empty data;
 * - `none` when the input carries no revert data at all, as with a rejected wallet prompt.
 */
export function decodeRevert(input: unknown, options?: DecodeRevertOptions): DecodedRevert {
  let data: Hex | null;
  try {
    data = extractRevertData(input);
  } catch {
    return {kind: "none"};
  }
  if (data === null) return {kind: "none"};
  if (data.length < 10) return {kind: "unknown", selector: selectorOf(data), data};

  const selector = selectorOf(data);
  // ethers' `parseError` tolerates trailing bytes, so a selector followed by a partial word would still
  // decode as a custom error. Revert data is a selector plus whole words; anything else is unknown.
  if (!isAbiShaped(data)) return {kind: "unknown", selector, data};

  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const decoded = errorStringInterface.decodeErrorResult("Error", data);
      return {kind: "reason", message: String(decoded[0])};
    } catch {
      return {kind: "unknown", selector, data};
    }
  }

  if (selector === PANIC_SELECTOR) {
    try {
      const decoded = errorStringInterface.decodeErrorResult("Panic", data);
      const code = BigInt(decoded[0] as bigint | number | string);
      return {kind: "panic", code, name: panicName(code)};
    } catch {
      return {kind: "unknown", selector, data};
    }
  }

  const order: readonly Interface[] =
    options?.emitter === "vault" ? [vaultInterface, drawInterface] : [drawInterface, vaultInterface];
  for (const iface of order) {
    try {
      const parsed = iface.parseError(data);
      if (parsed === null) continue;
      return {
        kind: "custom",
        contract: classify(parsed.name, options),
        name: parsed.name,
        args: namedArgs(parsed.fragment, parsed.args),
        selector,
      };
    } catch {
      // Try the other ABI; a selector that matches neither falls through to `unknown`.
    }
  }

  return {kind: "unknown", selector, data};
}
