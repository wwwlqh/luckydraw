// The mainnet publication gate (SPEC §14, §12.1, ADR 034).
//
// The fixture is the committed local anvil manifest with the mock flags cleared and a mainnet identity put
// on it, built here in memory. It is deliberately not a file: nothing that looks like a chain 56 manifest
// may exist on disk in this repository, because `config/deployments/56/` is the operator's to create and
// `records.ts` globs that tree into the bundle.

import {describe, expect, it} from "vitest";
import localManifestJson from "../../../../config/deployments/31337/0x610178da211fef7d417bc0e6fed39f05609ad788.json";
import {
  checkFallbackPairing,
  checkReleaseGate,
  customerLaunchOf,
  findMockFlag,
  isMainnetBuild,
  isMockFlagName,
  REFUSAL_PREFIX,
} from "./releaseGate.ts";

const DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const PATH = `config/deployments/56/${DRAW}.json`;
const NOTICE = "LuckyDraw is not available to residents of Examplestan.";

/** Clears every mock flag in place, whatever its spelling, so the fixture is a realistic non-mock document. */
function clearMocks(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) clearMocks(entry);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (isMockFlagName(key) && entry === true) record[key] = false;
    else clearMocks(entry);
  }
}

/** A mainnet manifest that passes every rule. Overrides are applied on top. */
function mainnetManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = structuredClone(localManifestJson) as unknown as Record<string, unknown>;
  clearMocks(raw);
  delete raw.mocks;
  raw.environment = "mainnet";
  raw.deploymentId = `56:${DRAW}`;
  raw.release = {customerLaunch: true, shakedown: {performed: true}};
  return {...raw, ...overrides};
}

function verdict(overrides: Record<string, unknown> = {}, notice = NOTICE) {
  return checkReleaseGate({
    chainIdText: "56",
    manifest: mainnetManifest(overrides),
    manifestPath: PATH,
    jurisdictionNotice: notice,
  });
}

describe("isMainnetBuild", () => {
  it("is true only for chain 56", () => {
    expect(isMainnetBuild("56")).toBe(true);
    expect(isMainnetBuild(" 56 ")).toBe(true);
    expect(isMainnetBuild("97")).toBe(false);
    expect(isMainnetBuild("31337")).toBe(false);
    expect(isMainnetBuild("560")).toBe(false);
  });
});

describe("isMockFlagName", () => {
  it("matches the schema's mock spellings and nothing else", () => {
    expect(isMockFlagName("isMock")).toBe(true);
    expect(isMockFlagName("coordinatorIsMock")).toBe(true);
    expect(isMockFlagName("feedIsMock")).toBe(true);
    // Not a flag: the suffix has to be a suffix *of* something, and an unrelated name is not a flag.
    expect(isMockFlagName("IsMock")).toBe(false);
    expect(isMockFlagName("mocks")).toBe(false);
    expect(isMockFlagName("isMocked")).toBe(false);
  });
});

describe("findMockFlag", () => {
  it("finds the first flag in the committed local manifest", () => {
    // The real document, unmodified: it is full of labeled mocks, which is exactly what `local` means.
    expect(findMockFlag(localManifestJson)).toBe("vrf.coordinatorIsMock");
  });

  it("finds a flag nested inside an array", () => {
    expect(findMockFlag({assets: [{price: {feedIsMock: false}}, {price: {feedIsMock: true}}]})).toBe(
      "assets[1].price.feedIsMock",
    );
  });

  it("ignores a flag that is false, absent or not a boolean true", () => {
    expect(findMockFlag({vrf: {coordinatorIsMock: false}})).toBeNull();
    expect(findMockFlag({vrf: {}})).toBeNull();
    expect(findMockFlag({vrf: {coordinatorIsMock: "true"}})).toBeNull();
    expect(findMockFlag(null)).toBeNull();
    expect(findMockFlag("isMock")).toBeNull();
  });

  it("finds nothing in the cleaned fixture", () => {
    expect(findMockFlag(mainnetManifest())).toBeNull();
  });
});

describe("customerLaunchOf", () => {
  it("is false for an absent, non-object or non-true release", () => {
    expect(customerLaunchOf({})).toBe(false);
    expect(customerLaunchOf({release: null})).toBe(false);
    expect(customerLaunchOf({release: "true"})).toBe(false);
    expect(customerLaunchOf({release: {}})).toBe(false);
    expect(customerLaunchOf({release: {customerLaunch: false}})).toBe(false);
    expect(customerLaunchOf({release: {customerLaunch: "true"}})).toBe(false);
    expect(customerLaunchOf({release: {customerLaunch: 1}})).toBe(false);
    expect(customerLaunchOf(null)).toBe(false);
  });

  it("is true only for the boolean", () => {
    expect(customerLaunchOf({release: {customerLaunch: true}})).toBe(true);
  });
});

describe("checkFallbackPairing", () => {
  const ALL_SET = {
    chainIdSource: "environment",
    drawAddressSource: "environment",
    rpcUrlSource: "environment",
  } as const;
  const NONE_SET = {
    chainIdSource: "fallback",
    drawAddressSource: "fallback",
    rpcUrlSource: "fallback",
  } as const;

  it("passes a clean checkout with nothing set: the whole committed local pair is used", () => {
    expect(checkFallbackPairing({chainIdText: "31337", ...NONE_SET})).toEqual({ok: true});
  });

  it("passes chain 31337 with the chain id set by hand and the rest defaulted", () => {
    expect(
      checkFallbackPairing({
        chainIdText: "31337",
        chainIdSource: "environment",
        drawAddressSource: "fallback",
        rpcUrlSource: "fallback",
      }),
    ).toEqual({ok: true});
  });

  it("passes chain 56 and chain 97 when all three are set", () => {
    expect(checkFallbackPairing({chainIdText: "56", ...ALL_SET})).toEqual({ok: true});
    expect(checkFallbackPairing({chainIdText: "97", ...ALL_SET})).toEqual({ok: true});
  });

  it("refuses chain 56 when the Draw address variable was forgotten", () => {
    const result = checkFallbackPairing({
      chainIdText: "56",
      chainIdSource: "environment",
      drawAddressSource: "fallback",
      rpcUrlSource: "environment",
    });
    expect(result.ok).toBe(false);
    const reason = result.ok === false ? result.reason : "";
    expect(reason.startsWith(REFUSAL_PREFIX)).toBe(true);
    expect(reason).toContain("LUCKYDRAW_DRAW_ADDRESS");
    expect(reason).toContain("local anvil deployment");
    expect(reason.includes("\n")).toBe(false);
  });

  it("refuses chain 56 with only the chain id set, naming both missing variables", () => {
    const result = checkFallbackPairing({
      chainIdText: "56",
      chainIdSource: "environment",
      drawAddressSource: "fallback",
      rpcUrlSource: "fallback",
    });
    const reason = result.ok === false ? result.reason : "";
    expect(reason).toContain("LUCKYDRAW_DRAW_ADDRESS and LUCKYDRAW_RPC_URL");
    expect(reason).toContain("were not set");
  });

  it("refuses chain 97 too, without the mainnet wording", () => {
    const result = checkFallbackPairing({
      chainIdText: "97",
      chainIdSource: "environment",
      drawAddressSource: "fallback",
      rpcUrlSource: "environment",
    });
    const reason = result.ok === false ? result.reason : "";
    expect(reason.startsWith("Build refused:")).toBe(true);
    expect(reason).not.toContain(REFUSAL_PREFIX);
  });

  it("refuses a build whose Draw address is set but whose chain id fell back", () => {
    // The pair is only checked against the chain actually resolved, so this case is a 31337 build and legal;
    // the interesting one is the mirror, where a non-local chain id came from a .env and the address did not.
    expect(
      checkFallbackPairing({
        chainIdText: "31337",
        chainIdSource: "fallback",
        drawAddressSource: "environment",
        rpcUrlSource: "environment",
      }),
    ).toEqual({ok: true});
    const result = checkFallbackPairing({
      chainIdText: "56",
      chainIdSource: "fallback",
      drawAddressSource: "environment",
      rpcUrlSource: "environment",
    });
    expect(result.ok === false && result.reason).toContain("LUCKYDRAW_CHAIN_ID");
  });
});

describe("checkReleaseGate on other chains", () => {
  it("passes chain 31337 with the committed local manifest and no jurisdiction sentence", () => {
    expect(
      checkReleaseGate({
        chainIdText: "31337",
        manifest: localManifestJson,
        manifestPath: `config/deployments/31337/${DRAW}.json`,
        jurisdictionNotice: "",
      }),
    ).toEqual({ok: true});
  });

  it("passes chain 97 with a testnet manifest carrying no release object", () => {
    expect(
      checkReleaseGate({
        chainIdText: "97",
        manifest: {environment: "testnet"},
        manifestPath: `config/deployments/97/${DRAW}.json`,
        jurisdictionNotice: "",
      }),
    ).toEqual({ok: true});
  });
});

describe("checkReleaseGate on chain 56", () => {
  it("passes a mainnet manifest with no mock, customerLaunch true and a jurisdiction sentence", () => {
    expect(verdict()).toEqual({ok: true});
  });

  it("refuses when no manifest exists at the path the build selected", () => {
    const result = checkReleaseGate({
      chainIdText: "56",
      manifest: null,
      manifestPath: PATH,
      jurisdictionNotice: NOTICE,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("no deployment manifest at");
    expect(result.ok === false && result.reason).toContain(PATH);
  });

  it("refuses a manifest that is not an object", () => {
    const result = checkReleaseGate({
      chainIdText: "56",
      manifest: [1, 2, 3],
      manifestPath: PATH,
      jurisdictionNotice: NOTICE,
    });
    expect(result.ok === false && result.reason).toContain("is not a JSON object");
  });

  it("refuses a testnet manifest", () => {
    const result = verdict({environment: "testnet"});
    expect(result.ok === false && result.reason).toContain('not "mainnet"');
  });

  it("refuses a local manifest", () => {
    const result = verdict({environment: "local"});
    expect(result.ok === false && result.reason).toContain('declares environment "local"');
  });

  it("refuses a manifest with a mock coordinator, naming where it is", () => {
    const result = verdict({vrf: {coordinatorIsMock: true}});
    expect(result.ok === false && result.reason).toContain("vrf.coordinatorIsMock");
    expect(result.ok === false && result.reason).toContain("No mock artifact");
  });

  it("refuses a manifest with a mock feed nested in the asset list", () => {
    const manifest = mainnetManifest();
    const assets = manifest.assets as {price: Record<string, unknown>}[];
    (assets[0] as {price: Record<string, unknown>}).price.feedIsMock = true;
    const result = checkReleaseGate({
      chainIdText: "56",
      manifest,
      manifestPath: PATH,
      jurisdictionNotice: NOTICE,
    });
    expect(result.ok === false && result.reason).toContain("assets[0].price.feedIsMock");
  });

  it("refuses when release is absent", () => {
    const manifest = mainnetManifest();
    delete manifest.release;
    const result = checkReleaseGate({
      chainIdText: "56",
      manifest,
      manifestPath: PATH,
      jurisdictionNotice: NOTICE,
    });
    expect(result.ok === false && result.reason).toContain("release.customerLaunch");
  });

  it("refuses when customerLaunch is false", () => {
    const result = verdict({release: {customerLaunch: false, shakedown: null}});
    expect(result.ok === false && result.reason).toContain("private shakedown");
  });

  it("refuses an empty or blank jurisdiction sentence", () => {
    expect(verdict({}, "").ok).toBe(false);
    const result = verdict({}, "   ");
    expect(result.ok === false && result.reason).toContain("VITE_LUCKYDRAW_JURISDICTION_NOTICE");
  });

  it("gives exactly one line, prefixed, for every refusal", () => {
    const results = [
      checkReleaseGate({chainIdText: "56", manifest: null, manifestPath: PATH, jurisdictionNotice: NOTICE}),
      verdict({environment: "testnet"}),
      verdict({vrf: {coordinatorIsMock: true}}),
      verdict({release: {customerLaunch: false}}),
      verdict({}, ""),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      const reason = result.ok === false ? result.reason : "";
      expect(reason.startsWith(REFUSAL_PREFIX)).toBe(true);
      expect(reason.includes("\n")).toBe(false);
    }
  });
});
