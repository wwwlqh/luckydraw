// The deposit flow of SPEC §9.5, end to end against a fake node: the live `Vault.getAsset` refusal, the
// allowance matrix of `depositSteps`, and the re-check when the amount changes.

import type {Address, ManifestAsset} from "@luckydraw/client";
import {act, fireEvent, screen, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {useTransaction} from "../../lib/tx/useTransaction.tsx";
import {useWallet} from "../../lib/wallet/WalletProvider.tsx";
import {walletEn} from "../../strings/wallet.ts";
import {DepositPanel} from "./DepositPanel.tsx";
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

const ONE_BNB = 1_000_000_000_000_000_000n;

function assetOf(chain: FakeChain, address: Address): ManifestAsset {
  const asset = chain.manifest.assets.find((entry) => entry.asset === address);
  if (asset === undefined) throw new Error(`fixture has no asset ${address}`);
  return asset;
}

type HarnessProps = {
  asset: ManifestAsset;
  allowance: bigint;
  runtime: ReturnType<typeof fakeTxRuntime>;
};

function Harness({asset, allowance, runtime}: HarnessProps) {
  const wallet = useWallet();
  const tx = useTransaction({runtime: runtime.runtime, resume: false});
  if (wallet.account === null) return <p>not connected</p>;
  return (
    <DepositPanel
      asset={asset}
      account={wallet.account}
      walletBalance={10n * ONE_BNB}
      vaultBalance={0n}
      allowance={allowance}
      onRefresh={() => undefined}
      tx={tx}
    />
  );
}

async function mount(script: ChainScript, assetAddress: Address, allowance = 0n) {
  const chain = fakeChain(script);
  const runtime = fakeTxRuntime();
  renderSurface(
    <>
      <ConnectButton />
      <Harness asset={assetOf(chain, assetAddress)} allowance={allowance} runtime={runtime} />
    </>,
    chain.base,
  );
  await connectTestWallet();
  await waitFor(() => expect(screen.getByLabelText(walletEn.deposit.amountLabel)).toBeInTheDocument());
  return {chain, runtime};
}

async function enterAndReview(text: string) {
  fireEvent.change(screen.getByLabelText(walletEn.deposit.amountLabel), {target: {value: text}});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", {name: walletEn.deposit.review}));
  });
}

/** The ordered step sentences the panel is showing. */
function stepTexts(): string[] {
  const list = screen.getByRole("list", {name: walletEn.deposit.stepsHeading});
  return [...list.querySelectorAll("li")].map((item) => item.textContent ?? "");
}

describe("DepositPanel", () => {
  it("deposits native BNB in a single step", async () => {
    await mount({}, NATIVE);
    await enterAndReview("1");

    const steps = stepTexts();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain("single transaction");
    expect(screen.getByText("depositNative")).toBeInTheDocument();
  });

  it("skips the approval when the existing allowance already covers the amount", async () => {
    await mount({allowances: {[TOKEN]: 5_000n}}, TOKEN, 5_000n);
    await enterAndReview("10");

    // TEST2 has 2 decimals, so "10" is 1,000 raw units and the 5,000 allowance covers it.
    expect(stepTexts()).toHaveLength(1);
    expect(screen.getByText(walletEn.deposit.approvalSkipped)).toBeInTheDocument();
    expect(screen.getByText("deposit")).toBeInTheDocument();
  });

  it("offers approve(amount) then deposit when the allowance is short and no reset is needed", async () => {
    await mount({allowances: {[TOKEN]: 100n}}, TOKEN, 100n);
    await enterAndReview("10");

    const steps = stepTexts();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain("Approve exactly");
    expect(screen.getByText("approve")).toBeInTheDocument();
    // The spender is the manifest Vault, never the Draw (SPEC §5.3, §9.5).
    expect(screen.getByText(/0x8a791620dd6260079bf849dc5567adc3f2fdc318/i)).toBeInTheDocument();
  });

  it("offers approve(0) then approve(amount) for a token flagged requiresZeroReset", async () => {
    const chain = fakeChain({allowances: {[TOKEN]: 100n}});
    const runtime = fakeTxRuntime();
    const asset = assetOf(chain, TOKEN);
    // The flag as a future manifest schema would carry it; `requiresZeroReset` reads it off the record.
    const flagged = {...asset, requiresZeroReset: true} as ManifestAsset;
    renderSurface(
      <>
        <ConnectButton />
        <Harness asset={flagged} allowance={100n} runtime={runtime} />
      </>,
      chain.base,
    );
    await connectTestWallet();
    await waitFor(() => expect(screen.getByLabelText(walletEn.deposit.amountLabel)).toBeInTheDocument());
    await enterAndReview("10");

    const steps = stepTexts();
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain(walletEn.deposit.stepApproveReset);
    expect(steps[1]).toContain("Approve exactly");
  });

  it("refuses before the prompt when the live Vault.getAsset says deposits are paused", async () => {
    await mount(
      {assetRecords: {[NATIVE]: {listed: true, tokenDecimals: 18n, depositsEnabled: false}}},
      NATIVE,
    );
    await enterAndReview("1");

    expect(screen.getByText(walletEn.deposit.refusedTitle)).toBeInTheDocument();
    expect(screen.getByText(/Deposits for this asset are paused/)).toBeInTheDocument();
    // No plan and therefore no calldata was built.
    expect(screen.queryByRole("list", {name: walletEn.deposit.stepsHeading})).toBeNull();
  });

  it("re-runs the allowance check when the amount changes", async () => {
    const {chain} = await mount({allowances: {[TOKEN]: 2_000n}}, TOKEN, 2_000n);
    await enterAndReview("10");
    expect(stepTexts()).toHaveLength(1);

    // A larger amount that the same allowance no longer covers must produce the approval step again.
    fireEvent.click(screen.getByRole("button", {name: walletEn.deposit.cancel}));
    await enterAndReview("100");
    expect(stepTexts()).toHaveLength(2);
    expect(stepTexts()[0]).toContain("Approve exactly");

    // And the re-check really went to the chain: the allowance moved under the panel between the two
    // previews and the third preview follows the chain, not the prop it was mounted with.
    chain.state.allowances[TOKEN] = 1_000_000n;
    fireEvent.click(screen.getByRole("button", {name: walletEn.deposit.cancel}));
    await enterAndReview("100");
    expect(stepTexts()).toHaveLength(1);
  });

  it("refuses when the Vault's global deposit switch is paused, before any plan exists", async () => {
    const {runtime} = await mount({depositsPaused: true}, NATIVE);
    await enterAndReview("1");

    expect(screen.getByText(walletEn.deposit.refusedTitle)).toBeInTheDocument();
    expect(screen.getByText(/Deposits for this asset are paused/)).toBeInTheDocument();
    expect(screen.queryByRole("list", {name: walletEn.deposit.stepsHeading})).toBeNull();
    expect(screen.queryByRole("button", {name: walletEn.deposit.confirm})).toBeNull();
    expect(runtime.sent).toHaveLength(0);
  });

  it("refuses to sign a step whose summary was never shown when the allowance moves", async () => {
    // At Review the allowance covers the amount, so the only step is the deposit and that is the summary
    // the user reads. The allowance is then revoked under the panel (SPEC §9.5: the check is re-run before
    // every signature), so the re-plan's first step is an approval nobody has seen.
    const {chain, runtime} = await mount({allowances: {[TOKEN]: 5_000n}}, TOKEN, 5_000n);
    await enterAndReview("10");
    expect(stepTexts()).toHaveLength(1);
    expect(screen.getByText("deposit")).toBeInTheDocument();

    chain.state.allowances[TOKEN] = 0n;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {name: walletEn.deposit.confirm}));
    });

    expect(runtime.sent).toHaveLength(0);
    expect(screen.getByText(walletEn.deposit.allowanceChanged)).toBeInTheDocument();
    // The approval the panel would now sign is the one on screen, with its own decoded summary.
    const steps = stepTexts();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain("Approve exactly");
    expect(screen.getByText("approve")).toBeInTheDocument();
  });

  // SPEC §9.6: "a decoded summary (function, round, asset, amount and, for approvals, the spender) is shown
  // before every wallet prompt". A revoke is a wallet prompt, so it is reviewed exactly like a deposit step.
  it("shows the decoded approve(0) summary before the revoke opens the wallet", async () => {
    const {runtime} = await mount({allowances: {[TOKEN]: 5_000n}}, TOKEN, 5_000n);

    fireEvent.click(screen.getByRole("button", {name: /Set the Vault allowance for TEST2 to zero/}));

    // The summary, not the wallet: the function, the token and an amount of exactly zero.
    expect(screen.getByText(walletEn.deposit.revokePreviewHeading)).toBeInTheDocument();
    expect(screen.getByText("approve")).toBeInTheDocument();
    expect(screen.getByText("0 TEST2")).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(TOKEN, "i")).length).toBeGreaterThan(0);
    // The spender is the manifest Vault and never the Draw (SPEC §9.5).
    expect(screen.getByText(/0x8a791620dd6260079bf849dc5567adc3f2fdc318/i)).toBeInTheDocument();
    expect(runtime.sent).toHaveLength(0);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {name: /Confirm setting the Vault allowance for TEST2 to zero/}),
      );
    });

    await waitFor(() => expect(runtime.sent).toHaveLength(1));
    expect(runtime.sent[0]?.to).toBe(TOKEN);
    expect(runtime.sent[0]?.from).toBe(ACCOUNT);
  });

  it("sends the first step and shows the deposit success sentence once it is included", async () => {
    const {runtime} = await mount({}, NATIVE);
    await enterAndReview("1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {name: walletEn.deposit.confirm}));
    });

    await waitFor(() => expect(runtime.sent).toHaveLength(1));
    expect(runtime.sent[0]?.value).toBe(ONE_BNB);
    expect(runtime.sent[0]?.from).toBe(ACCOUNT);
    await waitFor(() => expect(screen.getByText(walletEn.deposit.success)).toBeInTheDocument());
  });
});
