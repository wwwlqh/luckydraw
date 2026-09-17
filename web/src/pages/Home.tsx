// `/` — the pools page (SPEC §9.4).
//
// The whole page is one block-keyed snapshot (`readHome`) plus one account-scoped snapshot for the connected
// account's positions, so the list re-renders only when the block hash changes (§9.3) and disconnecting drops
// the account-scoped read without touching the public one (§9.6).
//
// Loading shows skeleton cards, never a full-page spinner (§9.1 X5), and a failed read keeps the last good
// list on screen with a retry, because a stale list is more useful than an empty page (§9.1 X4).

import type {Address} from "@luckydraw/client";
import {useMemo} from "react";
import {Card, DataFreshness, ErrorState, Skeleton} from "../components/index.ts";
import {FilterChips, HowItWorks} from "../components/rounds/HowItWorks.tsx";
import {RoundCard} from "../components/rounds/RoundCard.tsx";
import {useSnapshot} from "../lib/data/useSnapshot.ts";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {useChainNow} from "../lib/rounds/clock.ts";
import {
  buildCards,
  filterCards,
  readHome,
  readHomePositions,
  sortByClosingSoonest,
} from "../lib/rounds/list.ts";
import {useHowItWorks, useStoredFilter} from "../lib/rounds/prefs.ts";
import {useWallet} from "../lib/wallet/WalletProvider.tsx";
import {en} from "../strings/en.ts";
import {rounds} from "../strings/rounds.ts";

function SkeletonCards() {
  return (
    <ul className="pool-grid">
      {[0, 1, 2].map((index) => (
        <li key={index}>
          <Card>
            <Skeleton height="1.5rem" label={rounds.home.loading} />
            <Skeleton height="0.5rem" />
            <Skeleton height="3rem" />
          </Card>
        </li>
      ))}
    </ul>
  );
}

export default function Home() {
  const {manifest, chain} = useDeployment();
  const wallet = useWallet();
  const home = useSnapshot("home", readHome);
  const now = useChainNow(home.snapshot);
  const {filter, setFilter} = useStoredFilter();
  const howItWorks = useHowItWorks();

  // Round ids the connected account might hold a position in, keyed exactly like the cards.
  const roundIds = useMemo(() => {
    const map = new Map<string, bigint>();
    for (const [key, round] of home.value?.rounds ?? []) if (round !== null) map.set(key, round.id);
    return map;
  }, [home.value]);

  const account: Address | null = wallet.account;
  const positions = useSnapshot(
    "home:positions",
    (ctx) => readHomePositions(ctx, roundIds, account as Address),
    {
      enabled: account !== null && roundIds.size > 0,
      deps: [account ?? "none", wallet.accountEpoch, [...roundIds.values()].join(",")],
    },
  );

  const cards = useMemo(() => {
    if (home.value === null) return [];
    return sortByClosingSoonest(
      buildCards({
        pools: home.value.pools,
        rounds: home.value.rounds,
        feeds: home.value.feeds,
        assets: manifest.assets,
        buysPaused: home.value.buysPaused,
        now,
        positions: positions.value ?? undefined,
      }),
    );
  }, [home.value, manifest.assets, now, positions.value]);

  const visible = useMemo(() => filterCards(cards, filter), [cards, filter]);

  return (
    <>
      <div className="page-heading">
        <h1>{rounds.home.title}</h1>
        <DataFreshness snapshot={home.snapshot} {...(now === 0n ? {} : {nowSeconds: now})} />
      </div>
      <p className="muted">{rounds.home.intro}</p>

      {/* Slot for the unclaimed-money banner of SPEC §9.4. The positions and refunds surface owns it. */}
      <div data-slot="unclaimed-banner" aria-hidden="true" />

      {howItWorks.shown ? <HowItWorks onDismiss={howItWorks.dismiss} /> : null}

      <FilterChips assets={manifest.assets} filter={filter} onChange={setFilter} />

      {home.status === "error" && home.error !== null ? (
        <ErrorState body={home.error.message} onRetry={home.refresh} retryLabel={en.app.retry} />
      ) : null}

      {home.value === null ? (
        <SkeletonCards />
      ) : visible.length === 0 ? (
        <Card title={cards.length === 0 ? rounds.home.empty : rounds.home.filters.none}>
          <p className="muted">{cards.length === 0 ? rounds.home.emptyBody : rounds.home.filters.noneBody}</p>
        </Card>
      ) : (
        <ul className="pool-grid" aria-label={rounds.home.listLabel}>
          {visible.map((card) => (
            <li key={card.key}>
              <RoundCard card={card} now={now} chainId={chain.chainId} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
