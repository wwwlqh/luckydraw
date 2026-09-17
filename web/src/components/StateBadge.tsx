// State and asset badges (SPEC §9.3).
//
// "Never convey state by color alone: pair it with an icon and a label." Every badge below therefore renders
// a glyph and a text label; the colour is the third signal, never the first. The glyphs are text characters,
// not images, so nothing is fetched and nothing depends on a font that may not load.
//
// `AssetBadge` reads the symbol and decimals from the pinned deployment manifest and nothing else: §9.3,
// "Asset badges (icon, symbol, chain) come from the pinned deployment manifest. No runtime fetch of logos or
// metadata from third parties."

import type {ManifestAsset} from "@luckydraw/client";

export type StateTone = "neutral" | "accent" | "positive" | "negative" | "pending" | "info";

const GLYPHS: Readonly<Record<StateTone, string>> = {
  neutral: "•",
  accent: "★",
  positive: "✓",
  negative: "✕",
  pending: "◷",
  info: "ℹ",
};

export type StateBadgeProps = {
  tone: StateTone;
  label: string;
  /** Overrides the default glyph for the tone. */
  glyph?: string;
  /** Extra context announced with the label, for example the round state's message. */
  title?: string;
};

export function StateBadge({tone, label, glyph, title}: StateBadgeProps) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      <span className="badge__glyph" aria-hidden="true">
        {glyph ?? GLYPHS[tone]}
      </span>
      <span>{label}</span>
    </span>
  );
}

export type AssetBadgeProps = {
  asset: Pick<ManifestAsset, "symbol" | "name" | "native">;
  /** Shows the asset's full name next to the symbol. */
  showName?: boolean;
};

export function AssetBadge({asset, showName = false}: AssetBadgeProps) {
  return (
    <span className="asset-badge">
      <span className="asset-badge__mark" aria-hidden="true">
        {asset.symbol.slice(0, 3).toUpperCase()}
      </span>
      <span className="asset-badge__symbol">{asset.symbol}</span>
      {showName ? <span className="small muted">{asset.name}</span> : null}
    </span>
  );
}
