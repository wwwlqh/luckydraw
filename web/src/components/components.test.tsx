// Each base component in each of its states (SPEC §9.3 component catalog; the Storybook catalog itself is
// deferred, so these render checks stand in for it in this wave).

import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import type {ChainRecord} from "../lib/deployment/records.ts";
import type {TxState} from "../lib/tx/types.ts";
import {IDLE_TX_STATE} from "../lib/tx/types.ts";
import {en} from "../strings/en.ts";
import {AccountChip, truncateAddress} from "./AccountChip.tsx";
import {Button} from "./Button.tsx";
import {Card, Skeleton} from "./Card.tsx";
import {ConnectModal} from "./ConnectModal.tsx";
import {DataFreshness} from "./DataFreshness.tsx";
import {TxLiveRegion, TxStepper} from "./index.ts";
import {AssetBadge, StateBadge} from "./StateBadge.tsx";
import {EmptyState, ErrorState} from "./StatePanels.tsx";

const CHAIN: ChainRecord = {
  chainId: 97n,
  name: "bsc-testnet",
  displayName: "BNB Smart Chain Testnet",
  nativeSymbol: "BNB",
  explorerUrl: "https://testnet.bscscan.com",
  confirmationDepth: 200n,
  finalityTag: "finalized",
  multicall3: null,
  publicRpcEnvVar: "LUCKYDRAW_RPC_URL",
};

const ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

describe("Button", () => {
  it("renders the default, loading and disabled-with-a-reason states", () => {
    const {rerender} = render(<Button variant="primary">Enter</Button>);
    expect(screen.getByRole("button", {name: "Enter"})).toBeEnabled();

    rerender(
      <Button variant="primary" loading>
        Enter
      </Button>,
    );
    expect(screen.getByRole("button", {name: "Enter"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Enter"})).toHaveAttribute("aria-busy", "true");

    rerender(
      <Button variant="primary" disabledReason="Your wallet is on a different network.">
        Enter
      </Button>,
    );
    const button = screen.getByRole("button", {name: "Enter"});
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Your wallet is on a different network.");
  });

  it("fires its click handler and defaults to type=button", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const button = screen.getByRole("button", {name: "Go"});
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("surfaces", () => {
  it("renders a card with a title, aside and footer", () => {
    render(
      <Card title="Pot" aside={<StateBadge tone="pending" label="Pending" />} footer={<span>footer</span>}>
        body
      </Card>,
    );
    expect(screen.getByRole("heading", {name: "Pot"})).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("footer")).toBeInTheDocument();
  });

  it("announces the skeleton rather than showing a bare shimmer", () => {
    render(<Skeleton label="Loading pools" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading pools");
  });

  it("renders the empty and error panels with a cause, a funds effect and a next step", () => {
    render(<EmptyState />);
    expect(screen.getByText(en.empty.title)).toBeInTheDocument();

    const onRetry = vi.fn();
    render(
      <ErrorState
        body="The price reference is unavailable."
        funds="Nothing debited"
        nextAction="Retry when fresh"
        detail="0xdeadbeef"
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The price reference is unavailable.");
    expect(alert).toHaveTextContent("Nothing debited");
    expect(alert).toHaveTextContent("Retry when fresh");
    fireEvent.click(screen.getByRole("button", {name: en.app.retry}));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("badges", () => {
  it("pairs every state colour with a glyph and a label", () => {
    render(<StateBadge tone="positive" label="Won" />);
    const badge = screen.getByText("Won").parentElement;
    expect(badge?.className).toContain("badge--positive");
    // The glyph is decorative; the label is the accessible signal.
    expect(badge?.textContent).toBe("✓Won");
  });

  it("takes the asset symbol from the manifest record only", () => {
    render(<AssetBadge asset={{symbol: "TEST2", name: "Local mock token", native: false}} showName />);
    expect(screen.getByText("TEST2")).toBeInTheDocument();
    expect(screen.getByText("Local mock token")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("AccountChip", () => {
  it("shows the truncated address, the chain, an explorer link and Disconnect", () => {
    const onDisconnect = vi.fn();
    render(<AccountChip address={ADDRESS} chain={CHAIN} walletChainId={97n} onDisconnect={onDisconnect} />);
    expect(screen.getByText(truncateAddress(ADDRESS))).toBeInTheDocument();
    // The chip is player-facing, so it carries the display name, never the slug.
    expect(screen.getByText("BNB Smart Chain Testnet")).toBeInTheDocument();
    expect(screen.queryByText("bsc-testnet")).toBeNull();
    expect(screen.getByRole("link", {name: en.app.openInExplorer})).toHaveAttribute(
      "href",
      `https://testnet.bscscan.com/address/${ADDRESS}`,
    );
    fireEvent.click(screen.getByRole("button", {name: en.wallet.disconnect}));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("flags a wallet that is on another chain", () => {
    render(<AccountChip address={ADDRESS} chain={CHAIN} walletChainId={56n} onDisconnect={vi.fn()} />);
    expect(screen.getByText("Chain 56")).toBeInTheDocument();
  });
});

describe("ConnectModal", () => {
  const connectors = [
    {
      id: "io.metamask",
      name: "MetaMask",
      icon: null,
      recommended: true,
      detected: true,
      kind: "injected" as const,
      installUrl: null,
      provider: {request: () => Promise.resolve(null)},
      connect: () => Promise.reject(new Error("unused")),
      disconnect: () => Promise.resolve(),
    },
    {
      id: "io.rabby",
      name: "Rabby",
      icon: null,
      recommended: false,
      detected: true,
      kind: "injected" as const,
      installUrl: null,
      provider: {request: () => Promise.resolve(null)},
      connect: () => Promise.reject(new Error("unused")),
      disconnect: () => Promise.resolve(),
    },
  ];

  it("traps focus, returns it on close and badges the wallets", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const onClose = vi.fn();
    const onConnect = vi.fn();
    const {rerender} = render(
      <ConnectModal
        open
        connectors={connectors}
        connectingId={null}
        error={null}
        onConnect={onConnect}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(screen.getByText(en.wallet.recommendedBadge)).toBeInTheDocument();
    expect(screen.getByText(en.wallet.detectedBadge)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {name: /MetaMask/}));
    expect(onConnect).toHaveBeenCalledWith("io.metamask");

    fireEvent.keyDown(dialog, {key: "Escape"});
    expect(onClose).toHaveBeenCalled();

    rerender(
      <ConnectModal
        open={false}
        connectors={connectors}
        connectingId={null}
        error={null}
        onConnect={onConnect}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("offers an install link rather than a connect button when nothing is installed", () => {
    render(
      <ConnectModal
        open
        connectors={[
          {
            id: "io.metamask.install",
            name: "MetaMask",
            icon: null,
            recommended: true,
            detected: false,
            kind: "install" as const,
            installUrl: "https://metamask.io/download/",
            provider: null,
            connect: () => Promise.reject(new Error("not installed")),
            disconnect: () => Promise.resolve(),
          },
        ]}
        connectingId={null}
        error={null}
        onConnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", {name: /MetaMask/})).toHaveAttribute(
      "href",
      "https://metamask.io/download/",
    );
  });
});

describe("DataFreshness and TxStepper", () => {
  it("labels a head-pinned snapshot as provisional", () => {
    render(
      <DataFreshness
        snapshot={{
          chainId: 97n,
          blockNumber: 42n,
          blockHash: `0x${"11".repeat(32)}`,
          timestamp: 1_000n,
          confidence: {tag: "latest", depth: 0n},
          value: null,
        }}
        nowSeconds={1_030n}
      />,
    );
    expect(screen.getByText("Block 42")).toBeInTheDocument();
    expect(screen.getByText(en.data.confidenceLatest)).toBeInTheDocument();
  });

  it("shows nothing as confirmed before the machine says confirmed", () => {
    const included: TxState = {
      ...IDLE_TX_STATE,
      phase: "included",
      hash: `0x${"ab".repeat(32)}`,
      blockNumber: 500n,
      provisional: true,
      steps: [
        {name: "preview", at: 1_000, hash: null},
        {name: "walletConfirmation", at: 2_000, hash: null},
        {name: "submitted", at: 3_000, hash: `0x${"ab".repeat(32)}`},
        {name: "included", at: 4_000, hash: `0x${"ab".repeat(32)}`},
      ],
    };
    render(<TxStepper state={included} chain={CHAIN} />);
    expect(screen.getByText(en.tx.provisional)).toBeInTheDocument();
    expect(screen.getByText(en.tx.stateIncluded)).toBeInTheDocument();
    expect(screen.getAllByRole("link", {name: en.app.openInExplorer}).length).toBeGreaterThan(0);
  });

  it("announces progress politely and failures assertively", () => {
    const failed: TxState = {
      ...IDLE_TX_STATE,
      phase: "reverted",
      failure: {
        catalogKey: "EntryWindowClosed",
        message: "This round has closed.",
        funds: "Nothing debited",
        nextAction: "Link to the current round",
        selector: null,
        data: null,
      },
    };
    const {rerender} = render(<TxLiveRegion state={{...IDLE_TX_STATE, phase: "submitted"}} />);
    expect(screen.getByRole("status")).toHaveTextContent(en.tx.stateSubmitted);
    expect(screen.getByRole("alert")).toHaveTextContent("");

    rerender(<TxLiveRegion state={failed} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This round has closed.");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
