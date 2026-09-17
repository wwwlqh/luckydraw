// Reattaching to a persisted intent (SPEC §9.6 "Deep-link returns and tab restores reattach to any persisted
// hash and resume receipt tracking").
//
// The property under test is whose transaction gets reattached. An intent names an account, and the silent
// reconnect of §9.2 resolves one a tick or two after mount, so a resume that runs before the session settles
// would show this tab's last transaction to whoever connects next.

import {act, fireEvent, screen, waitFor} from "@testing-library/react";
import {useState} from "react";
import {describe, expect, it} from "vitest";
import {
  announce,
  FakeWallet,
  renderWithProviders,
  testDeploymentBase,
  testManifest,
} from "../../test/harness.tsx";
import {useWallet} from "../wallet/WalletProvider.tsx";
import {INTENT_STORAGE_KEY, type PendingIntent} from "./intent.ts";
import type {TxRuntime} from "./machine.ts";
import type {TxReceiptLike} from "./types.ts";
import {useTransaction} from "./useTransaction.tsx";

const ACCOUNT_A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const HASH = `0x${"ab".repeat(32)}`;
const VAULT = testManifest().contracts.vault.address;

function storedIntent(account: string, to: string = VAULT): PendingIntent {
  return {
    action: "deposit",
    contract: "vault",
    function: "depositNative",
    label: "Deposit",
    account: account.toLowerCase(),
    chainId: "31337",
    to,
    data: "0x",
    value: "0",
    nonce: 7,
    hash: HASH,
    startedAt: 1,
  };
}

/** A runtime whose receipt is already there, so a resume that happens at all finishes in one poll. */
function watcherRuntime(): TxRuntime {
  const receipt: TxReceiptLike = {hash: HASH, status: 1, blockNumber: 500};
  let clock = 1_000;
  return {
    signer: {
      estimateGas: () => Promise.reject(new Error("no signing in this test")),
      sendTransaction: () => Promise.reject(new Error("no signing in this test")),
    },
    watcher: {
      getTransactionReceipt: () => Promise.resolve(receipt),
      getTransaction: () => Promise.resolve({blockNumber: 500}),
      getTransactionCount: () => Promise.resolve(7),
      getBlockNumber: () => Promise.resolve(5_000),
      getFinalityHead: () => Promise.resolve(null),
      call: () => Promise.resolve("0x"),
    },
    chainId: 31_337n,
    finalityTag: null,
    confirmationDepth: 200n,
    storage: window.sessionStorage,
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    receiptPollMs: 1,
    dropAfterMs: 5_000,
  };
}

/**
 * A runtime whose transaction is forever pending, so a resume keeps polling until something stops it.
 *
 * `sleep` is a real timer rather than a resolved promise: an unbounded loop over microtasks starves the
 * macrotask queue, and `waitFor` runs on timers.
 */
function pendingRuntime(counter: {polls: number}): TxRuntime {
  const base = watcherRuntime();
  return {
    ...base,
    watcher: {
      ...base.watcher,
      getTransactionReceipt: () => {
        counter.polls += 1;
        return Promise.resolve(null);
      },
      // Still in the mempool: no verdict is ever reachable, so only an abort ends this loop.
      getTransaction: () => Promise.resolve({blockNumber: null}),
    },
    now: () => 1_000,
    sleep: () => new Promise<void>((done) => setTimeout(done, 1)),
    receiptPollMs: 1,
    maxPollMs: 1,
    dropAfterMs: 60 * 60_000,
  };
}

function Probe({runtimeFor = watcherRuntime}: {runtimeFor?: () => TxRuntime}) {
  const wallet = useWallet();
  // Built once: a new runtime object on every render would re-key the hook's memo on every render.
  const [runtime] = useState(runtimeFor);
  const tx = useTransaction({runtime});
  return (
    <div>
      <span data-testid="status">{wallet.status}</span>
      <span data-testid="account">{wallet.account ?? "-"}</span>
      <span data-testid="phase">{tx.state.phase}</span>
      <span data-testid="hash">{tx.state.hash ?? "-"}</span>
      <button type="button" onClick={() => void wallet.connect("io.metamask")}>
        connect
      </button>
      <button type="button" onClick={tx.reset}>
        reset
      </button>
    </div>
  );
}

async function connectAs(account: string, runtimeFor?: () => TxRuntime) {
  const wallet = new FakeWallet([account]);
  renderWithProviders(<Probe {...(runtimeFor === undefined ? {} : {runtimeFor})} />, {
    base: testDeploymentBase(),
  });
  await act(async () => {
    announce("MetaMask", "io.metamask", wallet);
  });
  fireEvent.click(screen.getByText("connect"));
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));
}

describe("useTransaction resume", () => {
  it("does not resume another account's intent", async () => {
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(storedIntent(ACCOUNT_B)));

    await connectAs(ACCOUNT_A);

    await waitFor(() => expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_A.toLowerCase()));
    expect(screen.getByTestId("phase").textContent).toBe("idle");
    expect(screen.getByTestId("hash").textContent).toBe("-");
    // Untouched: it was never this session's to consume or clear.
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).not.toBeNull();
  });

  it("resumes the connected account's own intent", async () => {
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(storedIntent(ACCOUNT_A)));

    await connectAs(ACCOUNT_A);

    await waitFor(() => expect(screen.getByTestId("hash").textContent).toBe(HASH));
    expect(screen.getByTestId("phase").textContent).toBe("confirmed");
  });

  it("does not resume an intent aimed at anything but this deployment's own contracts", async () => {
    // Session storage is writable by anything in this origin. An intent naming a foreign contract was not
    // written by this app and must not be shown under its transaction UI (SPEC §15).
    const foreign = storedIntent(ACCOUNT_A, "0x000000000000000000000000000000000000dead");
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(foreign));

    await connectAs(ACCOUNT_A);

    await waitFor(() => expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_A.toLowerCase()));
    expect(screen.getByTestId("phase").textContent).toBe("idle");
    // Removed rather than left to be retried on every reload.
    await waitFor(() => expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull());
  });

  it("stops polling for a receipt once the run is reset", async () => {
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(storedIntent(ACCOUNT_A)));
    const counter = {polls: 0};

    await connectAs(ACCOUNT_A, () => pendingRuntime(counter));

    await waitFor(() => expect(counter.polls).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("reset"));
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("idle"));
    const settled = counter.polls;
    await new Promise((done) => setTimeout(done, 20));

    // One poll may already have been in flight when reset landed; nothing keeps going after it.
    expect(counter.polls).toBeLessThanOrEqual(settled + 1);
  });
});
