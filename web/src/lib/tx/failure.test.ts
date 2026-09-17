// The three columns SPEC §9.6 requires — message, funds effect, next action — for the failures that never
// reach a decoded revert.
//
// The column that matters most is the funds one. "Unknown until receipt" sends someone looking for a hash;
// printing it for a gas estimate that failed before any signature existed is telling them to hunt for
// something that was never created.

import {
  catalogEntryFor,
  prepareDepositNative,
  type VerifiedDeployment,
  verifyDeployment,
} from "@luckydraw/client";
import type {JsonRpcProvider} from "ethers";
import {describe, expect, it} from "vitest";
import {en} from "../../strings/en.ts";
import {fakeNode, testManifest} from "../../test/harness.tsx";
import {toVerifyProvider} from "../deployment/provider.ts";
import {WalletError} from "../wallet/errors.ts";
import {failureFromUnknown, failureFromWalletError} from "./failure.ts";
import {runWrite, type TxRuntime} from "./machine.ts";

const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as const;

async function verified(): Promise<VerifiedDeployment> {
  const manifest = testManifest();
  const result = await verifyDeployment(
    toVerifyProvider(fakeNode(manifest) as unknown as JsonRpcProvider),
    manifest,
  );
  if (!result.ok) throw new Error("fixture did not verify");
  return result.verified;
}

function runtimeRejectingEstimate(error: unknown): TxRuntime {
  return {
    signer: {
      estimateGas: () => Promise.reject(error),
      sendTransaction: () => Promise.reject(new Error("must never be reached")),
    },
    watcher: {
      getTransactionReceipt: () => Promise.resolve(null),
      getTransaction: () => Promise.resolve(null),
      getTransactionCount: () => Promise.resolve(7),
      getBlockNumber: () => Promise.resolve(10_000),
      getFinalityHead: () => Promise.resolve(null),
      call: () => Promise.resolve("0x"),
    },
    chainId: 31_337n,
    finalityTag: null,
    confirmationDepth: 200n,
    storage: null,
    now: () => 1_000,
    sleep: () => Promise.resolve(),
    receiptPollMs: 1,
    dropAfterMs: 5_000,
  };
}

describe("failureFromUnknown", () => {
  it("says nothing was sent when the caller knows there is no hash", () => {
    const failure = failureFromUnknown(new Error("fetch failed"), {hasHash: false});
    expect(failure.funds).toBe("Nothing sent");
    expect(failure.nextAction).toBe("Retry; nothing was signed or sent");
  });

  it("stays at 'Unknown until receipt' when a hash may exist", () => {
    expect(failureFromUnknown(new Error("fetch failed")).funds).toBe("Unknown until receipt");
  });

  it("maps the ethers insufficient-funds shape onto the InsufficientGas catalog row", () => {
    const ethersError = Object.assign(new Error("insufficient funds for intrinsic transaction cost"), {
      code: "INSUFFICIENT_FUNDS",
    });
    const failure = failureFromUnknown(ethersError, {hasHash: false});
    expect(failure.catalogKey).toBe("InsufficientGas");
    expect(failure.funds).toBe(catalogEntryFor("InsufficientGas").funds);
  });

  it("recognizes a node that only says it in words", () => {
    const failure = failureFromUnknown(new Error("insufficient funds for gas * price + value"));
    expect(failure.catalogKey).toBe("InsufficientGas");
  });
});

describe("failureFromWalletError", () => {
  it("speaks in the app's voice and labels the wallet's own words separately", () => {
    const failure = failureFromWalletError(new WalletError("Unknown", "Internal JSON-RPC error. blah"));
    expect(failure.message).toBe(en.wallet.errorReported);
    expect(failure.walletText).toBe("Internal JSON-RPC error. blah");
    expect(failure.funds).toBe("Nothing sent");
  });

  it("caps what the wallet said at 200 characters", () => {
    const failure = failureFromWalletError(new WalletError("Unknown", "x".repeat(500)));
    expect(failure.walletText?.length).toBe(200);
  });
});

describe("a failing gas estimate", () => {
  it("reports 'Nothing sent' with no hash, because nothing was signed", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const runtime = runtimeRejectingEstimate(new Error("could not connect to the RPC endpoint"));

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.hash).toBeNull();
    expect(state.failure?.funds).toBe("Nothing sent");
    expect(state.failure?.nextAction).toBe("Retry; nothing was signed or sent");
  });

  it("reports a wallet that cannot pay for gas from the catalog row for it", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const runtime = runtimeRejectingEstimate(
      Object.assign(new Error("insufficient funds"), {code: "INSUFFICIENT_FUNDS"}),
    );

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.failure?.catalogKey).toBe("InsufficientGas");
  });
});
