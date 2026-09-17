// The single gate every control that can move funds asks before it enables itself (SPEC §9.2, §9.6, §15).
//
// Four conditions, in the order that matters:
//
//  1. the deployment has not finished its checks, or failed them. SPEC §15: "block writes on
//     missing/mismatched deployment code". Reads are unaffected;
//  2. no wallet is connected;
//  3. the wallet is on a different chain. §9.2: "Reads keep working on the wrong chain; every write control
//     is disabled with the reason shown."
//  4. otherwise the gate is open.
//
// The reasons come from the client's catalog wherever §9.6 defines the sentence, so no wording is duplicated.

import {catalogEntryFor, renderMessage} from "@luckydraw/client";
import {en, fill} from "../../strings/en.ts";
import {useDeployment} from "../deployment/DeploymentProvider.tsx";
import {useWallet} from "./WalletProvider.tsx";

export type WriteGateCode =
  | "ok"
  | "deploymentVerifying"
  | "deploymentUnverified"
  | "disconnected"
  | "wrongChain";

export type WriteGate = {
  allowed: boolean;
  code: WriteGateCode;
  /** One sentence naming the cause, or null when the gate is open. */
  reason: string | null;
  /** What the surface should offer next, or null when the gate is open. */
  nextAction: string | null;
};

const OPEN: WriteGate = {allowed: true, code: "ok", reason: null, nextAction: null};

/** Whether writes are allowed right now, and why not. */
export function useWriteGate(): WriteGate {
  const deployment = useDeployment();
  const wallet = useWallet();

  if (deployment.status === "verifying") {
    return {
      allowed: false,
      code: "deploymentVerifying",
      reason: en.gate.verifying,
      nextAction: en.app.loading,
    };
  }
  if (deployment.status === "failed" || deployment.verified === null) {
    return {
      allowed: false,
      code: "deploymentUnverified",
      reason: fill(en.gate.verifyFailed, {detail: deployment.verifyFailureText ?? "unknown reason"}),
      nextAction: en.gate.recheck,
    };
  }
  if (wallet.status !== "connected" || wallet.account === null) {
    const entry = catalogEntryFor("Disconnected");
    return {allowed: false, code: "disconnected", reason: entry.message, nextAction: entry.nextAction};
  }
  if (wallet.chainId !== deployment.chain.chainId) {
    // The chain is named from the deployment's chain record, so a chain 97 build says "BNB Smart Chain
    // Testnet" and never points a player at mainnet.
    const entry = catalogEntryFor("WrongChain");
    return {
      allowed: false,
      code: "wrongChain",
      reason: renderMessage(entry, {chain: deployment.chain.displayName}),
      nextAction: entry.nextAction,
    };
  }
  return OPEN;
}
