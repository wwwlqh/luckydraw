// Turning an ethers decode result into the generated types.
//
// ethers returns every integer as a bigint and every address in checksum case. The generated types say
// bigint for every ABI integer, a numeric literal union for a Solidity enum (a `number`, because the enum
// objects are numeric literals) and a lowercase string for every address (README, SPEC §10.1). This module
// is the single place that conversion happens, driven by the ABI's own `internalType` - which is exactly
// why scripts/generate.ts keeps `internalType` in the emitted JSON.

export type AbiParamLike = {
  name?: string;
  type: string;
  internalType?: string;
  components?: readonly AbiParamLike[];
};

export type AbiEntryLike = {
  type: string;
  name?: string;
  inputs?: readonly AbiParamLike[];
  outputs?: readonly AbiParamLike[];
};

function isEnumParam(param: AbiParamLike): boolean {
  return param.internalType?.startsWith("enum ") === true;
}

/** Accepts the bigint, number, decimal string or 0x-quantity shapes a provider or ethers may hand back. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`not a safe integer: ${value}`);
    return BigInt(value);
  }
  if (typeof value === "string") {
    // `BigInt("")` and `BigInt(" ")` are 0n; a chain integer is a hex quantity or a decimal, nothing else.
    if (!/^(?:0x[0-9a-fA-F]+|-?\d+)$/.test(value)) throw new TypeError(`not an integer string: ${value}`);
    return BigInt(value);
  }
  throw new TypeError(`cannot convert ${typeof value} to bigint`);
}

/** Converts one decoded ABI value to its generated-type representation. */
export function normalizeAbiValue(param: AbiParamLike, value: unknown): unknown {
  const arrayMatch = /^(.*?)(\[\d*\])$/.exec(param.type);
  if (arrayMatch) {
    const inner: AbiParamLike = {...param, type: arrayMatch[1] ?? ""};
    const items = value as ArrayLike<unknown>;
    const out: unknown[] = [];
    for (let index = 0; index < items.length; index += 1) out.push(normalizeAbiValue(inner, items[index]));
    return out;
  }

  if (param.type === "tuple") {
    return normalizeAbiStruct(param.components ?? [], value as ArrayLike<unknown>);
  }

  if (param.type === "address") return String(value).toLowerCase();
  if (param.type === "bool") return Boolean(value);
  if (param.type === "string") return String(value);
  if (param.type === "bytes" || /^bytes\d+$/.test(param.type)) return String(value).toLowerCase();
  if (/^u?int\d*$/.test(param.type)) {
    // A Solidity enum is a uint8 on the wire but a numeric literal union in the generated types.
    return isEnumParam(param) ? Number(toBigInt(value)) : toBigInt(value);
  }
  throw new TypeError(`unsupported ABI type ${param.type}`);
}

/** Converts a decoded tuple (a struct, or one event's arguments) into a named record. */
export function normalizeAbiStruct(
  params: readonly AbiParamLike[],
  values: ArrayLike<unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  params.forEach((param, index) => {
    const key = param.name !== undefined && param.name.length > 0 ? param.name : `field${index}`;
    // Defined, not assigned: a field literally named `__proto__` must become an own property rather than a
    // prototype assignment that silently drops the value.
    Object.defineProperty(out, key, {
      value: normalizeAbiValue(param, values[index]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return out;
}

/** Indexes the function fragments of an ABI by their outputs, keeping `internalType` for the conversion above. */
export function indexFunctionOutputs(abi: readonly AbiEntryLike[]): Map<string, readonly AbiParamLike[]> {
  const out = new Map<string, readonly AbiParamLike[]>();
  for (const entry of abi) {
    if (entry.type !== "function" || entry.name === undefined) continue;
    out.set(entry.name, entry.outputs ?? []);
  }
  return out;
}

/** Indexes the event fragments of an ABI by name, keeping `internalType` for the conversion above. */
export function indexEventInputs(abi: readonly AbiEntryLike[]): Map<string, readonly AbiParamLike[]> {
  const out = new Map<string, readonly AbiParamLike[]>();
  for (const entry of abi) {
    if (entry.type !== "event" || entry.name === undefined) continue;
    out.set(entry.name, entry.inputs ?? []);
  }
  return out;
}
