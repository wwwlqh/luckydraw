// The app shell: the testnet banner, top navigation, thumb-reach bottom bar, theme toggle and the outlet
// every route renders into (SPEC §9.3, §9.4).
//
// §9.4: "Top navigation: Pools, My entries, Wallet, Activity, Leaderboard, Verify and Help; wallet and chain
// state are always visible. [...] Testnet builds show a persistent 'Testnet, no real value' banner."
// Activity, Leaderboard and /admin are deferred in this wave and are listed in web/README.md.

import {NavLink, Outlet} from "react-router";
import {NetworkGuard, WalletButton} from "../components/index.ts";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {useTheme} from "../lib/theme/ThemeProvider.tsx";
import {en, fill} from "../strings/en.ts";

const ROUTES = [
  {to: "/", label: en.nav.pools, end: true},
  {to: "/entries", label: en.nav.entries, end: false},
  {to: "/wallet", label: en.nav.wallet, end: false},
  {to: "/verify", label: en.nav.verify, end: false},
  {to: "/help", label: en.nav.help, end: false},
] as const;

function EnvironmentBanner() {
  const {environment, manifest} = useDeployment();
  if (environment === "mainnet") return null;
  return (
    <div className="env-banner" role="note">
      <strong>{environment === "local" ? en.banner.local : en.banner.testnet}</strong>
      <span className="muted">
        {fill(en.banner.detail, {environment, deploymentId: manifest.deploymentId})}
      </span>
    </div>
  );
}

function ThemeToggle() {
  const {mode, cycle} = useTheme();
  const next = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  const label = mode === "system" ? en.theme.system : mode === "light" ? en.theme.light : en.theme.dark;
  return (
    <button
      type="button"
      className="button button--ghost"
      onClick={cycle}
      aria-label={fill(en.theme.toggleTo, {mode: next})}
      title={`${en.theme.label}: ${label}`}
    >
      {mode === "dark" ? "◑" : mode === "light" ? "◐" : "◎"}
      <span className="visually-hidden">{label}</span>
    </button>
  );
}

function NavItems({className}: {className: string}) {
  return (
    <ul className={className}>
      {ROUTES.map((route) => (
        <li key={route.to}>
          <NavLink to={route.to} end={route.end} className="navlink">
            {route.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function AppShell() {
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {en.app.skipToContent}
      </a>
      <EnvironmentBanner />
      <header className="topbar">
        <NavLink to="/" className="topbar__brand">
          {en.app.name}
        </NavLink>
        <nav aria-label={en.nav.label}>
          <NavItems className="topbar__links" />
        </nav>
        <div className="topbar__actions">
          <ThemeToggle />
          <WalletButton />
        </div>
      </header>

      <main className="main" id="main" aria-label={en.app.mainLandmark}>
        <NetworkGuard />
        <Outlet />
      </main>

      <nav className="bottombar" aria-label={en.nav.label}>
        <NavItems className="" />
      </nav>
    </div>
  );
}
