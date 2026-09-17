// Catalog rows for every `SeedSkipReason` member (SPEC §5.4), for the keeper and admin surfaces.
//
// A seed attempt made from round creation or from the first player purchase never reverts: it emits
// SeedSkipped with a reason and the round carries on unseeded (SPEC §5.4). These rows explain that outcome
// to the operator. The public `seedRound` call reverts instead, with BuysPaused (the global or the pool's
// buy stop), SeedNotConfigured, SeedNotAuthorized, EntryWindowClosed, InsufficientSeedBalance or
// AlreadySeeded, whose rows are in `errors.ts`.
//
// Authorization is per asset (SPEC §5.4): a seed account that authorized BNB has authorized nothing in a
// token pool, so a NotAuthorized skip or revert is always about one round's asset.
//
// The app labels the seed "Operator seed" everywhere it appears (SPEC §5.4).

import {SeedSkipReasonNames} from "../types/generated.ts";
import type {CatalogEntry, SeedSkipReasonName} from "./types.ts";

export const seedSkipCatalog = {
  "SeedSkip:NotConfigured": {
    message: "The operator seed was skipped: this pool has no seed amount set.",
    funds: "Nothing debited",
    nextAction: "Set a seed amount for the pool if its rounds should be seeded",
  },
  "SeedSkip:NotAuthorized": {
    message:
      "The operator seed was skipped: the seed account has not authorized a debit this large in this round's asset.",
    funds: "Nothing debited",
    nextAction: "Raise the seed account's own authorization for this asset before the next round opens",
  },
  "SeedSkip:InsufficientSeedBalance": {
    message: "The operator seed was skipped: the seed account's available balance does not cover it.",
    funds: "Nothing debited",
    nextAction: "Top up the seed account, then seed this round again while it is open",
  },
  "SeedSkip:NotOpen": {
    message: "The operator seed was skipped: the round was no longer open before its cutoff.",
    funds: "Nothing debited",
    nextAction: "No action is needed; this round follows the normal close path without a seed",
  },
} satisfies Record<`SeedSkip:${SeedSkipReasonName}`, CatalogEntry>;

export type SeedSkipCatalogKey = keyof typeof seedSkipCatalog;

/** The catalog key for a `SeedSkipReason` ABI value, or `undefined` for a value outside the enum. */
export const seedSkipCatalogKey = (reason: bigint | number): SeedSkipCatalogKey | undefined => {
  const index = Number(reason);
  if (!Number.isInteger(index) || index < 0 || index >= SeedSkipReasonNames.length) return undefined;
  const name = SeedSkipReasonNames[index];
  return name === undefined ? undefined : (`SeedSkip:${name}` as SeedSkipCatalogKey);
};
