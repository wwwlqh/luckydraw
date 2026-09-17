// The mainnet publication gate (SPEC §14 release gates, §12.1 MVP tier, ADR 034).
//
// A chain 56 build puts a page in front of real customers with real money behind it, so the build itself is
// the last automatic check between a half-finished deployment and a published site. Everything here is a
// pure function over already-parsed JSON: `web/vite.config.ts` reads the files and runs the validator, this
// module decides. That split is what makes every branch testable without a build, a file system or a chain.
//
// The rules, all of them from the §14 "Mainnet" row and the brief that pins `release.customerLaunch`:
//
//  * the manifest the build is pinned to must exist and be `environment: "mainnet"`. A testnet or local
//    document reached by a mistyped variable would publish a page that signs against the wrong chain;
//  * it must carry no mock anywhere. A mock coordinator or a mock feed outside `local` is the one thing
//    SPEC §12.1 never lets through, and a build is a cheaper place to catch it than a customer's wallet;
//  * `release.customerLaunch` must be exactly `true`. Absent `release` means false, which is the state of
//    every manifest until the operator has played the §14 private shakedown and recorded its numbers;
//  * the jurisdiction sentence must be non-empty, because §14 requires the app to state the outcome of the
//    operator's jurisdiction advice and an empty string states nothing.
//
// Any other chain id is out of scope here: 31337 keeps its committed local-anvil fallback and 97 behaves
// exactly as it did before this gate existed.

/** The chain this gate applies to. Every other chain id passes it unchanged. */
export const MAINNET_CHAIN_ID = "56";

/** The chain the committed `web/.env.example` fallback describes: a local anvil run and nothing else. */
export const LOCAL_CHAIN_ID = "31337";

/** Every refusal starts with this, so one line in a build log is the whole answer. */
export const REFUSAL_PREFIX = "Mainnet build refused:";

export type ReleaseGateInput = {
  /** Decimal chain id the build resolved, as text. */
  chainIdText: string;
  /** The parsed manifest, or `null` when no file exists where the build looked. */
  manifest: unknown;
  /** Repo-relative path of that file, for the reason line. Never an absolute path in published output. */
  manifestPath: string;
  /** `VITE_LUCKYDRAW_JURISDICTION_NOTICE`, already trimmed. */
  jurisdictionNotice: string;
};

export type ReleaseGateVerdict = {ok: true} | {ok: false; reason: string};

function refuse(detail: string): ReleaseGateVerdict {
  return {ok: false, reason: `${REFUSAL_PREFIX} ${detail}`};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for a property name that flags a mock artifact: `isMock` itself and the per-role spellings the
 * manifest schema uses (`coordinatorIsMock`, `feedIsMock`). Matching the suffix rather than a fixed list
 * means a mock flag added to the schema later is caught by this gate on the day it appears.
 */
export function isMockFlagName(key: string): boolean {
  return key === "isMock" || (key.endsWith("IsMock") && key.length > "IsMock".length);
}

/**
 * The JSON path of the first mock flag that is `true`, or null. Depth-first in document order, so the path
 * in the reason line is the first one a reader scrolling the manifest would meet.
 */
export function findMockFlag(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findMockFlag(value[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    const child = path === "" ? key : `${path}.${key}`;
    if (isMockFlagName(key) && entry === true) return child;
    const found = findMockFlag(entry, child);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The manifest's `release.customerLaunch`. Absent `release`, a `release` that is not an object and anything
 * but the boolean `true` all mean false: this flag only ever opens a gate, so it is never inferred.
 */
export function customerLaunchOf(manifest: unknown): boolean {
  if (!isRecord(manifest)) return false;
  const release = manifest.release;
  if (!isRecord(release)) return false;
  return release.customerLaunch === true;
}

/** Whether this chain id is published under the mainnet gate. */
export function isMainnetBuild(chainIdText: string): boolean {
  return chainIdText.trim() === MAINNET_CHAIN_ID;
}

/** Where a resolved build variable came from. */
export type ValueSource = "environment" | "fallback";

export type PairingInput = {
  chainIdText: string;
  chainIdSource: ValueSource;
  drawAddressSource: ValueSource;
  rpcUrlSource: ValueSource;
};

/**
 * The committed `web/.env.example` pair is a *local anvil* deployment and a localhost RPC. It exists so that
 * `pnpm build` works in a clean checkout with no deployment at all, and the Pages workflow publishes
 * something honest before the operator has set any repository variable.
 *
 * The danger it creates is a half-set configuration: `LUCKYDRAW_CHAIN_ID` set to 56 with the Draw address
 * variable forgotten publishes a page that claims to be chain 56 while naming the anvil contract and a
 * 127.0.0.1 RPC. So the fallback is all-or-nothing: the moment a build asks for any chain but 31337, every
 * one of the three values has to come from the environment and none of them may be filled in from the
 * committed example.
 */
export function checkFallbackPairing(input: PairingInput): ReleaseGateVerdict {
  const chainIdText = input.chainIdText.trim();
  if (chainIdText === "" || chainIdText === LOCAL_CHAIN_ID) return {ok: true};

  const missing: string[] = [];
  if (input.chainIdSource === "fallback") missing.push("LUCKYDRAW_CHAIN_ID");
  if (input.drawAddressSource === "fallback") missing.push("LUCKYDRAW_DRAW_ADDRESS");
  if (input.rpcUrlSource === "fallback") missing.push("LUCKYDRAW_RPC_URL");
  if (missing.length === 0) return {ok: true};

  const prefix = isMainnetBuild(chainIdText) ? REFUSAL_PREFIX : "Build refused:";
  return {
    ok: false,
    reason:
      `${prefix} chain ${chainIdText} was asked for but ${missing.join(" and ")} ` +
      `${missing.length === 1 ? "was" : "were"} not set, so the build fell back to the committed local ` +
      "anvil deployment in web/.env.example. A build for any chain but " +
      `${LOCAL_CHAIN_ID} names its own manifest and its own public RPC: set all three, or none of them.`,
  };
}

/**
 * The gate. Returns ok for every chain but 56; for 56, the first failing rule with a one-line reason.
 *
 * The order is deliberate: a missing or wrong-environment manifest is reported before anything is read out
 * of it, the mock scan before the launch flag (a manifest full of mocks is not "nearly ready"), and the
 * jurisdiction sentence last, because it is the only rule whose fix is a repository variable rather than a
 * deployment.
 */
export function checkReleaseGate(input: ReleaseGateInput): ReleaseGateVerdict {
  if (!isMainnetBuild(input.chainIdText)) return {ok: true};

  if (input.manifest === null || input.manifest === undefined) {
    return refuse(
      `no deployment manifest at ${input.manifestPath}. A chain ${MAINNET_CHAIN_ID} build publishes against ` +
        "a mainnet deployment that exists; set LUCKYDRAW_DRAW_ADDRESS to the address in the manifest written " +
        "by Finalize.",
    );
  }
  if (!isRecord(input.manifest)) {
    return refuse(`${input.manifestPath} is not a JSON object.`);
  }

  const environment = input.manifest.environment;
  if (environment !== "mainnet") {
    return refuse(
      `${input.manifestPath} declares environment ${JSON.stringify(environment)}, not "mainnet". A chain ` +
        `${MAINNET_CHAIN_ID} build may only publish a mainnet deployment (SPEC §12.1).`,
    );
  }

  const mockPath = findMockFlag(input.manifest);
  if (mockPath !== null) {
    return refuse(
      `${input.manifestPath} flags a mock at ${mockPath}. No mock artifact may appear outside a local ` +
        "deployment (SPEC §12.1).",
    );
  }

  if (!customerLaunchOf(input.manifest)) {
    return refuse(
      `${input.manifestPath} does not set release.customerLaunch to true, so this deployment has not passed ` +
        "the SPEC §14 private shakedown and must not be published to customers.",
    );
  }

  if (input.jurisdictionNotice.trim() === "") {
    return refuse(
      "VITE_LUCKYDRAW_JURISDICTION_NOTICE is empty. SPEC §14 requires the app to state the outcome of the " +
        "operator's jurisdiction advice, so a mainnet build needs that sentence.",
    );
  }

  return {ok: true};
}
