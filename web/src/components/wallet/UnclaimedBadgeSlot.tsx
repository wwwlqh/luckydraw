// The marked slot for the unclaimed-money badges of SPEC §9.4, which are deferred in this wave.
//
// SPEC §9.4: "when the connected account has claimable refunds, or has received a prize or refund credit
// since its last acknowledged event, the My entries and Wallet navigation items carry a count badge and `/`
// shows a dismissible banner with per-asset totals and direct claim or withdraw controls; dismissal is per
// event, not per session."
//
// Two of those three parts are not built here and it would be dishonest to half-build them:
//
//   - the count of *claimable refunds* is available to this page (it is `rows` filtered to the refunds tab),
//     but the navigation items it belongs on live in `app/AppShell.tsx`, which this wave's page builders do
//     not own. The badge needs a shared source, not a copy;
//   - "credited since its last acknowledged event" needs a per-event acknowledgement store that no layer has
//     yet. Anything short of per-event dismissal would re-show a banner the user already dismissed, or hide
//     one they have not seen.
//
// This component renders nothing and exists so the slot has a name, a home and a test that pins it: when the
// acknowledgement store lands, it is the only file the badge has to be threaded through.

export function UnclaimedBadgeSlot({count}: {count: number}) {
  return (
    <span
      className="visually-hidden"
      data-slot="unclaimed-money-badge"
      data-count={count.toString()}
      aria-hidden="true"
    />
  );
}
