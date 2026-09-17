// The deployment and read context every page reads from (SPEC §10.1, §15).
//
// One provider, created once per page load:
//
//  - the pinned manifest and chain record come from `config/` at build time (records.ts);
//  - `verifyDeployment` runs once against the read RPC before anything can be signed. Until it returns ok,
//    `useWriteGate()` refuses every write with the failure as its reason. Reads keep working regardless of
//    what the *wallet* is doing, because they go through the app's own RPC provider and never through the
//    wallet; what reads do need is a verified deployment, since `ReadContext` cannot be built without one.
//  - the `ReadContext` pins the snapshot tag: `latest` on 31337, because anvil reports `finalized` as block
//    0 and every adapter would read an empty chain, and the default `finalized -> safe -> depth` walk
//    elsewhere with the chain record's `confirmationDepth`.

import {
  asAddress,
  type DeploymentManifest,
  describeFailure,
  type Environment,
  type ReadContext,
  type VerifiedDeployment,
  type VerifyFailure,
  verifyDeployment,
} from "@luckydraw/client";
import type {JsonRpcProvider} from "ethers";
import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState} from "react";
import {type WebEnv, webEnv} from "../config/env.ts";
import {createReadProvider, toReadProvider, toVerifyProvider} from "./provider.ts";
import {type ChainRecord, loadChainRecord, loadManifest} from "./records.ts";

/** Everything that exists before the chain is contacted. Built once; injectable so tests can supply fakes. */
export type DeploymentBase = {
  env: WebEnv;
  manifest: DeploymentManifest;
  chain: ChainRecord;
  provider: JsonRpcProvider;
  rpcUrl: string;
};

export type VerificationStatus = "verifying" | "ready" | "failed";

export type DeploymentContextValue = {
  manifest: DeploymentManifest;
  chain: ChainRecord;
  environment: Environment;
  /** The build's `VITE_LUCKYDRAW_*` values. */
  env: WebEnv;
  provider: JsonRpcProvider;
  status: VerificationStatus;
  /** Present only after `verifyDeployment` succeeded. Every write builder requires it (SPEC §15). */
  verified: VerifiedDeployment | null;
  verifyFailure: VerifyFailure | null;
  /** One-line, user-showable description of `verifyFailure`, or null. */
  verifyFailureText: string | null;
  /** Null until verification succeeds: a `ReadContext` cannot exist without a `VerifiedDeployment`. */
  readCtx: ReadContext | null;
  /** Re-runs verification. Used by the error state's retry control. */
  retryVerification: () => void;
};

const DeploymentContext = createContext<DeploymentContextValue | null>(null);

let cachedBase: DeploymentBase | null = null;

/** Builds (and caches for the page's lifetime) the manifest, chain record and read provider. */
export function deploymentBase(): DeploymentBase {
  if (cachedBase !== null) return cachedBase;
  const env = webEnv();
  const manifest = loadManifest(env.chainIdText, env.drawAddress);
  const chain = loadChainRecord(env.chainIdText);
  if (chain.chainId !== manifest.chain.chainId) {
    throw new Error(
      `config/chains/${env.chainIdText}.json is chain ${chain.chainId} but the manifest is chain ` +
        `${manifest.chain.chainId}.`,
    );
  }
  const rpcUrl = env.rpcUrls[0] as string;
  cachedBase = {env, manifest, chain, provider: createReadProvider(chain, rpcUrl), rpcUrl};
  return cachedBase;
}

/** Anvil reports `finalized` as block 0, so a local build must pin its snapshots to the head (SPEC §10.1). */
export const LOCAL_CHAIN_ID = 31337n;

function readContextFor(
  base: DeploymentBase,
  verified: VerifiedDeployment,
  provider: JsonRpcProvider,
): ReadContext {
  const multicall3 = base.chain.multicall3;
  return {
    provider: toReadProvider(provider),
    deployment: verified,
    multicall3: multicall3 === null ? undefined : asAddress(multicall3),
    depth: base.chain.confirmationDepth,
    tag: base.chain.chainId === LOCAL_CHAIN_ID ? "latest" : undefined,
  };
}

export function DeploymentProvider({base, children}: {base?: DeploymentBase; children: ReactNode}) {
  const resolved = useMemo(() => base ?? deploymentBase(), [base]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<VerificationStatus>("verifying");
  const [verified, setVerified] = useState<VerifiedDeployment | null>(null);
  const [verifyFailure, setVerifyFailure] = useState<VerifyFailure | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger, not a value the effect reads.
  useEffect(() => {
    let live = true;
    setStatus("verifying");
    setVerifyFailure(null);
    void verifyDeployment(toVerifyProvider(resolved.provider), resolved.manifest)
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setVerified(result.verified);
          setVerifyFailure(null);
          setStatus("ready");
        } else {
          setVerified(null);
          setVerifyFailure(result.failure);
          setStatus("failed");
        }
      })
      .catch((error: unknown) => {
        if (!live) return;
        setVerified(null);
        setVerifyFailure({
          kind: "ProviderFailed",
          step: "getNetwork",
          message: error instanceof Error ? error.message : String(error),
        });
        setStatus("failed");
      });
    return () => {
      live = false;
    };
  }, [resolved, attempt]);

  const retryVerification = useCallback(() => setAttempt((value) => value + 1), []);

  const value = useMemo<DeploymentContextValue>(
    () => ({
      manifest: resolved.manifest,
      chain: resolved.chain,
      environment: resolved.manifest.environment,
      env: resolved.env,
      provider: resolved.provider,
      status,
      verified,
      verifyFailure,
      verifyFailureText: verifyFailure === null ? null : describeFailure(verifyFailure),
      readCtx: verified === null ? null : readContextFor(resolved, verified, resolved.provider),
      retryVerification,
    }),
    [resolved, status, verified, verifyFailure, retryVerification],
  );

  return <DeploymentContext.Provider value={value}>{children}</DeploymentContext.Provider>;
}

/** The pinned deployment, its verification result and the read context. Throws outside the provider. */
export function useDeployment(): DeploymentContextValue {
  const value = useContext(DeploymentContext);
  if (value === null) throw new Error("useDeployment must be used inside <DeploymentProvider>.");
  return value;
}
