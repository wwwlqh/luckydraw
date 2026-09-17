// Code generator for @luckydraw/client (README "Generated code is committed and checked").
//
// Inputs (all resolved from `import.meta.dirname`, never from the working directory):
//   contracts/out/LuckyVault.sol/LuckyVault.json            forge artifact
//   contracts/out/LuckyDraw.sol/LuckyDraw.json              forge artifact
//   contracts/out/IMulticall3.sol/IMulticall3.json          forge-std
//   contracts/out/AggregatorV3Interface.sol/AggregatorV3Interface.json   Chainlink
//   contracts/src/Types.sol                                 enum member order, which is ABI order
//   contracts/src/Errors.sol                                which error names are this project's own
//
// Outputs:
//   src/abi/generated/{luckyVault,luckyDraw,multicall3,aggregatorV3}.ts
//   src/types/generated.ts
//
// Output is deterministic: no timestamps, a canonical key order inside every ABI entry, the artifact's own
// entry order preserved, LF line endings and a trailing newline. `--check` regenerates in memory and
// compares byte for byte, so CI fails when a committed file is stale (exit 1) or an artifact is missing
// (exit 2). SPEC §8.1: "All numeric fields and reason enums must appear in generated types."
//
// Runs under plain `node scripts/generate.ts` on Node 24 and 25: erasable TypeScript only.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {id as keccakId} from "ethers";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR: string = import.meta.dirname;
const PACKAGE_ROOT: string = dirname(SCRIPT_DIR);
const REPO_ROOT: string = dirname(dirname(PACKAGE_ROOT));
const CONTRACTS_DIR: string = join(REPO_ROOT, "contracts");

export const TYPES_SOL: string = join(CONTRACTS_DIR, "src", "Types.sol");
export const ERRORS_SOL: string = join(CONTRACTS_DIR, "src", "Errors.sol");

/** One generated ABI module. `label` is what the header comment names as the source. */
export type ArtifactSpec = {
  /** Exported constant name, for example `luckyVaultAbi`. */
  constName: string;
  /** File written under `src/abi/generated/`. */
  outFile: string;
  /** Artifact path relative to `contracts/`. */
  artifact: string;
  /** Included in the generated types: only these two contribute events, errors and view structs. */
  contract: "vault" | "draw" | null;
};

export const ARTIFACTS: readonly ArtifactSpec[] = [
  {
    constName: "luckyVaultAbi",
    outFile: "luckyVault.ts",
    artifact: "out/LuckyVault.sol/LuckyVault.json",
    contract: "vault",
  },
  {
    constName: "luckyDrawAbi",
    outFile: "luckyDraw.ts",
    artifact: "out/LuckyDraw.sol/LuckyDraw.json",
    contract: "draw",
  },
  {
    constName: "multicall3Abi",
    outFile: "multicall3.ts",
    artifact: "out/IMulticall3.sol/IMulticall3.json",
    contract: null,
  },
  {
    constName: "aggregatorV3Abi",
    outFile: "aggregatorV3.ts",
    artifact: "out/AggregatorV3Interface.sol/AggregatorV3Interface.json",
    contract: null,
  },
];

// ---------------------------------------------------------------------------
// ABI shapes
// ---------------------------------------------------------------------------

export type AbiParam = {
  name?: string;
  type: string;
  internalType?: string;
  indexed?: boolean;
  components?: AbiParam[];
};

export type AbiEntry = {
  type: string;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
  anonymous?: boolean;
};

/** Raised for a missing artifact so `main` can exit 2 with the `forge build` hint. */
export class MissingArtifactError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`artifact not found: ${path}`);
    this.name = "MissingArtifactError";
    this.path = path;
  }
}

/** Raised when the inputs cannot produce a well-formed module (name collision, unnamed tuple, ...). */
export class GenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateError";
  }
}

/** Reads own properties only: a forge artifact is a plain JSON object that inherits `constructor`. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Object.hasOwn(value as object, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** Absolute path of one artifact, resolved from this file's location and never from the working directory. */
export function artifactPath(spec: ArtifactSpec): string {
  return join(CONTRACTS_DIR, spec.artifact);
}

export function readArtifactAbi(path: string): AbiEntry[] {
  if (!existsSync(path)) throw new MissingArtifactError(path);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const abi = own(parsed, "abi");
  if (!Array.isArray(abi)) throw new GenerateError(`${path}: no "abi" array`);
  return abi as AbiEntry[];
}

// ---------------------------------------------------------------------------
// Canonical ABI rendering
// ---------------------------------------------------------------------------

const PARAM_KEYS = ["name", "type", "internalType", "indexed", "components"] as const;
const ENTRY_KEYS = ["type", "name", "inputs", "outputs", "stateMutability", "anonymous"] as const;

function normalizeParam(param: AbiParam): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    const value = own(param, key);
    if (value === undefined) continue;
    out[key] = key === "components" ? (value as AbiParam[]).map(normalizeParam) : value;
  }
  return out;
}

/**
 * Rebuilds every entry with a fixed key order so the emitted JSON does not depend on the artifact's own key
 * order, while keeping the artifact's entry order (which is the order solc recorded). `internalType` is kept
 * deliberately: it is what carries `enum Kind` and `struct ILuckyDraw.RoundView` into the generated types.
 */
export function normalizeAbi(abi: AbiEntry[]): Record<string, unknown>[] {
  return abi.map((entry) => {
    const out: Record<string, unknown> = {};
    for (const key of ENTRY_KEYS) {
      const value = own(entry, key);
      if (value === undefined) continue;
      out[key] = key === "inputs" || key === "outputs" ? (value as AbiParam[]).map(normalizeParam) : value;
    }
    return out;
  });
}

export function header(source: string): string {
  return [
    "// GENERATED FILE - DO NOT EDIT BY HAND.",
    `// Source: ${source}`,
    "// Written by packages/client/scripts/generate.ts. Regenerate with `node scripts/generate.ts` after",
    "// `forge build`; `node scripts/generate.ts --check` fails when this file is stale.",
    "",
  ].join("\n");
}

export function renderAbiModule(spec: ArtifactSpec, abi: AbiEntry[]): string {
  const json = JSON.stringify(normalizeAbi(abi), null, 2);
  return `${header(`contracts/${spec.artifact}`)}\nexport const ${spec.constName} = ${json} as const;\n`;
}

// ---------------------------------------------------------------------------
// Solidity source parsing (tolerant: comments and blank lines sit between members)
// ---------------------------------------------------------------------------

/** Removes `//` and block comments. Types.sol and Errors.sol contain no string literals, so this is safe. */
export function stripSolidityComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

export type EnumDef = {name: string; members: string[]};

/**
 * Parses every `enum` declaration in source order and returns its members in source order.
 * Types.sol says it plainly: "Enum member order is part of the ABI and of the generated client types.
 * Never reorder." Nothing here sorts.
 */
export function parseEnums(source: string): EnumDef[] {
  const clean = stripSolidityComments(source);
  const out: EnumDef[] = [];
  const re = /\benum\s+([A-Za-z_$][\w$]*)\s*\{([^}]*)\}/g;
  for (const match of clean.matchAll(re)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) continue;
    const members = body
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member.length > 0);
    for (const member of members) {
      if (!/^[A-Za-z_$][\w$]*$/.test(member)) {
        throw new GenerateError(`enum ${name}: unparsable member ${JSON.stringify(member)}`);
      }
    }
    if (members.length === 0) throw new GenerateError(`enum ${name}: no members`);
    out.push({name, members});
  }
  return out;
}

/** Parses the free-function `error Name(...)` declarations of Errors.sol, in source order. */
export function parseErrorNames(source: string): string[] {
  const clean = stripSolidityComments(source);
  const out: string[] = [];
  for (const match of clean.matchAll(/\berror\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Solidity -> TypeScript type mapping
// ---------------------------------------------------------------------------

/** The hex primitives a generated module may need from `./common.ts`. */
export type PrimitiveUse = Set<"Address" | "Hex" | "Hex32">;

/** `struct ILuckyDraw.PoolView[]` -> `PoolView`; `enum Kind` -> `Kind`. */
export function shortInternalName(internalType: string): string {
  const withoutArrays = internalType.replace(/(\[\d*\])+$/, "");
  const withoutKeyword = withoutArrays.replace(/^(struct|enum|contract)\s+/, "");
  const parts = withoutKeyword.split(".");
  const last = parts[parts.length - 1];
  if (last === undefined || last.length === 0) {
    throw new GenerateError(`cannot derive a name from internalType ${JSON.stringify(internalType)}`);
  }
  return last;
}

// Maps one ABI parameter to a TypeScript type.
//
// Every uint and int width -> bigint (README "bigint everywhere"); address -> Address; bool -> boolean;
// bytes32 -> Hex32; bytes and bytesN -> Hex; string -> string; a uint8 carrying `internalType: "enum X"`
// -> the X numeric literal union; `T[3]` -> a fixed readonly tuple; `T[]` -> readonly T[]; `tuple` -> the
// generated interface named by its internalType.
export function solidityTypeToTs(param: AbiParam, used?: PrimitiveUse): string {
  const type = param.type;
  const arrayMatch = /^(.*?)(\[(\d*)\])$/.exec(type);
  if (arrayMatch) {
    const innerType = arrayMatch[1];
    const fixedSize = arrayMatch[3];
    if (innerType === undefined || fixedSize === undefined) {
      throw new GenerateError(`unparsable array type ${JSON.stringify(type)}`);
    }
    const innerParam: AbiParam = {...param, type: innerType};
    const inner = solidityTypeToTs(innerParam, used);
    if (fixedSize.length === 0) return `readonly ${wrapForArray(inner)}[]`;
    const size = Number.parseInt(fixedSize, 10);
    if (!Number.isInteger(size) || size <= 0 || size > 32) {
      throw new GenerateError(`unsupported fixed array size in ${JSON.stringify(type)}`);
    }
    return `readonly [${new Array(size).fill(inner).join(", ")}]`;
  }

  if (type === "tuple") {
    const internalType = param.internalType;
    if (internalType === undefined || !internalType.startsWith("struct ")) {
      throw new GenerateError(
        `tuple parameter ${JSON.stringify(param.name ?? "")} has no struct internalType; ` +
          "the generator names every struct interface from its internalType",
      );
    }
    return shortInternalName(internalType);
  }

  if (type === "address") {
    used?.add("Address");
    return "Address";
  }
  if (type === "bool") return "boolean";
  if (type === "string") return "string";
  if (type === "bytes32") {
    used?.add("Hex32");
    return "Hex32";
  }
  if (type === "bytes" || /^bytes([1-9]|[12]\d|3[0-2])$/.test(type)) {
    used?.add("Hex");
    return "Hex";
  }
  if (/^u?int(\d*)$/.test(type)) {
    const internalType = param.internalType;
    if (internalType?.startsWith("enum ") === true) {
      return shortInternalName(internalType);
    }
    return "bigint";
  }
  throw new GenerateError(`unsupported Solidity type ${JSON.stringify(type)}`);
}

/** `readonly [a, b][]` is invalid; a tuple element type needs parentheses inside an array type. */
function wrapForArray(inner: string): string {
  return inner.startsWith("readonly ") ? `(${inner})` : inner;
}

// ---------------------------------------------------------------------------
// Struct, event and error collection
// ---------------------------------------------------------------------------

export type StructDef = {name: string; qualified: string; components: AbiParam[]};

/** Walks every parameter of every entry and records each distinct struct, nested ones included. */
export function collectStructs(abis: readonly AbiEntry[][]): StructDef[] {
  const byName = new Map<string, StructDef>();

  const visit = (param: AbiParam): void => {
    if (param.type.startsWith("tuple")) {
      const internalType = param.internalType;
      if (internalType === undefined) throw new GenerateError("tuple parameter without internalType");
      const name = shortInternalName(internalType);
      const qualified = internalType.replace(/(\[\d*\])+$/, "").replace(/^struct\s+/, "");
      const existing = byName.get(name);
      if (existing === undefined) {
        byName.set(name, {name, qualified, components: param.components ?? []});
      } else if (existing.qualified !== qualified) {
        throw new GenerateError(
          `two different structs share the name ${name}: ${existing.qualified} and ${qualified}`,
        );
      }
    }
    for (const component of param.components ?? []) visit(component);
  };

  for (const abi of abis) {
    for (const entry of abi) {
      for (const param of entry.inputs ?? []) visit(param);
      for (const param of entry.outputs ?? []) visit(param);
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export type EventDef = {name: string; inputs: AbiParam[]; signature: string; topic0: string};

/** Canonical signature of a function, event or error: names and `indexed` dropped, tuples expanded. */
export function canonicalSignature(name: string, inputs: readonly AbiParam[]): string {
  return `${name}(${inputs.map(canonicalType).join(",")})`;
}

function canonicalType(param: AbiParam): string {
  if (!param.type.startsWith("tuple")) return param.type;
  const suffix = param.type.slice("tuple".length);
  return `(${(param.components ?? []).map(canonicalType).join(",")})${suffix}`;
}

export function collectEvents(abi: readonly AbiEntry[]): EventDef[] {
  const out: EventDef[] = [];
  for (const entry of abi) {
    if (entry.type !== "event" || entry.name === undefined) continue;
    const inputs = entry.inputs ?? [];
    const signature = canonicalSignature(entry.name, inputs);
    out.push({name: entry.name, inputs, signature, topic0: keccakId(signature)});
  }
  return out;
}

export type ErrorDef = {name: string; inputs: AbiParam[]; signature: string; selector: string};

export function collectErrors(abi: readonly AbiEntry[]): ErrorDef[] {
  const out: ErrorDef[] = [];
  for (const entry of abi) {
    if (entry.type !== "error" || entry.name === undefined) continue;
    const inputs = entry.inputs ?? [];
    const signature = canonicalSignature(entry.name, inputs);
    out.push({name: entry.name, inputs, signature, selector: keccakId(signature).slice(0, 10)});
  }
  return out;
}

// ---------------------------------------------------------------------------
// src/types/generated.ts
// ---------------------------------------------------------------------------

function lowerFirst(value: string): string {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

/** A readonly string-literal array, wrapped across lines when the single-line form would run long. */
function renderStringArray(declaration: string, values: readonly string[]): string {
  const items = values.map((value) => JSON.stringify(value));
  const single = `${declaration} = [${items.join(", ")}] as const;`;
  if (single.length <= 110) return single;
  return [`${declaration} = [`, ...items.map((item) => `  ${item},`), "] as const;"].join("\n");
}

function renderEnum(def: EnumDef): string {
  const lines: string[] = [];
  lines.push(`export const ${def.name} = {`);
  def.members.forEach((member, index) => {
    lines.push(`  ${member}: ${index},`);
  });
  lines.push("} as const;");
  lines.push(`export type ${def.name} = (typeof ${def.name})[keyof typeof ${def.name}];`);
  lines.push(renderStringArray(`export const ${def.name}Names`, def.members));
  lines.push(`export type ${def.name}Name = (typeof ${def.name}Names)[number];`);
  lines.push(`export function ${lowerFirst(def.name)}Name(value: ${def.name}): ${def.name}Name {`);
  lines.push(`  const name = ${def.name}Names[value];`);
  lines.push(
    `  if (name === undefined) throw new RangeError(\`${def.name} value out of range: \${value}\`);`,
  );
  lines.push("  return name;");
  lines.push("}");
  return lines.join("\n");
}

function renderFields(params: readonly AbiParam[], used: PrimitiveUse): string[] {
  return params.map((param, index) => {
    const name = param.name !== undefined && param.name.length > 0 ? param.name : `field${index}`;
    return `  ${name}: ${solidityTypeToTs(param, used)};`;
  });
}

function renderInterface(name: string, params: readonly AbiParam[], used: PrimitiveUse, doc: string): string {
  const lines: string[] = [`/** ${doc} */`, `export interface ${name} {`];
  lines.push(...renderFields(params, used));
  lines.push("}");
  return lines.join("\n");
}

function renderRecordConst(constName: string, entries: readonly (readonly [string, string])[]): string {
  const lines: string[] = [`export const ${constName} = {`];
  for (const [key, value] of entries) lines.push(`  ${key}: ${JSON.stringify(value)},`);
  lines.push("} as const;");
  return lines.join("\n");
}

export type TypesInput = {
  typesSol: string;
  errorsSol: string;
  vaultAbi: AbiEntry[];
  drawAbi: AbiEntry[];
  otherAbis: AbiEntry[][];
};

export function renderTypesModule(input: TypesInput): string {
  const enums = parseEnums(input.typesSol);
  const projectErrors = parseErrorNames(input.errorsSol);
  const structs = collectStructs([input.vaultAbi, input.drawAbi, ...input.otherAbis]);
  const used: PrimitiveUse = new Set();

  const body: string[] = [];

  body.push("// ---------------------------------------------------------------------------");
  body.push("// Enums (contracts/src/Types.sol). Member order is ABI order and is never sorted.");
  body.push("// ---------------------------------------------------------------------------");
  body.push("");
  body.push(enums.map(renderEnum).join("\n\n"));
  body.push("");

  body.push("// ---------------------------------------------------------------------------");
  body.push("// Structs reachable from the generated ABIs. Every integer is a bigint (SPEC §5.1, §8.1).");
  body.push("// ---------------------------------------------------------------------------");
  body.push("");
  const structBlocks = structs.map((struct) =>
    renderInterface(struct.name, struct.components, used, `Solidity \`${struct.qualified}\`.`),
  );
  body.push(structBlocks.join("\n\n"));
  body.push("");

  const vaultEvents = collectEvents(input.vaultAbi);
  const drawEvents = collectEvents(input.drawAbi);

  // Vault and Draw both inherit Ownable2Step, so a few events appear in both ABIs. Identical signatures
  // collapse into one interface; a genuine clash is a generation error rather than a silent overwrite.
  const eventArgs = new Map<string, {signature: string; inputs: AbiParam[]}>();
  for (const event of [...vaultEvents, ...drawEvents]) {
    const existing = eventArgs.get(event.name);
    if (existing === undefined) {
      eventArgs.set(event.name, {signature: event.signature, inputs: event.inputs});
    } else if (existing.signature !== event.signature) {
      throw new GenerateError(
        `event ${event.name} has two signatures: ${existing.signature} and ${event.signature}`,
      );
    }
  }

  body.push("// ---------------------------------------------------------------------------");
  body.push("// Event argument records (SPEC §8.2). Indexed and non-indexed fields alike.");
  body.push("// ---------------------------------------------------------------------------");
  body.push("");
  const argBlocks = [...eventArgs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, def]) =>
      renderInterface(`${name}Args`, def.inputs, used, `Arguments of \`${def.signature}\`.`),
    );
  body.push(argBlocks.join("\n\n"));
  body.push("");

  body.push("// ---------------------------------------------------------------------------");
  body.push(
    "// Event topics and custom-error selectors, computed at generation time so a consumer can check",
  );
  body.push("// completeness without instantiating an ethers Interface (SPEC §8.1, §10.1).");
  body.push("// ---------------------------------------------------------------------------");
  body.push("");

  const topicBlocks: string[] = [];
  for (const [contract, events] of [
    ["vault", vaultEvents],
    ["draw", drawEvents],
  ] as const) {
    const prefix = contract === "vault" ? "Vault" : "Draw";
    const constName = `${contract}EventTopics`;
    topicBlocks.push(
      [
        renderRecordConst(
          constName,
          events.map((event) => [event.name, event.topic0] as const),
        ),
        `export type ${prefix}EventName = keyof typeof ${constName};`,
        "",
        `/** Event name to its argument record, so a decoder can be typed by name. */`,
        `export interface ${prefix}EventArgsByName {`,
        ...events.map((event) => `  ${event.name}: ${event.name}Args;`),
        "}",
      ].join("\n"),
    );
  }
  body.push(topicBlocks.join("\n\n"));
  body.push("");

  const errorBlocks: string[] = [];
  for (const [contract, abi] of [
    ["vault", input.vaultAbi],
    ["draw", input.drawAbi],
  ] as const) {
    const errors = collectErrors(abi);
    const constName = `${contract}ErrorSelectors`;
    const typeName = `${contract === "vault" ? "Vault" : "Draw"}ErrorName`;
    errorBlocks.push(
      [
        renderRecordConst(
          constName,
          errors.map((error) => [error.name, error.selector] as const),
        ),
        `export type ${typeName} = keyof typeof ${constName};`,
      ].join("\n"),
    );
  }
  body.push(errorBlocks.join("\n\n"));
  body.push("");

  body.push(
    [
      "/**",
      " * The error names declared in contracts/src/Errors.sol. Anything else a Vault or Draw ABI declares comes",
      " * from a pinned dependency (OpenZeppelin's `OwnableUnauthorizedAccount`, `SafeERC20FailedOperation`,",
      " * `ReentrancyGuardReentrantCall`), which SPEC §8.1 allows the client to decode as a documented",
      " * dependency error. `src/errors/` uses this list to classify a decoded revert.",
      " */",
      renderStringArray("export const projectErrorNames", projectErrors),
      "export type ProjectErrorName = (typeof projectErrorNames)[number];",
    ].join("\n"),
  );

  const imports =
    used.size === 0 ? "" : `import type {${[...used].sort().join(", ")}} from "./common.ts";\n\n`;

  return `${header("contracts/src/Types.sol, contracts/src/Errors.sol and the generated ABIs")}\n${imports}${body.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type GeneratedFile = {path: string; content: string};

function requireAbi(abis: Map<string, AbiEntry[]>, constName: string): AbiEntry[] {
  const abi = abis.get(constName);
  if (abi === undefined) throw new GenerateError(`no ABI was read for ${constName}`);
  return abi;
}

/** Regenerates every output in memory. Throws `MissingArtifactError` when an artifact is absent. */
export function generateAll(): GeneratedFile[] {
  const abis = new Map<string, AbiEntry[]>();
  const files: GeneratedFile[] = [];

  for (const spec of ARTIFACTS) {
    const abi = readArtifactAbi(artifactPath(spec));
    abis.set(spec.constName, abi);
    files.push({
      path: join(PACKAGE_ROOT, "src", "abi", "generated", spec.outFile),
      content: renderAbiModule(spec, abi),
    });
  }

  for (const path of [TYPES_SOL, ERRORS_SOL]) {
    if (!existsSync(path)) throw new MissingArtifactError(path);
  }

  files.push({
    path: join(PACKAGE_ROOT, "src", "types", "generated.ts"),
    content: renderTypesModule({
      typesSol: readFileSync(TYPES_SOL, "utf8"),
      errorsSol: readFileSync(ERRORS_SOL, "utf8"),
      vaultAbi: requireAbi(abis, "luckyVaultAbi"),
      drawAbi: requireAbi(abis, "luckyDrawAbi"),
      otherAbis: [requireAbi(abis, "multicall3Abi"), requireAbi(abis, "aggregatorV3Abi")],
    }),
  });

  return files;
}

function relativeToPackage(path: string): string {
  return path
    .slice(PACKAGE_ROOT.length + 1)
    .split("\\")
    .join("/");
}

export function writeGenerated(files: readonly GeneratedFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    mkdirSync(dirname(file.path), {recursive: true});
    const existing = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
    if (existing === file.content) continue;
    writeFileSync(file.path, file.content, "utf8");
    written.push(relativeToPackage(file.path));
  }
  return written;
}

/** Returns the package-relative paths whose committed content differs from a fresh generation. */
export function checkGenerated(files: readonly GeneratedFile[]): string[] {
  const stale: string[] = [];
  for (const file of files) {
    const existing = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
    if (existing !== file.content) stale.push(relativeToPackage(file.path));
  }
  return stale;
}

export function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  let files: GeneratedFile[];
  try {
    files = generateAll();
  } catch (error) {
    if (error instanceof MissingArtifactError) {
      process.stderr.write(`generate: ${error.message}\n`);
      process.stderr.write("generate: run `cd contracts && forge build` and try again.\n");
      return 2;
    }
    throw error;
  }

  if (check) {
    const stale = checkGenerated(files);
    if (stale.length > 0) {
      process.stderr.write(`generate --check: ${stale.length} generated file(s) are stale:\n`);
      for (const path of stale) process.stderr.write(`  ${path}\n`);
      process.stderr.write("generate --check: run `node scripts/generate.ts` and commit the result.\n");
      return 1;
    }
    process.stdout.write(`generate --check: ${files.length} generated file(s) up to date.\n`);
    return 0;
  }

  const written = writeGenerated(files);
  if (written.length === 0) {
    process.stdout.write(`generate: ${files.length} generated file(s) already up to date.\n`);
  } else {
    process.stdout.write(`generate: wrote ${written.length} of ${files.length} file(s):\n`);
    for (const path of written) process.stdout.write(`  ${path}\n`);
  }
  return 0;
}

// Only run as a program: `src/abi/generate.test.ts` imports the pure functions above.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
