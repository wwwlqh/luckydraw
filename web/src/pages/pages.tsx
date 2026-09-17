// The routed pages of this wave.
//
// `/`, `/round/:chainId/:roundId`, `/wallet` and `/entries` are the real pages; `/verify` and `/help` are
// minimal static pages carrying the SPEC §9.2 trust statements, the
// official-domain phishing line (a placeholder until the domain is published) and the tested-wallet list.

import type {ContractRecord} from "@luckydraw/client";
import {lazy} from "react";
import {Card, CopyButton, Disclosures, JurisdictionNotice} from "../components/index.ts";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {explorerAddressUrl, explorerBlockUrl} from "../lib/deployment/provider.ts";
import type {ChainRecord} from "../lib/deployment/records.ts";
import {credit} from "../lib/rounds/format.ts";
import {en} from "../strings/en.ts";
import Home from "./Home.tsx";

// `/`, `/round/:chainId/:roundId`, `/wallet` and `/entries` are real pages now; the router keeps importing
// them from here, so adding one is a single line and the route table never changes.
// `/` stays in the entry chunk (it is the landing page); the other three pages load on first visit so the
// initial JavaScript for `/` stays inside the SPEC section 9.3 budget (250 kB gzipped).
export const HomePage = Home;
export const RoundPage = lazy(() => import("./Round.tsx"));
export const WalletPage = lazy(() => import("./Wallet.tsx"));
export const EntriesPage = lazy(() => import("./Entries.tsx"));

export function NotFoundPage() {
  return (
    <>
      <h1>{en.pages.notFound.title}</h1>
      <p className="muted">{en.pages.notFound.body}</p>
    </>
  );
}

/**
 * One contract as the manifest records it: address, code hash and deploy block, each copyable, with the
 * explorer links the chain record can build (SPEC §9.2, §12).
 *
 * Every value comes from the manifest that was compiled into this bundle, never from the chain and never
 * from a network fetch, which is the whole point of the page: what the reader compares against BscScan is
 * what this build actually signs against.
 */
function ContractFacts({
  heading,
  contract,
  chain,
}: {
  heading: string;
  contract: ContractRecord;
  chain: ChainRecord;
}) {
  const verify = en.pages.verify;
  const addressUrl = explorerAddressUrl(chain, contract.address);
  const blockUrl = explorerBlockUrl(chain, contract.deployBlock);
  return (
    <section aria-label={heading}>
      <p className="card__title">{heading}</p>
      <dl className="definition-list">
        <dt>{verify.addressLabel}</dt>
        <dd>
          <span className="mono">{contract.address}</span>{" "}
          <CopyButton value={contract.address} field={`${heading} ${verify.addressLabel}`} />
          {addressUrl === null ? null : (
            <>
              {" "}
              <a href={addressUrl} rel="noreferrer noopener" target="_blank">
                {verify.explorerAddress}
              </a>
            </>
          )}
        </dd>
        <dt>{verify.codeHashLabel}</dt>
        <dd>
          <span className="mono">{contract.codeHash}</span>{" "}
          <CopyButton value={contract.codeHash} field={`${heading} ${verify.codeHashLabel}`} />
        </dd>
        <dt>{verify.deployBlockLabel}</dt>
        <dd>
          <span className="amount">{contract.deployBlock.toString()}</span>{" "}
          <CopyButton
            value={contract.deployBlock.toString()}
            field={`${heading} ${verify.deployBlockLabel}`}
          />
          {blockUrl === null ? null : (
            <>
              {" "}
              <a href={blockUrl} rel="noreferrer noopener" target="_blank">
                {verify.explorerBlock}
              </a>
            </>
          )}
        </dd>
      </dl>
    </section>
  );
}

export function VerifyPage() {
  const {manifest, chain, verified, verifyFailureText} = useDeployment();
  const verify = en.pages.verify;
  const fields = verify.fields;
  const {makeWholeReserve, makeWholeCap} = manifest.ownership;
  return (
    <>
      <h1>{verify.title}</h1>
      <p className="muted">{verify.intro}</p>
      <JurisdictionNotice />

      <Card title={verify.deploymentHeading}>
        <dl className="definition-list">
          <dt>{fields.deploymentId}</dt>
          <dd className="mono">{manifest.deploymentId}</dd>
          <dt>{fields.environment}</dt>
          <dd>{manifest.environment}</dd>
          <dt>{fields.chain}</dt>
          <dd>
            {chain.name} <span className="amount">({chain.chainId.toString()})</span>
          </dd>
          <dt>{fields.compiler}</dt>
          <dd>
            solc {manifest.toolchain.solc}, {manifest.toolchain.evmVersion}, optimizer runs{" "}
            <span className="amount">{manifest.toolchain.optimizerRuns.toString()}</span>
          </dd>
          <dt>{fields.checks}</dt>
          <dd>
            {verified === null
              ? (verifyFailureText ?? en.gate.verifying)
              : verified.checks.map((check) => check.name).join(", ")}
          </dd>
        </dl>
      </Card>

      <Card title={verify.contractsHeading}>
        <p className="small muted">{verify.contractsIntro}</p>
        <ContractFacts heading={verify.drawHeading} contract={manifest.contracts.draw} chain={chain} />
        <ContractFacts heading={verify.vaultHeading} contract={manifest.contracts.vault} chain={chain} />
        {chain.explorerUrl === null ? <p className="small muted">{en.app.explorerUnavailable}</p> : null}
      </Card>

      {/* SPEC §14 mainnet row: the seed account and the make-whole reserve are published on Verify. */}
      <Card title={verify.makeWholeHeading}>
        <dl className="definition-list">
          <dt>{verify.makeWholeReserve}</dt>
          <dd className="amount">
            {makeWholeReserve === null
              ? verify.notRecorded
              : credit(makeWholeReserve, 18, chain.nativeSymbol)}
          </dd>
          <dt>{verify.makeWholeCap}</dt>
          <dd className="amount">
            {makeWholeCap === null ? verify.notRecorded : credit(makeWholeCap, 18, chain.nativeSymbol)}
          </dd>
        </dl>
        <p className="small">{en.limits.makeWhole}</p>
      </Card>

      <Card title={verify.trustHeading}>
        <ul>
          {verify.trust.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>

      <Disclosures />

      <Card title={verify.domainHeading}>
        <p>{verify.domainPlaceholder}</p>
      </Card>

      <Card title={verify.walletsHeading}>
        <p>{verify.walletsBody}</p>
      </Card>
    </>
  );
}

export function HelpPage() {
  return (
    <>
      <h1>{en.pages.help.title}</h1>
      <p className="muted">{en.pages.help.intro}</p>
      <JurisdictionNotice />
      {en.pages.help.sections.map((section) => (
        <Card key={section.heading} title={section.heading}>
          <p>{section.body}</p>
        </Card>
      ))}
      {/* SPEC §14: the app states the same limitations as the contracts, on the page people are sent to. */}
      <Disclosures />
      <Card title={en.pages.verify.domainHeading}>
        <p>{en.pages.verify.domainPlaceholder}</p>
      </Card>
      <Card title={en.pages.verify.walletsHeading}>
        <p>{en.pages.verify.walletsBody}</p>
      </Card>
    </>
  );
}
