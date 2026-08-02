// A6 — inherited vs overridden, with the one-tap revert.
//
// docs/per-account-control-plan.md §5.1. Two accounts can show the same
// number for entirely different reasons: one INHERITED it and will follow you
// when you change your house rule, the other has it PINNED and will not. Only
// one of those follows you, and until now nothing on screen said which.
//
// So the row leads with the source word, not the value. The values here are
// whole JSON configs — dumping them into a list would bury the single fact
// this view exists to carry.
//
// TWO THINGS SAID OUT LOUD RATHER THAN IMPLIED.
//
//   · Revert restores INHERITANCE, not a copy. The button says so, because
//     "reset to default" reads as "make it match right now" and the
//     difference only shows up weeks later when the shared value changes.
//   · The settings that CANNOT be overridden are listed with their reason.
//     A refusal you can only discover by trying is the kind that gets worked
//     around; a portfolio guard that says why it is portfolio-level does not.
import { useCallback, useEffect, useState } from 'react'
import { agentGet, agentPost } from '../lib/agent-api.js'
import { useAccountSwitch } from '../lib/use-account-switch.js'
import { selectedAccountId, accountLabel } from '../lib/selected-account.js'
import Badge from './common/Badge.jsx'

export function SettingRow({ s, accountId, onRevert, busy }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-0.5">
      <Badge tone={s.overridden ? 'special' : 'neutral'}>
        {s.overridden ? 'overridden' : 'inherited'}
      </Badge>
      <span className="font-semibold">{s.label}</span>
      <span className="text-[var(--color-text-sub)]">{s.key}</span>
      {!s.overridden && !s.hasShared && (
        <span className="text-[var(--color-muted)]">nothing set anywhere yet</span>
      )}
      {s.overridden && !s.differs && (
        // The trap this view exists for: same value, different behaviour.
        <span className="text-[var(--color-warning-text)]">
          same as shared today — but pinned, so it will NOT follow a change
        </span>
      )}
      {s.overridden && accountId && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onRevert(s.key)}
          className="ml-auto glass-inset rounded-[var(--radius-control)] px-2 py-0.5 cursor-pointer"
          title="Delete this account's copy so it follows the shared setting again — not a copy of today's value"
        >
          Revert to inherited
        </button>
      )}
    </div>
  )
}

export default function AccountSettingsScope() {
  const [view, setView] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [acct, setAcct] = useState(() => selectedAccountId())

  const load = useCallback((id) => {
    const q = id != null && id !== '' ? `?account=${encodeURIComponent(id)}` : ''
    return agentGet(`/state/account-settings${q}`)
      .then(d => { setView(d); setErr(d?.error || null) })
      .catch(e => setErr(e?.message || String(e)))
  }, [])

  useEffect(() => {
    let alive = true
    const id = acct
    const q = id != null && id !== '' ? `?account=${encodeURIComponent(id)}` : ''
    agentGet(`/state/account-settings${q}`)
      .then(d => { if (alive) { setView(d); setErr(d?.error || null) } })
      .catch(e => { if (alive) setErr(e?.message || String(e)) })
    return () => { alive = false }
  }, [acct])

  useAccountSwitch(useCallback((ev) => { setAcct(ev?.to ?? selectedAccountId()) }, []))

  const revert = useCallback(async (key) => {
    setBusy(true)
    try {
      await agentPost('/actions/account-setting', { accountId: acct, key, revert: true })
      await load(acct)
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [acct, load])

  if (err) return <p className="text-[9px] text-[var(--color-down)]">Settings scope unavailable: {err}</p>
  if (!view) return <p className="text-[9px] text-[var(--color-text-sub)]">Loading…</p>

  return (
    <div id="sec-settings-scope" className="text-[9px] flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="t-h3">Per-Account Settings card</h3>
        <span className="text-[var(--color-text-sub)]">
          {acct ? `${accountLabel(acct) || acct} — ` : 'No account selected — '}
          {view.overriddenCount} pinned, the rest inherited from the shared configuration
        </span>
      </div>
      <p className="text-[var(--color-text-sub)]">
        Inherited means the shared value applies <strong>and keeps applying</strong> when you change it.
        Pinned means this account keeps its own copy and will not follow. Reverting deletes the copy —
        it does not freeze today's shared value.
      </p>

      {view.groups.map(g => (
        <div key={g.category} className="rounded-[6px] border border-[var(--color-border)] px-1.5 py-1">
          <div className="font-semibold text-[var(--color-accent)]">{g.label}</div>
          {g.settings.map(s => (
            <SettingRow key={s.key} s={s} accountId={acct} onRevert={revert} busy={busy} />
          ))}
        </div>
      ))}

      {view.notOverridable?.length > 0 && (
        <div className="text-[var(--color-text-sub)]">
          <span className="font-semibold">Not overridable per account:</span>{' '}
          {view.notOverridable.map((n, i) => (
            <span key={n.key}>{i > 0 && ' · '}<strong>{n.key}</strong> — {n.why}</span>
          ))}
        </div>
      )}
    </div>
  )
}
