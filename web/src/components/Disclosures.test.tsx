// The SPEC §14 limitations and the operator's jurisdiction sentence, rendered.
//
// Six limitations are required by §14's last paragraph and §7.3, and each one is asserted here by its own
// distinctive words rather than by counting list items, so deleting one is a failing test and not a silently
// shorter list.

import {screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import type {DeploymentBase} from "../lib/deployment/DeploymentProvider.tsx";
import {credit} from "../lib/rounds/format.ts";
import {en} from "../strings/en.ts";
import {renderWithProviders, testDeploymentBase} from "../test/harness.tsx";
import {Disclosures, JurisdictionNotice} from "./Disclosures.tsx";

const RESERVE = 5n * 10n ** 18n;
const CAP = 20n * 10n ** 18n;
const NOTICE = "LuckyDraw is not offered to residents of Examplestan.";

function baseWith(options: {reserve?: bigint | null; cap?: bigint | null; notice?: string} = {}) {
  const base = testDeploymentBase();
  const ownership = {
    ...base.manifest.ownership,
    makeWholeReserve: options.reserve ?? null,
    makeWholeCap: options.cap ?? null,
  };
  return {
    ...base,
    manifest: {...base.manifest, ownership},
    env: {...base.env, jurisdictionNotice: options.notice ?? ""},
  } as DeploymentBase;
}

describe("Disclosures", () => {
  it("states all six limitations SPEC §14 and §7.3 require", () => {
    renderWithProviders(<Disclosures />, {base: baseWith()});
    const list = screen.getByRole("list");
    const text = list.textContent ?? "";
    // 3% deducted on entry.
    expect(text).toContain("3% of every entry is deducted");
    // Uncapped exposure: no product maximum.
    expect(text).toContain("no maximum entry and no maximum pot");
    // No cash-out outside the contract.
    expect(text).toContain("There is no cash-out");
    // The operator's seed is an entry that can win.
    expect(text).toContain("That seed is an ordinary entry");
    // The operator can pause buys.
    expect(text).toContain("pause new entries at any time");
    // Accepted-request escrow risk.
    expect(text).toContain("stays in Drawing until the oracle");
    expect(text).toContain("stays locked");
  });

  it("states the make-whole commitment with the reserve and the cap from the manifest", () => {
    renderWithProviders(<Disclosures />, {base: baseWith({reserve: RESERVE, cap: CAP})});
    const text = screen.getByRole("list").textContent ?? "";
    expect(text).toContain("Make-whole commitment");
    expect(text).toContain(credit(RESERVE, 18, "BNB"));
    expect(text).toContain(credit(CAP, 18, "BNB"));
    expect(text).not.toContain(en.limits.makeWholeUnfunded);
  });

  it("says so plainly when the manifest records no reserve or no cap", () => {
    renderWithProviders(<Disclosures />, {base: baseWith({reserve: RESERVE, cap: null})});
    expect(screen.getByRole("list").textContent).toContain("records no make-whole reserve and no cap");
  });

  it("marks the block with a word, not only a colour", () => {
    renderWithProviders(<Disclosures />, {base: baseWith()});
    expect(screen.getByText(en.limits.noticeLabel)).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: en.limits.heading})).toBeInTheDocument();
  });

  it("renders nothing of the jurisdiction sentence by itself: each page places it once", () => {
    renderWithProviders(<Disclosures />, {base: baseWith({notice: NOTICE})});
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

describe("JurisdictionNotice", () => {
  it("renders the operator's sentence with a heading a screen reader can find", () => {
    renderWithProviders(<JurisdictionNotice />, {base: baseWith({notice: NOTICE})});
    const note = screen.getByRole("note", {name: en.jurisdiction.label});
    expect(note.textContent).toContain(en.jurisdiction.heading);
    expect(note.textContent).toContain(NOTICE);
  });

  it("renders nothing when this build has no sentence", () => {
    renderWithProviders(<JurisdictionNotice />, {base: baseWith({notice: "   "})});
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(en.jurisdiction.heading)).toBeNull();
  });

  it("shows markup in the sentence literally, never as HTML", () => {
    const hostile = '<img src=x onerror="alert(1)"> <b>bold</b>';
    renderWithProviders(<JurisdictionNotice />, {base: baseWith({notice: hostile})});
    const note = screen.getByRole("note", {name: en.jurisdiction.label});
    expect(note.textContent).toContain(hostile);
    expect(note.querySelector("img")).toBeNull();
    expect(note.querySelector("b")).toBeNull();
  });
});
