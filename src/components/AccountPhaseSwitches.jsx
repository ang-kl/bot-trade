// AccountPhaseSwitches — Scan / Analyze / Autotrade for EACH account, under
// the master switches.
//
// Owner, three times: "The master switch is for all account i tagged to via
// CTrader. I need switches for each account. can you link them and put below
// the master switch a card to show which account's switch status and on/off
// here"; "scan/analyze/autotrade should be in all account. I don't want all
// accounts to be traded by this bot-trade in the same way"; and then "we are
// still not having independent switches, have you wired them?"
//
// The answer to that last one was NO — the three flags were global, so this
// card was deliberately not built until the parts underneath it existed:
// services/account-phases.js resolves the switches, loop.js:916 enforces them
// on the dispatch path, POST /actions/account-phases writes them. A toggle over
// a global flag is exactly the kind of lie that produced the question.
//
// WHAT THE SWITCHES HONESTLY DO, which the card says out loud:
// · Autotrade off on an account → that account is never dispatched an order.
//   Fully per-account, and it saves the sizing/risk-gate work too.
// · Scan / Analyze are ONE shared pass per cycle over the shared symbol
//   universe (loop.js:2269), not per-account work. Off on one account stops
//   THAT account acting; the scan still runs because the others need it. The
//   work only stops once every account has it off — which the loop does check
//   (phaseWanted), so the saving is real, just not proportional.
// · The master is an absolute veto. A per-account ON cannot arm anything while
//   the switch above is off, so those switches are disabled rather than
//   offering a click that would silently do nothing.
import { useCallback, useEffect, useRef, useState } from 'react'
import Card from './common/Card.jsx'
import DoneCue from './common/DoneCue.jsx'
import { useDoneCue } from '../lib/use-done-cue.js'
import { agentGet, agentPost } from '../lib/agent-api.js'
import { PHASES } from '../lib/account-phases.js'

/**
 * One phase switch for one account.
 *
 * Three underlying states (on / off / inherit) render as two, because the
 * owner asked for switches and a tri-state switch is a puzzle. `inherit` is
 * shown as whatever it currently resolves to, with the row's Inherit button as
 * the way back — and the title text always names which level decided.
 */
function PhaseSwitch({ phase, acct, masterOn, busy, onSet }) {
  const eff = acct.effective[phase.key] === true
  const ov = acct.overrides[phase.key]
  const blocked = !masterOn
  const why = blocked
    ? `Master ${phase.label} is off above — turn it on there first. This account's own setting (${ov === null ? 'inherit' : ov ? 'on' : 'off'}) is remembered.`
    : `${phase.label} is ${eff ? 'ON' : 'OFF'} for ${acct.traderLogin || acct.accountId}${ov === null ? ' (following the master)' : ' (set on this account)'} — tap to turn ${eff ? 'off' : 'on'}`
  return (
    <button
      type="button" role="switch" aria-checked={eff} disabled={blocked || busy}
      aria-label={`${phase.label} for account ${acct.traderLogin || acct.accountId}`}
      title={why}
      onClick={() => onSet(phase.key, !eff)}
      className={`inline-flex items-center justify-center rounded-[3px] border leading-none
                  min-w-[26px] px-[5px] py-[3px] text-[9px] font-bold transition-colors
                  ${blocked || busy ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'} ${
        eff
          ? 'border-[var(--color-state-on-border)] text-[var(--color-state-on-text)] bg-[var(--color-state-on-bg)]'
          : 'border-[var(--color-state-off-border)] text-[var(--color-state-off-text)] bg-[var(--color-state-off-bg)]'
      }`}
    >
      {phase.initial}
      {/* The override marker: a dot means this account has its OWN setting
          rather than following the master. Without it, an account switched off
          individually is indistinguishable from one whose master is off. */}
      {ov !== null && <span aria-hidden="true" className="ml-[2px] text-[7px] leading-none">•</span>}
    </button>
  )
}

/**
 * @param {{master?: {scan?: boolean, analyze?: boolean, autotrade?: boolean},
 *          onMasterTruth?: (m: {scan: boolean, analyze: boolean, autotrade: boolean}) => void}} props
 *   `master` is the PAGE's live copy of the three global flags (Tune's own
 *   `config`). Passing it in is what keeps this card honest when the master is
 *   toggled above: see the refetch below.
 *
 *   `onMasterTruth` is the REVERSE direction, and it exists because of a real
 *   incident. 2026-07-30: the owner reported "the AutoTrade broke for every
 *   accounts even though the master switch is on in the pipeline page", with a
 *   screenshot showing the master Autotrade chip ON and every account's T OFF.
 *   Both cards read the same state key, so they cannot really disagree —
 *   effectivePhases is `master && (override ?? true)`, so an account with NO
 *   override reading OFF proves the SERVER's master was off. The master chip was
 *   showing a value that had gone stale: Tune's sync poll skips while the tab is
 *   backgrounded (pageAsleep), so a background disarm — the performance breaker
 *   writes that master flag — could leave the chip lying indefinitely.
 *
 *   This card always renders from the server's answer, so it already holds the
 *   truth. Handing it back up lets the page correct itself instead of showing
 *   the owner two contradictory cards and letting them trust the wrong one.
 */
export default function AccountPhaseSwitches({ master = null, onMasterTruth = null }) {
  const [view, setView] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [done, showDone] = useDoneCue()

  // Fetch on mount and after each write — no polling. The owner asked for
  // "precision" refreshes ("there is a lot of moving text for the webpage"),
  // and a card of switches has no reason to repaint on a timer.
  const truthRef = useRef(null)
  truthRef.current = onMasterTruth
  const load = useCallback(() => agentGet('/state/account-phases')
    .then(v => {
      setView(v); setErr('')
      // Via a ref so the caller need not memoise the handler to avoid an
      // effect loop — load() is in a dependency list.
      if (v?.master) { try { truthRef.current?.(v.master) } catch { /* never break the card */ } }
    })
    .catch(e => setErr(e.message)), [])
  useEffect(() => { load() }, [load])

  // ...BUT A MASTER TOGGLE IS ALSO A CHANGE TO THIS CARD, and on first ship it
  // was not. Owner, minutes after the feature landed: "per switch not updated
  // once master-switch is set" — they turned master Autotrade ON above and
  // every T here stayed greyed out, because the card had fetched while the
  // master was off and nothing told it otherwise. "No polling" is right;
  // "never refetch" was wrong. Keyed on the three flags' VALUES, so this fires
  // exactly when one of them flips and never on an unrelated re-render.
  const masterKey = master
    ? `${master.scan === true}|${master.analyze === true}|${master.autotrade === true}`
    : ''
  useEffect(() => { if (masterKey) load() }, [masterKey, load])

  const set = async (acct, phaseKey, on) => {
    const who = `${acct.isLive ? 'LIVE' : 'Demo'} ${acct.traderLogin || acct.accountId}`
    // Arming REAL orders on an account gets the same confirmation the master
    // Autotrade switch gets.
    if (phaseKey === 'autotrade' && on) {
      if (!window.confirm(`Arm autotrade on ${who}? The agent will place REAL orders on this account when a signal passes the risk gate.`)) return
    }
    // Approval-queue item 2 (owner 2026-08-01): DISARMS confirm too — after
    // two unexplained all-account disarms, a mis-tap silently stopping an
    // account's trading is the failure this guards against.
    if (!on) {
      const label = PHASES.find(p => p.key === phaseKey)?.label || phaseKey
      if (!window.confirm(`Turn ${label} OFF for ${who}? ${phaseKey === 'autotrade' ? 'No new orders will be placed on this account' : 'This stops new trades on this account'} until it is back on. Open positions keep being managed.`)) return
    }
    const key = `${acct.accountId}:${phaseKey}`
    setBusy(key)
    try {
      await agentPost('/actions/account-phases', { accountId: acct.accountId, [phaseKey]: on })
      await load()
      const label = PHASES.find(p => p.key === phaseKey)?.label || phaseKey
      showDone(`${label} ${on ? 'on' : 'off'} · ${acct.traderLogin || acct.accountId}`)
      setErr('')
    } catch (e) {
      setErr(e.message)
    } finally { setBusy('') }
  }

  const inherit = async (acct) => {
    setBusy(`${acct.accountId}:inherit`)
    try {
      await agentPost('/actions/account-phases',
        { accountId: acct.accountId, scan: null, analyze: null, autotrade: null })
      await load()
      showDone(`Following the master · ${acct.traderLogin || acct.accountId}`)
      setErr('')
    } catch (e) {
      setErr(e.message)
    } finally { setBusy('') }
  }

  const accounts = view?.accounts || []
  return (
    <Card id="sec-pipe-accounts" className="w3-hover-shadow">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h3 className="t-h3">Per-account switches</h3>
        <DoneCue message={done} />
      </div>
      <p className="text-[9px] text-[var(--color-text-sub)] mb-1.5">
        S = Scan, A = Analyze, T = Autotrade, for each account on your cTrader ID. The master switches
        above are a veto — anything off there is off everywhere, and those switches grey out here.
        A dot on a switch means the account has its own setting instead of following the master.
        Autotrade is fully per-account. Scan and Analyze are one shared pass per cycle, so switching
        either off on one account stops <em>that</em> account acting; the pass itself only stops once
        every account has it off.
      </p>
      {err && <div className="text-[9px] text-[var(--color-down)]" role="alert">{err}</div>}
      {!view && !err && <div className="text-[9px] text-[var(--color-text-sub)]">Loading accounts…</div>}
      {view && accounts.length === 0 && (
        <div className="text-[9px] text-[var(--color-text-sub)]">
          No accounts in the registry yet — pick them on Connect first.
        </div>
      )}
      <div className="flex flex-col gap-1">
        {accounts.map(a => {
          const ownSetting = PHASES.some(p => a.overrides[p.key] !== null)
          return (
            <div
              key={a.accountId}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1"
            >
              <span className={`text-[9px] font-bold tabular-nums ${a.isLive ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>
                {a.isLive ? 'LIVE' : 'DEMO'} {a.traderLogin || a.accountId}
              </span>
              <span className="text-[8px] text-[var(--color-text-sub)] tabular-nums">#{a.accountId}</span>
              {/* Owner (2026-07-31): "I need more details like current balance,
                  how many open positions, pending positions, disconnected or
                  active bot-trade." Balance is the loop's per-account stamp —
                  an em-dash means never reconciled, an honest unknown, not
                  zero. Counts are rows ATTRIBUTED to this account. The
                  connectivity chip is the sidecar's authorized roster:
                  active / disconnected / unknown, never guessed. */}
              <span className="text-[8px] text-[var(--color-text-sub)] tabular-nums" title="Last reconciled balance for this account (— = never reconciled)">
                {a.balance != null
                  ? `${a.baseCurrency || 'USD'} ${Number(a.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : 'balance —'}
              </span>
              <span className="text-[8px] text-[var(--color-text-sub)] tabular-nums" title="Open positions attributed to this account · working pending orders">
                {a.openPositions ?? '—'} open · {a.pendingOrders ?? '—'} pending
              </span>
              {a.connectivity && (
                <span
                  className={`text-[8px] font-semibold uppercase ${
                    a.connectivity === 'active' ? 'text-[var(--color-state-on-text)]'
                      : a.connectivity === 'disconnected' ? 'text-[var(--color-down)]'
                        : 'text-[var(--color-text-sub)]'}`}
                  title={a.connectivity === 'active'
                    ? 'The broker session has authorized this account — bot-trade can manage it right now.'
                    : a.connectivity === 'disconnected'
                      ? 'The broker session is up but this account is NOT authorized on it — bot-trade cannot reach it until it reconnects.'
                      : 'Connectivity unknown — the execution sidecar did not report its roster (js mode or a health blip).'}
                >
                  {a.connectivity}
                </span>
              )}
              {/* Ratchet v2 hold — separate from the switches on purpose: the
                  ratchet never writes them, so its hold needs its own badge. */}
              {a.ratchet && (
                <span className="text-[8px] font-bold text-[var(--color-warning-text)]"
                  title={a.ratchet === 'halt'
                    ? 'Profit ratchet HALT — the protected floor was hit; entries stopped on this account. Re-arm from the Telegram alert, or it re-arms on sustained recovery.'
                    : 'Profit ratchet warning — equity is just above the protected floor; new entries paused until it recovers.'}>
                  {a.ratchet === 'halt' ? '⛔ ratchet halt' : '⚠ ratchet warn'}
                </span>
              )}
              {/* An account switched off on Connect is not dispatched at all,
                  whatever these switches say — printing them without that fact
                  would overstate what they control. */}
              {!a.enabled && (
                <span className="text-[8px] font-semibold uppercase text-[var(--color-state-off-text)]"
                  title="This account is deselected on Connect, so the loop does not trade it at all. These switches apply if you re-enable it.">
                  off in Connect
                </span>
              )}
              <span className="ml-auto inline-flex items-center gap-[3px]">
                {PHASES.map(p => (
                  <PhaseSwitch
                    key={p.key} phase={p} acct={a}
                    masterOn={view.master[p.key] === true}
                    busy={busy === `${a.accountId}:${p.key}`}
                    onSet={(k, on) => set(a, k, on)}
                  />
                ))}
                <button
                  type="button" onClick={() => inherit(a)}
                  disabled={!ownSetting || busy === `${a.accountId}:inherit`}
                  title={ownSetting
                    ? 'Clear this account\'s own settings so all three follow the master switches again'
                    : 'Already following the master switches'}
                  className={`rounded-[3px] border border-[var(--color-border)] px-[5px] py-[3px] text-[9px] leading-none
                              text-[var(--color-text-sub)] ${ownSetting ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
                >
                  Inherit
                </button>
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
