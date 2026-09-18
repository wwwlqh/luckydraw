// The wallet session, the network guard and the write gate, driven by a fake EIP-1193 wallet
// (SPEC §9.2, §9.6; ACCEPTANCE U06 "never signs with a stale account").

import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {
  announce,
  FakeWallet,
  NO_INJECTED,
  Providers,
  renderWithProviders,
  testDeploymentBase,
  waitForWalletListeners,
} from "../../test/harness.tsx";
import {INTENT_STORAGE_KEY, type PendingIntent} from "../tx/intent.ts";
import {type ConnectorEnvironment, GENERIC_INJECTED_ID} from "./connectors.ts";
import type {Eip1193RequestArgs} from "./types.ts";
import {useWriteGate} from "./useWriteGate.ts";
import {CONNECTOR_STORAGE_KEY, useWallet} from "./WalletProvider.tsx";

const ACCOUNT_A = "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/**
 * A wallet that can hold its next `eth_accounts` answer, so a test can re-render the provider stack — and so
 * make the provider-events effect re-subscribe — while a re-validation is still in flight.
 */
class GatedWallet extends FakeWallet {
  /** Set before the event: the next `eth_accounts` read waits until `releaseAccounts()` is called. */
  holdAccounts = false;
  private readonly held: (() => void)[] = [];

  /** How many `eth_accounts` reads are waiting. */
  get heldReads(): number {
    return this.held.length;
  }

  override request(args: Eip1193RequestArgs): Promise<unknown> {
    if (args.method !== "eth_accounts" || !this.holdAccounts) return super.request(args);
    this.holdAccounts = false;
    return new Promise<void>((resolve) => {
      this.held.push(resolve);
    }).then(() => super.request(args));
  }

  releaseAccounts(): void {
    for (const resolve of this.held.splice(0)) resolve();
  }
}

function Probe() {
  const wallet = useWallet();
  const gate = useWriteGate();
  return (
    <div>
      <span data-testid="status">{wallet.status}</span>
      <span data-testid="account">{wallet.account ?? "-"}</span>
      <span data-testid="chain">{wallet.chainId === null ? "-" : wallet.chainId.toString()}</span>
      <span data-testid="epoch">{wallet.accountEpoch}</span>
      <span data-testid="connectors">{wallet.connectors.map((entry) => entry.id).join(",")}</span>
      <span data-testid="gate">{gate.code}</span>
      <span data-testid="reason">{gate.reason ?? "-"}</span>
      <span data-testid="error">{wallet.error === null ? "-" : wallet.error.code}</span>
      <button type="button" onClick={() => void wallet.connect("io.metamask")}>
        connect
      </button>
      <button type="button" onClick={() => void wallet.connect(GENERIC_INJECTED_ID)}>
        connect injected
      </button>
      <button type="button" onClick={() => void wallet.switchToDeploymentChain().catch(() => undefined)}>
        switch
      </button>
      <button type="button" onClick={wallet.disconnect}>
        disconnect
      </button>
    </div>
  );
}

function intentFor(account: string): PendingIntent {
  return {
    action: "deposit",
    contract: "vault",
    function: "depositNative",
    label: "Deposit",
    account: account.toLowerCase(),
    chainId: "31337",
    to: account.toLowerCase(),
    data: "0x",
    value: "0",
    nonce: 1,
    hash: `0x${"ab".repeat(32)}`,
    startedAt: 1,
  };
}

async function mountConnected(wallet: FakeWallet) {
  renderWithProviders(<Probe />, {base: testDeploymentBase()});
  await act(async () => {
    announce("MetaMask", "io.metamask", wallet);
  });
  await waitFor(() => expect(screen.getByTestId("gate").textContent).not.toBe("deploymentVerifying"));
  fireEvent.click(screen.getByText("connect"));
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));
  // "connected" in the DOM is one commit ahead of the effect that subscribes to the wallet's events, and an
  // event fired into a wallet with no listeners is lost outright.
  await waitForWalletListeners(wallet);
}

describe("WalletProvider", () => {
  it("connects, lowercases the account and stores only the connector id", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    await mountConnected(wallet);

    expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_A.toLowerCase());
    expect(screen.getByTestId("chain").textContent).toBe("31337");
    expect(screen.getByTestId("gate").textContent).toBe("ok");
    expect(window.localStorage.getItem(CONNECTOR_STORAGE_KEY)).toBe("io.metamask");
    // Nothing else is persisted: no key, no signature, no account.
    expect(Object.keys(window.localStorage)).toEqual([CONNECTOR_STORAGE_KEY]);
  });

  it("re-validates an account change against the wallet and advances the cache epoch", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    await mountConnected(wallet);
    const before = Number(screen.getByTestId("epoch").textContent);

    await act(async () => {
      wallet.setAccounts([ACCOUNT_B]);
    });

    await waitFor(() => expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_B.toLowerCase()));
    expect(Number(screen.getByTestId("epoch").textContent)).toBeGreaterThan(before);
    // The payload was not trusted: a fresh eth_accounts read followed the event.
    expect(wallet.calls.filter((call) => call.method === "eth_accounts").length).toBeGreaterThan(0);
  });

  it("retries a re-validation that an effect re-subscription dropped", async () => {
    // The provider-events effect re-subscribes whenever its connector's identity changes — a fresh
    // announcement, a new environment object, anything that rebuilds the connector list. Its cleanup used to
    // drop whatever `eth_accounts` read was in flight and nothing re-read, so the account chip kept the old
    // address with no error: a stale account, which §9.2 forbids. The dropped read is now re-run on the next
    // subscription instead.
    const base = testDeploymentBase();
    const wallet = new GatedWallet([ACCOUNT_A]);
    // A new object every time, with the same contents: only the identity changes, never the provider.
    const freshEnvironment = (): ConnectorEnvironment => ({...NO_INJECTED});
    const {rerender} = render(
      <Providers base={base} environment={freshEnvironment()}>
        <Probe />
      </Providers>,
    );
    await act(async () => {
      announce("MetaMask", "io.metamask", wallet);
    });
    await waitFor(() => expect(screen.getByTestId("gate").textContent).not.toBe("deploymentVerifying"));
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));
    await waitForWalletListeners(wallet);

    // The wallet moves to another account and holds its answer, so the re-validation stays in flight.
    wallet.holdAccounts = true;
    await act(async () => {
      wallet.setAccounts([ACCOUNT_B]);
    });
    expect(wallet.heldReads).toBe(1);
    expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_A.toLowerCase());

    await act(async () => {
      rerender(
        <Providers base={base} environment={freshEnvironment()}>
          <Probe />
        </Providers>,
      );
    });
    await act(async () => {
      wallet.releaseAccounts();
    });

    await waitFor(() => expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_B.toLowerCase()), {
      timeout: 2_000,
    });
    expect(screen.getByTestId("status").textContent).toBe("connected");
    // Still a fresh read rather than the event payload, and the session kept its own provider.
    expect(wallet.calls.filter((call) => call.method === "eth_accounts").length).toBeGreaterThan(1);
  });

  it("closes the write gate with a reason when the wallet moves to another chain", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    await mountConnected(wallet);

    await act(async () => {
      wallet.setChain(56n);
    });

    await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("wrongChain"));
    // The reason names the deployment chain (the local record's displayName), never mainnet.
    expect(screen.getByTestId("reason").textContent).toContain("LuckyDraw runs on Local anvil.");
    expect(screen.getByTestId("reason").textContent).not.toContain("BNB Smart Chain");
    expect(screen.getByTestId("chain").textContent).toBe("56");
  });

  it("switches back through wallet_addEthereumChain when the wallet does not know the chain", async () => {
    const wallet = new FakeWallet([ACCOUNT_A], 56n);
    await mountConnected(wallet);
    await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("wrongChain"));

    fireEvent.click(screen.getByText("switch"));

    await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("ok"));
    const methods = wallet.calls.map((call) => call.method);
    expect(methods).toContain("wallet_switchEthereumChain");
    expect(methods).toContain("wallet_addEthereumChain");
    const added = wallet.calls.find((call) => call.method === "wallet_addEthereumChain");
    const params = (added === undefined ? [] : added.params) as [Record<string, unknown>];
    expect(params[0]).toMatchObject({
      chainId: "0x7a69",
      nativeCurrency: {symbol: "BNB", decimals: 18},
    });
  });

  it("reports a user rejection as its own branch and stores nothing", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    wallet.failures.push({
      method: "eth_requestAccounts",
      error: Object.assign(new Error("User rejected the request."), {code: 4001}),
    });
    renderWithProviders(<Probe />, {base: testDeploymentBase()});
    await act(async () => {
      announce("MetaMask", "io.metamask", wallet);
    });
    await waitFor(() => expect(screen.getByTestId("gate").textContent).not.toBe("deploymentVerifying"));

    fireEvent.click(screen.getByText("connect"));

    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("UserRejected"));
    expect(screen.getByTestId("status").textContent).toBe("disconnected");
    expect(window.localStorage.getItem(CONNECTOR_STORAGE_KEY)).toBeNull();
  });

  it("reconnects silently from the stored connector id without prompting", async () => {
    window.localStorage.setItem(CONNECTOR_STORAGE_KEY, "io.metamask");
    const wallet = new FakeWallet([ACCOUNT_A]);
    renderWithProviders(<Probe />, {base: testDeploymentBase()});

    await act(async () => {
      announce("MetaMask", "io.metamask", wallet);
    });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));
    expect(wallet.calls.some((call) => call.method === "eth_requestAccounts")).toBe(false);
  });

  it("clears the session and the stored id when the wallet reports no accounts", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    await mountConnected(wallet);

    await act(async () => {
      wallet.setAccounts([]);
    });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("disconnected"));
    expect(window.localStorage.getItem(CONNECTOR_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId("gate").textContent).toBe("disconnected");
  });

  it("keeps the first announcement for an rdns and ignores a later one", async () => {
    // Last-writer-wins on `rdns` lets anything in the page announce "io.metamask" again and have its own
    // provider object used for the next signature. The first announcement wins instead.
    const first = new FakeWallet([ACCOUNT_A]);
    const impostor = new FakeWallet([ACCOUNT_B]);
    renderWithProviders(<Probe />, {base: testDeploymentBase()});
    await act(async () => {
      announce("MetaMask", "io.metamask", first);
    });
    await waitFor(() => expect(screen.getByTestId("gate").textContent).not.toBe("deploymentVerifying"));
    await act(async () => {
      announce("MetaMask", "io.metamask", impostor);
    });

    fireEvent.click(screen.getByText("connect"));

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));
    expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_A.toLowerCase());
    expect(screen.getByTestId("connectors").textContent).toBe("io.metamask");
    expect(impostor.calls).toHaveLength(0);
  });

  it("ends the session when the provider behind the connected wallet is replaced", async () => {
    const base = testDeploymentBase();
    const first = new FakeWallet([ACCOUNT_A]);
    const replacement = new FakeWallet([ACCOUNT_B]);
    const envWith = (injected: FakeWallet): ConnectorEnvironment => ({...NO_INJECTED, injected});
    const {rerender} = render(
      <Providers base={base} environment={envWith(first)}>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId("gate").textContent).not.toBe("deploymentVerifying"));
    fireEvent.click(screen.getByText("connect injected"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));

    rerender(
      <Providers base={base} environment={envWith(replacement)}>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("disconnected"));
    expect(screen.getByTestId("error").textContent).toBe("Disconnected");
    expect(window.localStorage.getItem(CONNECTOR_STORAGE_KEY)).toBeNull();
    // Nothing was asked of the newcomer: it never became the session's provider.
    expect(replacement.calls).toHaveLength(0);
  });

  it("ends the session when the connected connector vanishes from the list", async () => {
    // The generic `window.ethereum` entry exists only while nothing has announced itself. A wallet that
    // announces a moment after the user connected through it removes the connected connector, which used to
    // leave `status` at "connected" with no connector: no listeners, no signer, and a chip still showing an
    // address nothing was watching.
    const base = testDeploymentBase();
    const injected = new FakeWallet([ACCOUNT_A]);
    renderWithProviders(<Probe />, {base, environment: {...NO_INJECTED, injected}});
    await waitFor(() => expect(screen.getByTestId("gate").textContent).not.toBe("deploymentVerifying"));
    fireEvent.click(screen.getByText("connect injected"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));

    await act(async () => {
      announce("Rabby", "io.rabby", new FakeWallet([ACCOUNT_B]));
    });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("disconnected"));
    expect(screen.getByTestId("error").textContent).toBe("Disconnected");
    expect(window.localStorage.getItem(CONNECTOR_STORAGE_KEY)).toBeNull();

    // And the torn-down session does not come back to life on the old provider's next event.
    await act(async () => {
      injected.setAccounts([ACCOUNT_B]);
    });
    expect(screen.getByTestId("account").textContent).toBe("-");
    expect(screen.getByTestId("status").textContent).toBe("disconnected");
  });

  it("clears the pending transaction intent on disconnect", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    await mountConnected(wallet);
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intentFor(ACCOUNT_A)));

    fireEvent.click(screen.getByText("disconnect"));

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("disconnected"));
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it("clears the pending transaction intent when the wallet moves to another account", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    await mountConnected(wallet);
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intentFor(ACCOUNT_A)));

    await act(async () => {
      wallet.setAccounts([ACCOUNT_B]);
    });

    // `accountsChanged` is answered with a fresh `eth_accounts` read and no timer, so the new account is
    // already rendered when the `act` above returns; nothing here waits for a debounce. The wait is kept for
    // the same reason its neighbours keep theirs. Its budget was once raised to 5,000 ms on the theory that a
    // starved worker thread let the default expire; the real cause was an event fired before the app had
    // subscribed, which `mountConnected` now waits out, so the default budget is back — and 5,000 ms was in
    // any case the test timeout itself, which reported "test timed out" instead of the assertion.
    await waitFor(() => expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_B.toLowerCase()));
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it("blocks writes while the deployment has not passed its checks", async () => {
    renderWithProviders(<Probe />, {base: testDeploymentBase({emptyCode: true})});
    await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("deploymentUnverified"));
    expect(screen.getByTestId("reason").textContent).toContain("no contract code");
  });
});
