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
import AccountTrafficLights, { LightRow } from './AccountTrafficLights.jsx'
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
  // OVERRULED, NOT OFF (owner 04-08-2026: "why is the auto-trade … conflict
  // with user request", and earlier "I armed it 10 minutes ago and now
  // disarmed-autotrade!!!!!").
  //
  // Nothing disarmed anything. The owner's ON was stored — `overrides.
  // autotrade` is still true — and then the account's MODE said no new
  // entries, so `effective` came back false and this switch repainted OFF.
  // Tapping it again re-sends the same ON, which is why it looked like a
  // fight with the page. A switch that silently drops the operator's answer
  // and shows the opposite is the same "two sources of truth" defect as a
  // balance under the wrong account name.
  //
  // So: the switch keeps SAYING what the owner set, and the veto is drawn
  // beside it as a veto — a blocked state with the reason and the fix, not
  // an OFF that pretends nobody ever asked.
  const cap = acct.capability || null
  const overruled = phase.key === 'autotrade' && !eff && ov === true
    && acct.effective?.source?.autotrade === 'capability'
  const capWhy = !cap ? 'this account cannot enter new trades'
    : !cap.enabled ? 'this account is DISABLED in the registry — it is not in the broker roster, so no order can reach it'
      : cap.mode === 'manage_only' ? 'its mode is Manage only — existing positions are still managed, but no new entries'
        : cap.mode === 'paused' ? 'its mode is Paused — no scanning and no new entries'
          : cap.mode === 'archived' ? 'this account is Archived'
            : `its mode is ${cap.mode || 'unknown'}`
  const why = blocked
    ? `Master ${phase.label} is off above — turn it on there first. This account's own setting (${ov === null ? 'inherit' : ov ? 'on' : 'off'}) is remembered.`
    : overruled
      ? `You armed ${phase.label} on ${acct.traderLogin || acct.accountId} and that setting is SAVED — but ${capWhy}. Change the mode on this row to Active and it takes effect. Tap to withdraw the arm instead.`
      : `${phase.label} is ${eff ? 'ON' : 'OFF'} for ${acct.traderLogin || acct.accountId}${ov === null ? ' (following the master)' : ' (set on this account)'} — tap to turn ${eff ? 'off' : 'on'}`
  return (
    <button
      type="button" role="switch" aria-checked={overruled ? true : eff} disabled={blocked || busy}
      aria-label={`${phase.label} for account ${acct.traderLogin || acct.accountId}${overruled ? ' — armed but blocked by account mode' : ''}`}
      title={why}
      onClick={() => onSet(phase.key, overruled ? false : !eff)}
      className={`inline-flex items-center justify-center rounded-[3px] border leading-none
                  min-w-[26px] px-[5px] py-[3px] text-[9px] font-bold transition-colors
                  ${blocked || busy ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'} ${
        overruled
          ? 'border-[var(--color-warning-border)] text-[var(--color-warning-text)] bg-[var(--color-warning-bg)]'
          : eff
            ? 'border-[var(--color-state-on-border)] text-[var(--color-state-on-text)] bg-[var(--color-state-on-bg)]'
            : 'border-[var(--color-state-off-border)] text-[var(--color-state-off-text)] bg-[var(--color-state-off-bg)]'
      }`}
    >
      {phase.initial}
      {/* The strike says the arm exists AND is not in force — two facts one
          colour cannot carry. */}
      {overruled && <span aria-hidden="true" className="ml-[2px] text-[9px] leading-none">⃠</span>}
      {/* The override marker: a dot means this account has its OWN setting
          rather than following the master. Without it, an account switched off
          individually is indistinguishable from one whose master is off. */}
      {ov !== null && <span aria-hidden="true" className="ml-[2px] text-[9px] leading-none">•</span>}
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
  // The stale-account warning rides alongside the switches ON PURPOSE. This
  // card is registry-fed, so it is exactly where a vanished account is still
  // listed — and the only Disable button in the app lives on a BROKER-fed
  // surface, whose row has by then disappeared. Without a control here there
  // is no way to disable a stale account at all.
  const [stale, setStale] = useState([])
  const [roster, setRoster] = useState(null)
  const [busyId, setBusyId] = useState('')
  const loadStale = useCallback(() => agentGet('/state/accounts')
    .then(r => { setStale(r?.staleAccounts || []); setRoster(r?.brokerRoster || null) })
    .catch(() => { /* the switches still work without the warning */ }), [])

  const load = useCallback(() => agentGet('/state/account-phases')
    .then(v => {
      setView(v); setErr('')
      loadStale()
      // Via a ref so the caller need not memoise the handler to avoid an
      // effect loop — load() is in a dependency list.
      if (v?.master) { try { truthRef.current?.(v.master) } catch { /* never break the card */ } }
    })
    .catch(e => setErr(e.message)), [loadStale])

  // The Disable that works when the broker row is gone. It writes `enabled: 0`
  // through the same route the Accounts page uses — no new privilege, no
  // deletion, and nothing automatic: the owner asked to be warned and left in
  // control, so this only ever fires from a click.
  const disableStale = (a) => {
    setBusyId(a.accountId)
    agentPost('/actions/registry-account', { accountId: a.accountId, enabled: false })
      .then(() => load())
      .catch(e => setErr(e.message))
      .finally(() => setBusyId(''))
  }

  // Change what an account is ALLOWED to do. Same route, same privilege as the
  // Disable button above — this only widens which of its arguments the UI can
  // reach, and never for a LIVE row (the select is disabled there, and the
  // route refuses an enable without confirmLive regardless).
  //
  // Moving to Active is the one direction that can start new orders, so it
  // confirms exactly like arming does. Every other direction only ever removes
  // permission, and management of open positions survives all four.
  const setMode = async (a, next) => {
    const who = `${a.isLive ? 'LIVE' : 'Demo'} ${a.traderLogin || a.accountId}`
    const enabled = next !== 'disabled'
    const mode = enabled ? next : 'manage_only'
    if (next === 'active') {
      if (!window.confirm(`Set ${who} to Active? With Auto Trade armed, the agent may open REAL new positions on this account.`)) return
    } else if (!window.confirm(`Set ${who} to ${next === 'disabled' ? 'Disabled' : next === 'paused' ? 'Paused' : 'Manage only'}? No new entries will be opened on it. Open positions keep being managed.`)) return
    setBusyId(a.accountId)
    try {
      await agentPost('/actions/registry-account', { accountId: a.accountId, enabled, mode })
      await load()
      showDone(`Mode ${next} · ${a.traderLogin || a.accountId}`)
      setErr('')
    } catch (e) { setErr(e.message) } finally { setBusyId('') }
  }
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

      {/* STALE ACCOUNTS. Owner 02-08-2026: "I select only two account from the
          CTrader, but still shows 5 in the Tune > Pipeline. I am confuse."
          The registry is insert-only and nothing re-syncs it, so an account
          unticked in the cTrader app lives on here forever — and if it is
          still enabled, the loop and the sidecar keep targeting it.
          The owner's instruction was to flag it, not act on it, so nothing is
          disabled automatically; the button below is the only thing that
          writes, and only when clicked. */}
      {stale.length > 0 && (
        <div className="rounded-[6px] border border-[var(--color-down)] p-2 mb-2 text-[9px]" role="alert">
          <div className="font-bold text-[var(--color-down)]">
            {stale.length} account{stale.length === 1 ? '' : 's'} below {stale.length === 1 ? 'is' : 'are'} no longer listed by the broker
          </div>
          <div className="text-[var(--color-text-sub)] mt-0.5">
            You most likely unticked {stale.length === 1 ? 'it' : 'them'} in the cTrader app. Nothing removes
            {stale.length === 1 ? ' it' : ' them'} from this list automatically, and an account left
            <strong> enabled</strong> is still dispatched to by the loop and still authorised at the C++ engine.
            {roster?.at && <> Broker list last read {roster.ageMin != null ? `${roster.ageMin} min ago` : 'recently'}.</>}
          </div>
          <ul className="mt-1 space-y-1">
            {stale.map(a => (
              <li key={a.accountId} className="flex flex-wrap items-center gap-2">
                <span className={`font-bold tabular-nums ${a.isLive ? 'text-[var(--color-down)]' : ''}`}>
                  {a.isLive ? 'LIVE' : 'DEMO'} {a.traderLogin || a.accountId}
                </span>
                <span className="text-[9px] text-[var(--color-text-sub)] tabular-nums">#{a.accountId}</span>
                {a.enabled
                  ? <span className="font-semibold text-[var(--color-down)]">STILL ENABLED — the bot can trade it</span>
                  : <span className="text-[var(--color-text-sub)]">already disabled — harmless, just clutter</span>}
                {a.enabled && (
                  <button
                    type="button"
                    onClick={() => disableStale(a)}
                    disabled={busyId === a.accountId}
                    className="ml-auto rounded-full border border-[var(--md-outline-variant)] px-2 py-0.5 cursor-pointer disabled:opacity-60"
                    title="Sets enabled = 0 in the registry. Open positions are NOT closed and nothing else changes — the loop simply stops opening new trades on it."
                  >
                    {busyId === a.accountId ? 'Disabling…' : 'Disable'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!view && !err && <div className="text-[9px] text-[var(--color-text-sub)]">Loading accounts…</div>}
      {view && accounts.length === 0 && (
        <div className="text-[9px] text-[var(--color-text-sub)]">
          No accounts in the registry yet — pick them on Connect first.
        </div>
      )}
      <AccountTrafficLights>{({ byId, alarms, globalHalt, globalHaltReason }) => (
      <>
      {/* A4. A red Manage light is not a status — it means open exposure with
          nothing watching it, which the API refuses to create. If it shows up,
          something wrote accounts.mode directly, and a small dot is not
          enough. */}
      {alarms.length > 0 && (
        <div className="text-[9px] font-semibold text-[var(--color-down)] border border-[var(--color-down)] rounded-[6px] px-1.5 py-1 mb-1">
          UNMANAGED EXPOSURE: {alarms.map(r => r.accountId).join(', ')} — open work with management off.
          {' '}{alarms[0].lights.manage.reason}
        </div>
      )}
      {globalHalt && (
        <div className="text-[9px] text-[var(--color-warning-text)] mb-1">
          Portfolio guard is blocking entries on every account{globalHaltReason ? ` — ${globalHaltReason}` : ''}.
          Accounts below can still show as armed; that is the account's own state, not permission to trade.
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
              <span className="text-[9px] text-[var(--color-text-sub)] tabular-nums">#{a.accountId}</span>
              {/* Owner (2026-07-31): "I need more details like current balance,
                  how many open positions, pending positions, disconnected or
                  active bot-trade." Balance is the loop's per-account stamp —
                  an em-dash means never reconciled, an honest unknown, not
                  zero. Counts are rows ATTRIBUTED to this account. The
                  connectivity chip is the sidecar's authorized roster:
                  active / disconnected / unknown, never guessed. */}
              <span className="text-[9px] text-[var(--color-text-sub)] tabular-nums" title="Last reconciled balance for this account (— = never reconciled)">
                {a.balance != null
                  ? `${a.baseCurrency || 'USD'} ${Number(a.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : 'balance —'}
              </span>
              <span className="text-[9px] text-[var(--color-text-sub)] tabular-nums" title="Open positions attributed to this account · working pending orders">
                {a.openPositions ?? '—'} open · {a.pendingOrders ?? '—'} pending
              </span>
              {a.connectivity && (
                <span
                  className={`text-[9px] font-semibold uppercase ${
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
              {/* THE MODE, AS A CONTROL (owner 04-08-2026).
                  `accounts.mode` decided whether an armed account could enter,
                  and NOTHING in the app could change it — POST /actions/
                  registry-account existed and had exactly one caller, the
                  Disable-a-stale-account button. So two of three connected
                  accounts sat in `manage_only` with the owner's arm saved and
                  overruled, and the only way out was a route call by hand.
                  A veto with no control beside it is not a safety feature; it
                  is a dead end.
                  LIVE rows are read-only here on purpose: enabling live
                  trading is the M5 cutover gesture and the route refuses it
                  without confirmLive — that stays a deliberate act, never a
                  dropdown. */}
              <select
                aria-label={`Trading mode for account ${a.traderLogin || a.accountId}`}
                value={a.enabled ? (a.mode || 'manage_only') : 'disabled'}
                disabled={a.isLive || busyId === a.accountId}
                title={a.isLive
                  ? 'LIVE account — its mode is not changed from this dropdown. Enabling live trading is a deliberate cutover, not a click.'
                  : 'Active = may open new trades · Manage only = keeps existing positions managed, opens nothing new · Paused = no scanning, no entries · Disabled = out of the broker roster entirely. Open positions are ALWAYS managed.'}
                onChange={(e) => setMode(a, e.target.value)}
                className={`rounded-[3px] border border-[var(--color-border)] bg-transparent px-[3px] py-[2px]
                            text-[9px] font-semibold text-[var(--color-text)]
                            ${a.isLive ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <option value="active">Active</option>
                <option value="manage_only">Manage only</option>
                <option value="paused">Paused</option>
                <option value="disabled">Disabled</option>
              </select>
              {byId.get(String(a.accountId)) && (
                <LightRow row={byId.get(String(a.accountId))} />
              )}
              {/* Ratchet v2 hold — separate from the switches on purpose: the
                  ratchet never writes them, so its hold needs its own badge. */}
              {a.ratchet && (
                <span className="text-[9px] font-bold text-[var(--color-warning-text)]"
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
                <span className="text-[9px] font-semibold uppercase text-[var(--color-state-off-text)]"
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
      </>
      )}</AccountTrafficLights>
    </Card>
  )
}
