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
} from "../../test/harness.tsx";
import {INTENT_STORAGE_KEY, type PendingIntent} from "../tx/intent.ts";
import {type ConnectorEnvironment, GENERIC_INJECTED_ID} from "./connectors.ts";
import {useWriteGate} from "./useWriteGate.ts";
import {CONNECTOR_STORAGE_KEY, useWallet} from "./WalletProvider.tsx";

const ACCOUNT_A = "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

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
    // the same reason its neighbours keep theirs, and its budget is raised past the 1,000 ms default because
    // the deadline is wall-clock: under the full parallel run a starved worker thread once let it expire on
    // work that was not slow, only descheduled. The assertion is unchanged.
    await waitFor(() => expect(screen.getByTestId("account").textContent).toBe(ACCOUNT_B.toLowerCase()), {
      timeout: 5_000,
    });
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it("blocks writes while the deployment has not passed its checks", async () => {
    renderWithProviders(<Probe />, {base: testDeploymentBase({emptyCode: true})});
    await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("deploymentUnverified"));
    expect(screen.getByTestId("reason").textContent).toContain("no contract code");
  });
});
