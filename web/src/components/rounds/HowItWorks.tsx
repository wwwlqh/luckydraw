// The first-visit three-step "How it works" of SPEC §9.4, and the filter chips next to it.
//
// Both remember their state locally and neither stores anything else (`lib/rounds/prefs.ts`). The chips are
// real toggle buttons with `aria-pressed`, so the filter is operable and readable with the keyboard and a
// screen reader (§9.7); an empty set means "all", which is what the "All" chip resets to.

import type {Address, Kind, ManifestAsset} from "@luckydraw/client";
import type {CardFilter} from "../../lib/rounds/list.ts";
import {toggleValue} from "../../lib/rounds/prefs.ts";
import {rounds} from "../../strings/rounds.ts";
import {Card} from "../index.ts";
import "./rounds.css";

export function HowItWorks({onDismiss}: {onDismiss: () => void}) {
  return (
    <Card
      title={rounds.home.howItWorks.title}
      aside={
        <button
          type="button"
          className="button button--ghost"
          onClick={onDismiss}
          aria-label={rounds.home.howItWorks.dismissLabel}
        >
          {rounds.home.howItWorks.dismiss}
        </button>
      }
    >
      <div className="how-it-works">
        {rounds.home.howItWorks.steps.map((step) => (
          <div key={step.heading}>
            <p className="card__title">{step.heading}</p>
            <p className="small muted">{step.body}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * The seven tier chips, grouped by cadence (ADR 036).
 *
 * One flat row of eight chips wraps to five or six lines at 375 px, which pushes the round cards below the
 * fold on a phone. Each cadence gets its own labelled row instead, so the longest row is four chips, and the
 * chip carries only the target because the row label already says the cadence. `aria-label` keeps the full
 * "Daily · USD 100" wording for a screen reader, which reads the chip out of its visual row.
 */
const KIND_GROUPS: readonly {
  readonly cadence: string;
  readonly chips: readonly {readonly kind: Kind; readonly label: string; readonly fullLabel: string}[];
}[] = [
  {
    cadence: rounds.home.filters.cadenceLabels.day,
    chips: [
      {kind: 0, label: rounds.home.filters.tierTargets.Day100, fullLabel: rounds.card.kinds.Day100},
      {kind: 1, label: rounds.home.filters.tierTargets.Day1k, fullLabel: rounds.card.kinds.Day1k},
      {kind: 2, label: rounds.home.filters.tierTargets.Day10k, fullLabel: rounds.card.kinds.Day10k},
    ],
  },
  {
    cadence: rounds.home.filters.cadenceLabels.week,
    chips: [
      {kind: 3, label: rounds.home.filters.tierTargets.Week1k, fullLabel: rounds.card.kinds.Week1k},
      {kind: 4, label: rounds.home.filters.tierTargets.Week10k, fullLabel: rounds.card.kinds.Week10k},
      {kind: 5, label: rounds.home.filters.tierTargets.Week100k, fullLabel: rounds.card.kinds.Week100k},
    ],
  },
  {
    cadence: rounds.home.filters.cadenceLabels.month,
    chips: [
      {kind: 6, label: rounds.home.filters.tierTargets.Month100k, fullLabel: rounds.card.kinds.Month100k},
    ],
  },
];

export type FilterChipsProps = {
  assets: readonly ManifestAsset[];
  filter: CardFilter;
  onChange: (next: CardFilter) => void;
};

function Chip({
  label,
  ariaLabel,
  pressed,
  onClick,
}: {
  label: string;
  ariaLabel?: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={pressed ? "button button--primary" : "button button--secondary"}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function FilterChips({assets, filter, onChange}: FilterChipsProps) {
  const setAssets = (asset: Address): void =>
    onChange({assets: toggleValue(filter.assets, asset), kinds: filter.kinds});
  const setKinds = (kind: Kind): void =>
    onChange({assets: filter.assets, kinds: toggleValue(filter.kinds, kind)});

  return (
    <section aria-label={rounds.home.filters.label}>
      <div className="chip-row">
        <span className="small muted">{rounds.home.filters.assetLabel}</span>
        <Chip
          label={rounds.home.filters.all}
          pressed={filter.assets.length === 0}
          onClick={() => onChange({assets: [], kinds: filter.kinds})}
        />
        {assets.map((asset) => (
          <Chip
            key={asset.asset}
            label={asset.symbol}
            pressed={filter.assets.includes(asset.asset)}
            onClick={() => setAssets(asset.asset)}
          />
        ))}
      </div>
      <div className="chip-row">
        <span className="small muted">{rounds.home.filters.tierLabel}</span>
        <Chip
          label={rounds.home.filters.all}
          pressed={filter.kinds.length === 0}
          onClick={() => onChange({assets: filter.assets, kinds: []})}
        />
      </div>
      {KIND_GROUPS.map((group) => (
        <div className="chip-row" key={group.cadence}>
          <span className="small muted">{group.cadence}</span>
          {group.chips.map((chip) => (
            <Chip
              key={chip.kind}
              label={chip.label}
              ariaLabel={chip.fullLabel}
              pressed={filter.kinds.includes(chip.kind)}
              onClick={() => setKinds(chip.kind)}
            />
          ))}
        </div>
      ))}
    </section>
  );
}
