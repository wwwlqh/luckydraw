// Withdrawal: no minimum, the fixed destination, and the contract-wallet warning for native BNB
// (SPEC §9.4 `/wallet` row, §9.5 last paragraph, §4.2).

import type {Address, ManifestAsset} from "@luckydraw/client";
import {act, fireEvent, screen, waitFor} from "@testing-library/react";
import {useState} from "react";
import {describe, expect, it} from "vitest";
import {useTransaction} from "../../lib/tx/useTransaction.tsx";
import {useWallet} from "../../lib/wallet/WalletProvider.tsx";
import {walletEn} from "../../strings/wallet.ts";
import {
  ACCOUNT,
  type ChainScript,
  ConnectButton,
  connectTestWallet,
  type FakeChain,
  fakeChain,
  fakeTxRuntime,
  NATIVE,
  renderSurface,
  TOKEN,
} from "./testKit.tsx";
import {WithdrawPanel} from "./WithdrawPanel.tsx";

function assetOf(chain: FakeChain, address: Address): ManifestAsset {
  const asset = chain.manifest.assets.find((entry) => entry.asset === address);
  if (asset === undefined) throw new Error(`fixture has no asset ${address}`);
  return asset;
}

/** The balance the page re-reads every block, held here so a test can move it under an open preview. */
type Controls = {setBalance: (value: bigint) => void};

function Harness({
  asset,
  balance,
  hasCode,
  runtime,
  controls,
}: {
  asset: ManifestAsset;
  balance: bigint;
  hasCode: boolean;
  runtime: ReturnType<typeof fakeTxRuntime>;
  controls: Controls;
}) {
  const wallet = useWallet();
  const tx = useTransaction({runtime: runtime.runtime, resume: false});
  const [live, setBalance] = useState(balance);
  controls.setBalance = setBalance;
  if (wallet.account === null) return <p>not connected</p>;
  return (
    <WithdrawPanel
      asset={asset}
      account={wallet.account}
      vaultBalance={live}
      accountHasCode={hasCode}
      onRefresh={() => undefined}
      tx={tx}
    />
  );
}

async function mount(
  assetAddress: Address,
  options: {balance?: bigint; hasCode?: boolean; script?: ChainScript} = {},
) {
  const chain = fakeChain(options.script ?? {});
  const runtime = fakeTxRuntime();
  const controls: Controls = {setBalance: () => undefined};
  renderSurface(
    <>
      <ConnectButton />
      <Harness
        asset={assetOf(chain, assetAddress)}
        balance={options.balance ?? 1_000_000_000_000_000_000n}
        hasCode={options.hasCode ?? false}
        runtime={runtime}
        controls={controls}
      />
    </>,
    chain.base,
  );
  await connectTestWallet();
  await waitFor(() => expect(screen.getByLabelText(walletEn.withdraw.amountLabel)).toBeInTheDocument());
  return {chain, runtime, controls};
}

async function review(text: string) {
  fireEvent.change(screen.getByLabelText(walletEn.withdraw.amountLabel), {target: {value: text}});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", {name: walletEn.withdraw.review}));
  });
}

describe("WithdrawPanel", () => {
  it("shows the connected address as the only destination, read-only and copyable", async () => {
    await mount(NATIVE);

    const destination = screen.getByLabelText(walletEn.withdraw.destinationLabel);
    expect(destination.textContent).toBe(ACCOUNT);
    expect(destination.tagName).toBe("OUTPUT");
    expect(screen.getByText(walletEn.withdraw.destinationNote)).toBeInTheDocument();
    expect(screen.getByLabelText(walletEn.withdraw.copyDestination)).toBeInTheDocument();
    // There is no editable destination field anywhere on the panel: `Vault.withdraw` pays its caller only.
    expect(screen.queryByRole("textbox", {name: walletEn.withdraw.destinationLabel})).toBeNull();
  });

  it("accepts any positive representable amount, with no USD minimum", async () => {
    const {runtime} = await mount(NATIVE, {balance: 1_000_000_000_000_000_000n});
    // One wei: far below USD 1 at any price, and SPEC §9.5 allows it.
    await review("0.000000000000000001");

    expect(screen.getByText("withdraw")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {name: walletEn.withdraw.confirm}));
    });
    await waitFor(() => expect(runtime.sent).toHaveLength(1));
    expect(runtime.sent[0]?.value).toBe(0n);
    expect(runtime.sent[0]?.from).toBe(ACCOUNT);
  });

  it("refuses an amount above the available balance before anything is signed", async () => {
    const {runtime} = await mount(NATIVE, {balance: 1_000n});
    fireEvent.change(screen.getByLabelText(walletEn.withdraw.amountLabel), {target: {value: "1"}});

    expect(screen.getByText(/this withdrawal asks for/)).toBeInTheDocument();
    expect(screen.getByRole("button", {name: walletEn.withdraw.review})).toBeDisabled();
    expect(runtime.sent).toHaveLength(0);
  });

  it("warns before signing when the connected address has code and the asset is BNB", async () => {
    await mount(NATIVE, {hasCode: true});
    await review("0.5");

    expect(screen.getByText(walletEn.withdraw.contractWarningTitle)).toBeInTheDocument();
    expect(
      screen.getByText(/must accept a plain BNB transfer|does not accept a plain BNB/),
    ).toBeInTheDocument();
  });

  it("refuses the open preview when the balance falls under the amount, with no negative figure", async () => {
    const {runtime, controls} = await mount(NATIVE, {balance: 1_000_000_000_000_000_000n});
    await review("0.5");
    expect(screen.getByRole("button", {name: walletEn.withdraw.confirm})).toBeEnabled();

    // The next block credits somebody else and this balance drops below the amount already on screen.
    await act(async () => {
      controls.setBalance(100_000_000_000_000_000n);
    });

    expect(screen.getByRole("button", {name: walletEn.withdraw.confirm})).toBeDisabled();
    expect(screen.getByText(/this withdrawal asks for/)).toBeInTheDocument();
    // "Balance afterwards" says nothing rather than saying minus 0.4 BNB.
    expect(screen.queryByText(/-0.4/)).toBeNull();
    expect(runtime.sent).toHaveLength(0);
  });

  it("does not warn about plain transfers for an ERC-20, even from a contract address", async () => {
    await mount(TOKEN, {hasCode: true, balance: 10_000n});
    await review("5");

    expect(screen.queryByText(walletEn.withdraw.contractWarningTitle)).toBeNull();
  });
});
