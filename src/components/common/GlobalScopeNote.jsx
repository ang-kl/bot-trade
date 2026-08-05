// GlobalScopeNote — says out loud that a card writes ONE setting for EVERY
// account.
//
// Owner, 04-08-2026: "i try to change the setup for different account but it
// didn't work."
//
// It wasn't the pages failing to pass the account. Most of these settings have
// no per-account dimension to write to: /actions/loss-cap, /actions/
// loss-guardian, /actions/profit-ratchet, /actions/exec-guard, /actions/
// stage-matrix and the weekend/VPO/guardian toggles all take a body with no
// accountId and write one global state key. Only /actions/risk-config and
// /actions/account-phases carry an account.
//
// So the page sat under an account selector, the operator changed a number
// "for this account", and it landed on all of them. Nothing warned.
//
// This note is the cheap half of the fix, and it is deliberately NOT an
// account picker: putting a scope control over a global write would be a
// lie with a nicer interface. The expensive half — giving these routes a
// real per-account overlay, the way risk-config has one — is separate work,
// and this note is what tells the truth until then.
export default function GlobalScopeNote({ what = 'These settings', className = '' }) {
  return (
    <div
      className={`glass-inset rounded-[2px] px-2 py-1 text-(length:--fs-body) text-[var(--color-text-sub)] ${className}`}
      style={{ borderLeft: '2px solid var(--color-warning-text)' }}
    >
      <b className="text-[var(--color-text)]">Applies to every account.</b>{' '}
      {what} are stored once for the whole bot — the account selector above does not scope them,
      and saving here changes what every account trades under.
    </div>
  )
}
