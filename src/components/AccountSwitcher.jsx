// AccountSwitcher — the broker accounts, always visible in the left nav.
// One tap switches which account the bot trades (LIVE still requires the
// typed confirmation) — no trip back to the Connect page needed.
//
// Owner 01-08: "moving the master switch and individual account switches to
// side bar and the 'Account' should be 'Accounts' on the side bar above the
// list of account". So this block now carries the CONTROLS, not just the
// dots: a master S/A/T row under the Accounts heading, and tappable S/A/T
// switches on every account row. Same wiring as the Tune › Pipeline cards
// (which stay): the same POST routes, the same arm confirmations, the same
// typed master disarm — and reads come from the one shared
// /state/account-phases poll, so a ratchet/breaker trip repaints here within
// one poll without any extra request.
import { useEffect, useState, useCallback } from 'react'
import { agentPost, agentConfigured } from '../lib/agent-api.js'
import { useAccountPhases, refreshPhases } from '../lib/use-active-account.js'
import { PHASES } from '../lib/account-phases.js'

const CACHE = 'accounts_cache_v1'

/** One compact S/A/T switch — shared look for the master row and the account
 *  rows. `ov` non-null draws the ● own-setting marker (account rows only). */
function MiniSwitch({ label, initial, on, disabled, busy, title, onClick, ov = null }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} disabled={disabled || busy}
      aria-label={label} title={title}
      onClick={onClick}
      className={`inline-flex items-center justify-center rounded-[3px] border leading-none
                  min-w-[18px] px-[3px] py-[2px] text-[8px] font-bold transition-colors
                  ${disabled || busy ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'} ${
        on
          ? 'border-[var(--color-state-on-border)] text-[var(--color-state-on-text)] bg-[var(--color-state-on-bg)]'
          : 'border-[var(--color-state-off-border)] text-[var(--color-state-off-text)] bg-[var(--color-state-off-bg)]'
      }`}
    >
      {initial}
      {ov !== null && ov !== undefined && <span aria-hidden="true" className="ml-[1px] text-[6px] leading-none">•</span>}
    </button>
  )
}

export default function AccountSwitcher() {
  const [data, setData] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(CACHE)) || null } catch { return null }
  })
  const [busy, setBusy] = useState(false)
  const [phaseBusy, setPhaseBusy] = useState('')
  const [err, setErr] = useState('')
  // Each row's OWN Scan/Analyze/Autotrade state, plus the master flags — the
  // shared account poll fetches it, and refreshPhases() re-reads right after
  // each write here so the switch shows the SERVER's answer.
  const phaseView = useAccountPhases()

  const load = useCallback(async () => {
    if (!agentConfigured()) return
    try {
      const r = await agentPost('/actions/ctrader-accounts')
      const next = { accounts: r.accounts || [], selectedAccountId: r.selectedAccountId ? Number(r.selectedAccountId) : null }
      setData(next)
      try { sessionStorage.setItem(CACHE, JSON.stringify(next)) } catch { /* quota — skip */ }
      setErr('')
    } catch { /* not logged in / no token yet — stay hidden or stale */ }
  }, [])

  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])

  if (!agentConfigured() || !data?.accounts?.length) return null

  const pick = async (a) => {
    if (busy || a.accountId === data.selectedAccountId) return
    if (a.isLive) {
      const word = window.prompt(
        `⚠ ${a.traderLogin ? `Login ${a.traderLogin}` : `Account ${a.accountId}`} is a LIVE account with REAL money.\n\n` +
        'If Autotrade is armed, the bot will place REAL orders on it.\n\nType LIVE to confirm.'
      )
      if (word !== 'LIVE') return
    }
    setBusy(true)
    setErr('')
    try {
      await agentPost('/actions/ctrader-select-account', { accountId: a.accountId, isLive: a.isLive, traderLogin: a.traderLogin ?? null })
      await load()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const master = phaseView?.master || null

  // Master toggles — the SAME confirmations the Tune card uses, verbatim:
  // arming asks; disarming the master autotrade demands the typed word,
  // because it is an absolute veto over every account at once (owner
  // 2026-07-31, after two unexplained all-account disarms).
  const setMaster = async (key, next) => {
    if (key === 'autotrade' && next && !window.confirm('Arm autotrade? The agent will place REAL orders when a signal passes the risk gate.')) return
    if (key === 'autotrade' && !next) {
      const word = window.prompt('Disarm the MASTER autotrade switch? This stops new entries on EVERY account at once.\n\nType disarm to confirm:')
      if (word == null || word.trim().toLowerCase() !== 'disarm') return
    }
    setPhaseBusy(`master:${key}`)
    setErr('')
    try {
      await agentPost(`/actions/${key}-toggle`, { on: next })
      await refreshPhases()
    } catch (e) { setErr(e.message) } finally { setPhaseBusy('') }
  }

  const setAccountPhase = async (a, key, next) => {
    if (key === 'autotrade' && next) {
      const who = `${a.isLive ? 'LIVE' : 'Demo'} ${a.traderLogin || a.accountId}`
      if (!window.confirm(`Arm autotrade on ${who}? The agent will place REAL orders on this account when a signal passes the risk gate.`)) return
    }
    setPhaseBusy(`${a.accountId}:${key}`)
    setErr('')
    try {
      await agentPost('/actions/account-phases', { accountId: a.accountId, [key]: next })
      await refreshPhases()
    } catch (e) { setErr(e.message) } finally { setPhaseBusy('') }
  }

  return (
    <div>
      <div className="px-3 pb-1 flex items-center gap-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">Accounts</span>
        {/* Master S/A/T — the veto over every row below. Greyed rows follow. */}
        {master && (
          <span className="ml-auto inline-flex items-center gap-[3px]" title="Master switches — a veto over every account. The full cards stay on Tune › Pipeline.">
            {PHASES.map(p => (
              <MiniSwitch
                key={p.key} initial={p.initial}
                label={`Master ${p.label}`}
                on={master[p.key] === true}
                busy={phaseBusy === `master:${p.key}`}
                title={`Master ${p.label} is ${master[p.key] === true ? 'ON' : 'OFF'} — tap to turn ${master[p.key] === true ? 'off' : 'on'} for ALL accounts`}
                onClick={() => setMaster(p.key, !(master[p.key] === true))}
              />
            ))}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        {data.accounts.map(a => {
          const active = a.accountId === data.selectedAccountId
          const ph = phaseView?.byId?.[String(a.accountId)]
          return (
            <div
              key={a.accountId}
              className={`rounded-[10px] px-3 py-1.5 w-full transition-all ${
                active ? 'glass-inset shadow-[var(--glow-accent)]' : 'hover:bg-[var(--color-accent-soft)]'
              } ${busy ? 'opacity-60' : ''}`}
            >
              {/* The pick target is its OWN button — the S/A/T switches sit
                  beside it, never inside it (nested buttons are invalid HTML
                  and one tap must never mean two things). */}
              <button
                type="button" onClick={() => pick(a)} disabled={busy}
                title={active ? 'The bot trades this account' : `Switch the bot to this ${a.isLive ? 'LIVE' : 'demo'} account`}
                className="block w-full text-left cursor-pointer"
              >
                <span className="flex items-center gap-1.5 text-[9px] font-semibold text-[var(--color-text)]">
                  <span className={`text-[9px] font-bold ${a.isLive ? 'text-[var(--color-down)]' : 'text-[var(--color-up)]'}`}>{a.isLive ? 'LIVE' : 'DEMO'}</span>
                  <span>{a.traderLogin ?? a.accountId}</span>
                  {active && <span aria-hidden="true" className="ml-auto text-[var(--color-accent)]">●</span>}
                </span>
              </button>
              <span className="flex items-center gap-1.5 text-[9px] text-[var(--color-text-sub)] tabular-nums">
                <span>{busy ? 'switching…' : a.balance != null ? `$${Number(a.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}</span>
                {/* Ratchet v2 hold — not a switch state, so it gets its own
                    badge: the account is held by the profit ratchet even
                    though every switch may be ON. */}
                {ph?.ratchet && (
                  <span
                    className="text-[8px] font-bold text-[var(--color-warning-text)]"
                    title={ph.ratchet === 'halt'
                      ? 'Profit ratchet HALT — the protected floor was hit; entries stopped on this account. Re-arm from the Telegram alert button, or it re-arms itself on sustained recovery.'
                      : 'Profit ratchet warning — equity is just above the protected floor; new entries paused until it recovers.'}
                  >
                    {ph.ratchet === 'halt' ? '⛔ ratchet' : '⚠ ratchet'}
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-[3px]">
                  {PHASES.map(p => {
                    const masterOn = master?.[p.key] === true
                    const eff = ph?.[p.key] === true
                    const ov = ph?.overrides ? ph.overrides[p.key] : null
                    return (
                      <MiniSwitch
                        key={p.key} initial={p.initial} ov={ov}
                        label={`${p.label} for account ${a.traderLogin || a.accountId}`}
                        on={eff}
                        disabled={!ph || !masterOn}
                        busy={phaseBusy === `${a.accountId}:${p.key}`}
                        title={!ph
                          ? `${p.label} state not loaded yet`
                          : !masterOn
                            ? `Master ${p.label} is off above — turn it on there first. This account's own setting (${ov === null ? 'inherit' : ov ? 'on' : 'off'}) is remembered.`
                            : `${p.label} is ${eff ? 'ON' : 'OFF'} for ${a.traderLogin || a.accountId}${ov === null ? ' (following the master)' : ' (set on this account)'} — tap to turn ${eff ? 'off' : 'on'}`}
                        onClick={() => setAccountPhase(a, p.key, !eff)}
                      />
                    )
                  })}
                </span>
              </span>
            </div>
          )
        })}
      </div>
      {err && <p className="px-3 pt-1 text-[9px] text-[var(--color-warning-text)]">{err}</p>}
    </div>
  )
}
