// Hex string primitives and the integer bounds every other module builds on.
//
// SPEC §10.1 stores and compares addresses lowercase, so `asAddress` is the single boundary that lowercases
// an address once; everything downstream compares with `===`. SPEC §5.1 uses uint256 for amounts, weights,
// counts and IDs, so `MAX_UINT256` is the only range check a caller ever needs.

/** `0x` + 40 lowercase hex characters once it has passed `asAddress`. */
export type Address = `0x${string}`;

/** `0x` + an even number of lowercase hex characters (calldata, revert data, arbitrary `bytes`). */
export type Hex = `0x${string}`;

/** `0x` + 64 lowercase hex characters (a `bytes32`, block hash or transaction hash). */
export type Hex32 = `0x${string}`;

/** Thrown by the `as*` coercions when a value is not the hex shape it claims to be. */
export class HexFormatError extends Error {
  /** What the value should have been, for example `address` or `bytes32`. */
  readonly expected: string;
  /** The offending value, stringified and truncated so a log line stays bounded. */
  readonly received: string;

  constructor(expected: string, received: unknown) {
    const shown = typeof received === "string" ? received : String(received);
    const truncated = shown.length > 80 ? `${shown.slice(0, 77)}...` : shown;
    super(`expected ${expected}, received ${truncated}`);
    this.name = "HexFormatError";
    this.expected = expected;
    this.received = truncated;
  }
}

/** The native BNB sentinel and the "no pending owner" value (Types.sol `NATIVE_ASSET`, SPEC §4.2). */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** 2^256 - 1. Every ABI integer is a bigint (README "bigint everywhere"); nothing here uses `number`. */
export const MAX_UINT256: bigint = (1n << 256n) - 1n;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

/** True for `0x` + 40 hex characters in any case. Does not check a checksum: SPEC §10.1 compares lowercase. */
export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

/** Validates and lowercases an address, or throws `HexFormatError`. */
export function asAddress(value: unknown): Address {
  if (!isAddress(value)) throw new HexFormatError("address (0x + 40 hex)", value);
  return value.toLowerCase() as Address;
}

/** True for `0x` + 64 hex characters in any case. */
export function isHex32(value: unknown): value is Hex32 {
  return typeof value === "string" && HEX32_RE.test(value);
}

/** Validates and lowercases a 32-byte value, or throws `HexFormatError`. */
export function asHex32(value: unknown): Hex32 {
  if (!isHex32(value)) throw new HexFormatError("bytes32 (0x + 64 hex)", value);
  return value.toLowerCase() as Hex32;
}

/** True for `0x` followed by an even number of hex characters, including the empty `0x`. */
export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX_RE.test(value);
}

/** Validates and lowercases arbitrary hex bytes, or throws `HexFormatError`. */
export function asHex(value: unknown): Hex {
  if (!isHex(value)) throw new HexFormatError("hex bytes (0x + even hex)", value);
  return value.toLowerCase() as Hex;
}

/** True when the value fits an unsigned 256-bit integer. */
export function isUint256(value: bigint): boolean {
  return value >= 0n && value <= MAX_UINT256;
}
