// LuckyDraw configuration validator (SPEC sections 12, 15 and 11.2 "Static/mutation").
//
// Walks `config/`, validates every JSON document against the schema its directory implies, then applies
// the cross-field rules that JSON Schema cannot express: identifier and file-name agreement, the mock
// boundary, the maxPriceAge policy, custody separation on mainnet, constructor/VRF agreement and pool
// uniqueness. A final pass applies the rules that need two documents (a mainnet manifest against its
// chain record; a recovery drill against the manifest's Safes). Prints one line per document and exits 1
// if anything failed. No network access: every rule is decided from the tree and the repository.
//
// Runs under plain `node scripts/validate_config.ts` on Node 24 (LTS, pinned in .nvmrc) and Node 25:
// both strip types natively, so this file stays inside the erasable TypeScript subset - no enums, no
// namespaces, no parameter properties, no runtime-visible type syntax.
//
// Usage:  node scripts/validate_config.ts [configRoot]
//         configRoot defaults to <repo>/config. Tests pass fixture roots.

import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import type {ErrorObject, ValidateFunction} from "ajv";
import {Ajv2020} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const SCRIPT_DIR: string = import.meta.dirname;
const REPO_ROOT: string = dirname(SCRIPT_DIR);
const SCHEMA_DIR: string = join(REPO_ROOT, "config", "schema");
const SCHEMA_BASE = "https://luckydraw.invalid/schema/";

const MAX_UINT256: bigint = (1n << 256n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Chains whose public identity is fixed. A record for one of these must agree with it. */
const KNOWN_CHAINS: Record<
  string,
  {nativeSymbol: string; displayName: string; explorerUrl: string; environment: string}
> = {
  "56": {
    nativeSymbol: "BNB",
    displayName: "BNB Smart Chain",
    explorerUrl: "https://bscscan.com",
    environment: "mainnet",
  },
  "97": {
    nativeSymbol: "BNB",
    displayName: "BNB Smart Chain Testnet",
    explorerUrl: "https://testnet.bscscan.com",
    environment: "testnet",
  },
};

type Kind =
  | "chain"
  | "asset"
  | "deployment"
  | "plan"
  | "operations"
  | "hosting"
  | "release-authority"
  | "acceptance";

const SCHEMA_FOR_KIND: Record<Kind, string> = {
  chain: "chain.schema.json",
  asset: "asset.schema.json",
  deployment: "deployment.schema.json",
  plan: "deployment-plan.schema.json",
  operations: "operations.schema.json",
  hosting: "hosting.schema.json",
  "release-authority": "release-authority.schema.json",
  acceptance: "acceptance.schema.json",
};

type Doc = Record<string, any>;

export type FileResult = {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  kind: Kind | null;
  errors: string[];
  warnings: string[];
};

export type RunResult = {
  results: FileResult[];
  failed: number;
  passed: number;
  warnings: number;
};

/** Manifest keys are read as own properties, so a name inherited from Object.prototype (such as `constructor`) can never satisfy a check. */
function own(value: unknown, key: string): any {
  if (value === null || typeof value !== "object") return undefined;
  return Object.hasOwn(value as object, key) ? (value as Doc)[key] : undefined;
}

function isObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function listJsonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir).sort();
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.toLowerCase().endsWith(".json")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

function buildAjv(): {ajv: InstanceType<typeof Ajv2020>; schemaErrors: string[]} {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    // JSON.parse produces objects inheriting Object.prototype, so `data.constructor` is never undefined.
    // Own-property semantics keep any inherited name from satisfying `required`; the Draw record is
    // therefore named `constructorArgs`, and the validator never trusts inherited properties.
    ownProperties: true,
  });
  addFormats(ajv);

  const schemaErrors: string[] = [];
  if (!existsSync(SCHEMA_DIR)) {
    schemaErrors.push(`schema directory not found: ${toPosix(SCHEMA_DIR)}`);
    return {ajv, schemaErrors};
  }
  for (const file of readdirSync(SCHEMA_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const full = join(SCHEMA_DIR, file);
    let schema: Doc;
    try {
      schema = JSON.parse(readFileSync(full, "utf8")) as Doc;
    } catch (error) {
      schemaErrors.push(`config/schema/${file}: not valid JSON (${(error as Error).message})`);
      continue;
    }
    const expectedId = `${SCHEMA_BASE}${file}`;
    if (schema.$id !== expectedId) {
      schemaErrors.push(
        `config/schema/${file}: $id is ${JSON.stringify(schema.$id)}, expected ${expectedId}`,
      );
    }
    try {
      ajv.addSchema(schema);
    } catch (error) {
      schemaErrors.push(`config/schema/${file}: rejected by Ajv (${(error as Error).message})`);
    }
  }
  return {ajv, schemaErrors};
}

function formatAjvError(error: ErrorObject): string {
  const where = error.instancePath === "" ? "(document root)" : error.instancePath;
  let detail = error.message ?? "is invalid";
  if (error.keyword === "additionalProperties") {
    detail = `has an unknown property "${String((error.params as Doc).additionalProperty)}"`;
  } else if (error.keyword === "const") {
    detail = `must equal ${JSON.stringify((error.params as Doc).allowedValue)}`;
  } else if (error.keyword === "enum") {
    detail = `must be one of ${JSON.stringify((error.params as Doc).allowedValues)}`;
  } else if (error.keyword === "false schema") {
    detail = "is not allowed here";
  }
  return `[schema] ${where} ${detail}`;
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

type Classification = {kind: Kind; segments: string[]; base: string};

function classify(relativeToConfigRoot: string): Classification | null {
  const segments = relativeToConfigRoot.split("/");
  const base = segments[segments.length - 1].replace(/\.json$/i, "");
  const dir = segments[0];
  if (dir === "chains" && segments.length === 2) return {kind: "chain", segments, base};
  if (dir === "assets" && segments.length === 3) return {kind: "asset", segments, base};
  if (dir === "deployments" && segments.length === 3) {
    if (base.endsWith(".plan")) return {kind: "plan", segments, base};
    return {kind: "deployment", segments, base};
  }
  if (dir === "operations" && segments.length === 2) return {kind: "operations", segments, base};
  if (dir === "hosting" && segments.length === 2) return {kind: "hosting", segments, base};
  if (dir === "release-authority" && segments.length === 2)
    return {kind: "release-authority", segments, base};
  if (dir === "acceptance" && segments.length === 2) return {kind: "acceptance", segments, base};
  return null;
}

// ---------------------------------------------------------------------------
// Pinned-toolchain facts read from the repository
// ---------------------------------------------------------------------------

type Pins = {
  solc: string | null;
  evmVersion: string | null;
  optimizer: boolean | null;
  optimizerRuns: number | null;
  viaIr: boolean | null;
  bytecodeHash: string | null;
  foundryInCi: string | null;
};

let pinsCache: Pins | null = null;

function readPins(): Pins {
  if (pinsCache !== null) return pinsCache;
  const pins: Pins = {
    solc: null,
    evmVersion: null,
    optimizer: null,
    optimizerRuns: null,
    viaIr: null,
    bytecodeHash: null,
    foundryInCi: null,
  };
  const foundryToml = join(REPO_ROOT, "contracts", "foundry.toml");
  if (existsSync(foundryToml)) {
    const text = readFileSync(foundryToml, "utf8");
    const start = text.indexOf("[profile.default]");
    if (start >= 0) {
      const rest = text.slice(start + "[profile.default]".length);
      const nextSection = rest.search(/\n\[/);
      const section = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
      const scalar = (key: string): string | null => {
        const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*([^#\\n]+)`, "m"));
        return match === null ? null : match[1].trim().replace(/^"|"$/g, "");
      };
      pins.solc = scalar("solc_version");
      pins.evmVersion = scalar("evm_version");
      const optimizer = scalar("optimizer");
      pins.optimizer = optimizer === null ? null : optimizer === "true";
      const runs = scalar("optimizer_runs");
      pins.optimizerRuns = runs === null ? null : Number(runs);
      const viaIr = scalar("via_ir");
      pins.viaIr = viaIr === null ? null : viaIr === "true";
      pins.bytecodeHash = scalar("bytecode_hash");
    }
  }
  const ciYml = join(REPO_ROOT, ".github", "workflows", "ci.yml");
  if (existsSync(ciYml)) {
    const match = readFileSync(ciYml, "utf8").match(/version:\s*v([0-9]+\.[0-9]+\.[0-9]+)/);
    pins.foundryInCi = match === null ? null : match[1];
  }
  pinsCache = pins;
  return pins;
}

// ---------------------------------------------------------------------------
// Cross-field rules
// ---------------------------------------------------------------------------

type Sink = {errors: string[]; warnings: string[]};

function fail(sink: Sink, rule: string, message: string): void {
  sink.errors.push(`[${rule}] ${message}`);
}

function warn(sink: Sink, rule: string, message: string): void {
  sink.warnings.push(`[${rule}] ${message}`);
}

/** G1: every long decimal string in the document must fit in uint256. */
function checkUintRange(value: unknown, path: string, sink: Sink): void {
  if (typeof value === "string") {
    if (/^[0-9]{20,}$/.test(value) && BigInt(value) > MAX_UINT256) {
      fail(sink, "G1", `${path} is ${value}, which exceeds 2^256-1`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      checkUintRange(item, `${path}[${index}]`, sink);
    });
    return;
  }
  if (isObject(value)) {
    for (const key of Object.keys(value as Doc)) {
      checkUintRange((value as Doc)[key], `${path}.${key}`, sink);
    }
  }
}

/** P1-P5: the Price record rules from SPEC 3.1 and ADR 020. */
function checkPrice(price: unknown, where: string, environment: string | null, sink: Sink): void {
  if (!isObject(price)) return;
  const p = price as Doc;

  const heartbeat = p.heartbeatSeconds;
  const maxAge = p.maxPriceAge;
  // P1: max(2H, 3600) can only be checked against a documented heartbeat H. Null (or an absent key) is
  // the local-mock escape hatch and nothing else: outside `local` the bounds check alone would accept any
  // maxPriceAge in 60..172800, including one no real feed justifies.
  if (typeof heartbeat !== "number" && environment !== null && environment !== "local") {
    fail(
      sink,
      "P1",
      `${where}.heartbeatSeconds is ${heartbeat === undefined ? "absent" : JSON.stringify(heartbeat)} in a ${environment} document; SPEC 3.1 and 15 require the documented feed heartbeat H so that maxPriceAge = max(2H, 3600) can be checked, and only a local mock may omit it`,
    );
  }
  if (typeof heartbeat === "number" && typeof maxAge === "number") {
    const expected = Math.max(2 * heartbeat, 3600);
    if (maxAge !== expected) {
      fail(
        sink,
        "P1",
        `${where}.maxPriceAge is ${maxAge}; SPEC 3.1 / ADR 020 require max(2H, 3600) = ${expected} for heartbeat H = ${heartbeat}`,
      );
    }
  } else if (typeof maxAge === "number" && (maxAge < 60 || maxAge > 172800)) {
    fail(sink, "P1", `${where}.maxPriceAge is ${maxAge}, outside the 60..172800 bounds in Types.sol`);
  }

  if (typeof p.minAnswer === "string" && typeof p.maxAnswer === "string") {
    const min = BigInt(p.minAnswer);
    const max = BigInt(p.maxAnswer);
    if (min !== 0n && max !== 0n && min >= max) {
      fail(
        sink,
        "P2",
        `${where} has minAnswer ${p.minAnswer} >= maxAnswer ${p.maxAnswer}; PriceReader rejects that config`,
      );
    }
    if (min === 0n && max === 0n && p.answerBoundsConfirmedAbsent !== true) {
      warn(
        sink,
        "P2w",
        `${where} records no aggregator bounds but does not set answerBoundsConfirmedAbsent; SPEC 15 wants the absence confirmed, not merely unchecked`,
      );
    }
  }

  if (p.referenceKind === "UnderlyingAsset") {
    if (typeof p.displayLabel !== "string" || p.displayLabel.length === 0) {
      fail(
        sink,
        "P3",
        `${where} uses referenceKind UnderlyingAsset without a displayLabel; SPEC 3.1 makes the label mandatory`,
      );
    }
    if (typeof p.pegAssumption !== "string" || p.pegAssumption.length === 0) {
      fail(
        sink,
        "P3",
        `${where} uses referenceKind UnderlyingAsset without a recorded pegAssumption (SPEC 3.1)`,
      );
    }
  }

  if (p.feed === null && p.feedIsMock !== true) {
    fail(
      sink,
      "P5",
      `${where}.feed is null but feedIsMock is not true; only a local mock may defer its feed address`,
    );
  }

  if (environment !== null && environment !== "local") {
    if (p.feedIsMock === true) {
      fail(
        sink,
        "M1",
        `${where}.feedIsMock is true in a ${environment} document; only the local environment may reference mocks (SPEC 12)`,
      );
    }
    if (p.feed === null) {
      fail(sink, "M1", `${where}.feed is null in a ${environment} document`);
    }
    if (p.source === undefined || own(p.source, "url") === null) {
      warn(
        sink,
        "P4w",
        `${where} has no source URL; SPEC 15 requires the feed's verification source and date`,
      );
    }
  }
  if (environment !== "mainnet") return;

  // P6: before mainnet the p99.9 update interval is measured on this chain, not assumed from the
  // documented heartbeat. A feed that meets its heartbeat on paper can still be late in practice.
  const observed = p.observedP999IntervalSeconds;
  if (typeof observed !== "number") {
    fail(
      sink,
      "P6",
      `${where}.observedP999IntervalSeconds is ${observed === undefined ? "absent" : JSON.stringify(observed)}; SPEC 3.1 and 15 require the p99.9 update interval observed on this chain before a mainnet release (scripts/observe_feed.ts prints it)`,
    );
  } else if (typeof maxAge === "number" && observed > maxAge) {
    // P7: the reverse bound (>= heartbeatSeconds) is deliberately not required: a deviation-driven
    // feed updates far more often than its heartbeat, so a short observed interval is normal.
    fail(
      sink,
      "P7",
      `${where}.observedP999IntervalSeconds is ${observed} but maxPriceAge is ${maxAge}; one update in a thousand is already older than the contract tolerates, so entries would halt on a healthy feed (SPEC 3.1)`,
    );
  }

  // P8: an interval with no window is an unattributable number. Item 3's observe_feed script prints it.
  const window = isObject(p.observationWindow) ? (p.observationWindow as Doc) : null;
  if (window === null) {
    fail(
      sink,
      "P8",
      `${where}.observationWindow is ${p.observationWindow === undefined ? "absent" : JSON.stringify(p.observationWindow)}; a mainnet price record records the {fromBlock, toBlock, samples} its observedP999IntervalSeconds was computed over (SPEC 15)`,
    );
    return;
  }
  for (const field of ["fromBlock", "toBlock", "samples"] as const) {
    if (typeof window[field] !== "number") {
      fail(
        sink,
        "P8",
        `${where}.observationWindow.${field} is ${window[field] === undefined ? "absent" : JSON.stringify(window[field])}; the observation window records fromBlock, toBlock and samples`,
      );
    }
  }
  if (
    typeof window.fromBlock === "number" &&
    typeof window.toBlock === "number" &&
    window.toBlock <= window.fromBlock
  ) {
    fail(
      sink,
      "P8",
      `${where}.observationWindow spans fromBlock ${window.fromBlock} to toBlock ${window.toBlock}; the window must move forward for an interval to be measurable`,
    );
  }
}

/** A2-A9: Asset record rules shared by standalone records and manifest entries. */
function checkAssetShape(asset: unknown, where: string, environment: string | null, sink: Sink): void {
  if (!isObject(asset)) return;
  const a = asset as Doc;

  if (a.native === true) {
    if (a.asset !== ZERO_ADDRESS) {
      fail(
        sink,
        "A3",
        `${where} is native but its address is ${JSON.stringify(a.asset)}; native BNB is the zero-address sentinel (Types.sol NATIVE_ASSET)`,
      );
    }
    if (a.decimals !== 18) {
      fail(
        sink,
        "A3",
        `${where} is native but declares ${a.decimals} decimals; native BNB uses 18 (SPEC 3.1)`,
      );
    }
  } else if (a.native === false && a.asset === ZERO_ADDRESS) {
    fail(sink, "A3", `${where} is not native but uses the zero-address native sentinel`);
  }

  if (a.asset === null && a.isMock !== true) {
    fail(
      sink,
      "A4",
      `${where}.asset is null but isMock is not true; only a local mock may defer its address`,
    );
  }

  // A9: SPEC 9.5 flags a token whose approve() refuses a nonzero-to-nonzero change, so the app offers
  // approve(0) then approve(amount). Absent means false; anything that is not a boolean is a rejection,
  // because a truthy string would silently turn the extra step on (or a "false" string turn it off), and a
  // native asset has no approve at all.
  if (a.requiresZeroReset !== undefined && typeof a.requiresZeroReset !== "boolean") {
    fail(
      sink,
      "A9",
      `${where}.requiresZeroReset is ${JSON.stringify(a.requiresZeroReset)}; it must be a boolean, or absent for false (SPEC 9.5)`,
    );
  }
  if (a.requiresZeroReset === true && a.native === true) {
    fail(
      sink,
      "A9",
      `${where} is native but sets requiresZeroReset; native BNB has no approve to reset (SPEC 4.2, 9.5)`,
    );
  }

  const mockStatus = a.status === "mock-local";
  if (mockStatus !== (a.isMock === true)) {
    fail(
      sink,
      "A5",
      `${where} has status ${JSON.stringify(a.status)} with isMock ${JSON.stringify(a.isMock)}; status "mock-local" and isMock must agree`,
    );
  }

  if (environment !== null && environment !== "local") {
    if (a.isMock === true) {
      fail(
        sink,
        "M1",
        `${where}.isMock is true in a ${environment} document; SPEC 12 forbids a mock artifact outside the local environment`,
      );
    }
    if (a.asset === null) {
      fail(sink, "M1", `${where}.asset is null in a ${environment} document`);
    }
  }
  if (environment === "mainnet" && a.native !== true) {
    if (typeof a.exactTransferEvidence !== "string" || a.exactTransferEvidence.length === 0) {
      fail(
        sink,
        "A7",
        `${where} has no exactTransferEvidence; SPEC 3.1 admits only tokens with recorded exact-transfer evidence`,
      );
    }
    if (a.status !== "approved") {
      fail(
        sink,
        "A8",
        `${where} has status ${JSON.stringify(a.status)}; a mainnet manifest lists only approved assets`,
      );
    }
  }

  checkPrice(a.price, `${where}.price`, environment, sink);
}

/** V1: the recorded maxRequestCostNative must cover the recorded derivation (SPEC 7.1). */
function checkVrfCost(vrf: unknown, sink: Sink): void {
  if (!isObject(vrf)) return;
  const v = vrf as Doc;
  const derivation = v.maxRequestCostDerivation;
  if (!isObject(derivation)) return;
  const d = derivation as Doc;
  if (
    typeof d.maxGasPriceWei !== "string" ||
    typeof d.flatFeeNativeWei !== "string" ||
    typeof d.verificationGasOverhead !== "number" ||
    typeof d.premiumPercentage !== "number" ||
    typeof v.callbackGasLimit !== "number" ||
    typeof v.maxRequestCostNative !== "string"
  ) {
    return;
  }
  const premiumBps = BigInt(Math.round(d.premiumPercentage * 100));
  const gas = BigInt(v.callbackGasLimit + d.verificationGasOverhead);
  const derived =
    (BigInt(d.maxGasPriceWei) * gas * (10000n + premiumBps)) / 10000n + BigInt(d.flatFeeNativeWei);
  if (BigInt(v.maxRequestCostNative) < derived) {
    fail(
      sink,
      "V1",
      `vrf.maxRequestCostNative is ${v.maxRequestCostNative} but its own derivation yields at least ${derived.toString()} wei; a request accepted below the true cost can never be fulfilled (SPEC 7.1)`,
    );
  }
  if (
    typeof v.lowFundingThresholdNative === "string" &&
    BigInt(v.lowFundingThresholdNative) < BigInt(v.maxRequestCostNative)
  ) {
    warn(
      sink,
      "V2w",
      `vrf.lowFundingThresholdNative (${v.lowFundingThresholdNative}) is below one request's maxRequestCostNative; the alert would fire too late to keep requestDraw working`,
    );
  }
}

function checkToolchain(toolchain: unknown, sink: Sink): void {
  if (!isObject(toolchain)) return;
  const t = toolchain as Doc;
  const pins = readPins();
  const compare = (field: string, pinned: unknown, pinName: string): void => {
    if (pinned === null || pinned === undefined) return;
    if (t[field] !== pinned) {
      fail(
        sink,
        "T1",
        `toolchain.${field} is ${JSON.stringify(t[field])} but contracts/foundry.toml pins ${pinName} = ${JSON.stringify(pinned)}`,
      );
    }
  };
  compare("solc", pins.solc, "solc_version");
  compare("evmVersion", pins.evmVersion, "evm_version");
  compare("optimizer", pins.optimizer, "optimizer");
  compare("optimizerRuns", pins.optimizerRuns, "optimizer_runs");
  compare("viaIr", pins.viaIr, "via_ir");
  compare("bytecodeHash", pins.bytecodeHash, "bytecode_hash");
  if (pins.foundryInCi !== null && t.foundry !== pins.foundryInCi) {
    warn(
      sink,
      "T2w",
      `toolchain.foundry is ${JSON.stringify(t.foundry)} but .github/workflows/ci.yml builds with v${pins.foundryInCi}`,
    );
  }
}

/** E1: environment and chainId must agree. BSC mainnet is 56 and BSC testnet is 97 (SPEC 12, ACCEPTANCE A37). */
function checkEnvironmentChain(environment: unknown, chainId: unknown, sink: Sink): void {
  if (typeof chainId !== "number" || typeof environment !== "string") return;
  const known = KNOWN_CHAINS[String(chainId)];
  if (known !== undefined && known.environment !== environment) {
    fail(
      sink,
      "E1",
      `environment "${environment}" does not match chainId ${chainId}, which is ${known.environment} (${known.explorerUrl})`,
    );
  }
  if (environment === "mainnet" && chainId !== 56) {
    fail(
      sink,
      "E1",
      `environment "mainnet" with chainId ${chainId}; the only mainnet in this product is BSC (56)`,
    );
  }
  if (environment === "testnet" && chainId !== 97) {
    fail(
      sink,
      "E1",
      `environment "testnet" with chainId ${chainId}; the only testnet in this product is BSC testnet (97)`,
    );
  }
  if (environment === "local" && chainId !== 31337) {
    warn(
      sink,
      "E2w",
      `environment "local" with chainId ${chainId}; the local development chain is anvil (31337)`,
    );
  }
}

/** CH2: a record for a chain whose public identity is fixed must agree with it (ACCEPTANCE A37). */
function checkKnownChainFacts(chain: unknown, where: string, sink: Sink): void {
  if (!isObject(chain)) return;
  const c = chain as Doc;
  const known = KNOWN_CHAINS[String(c.chainId)];
  if (known === undefined) return;
  if (c.nativeSymbol !== undefined && c.nativeSymbol !== known.nativeSymbol) {
    fail(
      sink,
      "CH2",
      `${where}: chain ${c.chainId} has native symbol ${known.nativeSymbol}, not ${JSON.stringify(c.nativeSymbol)}`,
    );
  }
  if (c.displayName !== undefined && c.displayName !== known.displayName) {
    fail(
      sink,
      "CH2",
      `${where}: chain ${c.chainId} is shown to players as ${JSON.stringify(known.displayName)}, not ${JSON.stringify(c.displayName)}; a testnet must never be named as if it were mainnet`,
    );
  }
  if (c.explorerUrl !== undefined && c.explorerUrl !== known.explorerUrl) {
    fail(
      sink,
      "CH2",
      `${where}: chain ${c.chainId} explorerUrl is ${JSON.stringify(c.explorerUrl)}, expected ${known.explorerUrl}`,
    );
  }
}

function checkCustody(environment: unknown, ownership: unknown, sink: Sink): void {
  if (!isObject(ownership)) return;
  const o = ownership as Doc;
  const accounts = [o.finalOwner, o.feeAccount, o.seedAccount];
  if (environment === "mainnet") {
    const distinct = new Set(accounts.filter((a) => typeof a === "string"));
    if (distinct.size !== 3) {
      fail(
        sink,
        "O1",
        `mainnet requires separate owner, treasury and seed Safes (SPEC 10.5); finalOwner=${o.finalOwner}, feeAccount=${o.feeAccount}, seedAccount=${o.seedAccount}`,
      );
    }
    // O4: SPEC 10.5 and 14 require a funded make-whole reserve with a nonzero cap before real money is
    // accepted. Null or "0" stays legal on local and testnet, where there is nothing to make whole.
    for (const [name, value] of [
      ["makeWholeReserve", o.makeWholeReserve],
      ["makeWholeCap", o.makeWholeCap],
    ] as const) {
      const positive = typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
      if (!positive) {
        fail(
          sink,
          "O4",
          `ownership.${name} is ${value === undefined ? "absent" : JSON.stringify(value)}; mainnet requires a funded make-whole reserve with a nonzero cap (SPEC 10.5, 14), and only local and testnet may leave it null or "0"`,
        );
      }
    }
  } else if (environment === "testnet") {
    const distinct = new Set(accounts.filter((a) => typeof a === "string"));
    if (distinct.size !== 3) {
      warn(
        sink,
        "O2w",
        `owner, treasury and seed share an account; SPEC 12.1 allows one operator Safe on testnet but mainnet requires three`,
      );
    }
  }
  for (const [name, value] of [
    ["finalOwner", o.finalOwner],
    ["feeAccount", o.feeAccount],
    ["seedAccount", o.seedAccount],
  ] as const) {
    if (value === ZERO_ADDRESS) {
      fail(sink, "O3", `ownership.${name} is the zero address`);
    }
  }
}

/** Rules for a deployment manifest. */
function checkDeployment(doc: Doc, cls: Classification, sink: Sink): void {
  const chain = isObject(doc.chain) ? (doc.chain as Doc) : null;
  const contracts = isObject(doc.contracts) ? (doc.contracts as Doc) : null;
  const vault = contracts !== null && isObject(contracts.vault) ? (contracts.vault as Doc) : null;
  const draw = contracts !== null && isObject(contracts.draw) ? (contracts.draw as Doc) : null;
  const vrf = isObject(doc.vrf) ? (doc.vrf as Doc) : null;
  const environment = typeof doc.environment === "string" ? doc.environment : null;
  const chainId = chain === null ? undefined : chain.chainId;

  // D1: deploymentId is `${chainId}:${lowercase Draw address}` (SPEC 10.3).
  if (typeof chainId === "number" && draw !== null && typeof draw.address === "string") {
    const expected = `${chainId}:${draw.address}`;
    if (doc.deploymentId !== expected) {
      fail(
        sink,
        "D1",
        `deploymentId is ${JSON.stringify(doc.deploymentId)}, expected ${JSON.stringify(expected)} (chainId + ":" + Draw address)`,
      );
    }
  }

  // D2/D3: the path must carry the same chain and Draw address.
  if (typeof chainId === "number" && cls.segments[1] !== String(chainId)) {
    fail(sink, "D2", `file sits in config/deployments/${cls.segments[1]}/ but chain.chainId is ${chainId}`);
  }
  if (draw !== null && typeof draw.address === "string" && cls.base !== draw.address) {
    fail(
      sink,
      "D3",
      `file is named ${cls.base}.json but the Draw address is ${draw.address}; a manifest is named after its Draw address`,
    );
  }

  checkEnvironmentChain(environment, chainId, sink);
  checkKnownChainFacts(chain, "chain", sink);

  // D4/M1: a mainnet manifest may reference no mock artifact (SPEC 12).
  if (environment !== null && environment !== "local") {
    const mocks = Array.isArray(doc.mocks) ? (doc.mocks as unknown[]) : [];
    if (mocks.length > 0) {
      fail(
        sink,
        "D4",
        `environment is "${environment}" but mocks lists ${mocks.length} artifact(s): ${mocks.join(", ")}`,
      );
    }
    if (vrf !== null && vrf.coordinatorIsMock === true) {
      fail(sink, "M1", `vrf.coordinatorIsMock is true in a ${environment} manifest`);
    }
  }

  // D9/D10/D11: constructor arguments must equal the records they were taken from.
  const ctor = draw === null ? undefined : own(draw, "constructorArgs");
  if (isObject(ctor)) {
    const c = ctor as Doc;
    if (vault !== null && c.vault !== vault.address) {
      fail(
        sink,
        "D9",
        `contracts.draw.constructorArgs.vault is ${c.vault} but contracts.vault.address is ${vault.address}`,
      );
    }
    if (vrf !== null) {
      const pairs: Array<[string, unknown, unknown]> = [
        ["coordinator", c.coordinator, vrf.coordinator],
        ["subscriptionId", c.subscriptionId, vrf.subscriptionId],
        ["keyHash", c.keyHash, vrf.keyHash],
        ["requestConfirmations", c.requestConfirmations, vrf.requestConfirmations],
        ["callbackGasLimit", c.callbackGasLimit, vrf.callbackGasLimit],
        ["maxRequestCostNative", c.maxRequestCostNative, vrf.maxRequestCostNative],
      ];
      for (const [name, fromCtor, fromVrf] of pairs) {
        if (fromCtor !== fromVrf) {
          fail(
            sink,
            "D10",
            `contracts.draw.constructorArgs.${name} is ${JSON.stringify(fromCtor)} but vrf.${name} is ${JSON.stringify(fromVrf)}; every VRF parameter is constructor-fixed (SPEC 7.1)`,
          );
        }
      }
    }
    if (isObject(doc.ownership) && c.feeAccount !== (doc.ownership as Doc).feeAccount) {
      fail(
        sink,
        "D11",
        `contracts.draw.constructorArgs.feeAccount is ${c.feeAccount} but ownership.feeAccount is ${(doc.ownership as Doc).feeAccount}`,
      );
    }
    if (vault !== null && c.feeAccount === vault.address) {
      fail(
        sink,
        "D11",
        `contracts.draw.constructorArgs.feeAccount equals the Vault address; the constructor rejects that (LuckyDraw.sol InvalidRecipient)`,
      );
    }
  } else if (draw !== null) {
    fail(
      sink,
      "D8",
      `contracts.draw has no "constructorArgs" record; the deployed VRF parameters cannot be checked`,
    );
  }

  // D16: once both two-step transfers are accepted, both contracts are owned by finalOwner with nothing pending.
  if (isObject(doc.ownership) && (doc.ownership as Doc).ownershipAccepted === true) {
    const finalOwner = (doc.ownership as Doc).finalOwner;
    for (const [name, record] of [
      ["vault", vault],
      ["draw", draw],
    ] as const) {
      if (record === null) continue;
      if (record.owner !== finalOwner) {
        fail(
          sink,
          "D16",
          `ownership.ownershipAccepted is true but contracts.${name}.owner is ${record.owner}, not finalOwner ${finalOwner}`,
        );
      }
      if (record.pendingOwner !== ZERO_ADDRESS) {
        fail(
          sink,
          "D16",
          `ownership.ownershipAccepted is true but contracts.${name}.pendingOwner is ${record.pendingOwner}, not the zero address`,
        );
      }
    }
  }

  // D17: the indexer scans from startBlock, so neither contract may predate it.
  if (chain !== null && typeof chain.startBlock === "number") {
    for (const [name, record] of [
      ["vault", vault],
      ["draw", draw],
    ] as const) {
      if (
        record !== null &&
        typeof record.deployBlock === "number" &&
        record.deployBlock < chain.startBlock
      ) {
        fail(
          sink,
          "D17",
          `contracts.${name}.deployBlock (${record.deployBlock}) is below chain.startBlock (${chain.startBlock}); the indexer would never see its logs`,
        );
      }
    }
  }

  // D28: the optional Automation executor (SPEC 10.3, ADR 039) is bound to this manifest's Draw, is its own
  // contract, and holds none of the three privileged roles. The whole safety argument for an unattended executor
  // is that it is an ordinary address with four public calls, so a manifest that claims otherwise is refused.
  const upkeep = contracts !== null && isObject(contracts.upkeep) ? (contracts.upkeep as Doc) : null;
  if (upkeep !== null) {
    if (draw !== null && upkeep.draw !== draw.address) {
      fail(
        sink,
        "D28",
        `contracts.upkeep.draw is ${upkeep.draw} but contracts.draw.address is ${draw.address}; the executor is bound to another Draw`,
      );
    }
    if (draw !== null && upkeep.address === draw.address) {
      fail(sink, "D28", `contracts.upkeep.address is the Draw itself`);
    }
    if (vault !== null && upkeep.address === vault.address) {
      fail(sink, "D28", `contracts.upkeep.address is the Vault itself`);
    }
    if (isObject(doc.ownership)) {
      const ownership = doc.ownership as Doc;
      for (const role of ["finalOwner", "feeAccount", "seedAccount"] as const) {
        if (upkeep.address === ownership[role]) {
          fail(
            sink,
            "D28",
            `contracts.upkeep.address is also ownership.${role}; the Automation executor holds no privileged role (SPEC 10.3)`,
          );
        }
      }
    }
    if (
      chain !== null &&
      typeof chain.startBlock === "number" &&
      typeof upkeep.deployBlock === "number" &&
      upkeep.deployBlock < chain.startBlock
    ) {
      fail(
        sink,
        "D28",
        `contracts.upkeep.deployBlock (${upkeep.deployBlock}) is below chain.startBlock (${chain.startBlock})`,
      );
    }
    const registered = typeof upkeep.registry === "string" && upkeep.registry !== ZERO_ADDRESS;
    const hasId = typeof upkeep.upkeepId === "string" && upkeep.upkeepId.length > 0;
    if (registered !== hasId) {
      fail(
        sink,
        "D28",
        `contracts.upkeep records ${registered ? "a registry without an upkeepId" : "an upkeepId without a registry"}; registration produces both or neither`,
      );
    }
  }

  // D25: Vault and Draw are separate contracts (SPEC ADR 002).
  if (vault !== null && draw !== null && vault.address === draw.address) {
    fail(sink, "D25", `contracts.vault.address and contracts.draw.address are the same address`);
  }

  checkToolchain(doc.toolchain, sink);
  checkVrfCost(vrf, sink);
  checkCustody(environment, doc.ownership, sink);

  // D26/D27: the private mainnet shakedown (SPEC 14) is the only thing that opens a mainnet deployment
  // to customers. `release` is optional and an absent object means customerLaunch false.
  if (environment === "mainnet") {
    const release = isObject(doc.release) ? (doc.release as Doc) : null;
    const shakedown = release !== null && isObject(release.shakedown) ? (release.shakedown as Doc) : null;
    if (
      release !== null &&
      release.customerLaunch === true &&
      (shakedown === null || shakedown.performed !== true)
    ) {
      fail(
        sink,
        "D26",
        `release.customerLaunch is true but release.shakedown ${shakedown === null ? "is null" : `.performed is ${JSON.stringify(shakedown.performed)}`}; the operator plays one full round and one refund alone before any customer link is shared (SPEC 14)`,
      );
    }
    if (shakedown !== null && shakedown.performed === true) {
      if (typeof shakedown.date !== "string") {
        fail(
          sink,
          "D27",
          `release.shakedown.performed is true but date is ${shakedown.date === undefined ? "absent" : JSON.stringify(shakedown.date)}`,
        );
      }
      if (!Array.isArray(shakedown.roundIds) || (shakedown.roundIds as unknown[]).length === 0) {
        fail(
          sink,
          "D27",
          `release.shakedown.performed is true but roundIds is ${JSON.stringify(shakedown.roundIds ?? null)}; name the rounds the shakedown actually played`,
        );
      }
      // The numbers SPEC 14 requires in ACCEPTANCE before any customer link is shared. The pre-deploy
      // vrf.measuredCallbackGasUsed is the Foundry measurement and is not what this records.
      for (const [field, kind] of [
        ["callbackGasUsed", "number"],
        ["requestToFulfilmentSeconds", "number"],
        ["costPerDrawNativeWei", "string"],
      ] as const) {
        if (typeof shakedown[field] !== kind) {
          fail(
            sink,
            "D27",
            `release.shakedown.performed is true but ${field} is ${shakedown[field] === undefined ? "absent" : JSON.stringify(shakedown[field])}; SPEC 14 records measured callback gas, request-to-fulfilment latency and cost per draw before any customer link is shared`,
          );
        }
      }
      // D27, second half: a measurement that could not have been taken is worse than a missing one,
      // because it reads as evidence. Each value below is impossible for a fulfilment that really
      // happened, so it means the shakedown was not played or its numbers were copied from nowhere.
      const gasLimit = vrf !== null && typeof vrf.callbackGasLimit === "number" ? vrf.callbackGasLimit : null;
      if (typeof shakedown.callbackGasUsed === "number") {
        if (shakedown.callbackGasUsed <= 0) {
          fail(
            sink,
            "D27",
            `release.shakedown.callbackGasUsed is ${shakedown.callbackGasUsed}; fulfilRandomWords writes storage and emits, so a callback that ran cannot have used no gas`,
          );
        } else if (gasLimit !== null && shakedown.callbackGasUsed > gasLimit) {
          fail(
            sink,
            "D27",
            `release.shakedown.callbackGasUsed is ${shakedown.callbackGasUsed}, above vrf.callbackGasLimit (${gasLimit}); the coordinator caps the callback at that limit, so a fulfilment consuming more could not have been observed`,
          );
        }
      }
      if (
        typeof shakedown.requestToFulfilmentSeconds === "number" &&
        shakedown.requestToFulfilmentSeconds <= 0
      ) {
        fail(
          sink,
          "D27",
          `release.shakedown.requestToFulfilmentSeconds is ${shakedown.requestToFulfilmentSeconds}; the fulfilment lands whole confirmations after the request, so the measured latency is a positive number of seconds`,
        );
      }
      if (shakedown.costPerDrawNativeWei === "0") {
        fail(
          sink,
          "D27",
          `release.shakedown.costPerDrawNativeWei is "0"; a draw pays the coordinator's premium and the keeper's gas, so it cannot have cost nothing`,
        );
      }
      const createdOn = typeof doc.createdAtUtc === "string" ? doc.createdAtUtc.slice(0, 10) : null;
      if (typeof shakedown.date === "string" && createdOn !== null && shakedown.date < createdOn) {
        fail(
          sink,
          "D27",
          `release.shakedown.date is ${JSON.stringify(shakedown.date)} but this manifest records createdAtUtc ${JSON.stringify(doc.createdAtUtc)}; the shakedown is played on the deployed contracts, so it cannot predate the deployment it measures (SPEC 14)`,
        );
      }
    }
  }

  if (environment === "mainnet" && vrf !== null && vrf.consumerRegistered !== true) {
    fail(
      sink,
      "D22",
      `vrf.consumerRegistered is not true; an unregistered consumer can never be fulfilled (SPEC 15 requires the registration receipt)`,
    );
  }

  // D12/D13/D19/D20: per-asset and per-pool uniqueness.
  const assets = Array.isArray(doc.assets) ? (doc.assets as Doc[]) : [];
  const poolIds = new Map<string, number>();
  const symbols = new Map<string, number>();
  const addresses = new Map<string, number>();
  const flatRoundIds: Array<{value: bigint; label: string}> = [];
  assets.forEach((asset, index) => {
    const label = `assets[${index}] (${String(asset.symbol)})`;
    checkAssetShape(asset, label, environment, sink);

    if (typeof asset.symbol === "string") {
      const key = asset.symbol.toLowerCase();
      if (symbols.has(key))
        fail(
          sink,
          "D19",
          `${label} repeats symbol ${asset.symbol}, already used by assets[${symbols.get(key)}]`,
        );
      else symbols.set(key, index);
    }
    if (typeof asset.asset === "string") {
      if (addresses.has(asset.asset))
        fail(
          sink,
          "D20",
          `${label} repeats asset address ${asset.asset}, already used by assets[${addresses.get(asset.asset)}]`,
        );
      else addresses.set(asset.asset, index);
    }
    const pool = isObject(asset.pool) ? (asset.pool as Doc) : null;
    if (pool === null) return;
    if (typeof pool.poolId === "string") {
      if (poolIds.has(pool.poolId)) {
        fail(
          sink,
          "D12",
          `${label} reuses poolId ${pool.poolId}, already used by assets[${poolIds.get(pool.poolId)}]`,
        );
      } else {
        poolIds.set(pool.poolId, index);
      }
    }
    if (Array.isArray(pool.firstRoundIds)) {
      (pool.firstRoundIds as unknown[]).forEach((id, k) => {
        if (typeof id === "string")
          flatRoundIds.push({value: BigInt(id), label: `${label}.pool.firstRoundIds[${k}]`});
      });
    }
    if (pool.seedAmount === "0" && pool.enabled === true) {
      warn(
        sink,
        "D14w",
        `${label} is an enabled pool with seedAmount 0; a lone player in it is refunded instead of drawn (SPEC 5.4)`,
      );
    }
    if (typeof pool.seedAuthorizedMaxPerRound === "string" && typeof pool.seedAmount === "string") {
      if (BigInt(pool.seedAuthorizedMaxPerRound) < BigInt(pool.seedAmount)) {
        fail(
          sink,
          "D15",
          `${label} has seedAmount ${pool.seedAmount} above the authorized cap ${pool.seedAuthorizedMaxPerRound}; the seed would always be skipped as NotAuthorized (SPEC 5.4)`,
        );
      }
    }
  });

  // D13: round ids are assigned in one increasing sequence across every pool addPool created.
  for (let i = 1; i < flatRoundIds.length; i += 1) {
    if (flatRoundIds[i].value <= flatRoundIds[i - 1].value) {
      fail(
        sink,
        "D13",
        `${flatRoundIds[i].label} is ${flatRoundIds[i].value.toString()}, not greater than ${flatRoundIds[i - 1].label} (${flatRoundIds[i - 1].value.toString()}); round ids increase strictly in creation order`,
      );
    }
  }

  if (typeof doc.createdAtUtc === "string" && Number.isNaN(Date.parse(doc.createdAtUtc))) {
    fail(sink, "D24", `createdAtUtc ${JSON.stringify(doc.createdAtUtc)} is not a real instant`);
  }
}

/** Rules for an operator deployment plan. */
function checkPlan(doc: Doc, cls: Classification, sink: Sink): void {
  const chain = isObject(doc.chain) ? (doc.chain as Doc) : null;
  const environment = typeof doc.environment === "string" ? doc.environment : null;
  const chainId = chain === null ? undefined : chain.chainId;

  if (typeof chainId === "number" && cls.segments[1] !== String(chainId)) {
    fail(sink, "PL2", `plan sits in config/deployments/${cls.segments[1]}/ but chain.chainId is ${chainId}`);
  }
  const planName = cls.base.replace(/\.plan$/, "");
  if (typeof doc.name === "string" && doc.name !== planName) {
    fail(sink, "PL3", `plan name is ${JSON.stringify(doc.name)} but the file is ${planName}.plan.json`);
  }

  checkEnvironmentChain(environment, chainId, sink);
  checkKnownChainFacts(chain, "chain", sink);
  checkToolchain(doc.toolchain, sink);
  checkVrfCost(doc.vrf, sink);
  checkCustody(environment, doc.ownership, sink);

  if (
    environment !== null &&
    environment !== "local" &&
    isObject(doc.vrf) &&
    (doc.vrf as Doc).coordinatorIsMock === true
  ) {
    fail(sink, "M1", `vrf.coordinatorIsMock is true in a ${environment} plan`);
  }

  const assets = Array.isArray(doc.assets) ? (doc.assets as Doc[]) : [];
  const symbols = new Map<string, number>();
  assets.forEach((asset, index) => {
    const label = `assets[${index}] (${String(asset.symbol)})`;
    checkAssetShape(asset, label, environment, sink);
    if (typeof asset.symbol === "string") {
      const key = asset.symbol.toLowerCase();
      if (symbols.has(key))
        fail(
          sink,
          "PL8",
          `${label} repeats symbol ${asset.symbol}, already used by assets[${symbols.get(key)}]`,
        );
      else symbols.set(key, index);
    }
  });
}

function checkChainRecord(doc: Doc, cls: Classification, sink: Sink): void {
  if (String(doc.chainId) !== cls.base) {
    fail(
      sink,
      "CH1",
      `file is named ${cls.base}.json but chainId is ${JSON.stringify(doc.chainId)}; a chain record is named after its chain id`,
    );
  }
  checkKnownChainFacts(doc, "chain record", sink);
  const known = KNOWN_CHAINS[String(doc.chainId)];
  if (
    isObject(doc.networkIdentity) &&
    (doc.networkIdentity as Doc).multicall3 === null &&
    known !== undefined
  ) {
    warn(
      sink,
      "CH3w",
      `chain ${doc.chainId} has no verified Multicall3 address; SPEC 10.3 requires it verified in the manifest before batched reads are trusted`,
    );
  }
}

function checkAssetRecord(doc: Doc, cls: Classification, sink: Sink): void {
  if (String(doc.chainId) !== cls.segments[1]) {
    fail(
      sink,
      "A1",
      `file sits in config/assets/${cls.segments[1]}/ but chainId is ${JSON.stringify(doc.chainId)}`,
    );
  }
  if (typeof doc.symbol === "string" && doc.symbol.toLowerCase() !== cls.base) {
    fail(
      sink,
      "A2",
      `file is named ${cls.base}.json but the symbol is ${doc.symbol}; an asset record is named after its lowercase symbol`,
    );
  }
  if (doc.isMock === true && KNOWN_CHAINS[String(doc.chainId)] !== undefined) {
    fail(
      sink,
      "A6",
      `asset is marked isMock on chain ${doc.chainId}, which is a real network; mocks exist only on a local chain (SPEC 12)`,
    );
  }
  checkAssetShape(doc, "asset", null, sink);
}

function checkOperationsRecord(doc: Doc, sink: Sink): void {
  const environment = typeof doc.environment === "string" ? doc.environment : null;
  const providers = Array.isArray(doc.rpcProviders) ? (doc.rpcProviders as Doc[]) : [];
  if (environment !== null && environment !== "local") {
    if (providers.length < 2) {
      fail(
        sink,
        "OP1",
        `environment "${environment}" records ${providers.length} RPC provider(s); SPEC 10.3 requires at least two independent providers`,
      );
    }
    if (!providers.some((p) => p.role === "operational" && p.historyCoverage === "full")) {
      fail(
        sink,
        "OP2",
        `no operational RPC provider with full log history; the indexer cannot rebuild from the deployment block without one (SPEC 10.3)`,
      );
    }
  }
  if (isObject(doc.finality)) {
    const f = doc.finality as Doc;
    if (f.tag === "depth" && f.depth === null) {
      fail(
        sink,
        "OP3",
        `finality.tag is "depth" but no depth is recorded; SPEC 10.3 falls back to a 200-block depth`,
      );
    }
  }
}

/** The chain id half of a `${chainId}:${address}` deployment id, or null when it is not one. */
function chainIdOfDeploymentId(deploymentId: unknown): number | null {
  if (typeof deploymentId !== "string") return null;
  const match = deploymentId.match(/^([1-9][0-9]{0,18}):0x[0-9a-f]{40}$/);
  return match === null ? null : Number(match[1]);
}

function checkReleaseAuthorityRecord(doc: Doc, sink: Sink): void {
  if (doc.environment !== "mainnet") return;
  // E1: the same environment/chain table the manifests are held to. A record's chain is the chain half of
  // its deploymentId, and a record that calls itself mainnet while pointing at chain 97 would apply every
  // mainnet custody rule below to a testnet Safe.
  const recordChainId = chainIdOfDeploymentId(doc.deploymentId);
  if (recordChainId !== null && recordChainId !== 56) {
    const known = KNOWN_CHAINS[String(recordChainId)];
    fail(
      sink,
      "E1",
      `environment is "mainnet" but deploymentId ${JSON.stringify(doc.deploymentId)} releases on chain ${recordChainId}${known === undefined ? "" : ` (${known.environment})`}; the only mainnet in this product is BSC (56), so the custody and drill facts below would describe the wrong chain's Safes`,
    );
  }
  const custody = isObject(doc.custody) ? (doc.custody as Doc) : null;
  if (custody === null) return;
  if (custody.separateSafes !== true) {
    fail(sink, "RA1", `mainnet requires separate owner, treasury and seed Safes (SPEC 10.5)`);
  }
  // RA2: the drill is performed on the Safes that will hold the money, on the chain the release deploys
  // to, before the contracts are deployed (SPEC 10.5 and 14). A drill somewhere else proves nothing about
  // these keys, so location is part of the rule and not a footnote.
  const drill = isObject(custody.recoveryDrill) ? (custody.recoveryDrill as Doc) : null;
  if (drill === null) {
    fail(
      sink,
      "RA2",
      `custody.recoveryDrill is absent; mainnet requires a recovery drill performed on the mainnet Safes (SPEC 10.5)`,
    );
    return;
  }
  if (drill.performed !== true) {
    fail(
      sink,
      "RA2",
      `custody.recoveryDrill.performed is ${drill.performed === undefined ? "absent" : JSON.stringify(drill.performed)}; mainnet requires a recovery drill performed on the mainnet Safes before the contracts are deployed, and an unperformed or failed drill blocks the release (SPEC 10.5, 14)`,
    );
  }
  for (const [field, meaning] of [
    ["unavailableSignerPassed", "one signer absent, the others still acted"],
    ["compromisedSignerBlocked", "one signer alone could not act"],
    ["signerReplacementPassed", "a lost signer was replaced"],
    ["treasuryWithdrawalProven", "the treasury Safe proved one withdrawal from the Vault"],
  ] as const) {
    if (drill[field] !== true) {
      fail(
        sink,
        "RA2",
        `custody.recoveryDrill.${field} is ${drill[field] === undefined ? "absent" : JSON.stringify(drill[field])}; mainnet requires a drill on the mainnet Safes in which ${meaning} (SPEC 10.5)`,
      );
    }
  }
  if (typeof drill.date !== "string") {
    fail(
      sink,
      "RA2",
      `custody.recoveryDrill.date is ${drill.date === undefined ? "absent" : JSON.stringify(drill.date)}; record the date the drill was performed`,
    );
  }
  const expectedChainId = chainIdOfDeploymentId(doc.deploymentId);
  if (expectedChainId !== null && drill.chainId !== expectedChainId) {
    fail(
      sink,
      "RA2",
      `custody.recoveryDrill.chainId is ${drill.chainId === undefined ? "absent" : JSON.stringify(drill.chainId)} but deploymentId ${JSON.stringify(doc.deploymentId)} releases on chain ${expectedChainId}; the drill counts only on the chain whose Safes hold the money (SPEC 10.5)`,
    );
  }
  const safes = isObject(drill.safes) ? (drill.safes as Doc) : null;
  if (safes === null) {
    fail(
      sink,
      "RA2",
      `custody.recoveryDrill.safes is ${drill.safes === undefined ? "absent" : JSON.stringify(drill.safes)}; record the owner, treasury and seed Safe addresses the drill was performed on (SPEC 10.5)`,
    );
    return;
  }
  for (const role of ["owner", "treasury", "seed"] as const) {
    if (typeof safes[role] !== "string") {
      fail(
        sink,
        "RA2",
        `custody.recoveryDrill.safes.${role} is ${safes[role] === undefined ? "absent" : JSON.stringify(safes[role])}; all three Safe addresses are recorded`,
      );
    }
  }
  if (!Array.isArray(drill.receiptRefs) || (drill.receiptRefs as unknown[]).length === 0) {
    fail(
      sink,
      "RA2",
      `custody.recoveryDrill.receiptRefs is ${drill.receiptRefs === undefined ? "absent" : JSON.stringify(drill.receiptRefs)}; point at the drill receipts (a pointer or an explorer link, never the restricted material itself, SPEC 15)`,
    );
  }
}

/**
 * RA2, second half: the drill's Safes are the manifest's Safes and the drill happened before the deploy.
 * These are the comparisons that need two documents, so they run in the cross-record pass and are silent
 * when the manifest is not in the tree.
 */
function checkDrillAgainstManifest(record: Doc, manifest: Doc, sink: Sink): void {
  const custody = isObject(record.custody) ? (record.custody as Doc) : null;
  const drill = custody !== null && isObject(custody.recoveryDrill) ? (custody.recoveryDrill as Doc) : null;
  // The drill is performed on the mainnet Safes *before* the contracts are deployed (SPEC 10.5, 14): a
  // drill dated after the deployment leaves a window in which undrilled keys held the roles, and it can no
  // longer be the drill that authorised the release.
  const createdOn = typeof manifest.createdAtUtc === "string" ? manifest.createdAtUtc.slice(0, 10) : null;
  if (drill !== null && typeof drill.date === "string" && createdOn !== null && drill.date > createdOn) {
    fail(
      sink,
      "RA2",
      `custody.recoveryDrill.date is ${JSON.stringify(drill.date)} but the manifest for ${JSON.stringify(record.deploymentId)} records createdAtUtc ${JSON.stringify(manifest.createdAtUtc)}; the drill is performed on the mainnet Safes before the contracts are deployed (SPEC 10.5, 14)`,
    );
  }
  const safes = drill !== null && isObject(drill.safes) ? (drill.safes as Doc) : null;
  const ownership = isObject(manifest.ownership) ? (manifest.ownership as Doc) : null;
  if (safes === null || ownership === null) return;
  for (const [role, field] of [
    ["owner", "finalOwner"],
    ["treasury", "feeAccount"],
    ["seed", "seedAccount"],
  ] as const) {
    if (typeof safes[role] === "string" && safes[role] !== ownership[field]) {
      fail(
        sink,
        "RA2",
        `custody.recoveryDrill.safes.${role} is ${JSON.stringify(safes[role])} but the manifest for ${JSON.stringify(record.deploymentId)} has ownership.${field} ${JSON.stringify(ownership[field])}; the drill must have been performed on the Safe that actually holds the role (SPEC 10.5)`,
      );
    }
  }
}

function checkAcceptanceRecord(doc: Doc, sink: Sink): void {
  const campaign = isObject(doc.fuzzCampaign) ? (doc.fuzzCampaign as Doc) : null;
  if (campaign === null) return;
  const actions = typeof campaign.nonRevertingActions === "number" ? campaign.nonRevertingActions : 0;
  const reverted = typeof campaign.revertedCalls === "number" ? campaign.revertedCalls : 0;
  if (actions > 0 && reverted > actions * 0.2) {
    fail(
      sink,
      "AC1",
      `fuzzCampaign reports ${reverted} reverted calls against ${actions} non-reverting actions; SPEC 11.2 caps reverted calls at 20% of the calls that invoked a protocol function`,
    );
  }
  if (doc.environment === "mainnet" && actions < 100000) {
    fail(
      sink,
      "AC2",
      `fuzzCampaign records ${actions} non-reverting actions; SPEC 11.2 requires at least 100,000 in the recorded pre-release campaign`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cross-record rules
//
// Everything above judges one document. These rules need two, so they run after the whole tree has been
// read. A sink here is the same array object as the corresponding FileResult.errors, so appending to it
// attaches the error to the document that has to change.
// ---------------------------------------------------------------------------

type Loaded = {path: string; cls: Classification; doc: Doc; sink: Sink};

function checkCrossRecords(loaded: Loaded[]): void {
  const deployments = loaded.filter((e) => e.cls.kind === "deployment");
  const mainnetManifests = deployments.filter((e) => e.doc.environment === "mainnet");
  const chainRecords = loaded.filter((e) => e.cls.kind === "chain");

  // CH4: batched reads and the chain's own identity are checked against the chain record, so a mainnet
  // deployment may not leave them unverified. One error per chain, naming the manifest that requires it.
  const seenChains = new Set<number>();
  for (const manifest of mainnetManifests) {
    const chain = isObject(manifest.doc.chain) ? (manifest.doc.chain as Doc) : null;
    const chainId = chain === null ? undefined : chain.chainId;
    if (typeof chainId !== "number" || seenChains.has(chainId)) continue;
    seenChains.add(chainId);
    const record = chainRecords.find((e) => e.doc.chainId === chainId);
    if (record === undefined) {
      fail(
        manifest.sink,
        "CH4",
        `this is a mainnet manifest but there is no chain record at config/chains/${chainId}.json; the chain's genesis hash and Multicall3 are verified there before mainnet (SPEC 10.3, 15)`,
      );
      continue;
    }
    const identity = isObject(record.doc.networkIdentity) ? (record.doc.networkIdentity as Doc) : null;
    for (const field of ["multicall3", "genesisHash"] as const) {
      const value = identity === null ? undefined : identity[field];
      if (value === null || value === undefined) {
        fail(
          record.sink,
          "CH4",
          `networkIdentity.${field} is ${value === undefined ? "absent" : "null"} but ${manifest.path} is a mainnet manifest on chain ${chainId}; the operator verifies it against the live chain before mainnet (SPEC 10.3, 15)`,
        );
      }
    }
  }

  // D28 (cross-record half): a registered upkeep must name the registry its chain's record publishes. On its own
  // the per-document half only sees "some nonzero address", and a wrong registry is invisible on chain -- the
  // upkeep is simply never called, which looks exactly like a healthy deployment nothing happens to be due on.
  for (const manifest of deployments) {
    const contracts = isObject(manifest.doc.contracts) ? (manifest.doc.contracts as Doc) : null;
    const upkeep = contracts !== null && isObject(contracts.upkeep) ? (contracts.upkeep as Doc) : null;
    if (upkeep === null) continue;
    const registry = upkeep.registry;
    if (typeof registry !== "string" || registry === ZERO_ADDRESS) continue;
    const chain = isObject(manifest.doc.chain) ? (manifest.doc.chain as Doc) : null;
    const chainId = chain === null ? undefined : chain.chainId;
    if (typeof chainId !== "number") continue;
    const record = chainRecords.find((e) => e.doc.chainId === chainId);
    const automation =
      record !== undefined && isObject(record.doc.automationRegistry)
        ? (record.doc.automationRegistry as Doc)
        : null;
    const published = automation === null ? undefined : automation.address;
    // Absent on either side is silence, not a failure: a chain record may predate the verified address, and a
    // manifest may record no registration at all.
    if (typeof published !== "string" || registry === published) continue;
    fail(
      manifest.sink,
      "D28",
      `contracts.upkeep.registry is ${registry} but config/chains/${chainId}.json publishes the Chainlink Automation registry ${published}; a registration against the wrong registry never runs (SPEC 10.3, ADR 039)`,
    );
  }

  // RA2: a release-authority record's recovery drill names the Safes the manifest gives the roles to.
  const byDeploymentId = new Map<string, Doc>();
  for (const entry of deployments) {
    if (typeof entry.doc.deploymentId === "string") byDeploymentId.set(entry.doc.deploymentId, entry.doc);
  }
  const releaseAuthorities = loaded.filter((e) => e.cls.kind === "release-authority");
  for (const entry of releaseAuthorities) {
    if (entry.doc.environment !== "mainnet") continue;
    const manifest =
      typeof entry.doc.deploymentId === "string" ? byDeploymentId.get(entry.doc.deploymentId) : undefined;
    if (manifest === undefined) continue;
    checkDrillAgainstManifest(entry.doc, manifest, entry.sink);
  }

  // RA3: the other direction. RA1 and RA2 only ever ran when a mainnet release-authority record existed and
  // named this deployment, so a manifest with no record at all, or with one labelled `testnet`, or with one
  // whose deploymentId points somewhere else, reached mainnet with no recovery drill recorded anywhere. The
  // drill is a pre-Deploy gate (SPEC 10.5), not a launch-day one, so this applies to every mainnet manifest
  // and not only to those with release.customerLaunch true.
  for (const manifest of mainnetManifests) {
    const deploymentId =
      typeof manifest.doc.deploymentId === "string" ? (manifest.doc.deploymentId as string) : null;
    if (deploymentId === null) continue; // D1 and the schema already report an unusable deploymentId
    const covering = releaseAuthorities.filter((e) => e.doc.deploymentId === deploymentId);
    if (covering.length === 0) {
      fail(
        manifest.sink,
        "RA3",
        `this is a mainnet manifest but no release-authority record in config/release-authority/ carries deploymentId ${JSON.stringify(deploymentId)}; the custody separation and the recovery drill on the mainnet Safes are recorded there and are gates on Deploy (SPEC 10.5, 14, 15)`,
      );
      continue;
    }
    for (const record of covering) {
      if (record.doc.environment !== "mainnet") {
        fail(
          record.sink,
          "RA3",
          `environment is ${JSON.stringify(record.doc.environment)} but this record is the release authority for mainnet manifest ${manifest.path}; a record covering a mainnet deployment is a mainnet record and is held to RA1 and RA2, which a ${JSON.stringify(record.doc.environment)} label would otherwise skip (SPEC 10.5)`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function validateTree(configRoot: string): RunResult {
  const results: FileResult[] = [];
  const loaded: Loaded[] = [];
  const {ajv, schemaErrors} = buildAjv();

  if (schemaErrors.length > 0) {
    results.push({path: "config/schema", kind: null, errors: schemaErrors, warnings: []});
  }

  if (!existsSync(configRoot)) {
    results.push({
      path: toPosix(configRoot),
      kind: null,
      errors: ["configuration root does not exist"],
      warnings: [],
    });
    return summarise(results);
  }

  const validators = new Map<Kind, ValidateFunction>();
  if (schemaErrors.length === 0) {
    for (const kind of Object.keys(SCHEMA_FOR_KIND) as Kind[]) {
      const validate = ajv.getSchema(`${SCHEMA_BASE}${SCHEMA_FOR_KIND[kind]}`);
      if (validate === undefined) {
        results.push({
          path: `config/schema/${SCHEMA_FOR_KIND[kind]}`,
          kind: null,
          errors: ["schema not loaded"],
          warnings: [],
        });
      } else {
        validators.set(kind, validate);
      }
    }
  }

  for (const full of listJsonFiles(configRoot)) {
    const relativeToRoot = toPosix(full).slice(toPosix(configRoot).length + 1);
    if (relativeToRoot.startsWith("schema/")) continue; // schemas are loaded, not validated as documents
    const displayPath = toPosix(full).startsWith(toPosix(REPO_ROOT))
      ? toPosix(full).slice(toPosix(REPO_ROOT).length + 1)
      : toPosix(full);
    const sink: Sink = {errors: [], warnings: []};
    const cls = classify(relativeToRoot);

    const raw = readFileSync(full);
    if (raw.includes(13)) {
      fail(sink, "G2", `file contains CR bytes; every file in this repository is LF (.gitattributes)`);
    }
    if (raw.length > 0 && raw[raw.length - 1] !== 10) {
      warn(sink, "G3w", `file does not end with a newline`);
    }

    let doc: Doc | null = null;
    let parsed = false;
    try {
      doc = JSON.parse(raw.toString("utf8")) as Doc;
      parsed = true;
    } catch (error) {
      fail(sink, "G0", `not valid JSON: ${(error as Error).message}`);
    }

    if (cls === null) {
      fail(
        sink,
        "L1",
        `no schema is implied by this location; documents live in config/{chains,assets/<chainId>,deployments/<chainId>,operations,hosting,release-authority,acceptance}/`,
      );
      results.push({path: displayPath, kind: null, errors: sink.errors, warnings: sink.warnings});
      continue;
    }

    if (doc !== null && isObject(doc)) {
      // Rejected before anything else so the message is unambiguous, whatever the document kind.
      if (own(doc, "template") === true) {
        fail(
          sink,
          "TPL",
          `"template": true marks a blank form; fill the plan in and remove the flag before deploying from it`,
        );
      }

      const validate = validators.get(cls.kind);
      if (validate === undefined) {
        fail(sink, "L2", `no validator available for kind ${cls.kind}`);
      } else if (!validate(doc)) {
        for (const error of (validate.errors ?? []) as ErrorObject[]) {
          sink.errors.push(formatAjvError(error));
        }
      }

      checkUintRange(doc, "(document root)", sink);

      if (cls.kind === "deployment") checkDeployment(doc, cls, sink);
      else if (cls.kind === "plan") checkPlan(doc, cls, sink);
      else if (cls.kind === "chain") checkChainRecord(doc, cls, sink);
      else if (cls.kind === "asset") checkAssetRecord(doc, cls, sink);
      else if (cls.kind === "operations") checkOperationsRecord(doc, sink);
      else if (cls.kind === "release-authority") checkReleaseAuthorityRecord(doc, sink);
      else if (cls.kind === "acceptance") checkAcceptanceRecord(doc, sink);

      loaded.push({path: displayPath, cls, doc, sink});
    } else if (parsed) {
      fail(sink, "G0", `top level is not a JSON object`);
    }

    results.push({path: displayPath, kind: cls.kind, errors: sink.errors, warnings: sink.warnings});
  }

  checkCrossRecords(loaded);

  return summarise(results);
}

function summarise(results: FileResult[]): RunResult {
  let failed = 0;
  let warnings = 0;
  for (const result of results) {
    if (result.errors.length > 0) failed += 1;
    warnings += result.warnings.length;
  }
  return {results, failed, passed: results.length - failed, warnings};
}

export function report(run: RunResult): string {
  const lines: string[] = [];
  const width = run.results.reduce((max, r) => Math.max(max, r.path.length), 0);
  for (const result of run.results) {
    const status = result.errors.length > 0 ? "FAIL" : result.warnings.length > 0 ? "WARN" : "ok  ";
    lines.push(`${status}  ${result.path.padEnd(width)}  ${result.kind ?? "-"}`);
    for (const error of result.errors) lines.push(`        ${error}`);
    for (const warning of result.warnings) lines.push(`        warning ${warning}`);
  }
  lines.push("");
  lines.push(
    `${run.results.length} document(s): ${run.passed} passed, ${run.failed} failed, ${run.warnings} warning(s).`,
  );
  return lines.join("\n");
}

function main(): void {
  const argument = process.argv[2];
  const configRoot = argument === undefined ? join(REPO_ROOT, "config") : resolve(argument);
  const run = validateTree(configRoot);
  process.stdout.write(`${report(run)}\n`);
  process.exitCode = run.failed > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
