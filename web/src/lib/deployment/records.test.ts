// The configuration loader fails loudly rather than shipping a page that cannot verify anything
// (SPEC §12, §15).

import {describe, expect, it} from "vitest";
import {parseWebEnv, WebConfigError} from "../config/env.ts";
import {DeploymentRecordError, loadChainRecord, loadManifest} from "./records.ts";

const LOCAL_DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";

describe("loadManifest", () => {
  it("loads the local deployment and agrees with the pair that selected it", () => {
    const manifest = loadManifest("31337", LOCAL_DRAW);
    expect(manifest.deploymentId).toBe(`31337:${LOCAL_DRAW}`);
    expect(manifest.environment).toBe("local");
    expect(manifest.contracts.draw.address).toBe(LOCAL_DRAW);
    expect(manifest.chain.chainId).toBe(31_337n);
  });

  it("throws, naming the path, when the manifest does not exist", () => {
    expect(() => loadManifest("31337", "0x0000000000000000000000000000000000000001")).toThrow(
      DeploymentRecordError,
    );
    expect(() => loadManifest("999", LOCAL_DRAW)).toThrow(/deployments\/999/);
  });

  it("never mistakes an operator plan for a manifest", () => {
    // config/deployments/31337/ also holds local.plan.json; only the draw-address file is a manifest.
    expect(() => loadManifest("31337", "local.plan")).toThrow(DeploymentRecordError);
  });
});

describe("loadChainRecord", () => {
  it("reads the fields the app needs and cross-checks the chain id against the file name", () => {
    const chain = loadChainRecord("31337");
    expect(chain.chainId).toBe(31_337n);
    expect(chain.nativeSymbol).toBe("BNB");
    expect(chain.displayName).toBe("Local anvil");
    expect(chain.explorerUrl).toBeNull();
    expect(chain.confirmationDepth).toBe(200n);
    expect(chain.multicall3).toBeNull();
    expect(chain.publicRpcEnvVar).toBe("LUCKYDRAW_RPC_URL");
  });

  it("reads the BSC testnet record, which does carry an explorer and a finality tag", () => {
    const chain = loadChainRecord("97");
    expect(chain.explorerUrl).toBe("https://testnet.bscscan.com");
    expect(chain.finalityTag).toBe("finalized");
  });

  it("throws for a chain this build has no record for", () => {
    expect(() => loadChainRecord("1")).toThrow(DeploymentRecordError);
  });
});

describe("parseWebEnv", () => {
  const valid = {
    VITE_LUCKYDRAW_CHAIN_ID: "31337",
    VITE_LUCKYDRAW_DRAW_ADDRESS: LOCAL_DRAW,
    VITE_LUCKYDRAW_RPC_URL: "http://127.0.0.1:8545",
  };

  it("accepts the local defaults from .env.example", () => {
    const env = parseWebEnv(valid);
    expect(env.chainId).toBe(31_337n);
    expect(env.rpcUrls).toEqual(["http://127.0.0.1:8545"]);
    expect(env.blockPollMs).toBe(3_000);
  });

  it("refuses a checksummed address, because manifests are named in lowercase", () => {
    expect(() =>
      parseWebEnv({...valid, VITE_LUCKYDRAW_DRAW_ADDRESS: "0x610178DA211FEF7D417BC0E6FED39F05609AD788"}),
    ).toThrow(WebConfigError);
  });

  it("requires an RPC URL, because the chain record carries only the variable name", () => {
    expect(() => parseWebEnv({...valid, VITE_LUCKYDRAW_RPC_URL: ""})).toThrow(/rpcEnvVars/);
  });

  it("refuses an RPC URL that is not http or https", () => {
    expect(() => parseWebEnv({...valid, VITE_LUCKYDRAW_RPC_URL: "ws://127.0.0.1:8545"})).toThrow(
      WebConfigError,
    );
  });
});
