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
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
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

// Owner 2026-08-01: this panel moved from the sidebar onto the Accounts page
// (Setup group) — same wiring, same confirmations; only the home changed.
// `title` lets the host page name the section without a second heading.
export default function AccountSwitcher({ title = 'Accounts', broker = null }) {
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
  // Per-account engineering stats (owner 2026-08-01: W/L 24h + since
  // connected, watchlist size, mode, sidecar connectivity) — one route,
  // refreshed on the page's own cadence.
  const [eng, setEng] = useState(null)

  const load = useCallback(async () => {
    if (!agentConfigured()) return
    try {
      const r = await agentPost('/actions/ctrader-accounts')
      const next = { accounts: r.accounts || [], selectedAccountId: r.selectedAccountId ? Number(r.selectedAccountId) : null }
      setData(next)
      try { sessionStorage.setItem(CACHE, JSON.stringify(next)) } catch { /* quota — skip */ }
      setErr('')
    } catch { /* not logged in / no token yet — stay hidden or stale */ }
    try {
      const e = await agentGet('/state/account-engineering')
      setEng(e || null)
    } catch { /* stats are additive — the switches work without them */ }
  }, [])

  useEffect(() => {
    const t = setTimeout(load, 0)
    const iv = setInterval(load, 30_000)
    return () => { clearTimeout(t); clearInterval(iv) }
  }, [load])

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

  // Disconnect / Reconnect (owner 2026-08-01): Disconnect disables the
  // account in the registry — the bot stops EVERYTHING for it (scan,
  // analyse, autotrade, keeper, reconcile) and the sidecar drops it from
  // the credential roster on the next push. Reconnect re-enables the row
  // and re-establishes the roster the same way. Both confirm; re-enabling
  // a LIVE account additionally goes through the server's confirmLive
  // carve-out with a typed word.
  const setConnected = async (a, next) => {
    const who = `${a.isLive ? 'LIVE' : 'Demo'} ${a.traderLogin || a.accountId}`
    if (!next && !window.confirm(`Disconnect ${who}? The bot stops ALL activity for this account — scanning, analysis, autotrade AND position management/reconcile — and the sidecar drops its credentials on the next roster push. Open positions are left to their broker-side SL/TP.`)) return
    let confirmLive
    if (next && a.isLive) {
      const word = window.prompt(`⚠ ${who} is a LIVE account with REAL money.\n\nReconnecting re-establishes its credentials and re-enables it in the registry.\n\nType LIVE to confirm:`)
      if (word !== 'LIVE') return
      confirmLive = true
    } else if (next && !window.confirm(`Reconnect ${who}? The account is re-enabled in the registry and the sidecar re-establishes its credentials on the next roster push.`)) return
    setPhaseBusy(`${a.accountId}:conn`)
    setErr('')
    try {
      await agentPost('/actions/registry-account', { accountId: a.accountId, enabled: next, ...(confirmLive ? { confirmLive } : {}) })
      await Promise.all([refreshPhases(), load()])
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

  // Engineering stats by account id — additive; rows render without them.
  const engById = new Map((eng?.accounts || []).map(a => [String(a.accountId), a]))
  const wl = (x) => (x ? `${x.wins}W/${x.losses}L` : '—')
  const ago = (iso) => {
    const t = Date.parse(String(iso || '').includes('T') ? iso : String(iso || '').replace(' ', 'T') + 'Z')
    if (!Number.isFinite(t)) return null
    const m = Math.max(0, Math.round((Date.now() - t) / 60000))
    return m < 60 ? `${m}m` : m < 60 * 48 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  }

  return (
    <div>
      {/* Owner 2026-08-01: the MASTER S/A/T row was removed from this panel —
          the master veto lives on Tune › Pipeline only. Per-account switches
          below still honour it (greyed while the master is off). */}
      <div className="px-3 pb-1 flex items-center gap-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">{title}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {data.accounts.map(a => {
          const active = a.accountId === data.selectedAccountId
          const ph = phaseView?.byId?.[String(a.accountId)]
          const st = engById.get(String(a.accountId)) || null
          const bk = broker?.[String(a.accountId)] || null
          const disabled = st ? !st.enabled : false
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
                            ? `Master ${p.label} is OFF (Tune › Pipeline) — turn it on there first. This account's own setting (${ov === null ? 'inherit' : ov ? 'on' : 'off'}) is remembered.`
                            : `${p.label} is ${eff ? 'ON' : 'OFF'} for ${a.traderLogin || a.accountId}${ov === null ? ' (following the master)' : ' (set on this account)'} — tap to turn ${eff ? 'off' : 'on'}`}
                        onClick={() => setAccountPhase(a, p.key, !eff)}
                      />
                    )
                  })}
                  <button
                    type="button"
                    disabled={phaseBusy === `${a.accountId}:conn`}
                    onClick={() => setConnected(a, disabled)}
                    title={disabled
                      ? 'Disconnected — the bot ignores this account entirely. Tap to reconnect: re-enables it in the registry and re-establishes its sidecar credentials.'
                      : 'Disconnect this account from ALL bot activity (scan, analyse, autotrade AND management) and drop its sidecar credentials. The S/A/T switches are the finer control; this is the full unplug.'}
                    className={`ml-1 inline-flex items-center rounded-[var(--radius-control)] border leading-none px-[4px] py-[2px] text-[8px] font-bold cursor-pointer transition-colors disabled:opacity-45 ${
                      disabled
                        ? 'border-[var(--color-state-off-border)] text-[var(--color-state-off-text)] bg-[var(--color-state-off-bg)]'
                        : 'border-[var(--color-down)] text-[var(--color-down)] bg-transparent hover:bg-[color-mix(in_srgb,var(--color-down)_12%,transparent)]'
                    }`}
                  >{phaseBusy === `${a.accountId}:conn` ? '…' : disabled ? 'Reconnect' : 'Disconnect'}</button>
                </span>
              </span>
              {/* Under-the-bonnet line (owner 2026-08-01): W/L, positions +
                  floating, equity/margin, watchlist + mode, connectivity. */}
              {st && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[8px] text-[var(--color-text-sub)] tabular-nums pt-0.5">
                  <span title="Wins / losses over the past 24 hours">24h {wl(st.wl24h)}</span>
                  <span title={`Wins / losses since connected${st.connectedAt ? ` (${st.connectedAt.slice(0, 10)})` : ''} · net $${st.wlAll?.net ?? '—'}`}>all {wl(st.wlAll)}</span>
                  <span title="Open positions this account is carrying (bot ledger)">
                    {(bk?.positions?.length ?? st.openPositions) || 0} pos
                    {bk && bk.floating != null ? ` ${bk.floating >= 0 ? '+' : '−'}$${Math.abs(bk.floating).toFixed(2)}` : ''}
                  </span>
                  {bk && bk.equity != null && (
                    <span title="Equity (balance + floating P&L) and used margin, from the latest broker snapshot">
                      eq ${bk.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}{bk.usedMargin != null ? ` · mgn $${bk.usedMargin.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ''}
                    </span>
                  )}
                  <span title="Watchlist symbols this account scans (own list, or the shared list it inherits)">WL {st.watchlistCount ?? '—'}</span>
                  <span title="Bot mode: active dispatches new entries; manage_only only manages what is open; paused does neither">{st.mode || '—'}</span>
                  <span
                    title={st.sidecarAuthorised == null
                      ? 'Sidecar authorization unknown (roster not reported — js exec mode or health blip)'
                      : st.sidecarAuthorised
                        ? `C++ sidecar holds credentials for this account${st.lastReconcileAt ? ` · last reconcile ${ago(st.lastReconcileAt) ?? '—'} ago` : ''}`
                        : 'C++ sidecar session is up WITHOUT this account — not authorized'}
                    className={st.sidecarAuthorised === false ? 'text-[var(--color-state-off-text)] font-semibold' : st.sidecarAuthorised ? 'text-[var(--color-state-on-text)]' : ''}
                  >
                    ● {st.sidecarAuthorised == null ? 'link?' : st.sidecarAuthorised ? 'linked' : 'unlinked'}
                    {st.lastReconcileAt && ago(st.lastReconcileAt) != null ? ` · rec ${ago(st.lastReconcileAt)}` : ''}
                  </span>
                  {disabled && <span className="text-[var(--color-state-off-text)] font-semibold">DISCONNECTED</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {err && <p className="px-3 pt-1 text-[9px] text-[var(--color-warning-text)]">{err}</p>}
    </div>
  )
}
