// The build's environment variables (SPEC §12, §10.4).

import {describe, expect, it} from "vitest";
import {parseWebEnv, WebConfigError} from "./env.ts";

const BASE = {
  VITE_LUCKYDRAW_CHAIN_ID: "31337",
  VITE_LUCKYDRAW_DRAW_ADDRESS: "0x610178da211fef7d417bc0e6fed39f05609ad788",
  VITE_LUCKYDRAW_RPC_URL: "http://127.0.0.1:8545",
};

describe("parseWebEnv", () => {
  it("accepts the committed local defaults", () => {
    const env = parseWebEnv(BASE);
    expect(env.chainId).toBe(31_337n);
    expect(env.rpcUrls).toEqual(["http://127.0.0.1:8545"]);
    expect(env.blockPollMs).toBe(3_000);
  });

  it("refuses an RPC URL that carries credentials", () => {
    // A static build hands this URL to every visitor and to `wallet_addEthereumChain`. A keyed endpoint
    // cannot be baked into one (SPEC §10.4).
    expect(() =>
      parseWebEnv({...BASE, VITE_LUCKYDRAW_RPC_URL: "https://user:s3cret@rpc.example/bsc"}),
    ).toThrow(WebConfigError);
    try {
      parseWebEnv({...BASE, VITE_LUCKYDRAW_RPC_URL: "https://user:s3cret@rpc.example/bsc"});
    } catch (error) {
      // The message names the endpoint, never the secret it is rejecting.
      expect((error as Error).message).toContain("https://rpc.example/bsc");
      expect((error as Error).message).not.toContain("s3cret");
    }
  });

  it("refuses an RPC URL that carries a query string", () => {
    expect(() =>
      parseWebEnv({...BASE, VITE_LUCKYDRAW_RPC_URL: "https://rpc.example/bsc?key=abcdef"}),
    ).toThrow(/query string/);
    try {
      parseWebEnv({...BASE, VITE_LUCKYDRAW_RPC_URL: "https://rpc.example/bsc?key=abcdef"});
    } catch (error) {
      expect((error as Error).message).not.toContain("abcdef");
    }
  });

  it("still refuses a non-http scheme and a missing URL", () => {
    expect(() => parseWebEnv({...BASE, VITE_LUCKYDRAW_RPC_URL: "ws://rpc.example"})).toThrow(/http or https/);
    expect(() => parseWebEnv({...BASE, VITE_LUCKYDRAW_RPC_URL: ""})).toThrow(WebConfigError);
  });
});

describe("parseWebEnv: the jurisdiction sentence (SPEC §14)", () => {
  const MAINNET = {...BASE, VITE_LUCKYDRAW_CHAIN_ID: "56"};

  it("is optional off chain 56 and empty when unset", () => {
    expect(parseWebEnv(BASE).jurisdictionNotice).toBe("");
    expect(parseWebEnv({...BASE, VITE_LUCKYDRAW_CHAIN_ID: "97"}).jurisdictionNotice).toBe("");
  });

  it("is carried through trimmed, whatever the chain", () => {
    const env = parseWebEnv({...BASE, VITE_LUCKYDRAW_JURISDICTION_NOTICE: "  Not for Examplestan.  "});
    expect(env.jurisdictionNotice).toBe("Not for Examplestan.");
  });

  it("is required on chain 56", () => {
    expect(() => parseWebEnv(MAINNET)).toThrow(WebConfigError);
    expect(() => parseWebEnv({...MAINNET, VITE_LUCKYDRAW_JURISDICTION_NOTICE: "   "})).toThrow(
      /VITE_LUCKYDRAW_JURISDICTION_NOTICE/,
    );
  });

  it("accepts a non-empty sentence on chain 56", () => {
    const env = parseWebEnv({...MAINNET, VITE_LUCKYDRAW_JURISDICTION_NOTICE: "Not for Examplestan."});
    expect(env.chainId).toBe(56n);
    expect(env.jurisdictionNotice).toBe("Not for Examplestan.");
  });
});
