// `/verify` and `/help` (SPEC §9.2, §12, §14).
//
// The Verify assertions are about provenance: every address, code hash and deploy block on the page is the
// one in the manifest this build was compiled against, each of them copyable, and each explorer link built
// from the chain record's own `explorerUrl` rather than from a name hard-coded in the app.

import {screen, within} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import type {DeploymentBase} from "../lib/deployment/DeploymentProvider.tsx";
import type {ChainRecord} from "../lib/deployment/records.ts";
import {en, fill} from "../strings/en.ts";
import {renderWithProviders, testDeploymentBase} from "../test/harness.tsx";
import {HelpPage, VerifyPage} from "./pages.tsx";

const NOTICE = "LuckyDraw is not offered to residents of Examplestan.";

function baseWith(options: {explorerUrl?: string | null; notice?: string} = {}): DeploymentBase {
  const base = testDeploymentBase();
  const chain: ChainRecord = {
    ...base.chain,
    explorerUrl: options.explorerUrl === undefined ? "https://bscscan.com" : options.explorerUrl,
  };
  return {...base, chain, env: {...base.env, jurisdictionNotice: options.notice ?? NOTICE}};
}

const verify = en.pages.verify;

describe("VerifyPage contracts card", () => {
  it("shows the Draw and Vault addresses, code hashes and deploy blocks from the manifest", () => {
    const base = baseWith();
    renderWithProviders(<VerifyPage />, {base});
    for (const [heading, contract] of [
      [verify.drawHeading, base.manifest.contracts.draw],
      [verify.vaultHeading, base.manifest.contracts.vault],
    ] as const) {
      const section = screen.getByRole("region", {name: heading});
      expect(within(section).getByText(contract.address)).toBeInTheDocument();
      expect(within(section).getByText(contract.codeHash)).toBeInTheDocument();
      expect(within(section).getByText(contract.deployBlock.toString())).toBeInTheDocument();
    }
  });

  it("gives every one of those six values its own named copy button", () => {
    const base = baseWith();
    renderWithProviders(<VerifyPage />, {base});
    for (const heading of [verify.drawHeading, verify.vaultHeading]) {
      const section = screen.getByRole("region", {name: heading});
      for (const field of [verify.addressLabel, verify.codeHashLabel, verify.deployBlockLabel]) {
        const label = fill(verify.copyField, {field: `${heading} ${field}`});
        expect(within(section).getByRole("button", {name: label})).toBeInTheDocument();
      }
    }
  });

  it("builds the explorer links from the chain record's explorerUrl", () => {
    const base = baseWith({explorerUrl: "https://explorer.example/"});
    renderWithProviders(<VerifyPage />, {base});
    const draw = screen.getByRole("region", {name: verify.drawHeading});
    expect(within(draw).getByRole("link", {name: verify.explorerAddress})).toHaveAttribute(
      "href",
      `https://explorer.example/address/${base.manifest.contracts.draw.address}`,
    );
    expect(within(draw).getByRole("link", {name: verify.explorerBlock})).toHaveAttribute(
      "href",
      `https://explorer.example/block/${base.manifest.contracts.draw.deployBlock.toString()}`,
    );
  });

  it("offers no explorer link, and says why, on a chain record that has none", () => {
    renderWithProviders(<VerifyPage />, {base: baseWith({explorerUrl: null})});
    const draw = screen.getByRole("region", {name: verify.drawHeading});
    expect(within(draw).queryByRole("link")).toBeNull();
    expect(screen.getByText(en.app.explorerUnavailable)).toBeInTheDocument();
  });
});

describe("VerifyPage, the rest of it", () => {
  it("keeps the verification status display", () => {
    renderWithProviders(<VerifyPage />, {base: baseWith()});
    // Before the fake node answers, the checks row carries the "checking this deployment" line.
    expect(screen.getByText(verify.fields.checks)).toBeInTheDocument();
    expect(screen.getByText(en.gate.verifying)).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: verify.trustHeading})).toBeInTheDocument();
  });

  it("publishes the make-whole reserve and cap, and says when they are not recorded", () => {
    renderWithProviders(<VerifyPage />, {base: baseWith()});
    expect(screen.getByRole("heading", {name: verify.makeWholeHeading})).toBeInTheDocument();
    expect(screen.getByText(verify.makeWholeReserve)).toBeInTheDocument();
    expect(screen.getByText(verify.makeWholeCap)).toBeInTheDocument();
    // The committed local manifest records neither, which is what a deployment before funding looks like.
    expect(screen.getAllByText(verify.notRecorded)).toHaveLength(2);
  });

  it("states the limitations and the jurisdiction sentence exactly once each", () => {
    renderWithProviders(<VerifyPage />, {base: baseWith()});
    expect(screen.getByRole("heading", {name: en.limits.heading})).toBeInTheDocument();
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
  });
});

describe("HelpPage", () => {
  it("states the limitations and the jurisdiction sentence exactly once each", () => {
    renderWithProviders(<HelpPage />, {base: baseWith()});
    expect(screen.getByRole("heading", {name: en.limits.heading})).toBeInTheDocument();
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
    const list = screen.getByRole("list");
    expect(list.textContent).toContain("3% of every entry is deducted");
    expect(list.textContent).toContain("pause new entries at any time");
  });

  it("keeps its existing articles", () => {
    renderWithProviders(<HelpPage />, {base: baseWith()});
    for (const section of en.pages.help.sections) {
      expect(screen.getByRole("heading", {name: section.heading})).toBeInTheDocument();
    }
  });

  it("omits the jurisdiction block on a build that has no sentence", () => {
    renderWithProviders(<HelpPage />, {base: baseWith({notice: ""})});
    expect(screen.queryByRole("note", {name: en.jurisdiction.label})).toBeNull();
    // The limitations are not conditional on it.
    expect(screen.getByRole("heading", {name: en.limits.heading})).toBeInTheDocument();
  });
});
