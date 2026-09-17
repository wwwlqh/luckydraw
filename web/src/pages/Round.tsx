// `/round/:chainId/:roundId` (SPEC §9.4, §9.5, §9.6).
//
// This file is wiring only: the route parameters, four block-keyed snapshots, the two transactions the page
// owns and the two callbacks the entry panel needs. Everything it renders lives in `components/rounds/`, and
// every derivation lives in `lib/rounds/`, so the §9.6 state table is tested without a router or a node.
//
// The chain id in the path is checked before anything is read: a link built for another deployment is
// refused with the two chains named, never quietly answered with this deployment's round of the same number.

import {
  type Address,
  type EntryPanel as EntryPanelData,
  type PreparedWrite,
  type Range,
  readEntryPanel,
  readFeed,
  type Snapshot,
  ZERO_ADDRESS,
} from "@luckydraw/client";
import {useCallback, useMemo} from "react";
import {useParams} from "react-router";
import {Card, DataFreshness, ErrorState, Skeleton} from "../components/index.ts";
import {EntryPanel} from "../components/rounds/EntryPanel.tsx";
import {RoundDetail} from "../components/rounds/RoundDetail.tsx";
import {useSnapshot} from "../lib/data/useSnapshot.ts";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {useChainNow} from "../lib/rounds/clock.ts";
import {lifecycleOf, nativeReferenceOf, priceStateOf} from "../lib/rounds/derive.ts";
import {estimateNetworkFee} from "../lib/rounds/gas.ts";
import {readRoundPage, readRoundPosition, readRoundRanges} from "../lib/rounds/round.ts";
import {useTransaction} from "../lib/tx/useTransaction.tsx";
import {useWallet} from "../lib/wallet/WalletProvider.tsx";
import {en, fill} from "../strings/en.ts";
import {rounds} from "../strings/rounds.ts";

/** A round with no ranges: the tables show "no entry has been recorded yet" instead of a loading line. */
const EMPTY_RANGES: readonly Range[] = [];

/** A positive whole number, or null. A round id is a uint256 and nothing else (SPEC §8.1). */
function parseRoundId(text: string): bigint | null {
  if (!/^[0-9]+$/.test(text)) return null;
  const value = BigInt(text);
  return value > 0n ? value : null;
}

export default function Round() {
  const params = useParams<{chainId: string; roundId: string}>();
  const {manifest, chain, provider, readCtx} = useDeployment();
  const wallet = useWallet();
  const account: Address | null = wallet.account;

  const roundId = parseRoundId(params.roundId ?? "");
  const linkChain = params.chainId ?? "";
  const chainMatches = /^[0-9]+$/.test(linkChain) && BigInt(linkChain) === chain.chainId;

  const enabled = roundId !== null && chainMatches;
  const page = useSnapshot("round", (ctx) => readRoundPage(ctx, roundId as bigint), {
    enabled,
    deps: [roundId?.toString() ?? "none"],
  });
  const now = useChainNow(page.snapshot);

  const position = useSnapshot(
    "round:position",
    (ctx) => readRoundPosition(ctx, roundId as bigint, account as Address),
    {
      enabled: enabled && account !== null,
      deps: [roundId?.toString() ?? "none", account ?? "none", wallet.accountEpoch],
    },
  );

  const rangeCount = page.value?.round.rangeCount ?? 0n;
  const ranges = useSnapshot("round:ranges", (ctx) => readRoundRanges(ctx, roundId as bigint), {
    enabled: enabled && rangeCount > 0n,
    deps: [roundId?.toString() ?? "none", rangeCount.toString()],
  });

  const buyer = account ?? ZERO_ADDRESS;
  // An action read: the quote must come from the head, not the epoch's display block (SPEC §9.6), so it
  // opts out of the shared block pin. The page's other reads share one block for the freshness label.
  const panel = useSnapshot("round:entry", (ctx) => readEntryPanel(ctx, roundId as bigint, buyer, 0n), {
    enabled,
    deps: [roundId?.toString() ?? "none", buyer, wallet.accountEpoch],
    pinBlock: false,
  });
  // The panel's own clock. Its read opts out of the shared pin, so its quote, its balance and its feed come
  // from the head while the rest of the page shows the display block. A panel that judged price age, the
  // remaining time and its plan's expiry by the display clock would mix two blocks in one disclosure
  // (SPEC §10.1: related reads share one blockTag) and could, at the display block's lag, call an observation
  // fresh that the chain would already reject. One snapshot, one clock, for each of them.
  const panelNow = useChainNow(panel.snapshot);

  // The native asset's own feed, so the gas estimate can be shown in USD as well (SPEC §9.5).
  const nativeAsset = useMemo(() => manifest.assets.find((asset) => asset.native) ?? null, [manifest.assets]);
  const nativeFeedAddress = nativeAsset?.price.feed ?? null;
  const nativeFeed = useSnapshot("round:nativeFeed", (ctx) => readFeed(ctx, nativeFeedAddress as Address), {
    enabled: nativeFeedAddress !== null,
    deps: [nativeFeedAddress ?? "none"],
  });

  const entryTx = useTransaction();
  const lifecycleTx = useTransaction({resume: false});

  const readFresh = useCallback(
    async (gross: bigint): Promise<Snapshot<EntryPanelData>> => {
      if (readCtx === null || roundId === null || account === null) {
        throw new Error(en.gate.verifying);
      }
      return readEntryPanel(readCtx, roundId, account, gross);
    },
    [readCtx, roundId, account],
  );

  const estimateFee = useCallback(
    (prepared: PreparedWrite, from: Address) =>
      estimateNetworkFee(provider, {from, to: prepared.to, data: prepared.data, value: prepared.value}),
    [provider],
  );

  if (roundId === null) {
    return <ErrorState title={rounds.round.notFound} body={rounds.round.invalidId} />;
  }
  if (!chainMatches) {
    return (
      <ErrorState
        title={rounds.round.wrongChainTitle}
        body={fill(rounds.round.wrongChain, {
          linkChain,
          deploymentChain: chain.chainId.toString(),
          chainName: chain.displayName,
        })}
        funds={fill(en.tx.funds, {funds: "No change"})}
      />
    );
  }

  if (page.value === null) {
    return (
      <Card title={fill(rounds.round.title, {roundId: roundId.toString()})}>
        {page.status === "error" && page.error !== null ? (
          <ErrorState body={page.error.message} onRetry={page.refresh} />
        ) : (
          <Skeleton height="6rem" label={rounds.round.loading} />
        )}
      </Card>
    );
  }

  const data = page.value;
  const price = priceStateOf(data.round, data.feed, now);
  const asset = manifest.assets.find((entry) => entry.asset === data.round.asset) ?? null;
  const lifecycle = lifecycleOf(data.round, now, {
    hasPosition: position.value !== null && position.value.gross > 0n,
    refunded: position.value?.refunded === true,
  });

  // The native feed is classified exactly as the round's feed is, against the manifest's own frozen terms for
  // that asset: a stale, clamped or decimals-changed native answer produces no reference at all, so the gas
  // line says "unavailable" instead of converting it (SPEC §9.5, §9.1 X2).
  const nativeReference =
    nativeAsset === null || nativeFeed.value === null
      ? null
      : nativeReferenceOf(nativeAsset.price, nativeFeed.value, now);

  return (
    <>
      <div className="page-heading">
        <span />
        <DataFreshness snapshot={page.snapshot} {...(now === 0n ? {} : {nowSeconds: now})} />
      </div>
      <RoundDetail
        data={data}
        price={price}
        now={now}
        account={account}
        position={position.value}
        asset={asset}
        // A round with no entry yet has nothing to page, so the tables show their empty state rather
        // than waiting for a read that is deliberately not run.
        ranges={rangeCount === 0n ? EMPTY_RANGES : ranges.value}
        rangesError={ranges.status === "error" && ranges.error !== null ? ranges.error.message : null}
        lifecycleTx={lifecycleTx}
        chainId={chain.chainId}
        explorerUrl={chain.explorerUrl}
        drawAddress={manifest.contracts.draw.address}
        entryPanel={
          lifecycle.action === "enter" && panel.value !== null ? (
            <EntryPanel
              panel={panel.value}
              now={panelNow}
              account={account}
              asset={asset}
              price={priceStateOf(panel.value.round, panel.value.feed, panelNow)}
              refresh={panel.refresh}
              readFresh={readFresh}
              estimateFee={estimateFee}
              nativeReference={nativeReference}
              nativeSymbol={chain.nativeSymbol}
              tx={entryTx}
              successorRoundId={data.currentRoundId}
              chainId={chain.chainId}
            />
          ) : undefined
        }
      />
    </>
  );
}
