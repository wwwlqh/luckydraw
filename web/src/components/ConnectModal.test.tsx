// Wallet-authored text never stands alone in one of this app's alerts (SPEC §9.7), and two wallets that
// announce the same name are still distinguishable (SPEC §9.2).
//
// `error.message` is written by a browser extension. Rendered on its own inside `role="alert"` it reads as
// LuckyDraw speaking, which is how an extension gets to put its own sentence — "approve this to continue",
// anything — in the app's voice next to a Connect button.

import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import type {Connector} from "../lib/wallet/types.ts";
import {useWallet} from "../lib/wallet/WalletProvider.tsx";
import {en} from "../strings/en.ts";
import {announce, FakeWallet, renderWithProviders, testDeploymentBase} from "../test/harness.tsx";
import {ConnectModal} from "./ConnectModal.tsx";
import {NetworkGuard} from "./NetworkGuard.tsx";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function connector(id: string, name: string): Connector {
  return {
    id,
    name,
    icon: null,
    recommended: id === "io.metamask",
    detected: true,
    kind: "injected",
    installUrl: null,
    provider: {request: () => Promise.resolve(null)},
    connect: () => Promise.reject(new Error("unused")),
    disconnect: () => Promise.resolve(),
  };
}

describe("ConnectModal wallet-authored text", () => {
  it("puts the app's sentence first and labels the wallet's words", () => {
    render(
      <ConnectModal
        open
        connectors={[connector("io.metamask", "MetaMask")]}
        connectingId={null}
        error="Internal JSON-RPC error: approve the request in your wallet"
        onConnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent?.startsWith(en.wallet.errorReported)).toBe(true);
    expect(alert.textContent).toContain(en.wallet.errorSaidLabel);
    expect(alert.textContent).toContain("Internal JSON-RPC error");
  });

  it("caps what the wallet said", () => {
    render(
      <ConnectModal
        open
        connectors={[]}
        connectingId={null}
        error={"x".repeat(500)}
        onConnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // 199 characters plus the ellipsis, never the whole 500.
    expect(screen.getByRole("alert").textContent).not.toContain("x".repeat(201));
  });

  it("shows each wallet's rdns, so two rows named MetaMask can be told apart", () => {
    render(
      <ConnectModal
        open
        connectors={[connector("io.metamask", "MetaMask"), connector("io.metamask.flask", "MetaMask")]}
        connectingId={null}
        error={null}
        onConnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("io.metamask")).toBeInTheDocument();
    expect(screen.getByText("io.metamask.flask")).toBeInTheDocument();
  });
});

function GuardProbe() {
  const wallet = useWallet();
  return (
    <div>
      <span data-testid="status">{wallet.status}</span>
      <button type="button" onClick={() => void wallet.connect("io.metamask")}>
        connect
      </button>
      <NetworkGuard />
    </div>
  );
}

describe("NetworkGuard wallet-authored text", () => {
  it("labels a failed switch as the wallet's words, not the app's", async () => {
    const wallet = new FakeWallet([ACCOUNT], 56n);
    wallet.failures.push({
      method: "wallet_switchEthereumChain",
      error: new Error("MetaMask says: do something unusual"),
    });
    renderWithProviders(<GuardProbe />, {base: testDeploymentBase()});
    await act(async () => {
      announce("MetaMask", "io.metamask", wallet);
    });
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));
    await waitFor(() => expect(screen.getByText(en.network.guardTitle)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", {name: /Switch to/}));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.startsWith(en.wallet.errorReported)).toBe(true);
    expect(alert.textContent).toContain(`${en.wallet.errorSaidLabel} MetaMask says: do something unusual`);
  });
});
