// Discovery ordering and badging (SPEC §9.2).

import {describe, expect, it} from "vitest";
import {
  buildConnectors,
  GENERIC_INJECTED_ID,
  isMobileBrowser,
  METAMASK_DOWNLOAD_URL,
  METAMASK_INSTALL_ID,
  metaMaskDeepLink,
  parseChainId,
} from "./connectors.ts";
import type {Eip6963ProviderDetail} from "./eip6963.ts";
import type {Eip1193Provider} from "./types.ts";

const provider = (): Eip1193Provider => ({request: () => Promise.resolve(null)});

function detail(name: string, rdns: string): Eip6963ProviderDetail {
  return {info: {uuid: `uuid-${rdns}`, name, rdns, icon: "data:,"}, provider: provider()};
}

const DESKTOP = {
  injected: null,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  location: {host: "app.example", pathname: "/round/56/7"},
};

describe("buildConnectors", () => {
  it("lists MetaMask first with the recommended badge and badges the others as detected", () => {
    const connectors = buildConnectors(
      [
        detail("Trust Wallet", "com.trustwallet.app"),
        detail("MetaMask", "io.metamask"),
        detail("Rabby", "io.rabby"),
      ],
      DESKTOP,
    );
    expect(connectors.map((entry) => entry.name)).toEqual(["MetaMask", "Rabby", "Trust Wallet"]);
    expect(connectors[0]?.recommended).toBe(true);
    expect(connectors[0]?.detected).toBe(true);
    expect(connectors.slice(1).every((entry) => entry.detected && !entry.recommended)).toBe(true);
  });

  it("reserves the Recommended row for the exact io.metamask rdns", () => {
    // `rdns` is self-declared. A prefix match let anything announcing `io.metamask.*` take the Recommended
    // row *and* filter the real MetaMask out of the list entirely.
    const connectors = buildConnectors(
      [detail("MetaMask Flask", "io.metamask.flask"), detail("MetaMask", "io.metamask")],
      DESKTOP,
    );
    expect(connectors.map((entry) => entry.id)).toEqual(["io.metamask", "io.metamask.flask"]);
    expect(connectors[0]?.recommended).toBe(true);
    expect(connectors[1]?.recommended).toBe(false);
    expect(connectors[1]?.detected).toBe(true);
  });

  it("does not let an io.metamask.* impostor displace the install entry's recommendation", () => {
    const connectors = buildConnectors([detail("MetaMask", "io.metamask.evil")], DESKTOP);
    expect(connectors[0]?.id).toBe(METAMASK_INSTALL_ID);
    expect(connectors[0]?.recommended).toBe(true);
    expect(connectors[1]?.id).toBe("io.metamask.evil");
    expect(connectors[1]?.recommended).toBe(false);
  });

  it("offers a MetaMask install entry when MetaMask did not announce itself", () => {
    const connectors = buildConnectors([detail("Rabby", "io.rabby")], DESKTOP);
    expect(connectors[0]?.id).toBe(METAMASK_INSTALL_ID);
    expect(connectors[0]?.kind).toBe("install");
    expect(connectors[0]?.installUrl).toBe(METAMASK_DOWNLOAD_URL);
    expect(connectors[0]?.provider).toBeNull();
  });

  it("uses the MetaMask deep link in a standalone mobile browser", () => {
    const connectors = buildConnectors([], {
      ...DESKTOP,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
    expect(connectors[0]?.installUrl).toBe("https://metamask.app.link/dapp/app.example/round/56/7");
  });

  it("never infers a name from window.ethereum when anything announced", () => {
    const connectors = buildConnectors([detail("Rabby", "io.rabby")], {...DESKTOP, injected: provider()});
    expect(connectors.some((entry) => entry.id === GENERIC_INJECTED_ID)).toBe(false);
  });

  it("falls back to window.ethereum, labelled generically, only when nothing announced", () => {
    const connectors = buildConnectors([], {...DESKTOP, injected: provider()});
    const fallback = connectors.find((entry) => entry.id === GENERIC_INJECTED_ID);
    expect(fallback?.name).toBe("Browser wallet");
    expect(fallback?.recommended).toBe(false);
  });

  it("refuses to connect through an install entry", async () => {
    const connectors = buildConnectors([], DESKTOP);
    await expect(connectors[0]?.connect()).rejects.toMatchObject({code: "WalletNotInstalled"});
  });
});

describe("helpers", () => {
  it("builds the deep link from the page's own host and path", () => {
    expect(metaMaskDeepLink({host: "luckydraw.example", pathname: "/wallet"})).toBe(
      "https://metamask.app.link/dapp/luckydraw.example/wallet",
    );
  });

  it("detects a mobile browser", () => {
    expect(isMobileBrowser("Mozilla/5.0 (Linux; Android 14)")).toBe(true);
    expect(isMobileBrowser("Mozilla/5.0 (Windows NT 10.0)")).toBe(false);
  });

  it("parses hex and numeric chain ids into bigints", () => {
    expect(parseChainId("0x38")).toBe(56n);
    expect(parseChainId(97)).toBe(97n);
    expect(() => parseChainId(null)).toThrow();
  });
});
