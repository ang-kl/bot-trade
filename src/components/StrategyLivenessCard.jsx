// StrategyLivenessCard — is each armed strategy actually in the game?
//
// The backend for this has existed since 28-07 (agent/services/strategy-
// liveness.js) and nothing on screen read it. The defect it was built for is
// worth restating, because it is the whole reason this card is on the Pipeline
// tab rather than buried somewhere: Cup & Handle was armed, defaultOn, scored
// well in backtests, and was STRUCTURALLY unable to fire — it needs 210 bars
// and the scan fetched 150, so it returned null at its length guard before any
// pattern logic ran. Nothing caught it for weeks, because "this strategy is
// broken" and "this strategy saw no setup today" look identical from outside.
// Both are an absence.
//
// So the card shows the FUNNEL, not a score:
//
//   signals → decisions (and how many were stopped) → opened → closed
//
// A stage at zero while the stage above it is not is a specific, findable
// problem. An armed strategy at zero in the FIRST stage is the Cup & Handle
// case. Nothing here judges whether a strategy is any good — profit factor and
// expectancy live in Edge Health and the performance breaker. This answers the
// prior question those cannot: is it even running.
//
// TWO THINGS THE CARD REFUSES TO DO.
//
//   · It does not call a strategy dead on a quiet window. The server withholds
//     every verdict until the window holds enough scan activity for an absence
//     to mean something (`verdictable`); until then the card says so, in place
//     of the verdicts, rather than showing reassuring or alarming labels built
//     on nothing.
//   · It does not colour an unarmed strategy as a problem. Absence there is
//     expected, and flagging it would train the eye to ignore the row that
//     matters.
import { useEffect, useState } from 'react'
import { agentGet } from '../lib/agent-api.js'
import Badge from './common/Badge.jsx'
import Segmented from './common/Segmented.jsx'
import SectionTools from './common/SectionTools.jsx'
import { VERDICT, WINDOWS, ago, toText } from '../lib/strategy-liveness-view.js'

export function Row({ s, verdictable }) {
  const v = VERDICT[s.verdict] || VERDICT.unknown
  // The finding is an ARMED strategy that produced nothing. Unarmed rows are
  // context and are deliberately quiet.
  const flag = verdictable && s.armed && s.verdict === 'silent'
  return (
    <tr className={flag ? 'bg-[var(--color-error-bg)]' : ''}>
      <td className="py-1 pr-2 font-semibold whitespace-nowrap">{s.name}</td>
      <td className="py-1 pr-2"><Badge tone={s.armed ? 'on' : 'off'}>{s.armed ? 'ARMED' : 'OFF'}</Badge></td>
      <td className="py-1 pr-2 text-right tabular-nums">{s.signals.toLocaleString()}</td>
      <td className="py-1 pr-2 text-right tabular-nums">
        {s.decisions.toLocaleString()}
        {s.vetoes > 0 && <span className="text-[var(--color-text-sub)]"> ({s.vetoes.toLocaleString()} stopped)</span>}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums">{s.opened.toLocaleString()}</td>
      <td className="py-1 pr-2 text-right tabular-nums">{s.closed.toLocaleString()}</td>
      <td className="py-1 pr-2 whitespace-nowrap text-[var(--color-text-sub)]">{ago(s.lastSignalAt)}</td>
      <td className="py-1 pr-2"><Badge tone={v.tone}>{v.label}</Badge></td>
      <td className="py-1 text-[var(--color-text-sub)]">{s.note}</td>
    </tr>
  )
}

export function Table({ data }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[9px] border-collapse">
        <thead>
          <tr className="text-left text-[var(--color-text-sub)]">
            <th className="py-1 pr-2 font-semibold">Strategy</th>
            <th className="py-1 pr-2 font-semibold">State</th>
            <th className="py-1 pr-2 font-semibold text-right">Signals</th>
            <th className="py-1 pr-2 font-semibold text-right">Decisions</th>
            <th className="py-1 pr-2 font-semibold text-right">Opened</th>
            <th className="py-1 pr-2 font-semibold text-right">Closed</th>
            <th className="py-1 pr-2 font-semibold">Last signal</th>
            <th className="py-1 pr-2 font-semibold">Reading</th>
            <th className="py-1 font-semibold">Why</th>
          </tr>
        </thead>
        <tbody>
          {data.strategies.map(s => <Row key={s.key} s={s} verdictable={data.verdictable} />)}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The phone shape. A nine-column table does not become readable by scrolling
 * sideways — the funnel is a sequence, and on a narrow screen a sequence reads
 * as a line, not as columns you have to scroll to compare.
 *
 * Verdict FIRST, because it is the answer; then the funnel as one line with
 * arrows, so a zero under a non-zero is still visible at a glance; then the
 * plain-language note.
 */
export function StrategyCards({ data }) {
  return (
    <div className="flex flex-col gap-1">
      {data.strategies.map(s => {
        const v = VERDICT[s.verdict] || VERDICT.unknown
        const flag = data.verdictable && s.armed && s.verdict === 'silent'
        return (
          <div
            key={s.key}
            className={`rounded-[6px] border px-1.5 py-1 ${flag
              ? 'border-[var(--color-down)] bg-[var(--color-error-bg)]'
              : 'border-[var(--color-border)]'}`}
          >
            <div className="flex flex-wrap items-baseline gap-1.5">
              <Badge tone={v.tone}>{v.label}</Badge>
              <span className="font-semibold">{s.name}</span>
              {/* The badge NAMES ITS SCOPE. Owner, 05-08-2026, from an iPhone:
                  "keeps disarmed and i cannot see which account is disarmed."
                  On a phone the account switcher is nowhere near this badge, so
                  ARMED/OFF was a verdict with no subject. */}
              <Badge tone={s.armed ? 'on' : 'off'}>
                {s.armed ? 'ARMED' : 'OFF'}{data.armedScope ? ` · ${data.armedScope}` : ''}
              </Badge>
              <span className="ml-auto text-[var(--color-text-sub)]">{ago(s.lastSignalAt)}</span>
            </div>
            {/* The funnel on one line. The arrows carry the "a zero here under
                a non-zero there is the finding" reading that the table's
                column order carries on a wide screen. */}
            <div className="tabular-nums text-[var(--color-text-sub)]">
              {s.signals.toLocaleString()} signals → {s.decisions.toLocaleString()} decisions
              {s.vetoes > 0 && ` (${s.vetoes.toLocaleString()} stopped)`}
              {' → '}{s.opened.toLocaleString()} opened → {s.closed.toLocaleString()} closed
            </div>
            <div className="text-[var(--color-text-sub)]">{s.note}</div>
          </div>
        )
      })}
    </div>
  )
}

export default function StrategyLivenessCard() {
  const [days, setDays] = useState(WINDOWS[0])
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    agentGet(`/state/strategy-liveness?days=${days}`)
      .then(d => { if (alive) { setData(d); setErr(d?.error || null) } })
      .catch(e => { if (alive) setErr(e?.message || String(e)) })
    return () => { alive = false }
  }, [days])

  // Render only data that belongs to the SELECTED window. Without this the
  // previous window's counts sit under the new window's label for the length
  // of the fetch, which on a liveness panel reads as a changed verdict.
  const shown = data && Number(data.windowDays) === Number(days) ? data : null
  const silent = (shown?.strategies || []).filter(s => s.armed && s.verdict === 'silent')

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h3 className="t-h3">Strategy Liveness table</h3>
        <Segmented label="Liveness window" value={String(days)}
          options={WINDOWS.map(d => ({ value: String(d), label: `${d}d` }))}
          onChange={v => setDays(Number(v))} />
        {shown && (
          <SectionTools id="strategy-liveness" title="Strategy Liveness table" window={`${days}D`}
            data={shown} toText={() => toText(shown)} render={() => <Table data={shown} />} />
        )}
      </div>
      {shown?.armedScope && (
        <p className="text-[9px] text-[var(--color-text-sub)] mb-0.5">
          ARMED/OFF is the <strong>Auto Trade &amp; Open</strong> column for{' '}
          <strong>{shown.armedScope === 'global default' ? 'the global default' : `account ${shown.armedScope}`}</strong>
          {' '}— a different switch from an account being Active. Change it in Tune → Pipeline.
        </p>
      )}
      <p className="text-[9px] text-[var(--color-text-sub)] mb-1.5">
        Does each armed strategy actually reach the market — signals → decisions → orders opened → trades closed.
        A stage at zero under a stage that is not is a findable problem; an armed strategy with no signal at all is
        the Cup &amp; Handle case, where the code could not run rather than the market being quiet. This says
        nothing about whether a strategy is profitable — that is Edge Health.
      </p>

      {err && <p className="text-[9px] text-[var(--color-down)]">Liveness unavailable: {err}</p>}
      {!shown && !err && <p className="text-[9px] text-[var(--color-text-sub)]">Loading…</p>}

      {shown && !shown.verdictable && (
        <p className="text-[9px] text-[var(--color-warning-text)] mb-1.5">
          Only {shown.totalScans.toLocaleString()} scans in the last {shown.windowDays} days — too little activity for
          silence to mean anything, so no verdict is offered. The counts below are still real.
        </p>
      )}

      {shown && shown.verdictable && silent.length > 0 && (
        <p className="text-[9px] text-[var(--color-down)] font-semibold mb-1.5">
          {silent.length === 1 ? '1 armed strategy produced' : `${silent.length} armed strategies produced`} no signal
          at all in {shown.windowDays} days: {silent.map(s => s.name).join(', ')}. Either the market offered nothing,
          or the code path cannot run — a backtest of that strategy over the same window separates the two.
        </p>
      )}

      {/* ONE MOUNT, TWO LAYOUTS. The split is inside the component rather
          than two mounted variants, so there is exactly one fetch and the two
          shapes can never show different numbers — the failure mode the other
          mobile ports had to be fixed for after the fact. */}
      {shown && (
        <>
          <div className="hidden min-[700px]:block"><Table data={shown} /></div>
          <div className="min-[700px]:hidden"><StrategyCards data={shown} /></div>
        </>
      )}

      {shown && (
        <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">
          Window {shown.windowDays}d from {String(shown.since).slice(0, 10)} · {shown.totalScans.toLocaleString()} scans attributed to a strategy.
          Decisions counts every stage record; “stopped” is the subset that ended the setup.
        </p>
      )}
    </>
  )
}
