// The two things `/` remembers locally (SPEC §9.4): whether the "How it works" steps were dismissed, and the
// asset and tier filter chips.
//
// Local storage only, and only these two facts: no key, no signature, no address and no amount ever reaches
// it (SPEC §9.6 "local storage contains no keys or signatures", §9.7 privacy). Every read and write is
// wrapped, because a browser with storage disabled must still render the page.

import type {Address, Kind} from "@luckydraw/client";
import {useCallback, useState} from "react";
import type {CardFilter} from "./list.ts";

const FILTER_KEY = "luckydraw.pools.filter.v1";
const HOW_IT_WORKS_KEY = "luckydraw.pools.howItWorks.v1";

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A browser with storage disabled keeps working; only the memory of the choice is lost.
  }
}

/** Parses the stored filter defensively: anything unexpected becomes "no filter", never a crash. */
export function parseFilter(raw: string | null): CardFilter {
  if (raw === null) return {assets: [], kinds: []};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {assets: [], kinds: []};
    const record = parsed as {assets?: unknown; kinds?: unknown};
    const assets = Array.isArray(record.assets)
      ? record.assets.filter(
          (value): value is Address => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value),
        )
      : [];
    const kinds = Array.isArray(record.kinds)
      ? record.kinds.filter(
          (value): value is Kind =>
            Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6,
        )
      : [];
    return {assets, kinds};
  } catch {
    return {assets: [], kinds: []};
  }
}

export function serializeFilter(filter: CardFilter): string {
  return JSON.stringify({assets: filter.assets, kinds: filter.kinds});
}

/** The filter chips of SPEC §9.4, persisted locally. */
export function useStoredFilter(): {filter: CardFilter; setFilter: (next: CardFilter) => void} {
  const [filter, setState] = useState<CardFilter>(() => parseFilter(readLocal(FILTER_KEY)));
  const setFilter = useCallback((next: CardFilter) => {
    setState(next);
    writeLocal(FILTER_KEY, serializeFilter(next));
  }, []);
  return {filter, setFilter};
}

/** The first-visit "How it works" steps: shown until dismissed, and the dismissal is remembered. */
export function useHowItWorks(): {shown: boolean; dismiss: () => void} {
  const [shown, setShown] = useState(() => readLocal(HOW_IT_WORKS_KEY) !== "dismissed");
  const dismiss = useCallback(() => {
    setShown(false);
    writeLocal(HOW_IT_WORKS_KEY, "dismissed");
  }, []);
  return {shown, dismiss};
}

/** Toggles one value in a filter list, so a chip is a plain add/remove. */
export function toggleValue<T>(values: readonly T[], value: T): readonly T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}
