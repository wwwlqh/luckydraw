// The shared body of the placeholder pages of this wave.
//
// A placeholder still exercises the whole pipeline on purpose: it reads the verified deployment, runs one
// block-keyed snapshot through a client adapter and renders its freshness. If any of that were broken, these
// pages would show it now rather than when the page builders arrive.

import {readPools} from "@luckydraw/client";
import type {ReactNode} from "react";
import {Card, DataFreshness, ErrorState, Skeleton} from "../components/index.ts";
import {useSnapshot} from "../lib/data/useSnapshot.ts";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {en} from "../strings/en.ts";

/** One live read, so the placeholder proves the deployment, provider, snapshot and cache path all work. */
export function DeploymentProbe() {
  const {manifest, status, verifyFailureText, retryVerification} = useDeployment();
  const pools = useSnapshot("pools:first-page", (ctx) => readPools(ctx, 0n, 5n));

  if (status === "verifying") return <Skeleton height="4rem" label={en.gate.verifying} />;
  if (status === "failed") {
    return (
      <ErrorState
        title={en.gate.verifyFailedTitle}
        body={verifyFailureText ?? en.error.body}
        onRetry={retryVerification}
        retryLabel={en.gate.recheck}
      />
    );
  }

  return (
    <Card title={manifest.deploymentId} aside={<DataFreshness snapshot={pools.snapshot} />}>
      {pools.status === "error" && pools.error !== null ? (
        <ErrorState body={pools.error.message} onRetry={pools.refresh} />
      ) : null}
      <dl className="definition-list">
        <dt>Pools in this deployment</dt>
        <dd className="amount">
          {pools.value === null ? <Skeleton width="4rem" /> : pools.value.page.length}
        </dd>
        <dt>Listed assets in the manifest</dt>
        <dd className="amount">{manifest.assets.length}</dd>
      </dl>
    </Card>
  );
}

export function PlaceholderPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="page-heading">
        <h1>{title}</h1>
      </div>
      {intro === undefined ? null : <p className="muted">{intro}</p>}
      <p className="notice notice--info small">{en.pages.placeholderNote}</p>
      <DeploymentProbe />
      {children}
    </>
  );
}
