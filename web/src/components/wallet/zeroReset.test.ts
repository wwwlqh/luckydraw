// The `requiresZeroReset` source order of SPEC §9.5: the manifest's own flag first, the constant map second.

import type {Address, ManifestAsset} from "@luckydraw/client";
import {describe, expect, it} from "vitest";
import {testManifest} from "../../test/harness.tsx";
import {requiresZeroReset, ZERO_RESET_TOKENS} from "./zeroReset.ts";

const USDT = "0x55d398326f99059ff775485246999027b3197955" as Address;

function assetOf(overrides: Partial<ManifestAsset> = {}): ManifestAsset {
  const token = testManifest().assets.find((entry) => !entry.native);
  if (token === undefined) throw new Error("the test manifest has no ERC-20 asset");
  return {...token, ...overrides};
}

describe("requiresZeroReset", () => {
  it("reads the manifest flag on a chain whose map lists nothing", () => {
    // Chain 97 is in the map with an empty list, so only the typed manifest field can answer here.
    expect(ZERO_RESET_TOKENS["97"]).toEqual([]);
    expect(requiresZeroReset(assetOf({requiresZeroReset: true}), 97n)).toBe(true);
    expect(requiresZeroReset(assetOf({requiresZeroReset: false}), 97n)).toBe(false);
  });

  it("falls back to the chain-id map when the manifest does not flag the token", () => {
    const usdt = assetOf({asset: USDT, requiresZeroReset: false});
    expect(requiresZeroReset(usdt, 56n)).toBe(true);
    // The same token on a chain that does not list it, and an unknown chain, are both false.
    expect(requiresZeroReset(usdt, 97n)).toBe(false);
    expect(requiresZeroReset(usdt, 1n)).toBe(false);
  });

  it("is always false for the native asset, which has no approve", () => {
    const native = testManifest().assets.find((entry) => entry.native);
    expect(native).toBeDefined();
    expect(requiresZeroReset({...(native as ManifestAsset), requiresZeroReset: true}, 56n)).toBe(false);
  });
});
