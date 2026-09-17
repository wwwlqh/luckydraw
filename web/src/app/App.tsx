// Provider composition and the router (SPEC §9.4).
//
// The order is the dependency order and cannot be shuffled: the theme owns only the document attribute; the
// deployment owns the manifest, the provider and the verification result; the block poller needs that
// provider; the wallet needs the deployment's chain to build its network-guard parameters.

import {type ReactNode, Suspense, useMemo} from "react";
import {BrowserRouter, Route, Routes} from "react-router";
import {Skeleton} from "../components/index.ts";
import {BlockProvider} from "../lib/data/BlockProvider.tsx";
import {
  type DeploymentBase,
  DeploymentProvider,
  useDeployment,
} from "../lib/deployment/DeploymentProvider.tsx";
import {ThemeProvider} from "../lib/theme/ThemeProvider.tsx";
import type {ConnectorEnvironment} from "../lib/wallet/connectors.ts";
import {WalletProvider, type WalletTarget} from "../lib/wallet/WalletProvider.tsx";
import {
  EntriesPage,
  HelpPage,
  HomePage,
  NotFoundPage,
  RoundPage,
  VerifyPage,
  WalletPage,
} from "../pages/pages.tsx";
import {AppShell} from "./AppShell.tsx";
import {ErrorBoundary} from "./ErrorBoundary.tsx";

function DeploymentScoped({
  children,
  walletEnvironment,
}: {
  children: ReactNode;
  walletEnvironment?: ConnectorEnvironment | undefined;
}) {
  const {chain, env, provider, status} = useDeployment();
  const target = useMemo<WalletTarget>(
    () => ({
      chainId: chain.chainId,
      chainName: chain.displayName,
      nativeSymbol: chain.nativeSymbol,
      rpcUrls: env.rpcUrls,
      explorerUrl: chain.explorerUrl,
    }),
    [chain, env],
  );
  return (
    <BlockProvider provider={status === "failed" ? null : provider} pollMs={env.blockPollMs}>
      {walletEnvironment === undefined ? (
        <WalletProvider target={target}>{children}</WalletProvider>
      ) : (
        <WalletProvider target={target} environment={walletEnvironment}>
          {children}
        </WalletProvider>
      )}
    </BlockProvider>
  );
}

/** Every provider the app needs, in order. Exported so tests can mount a subtree with a fake base. */
export function AppProviders({
  children,
  base,
  walletEnvironment,
}: {
  children: ReactNode;
  base?: DeploymentBase | undefined;
  walletEnvironment?: ConnectorEnvironment | undefined;
}) {
  return (
    <ThemeProvider>
      {base === undefined ? (
        <DeploymentProvider>
          <DeploymentScoped walletEnvironment={walletEnvironment}>{children}</DeploymentScoped>
        </DeploymentProvider>
      ) : (
        <DeploymentProvider base={base}>
          <DeploymentScoped walletEnvironment={walletEnvironment}>{children}</DeploymentScoped>
        </DeploymentProvider>
      )}
    </ThemeProvider>
  );
}

/** Route-level code splitting: a lazily loaded page shows skeleton content while its chunk arrives (X5). */
function Lazy({children}: {children: ReactNode}) {
  return <Suspense fallback={<Skeleton height="12rem" label="Loading page" />}>{children}</Suspense>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route
          path="round/:chainId/:roundId"
          element={
            <Lazy>
              <RoundPage />
            </Lazy>
          }
        />
        <Route
          path="wallet"
          element={
            <Lazy>
              <WalletPage />
            </Lazy>
          }
        />
        <Route
          path="entries"
          element={
            <Lazy>
              <EntriesPage />
            </Lazy>
          }
        />
        <Route path="verify" element={<VerifyPage />} />
        <Route path="help" element={<HelpPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppProviders>
        {/*
          `BASE_URL` is Vite's resolved `base` (web/vite.config.ts, from `VITE_LUCKYDRAW_BASE`), so the
          router's basename and the asset URLs come from one value. It is "/" for a site at the root of its
          own origin — unchanged behaviour — and "/luckydraw/" for a GitHub Pages project site, where
          /luckydraw/round/97/1 has to route as /round/97/1.
        */}
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </ErrorBoundary>
  );
}
