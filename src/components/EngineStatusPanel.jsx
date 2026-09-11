// EngineStatusPanel — the per-account entry engine, from the server's own
// record (plan §13, register TM-32 / TM-33).
//
// One table, one vocabulary: what was REQUESTED, what the gateway
// ACKNOWLEDGED as effective, the transition between them, the tick
// observation and validation stage, the revision the next action must name,
// and the readiness blockers grouped by the plan's five classes with the
// server's own remedy on each. Nothing here derives a mode from a flag; the
// component renders /state/entry-engines and /state/tick-readiness and the
// age of that answer.
//
// Actions: Stop entries / Time-based per account (POST /actions/entry-mode
// with expectedRevision — a 409 means someone changed it first; the panel
// reloads and says so). Tick momentum is a button that is DISABLED with the
// server's blocker list as its title until readiness says ready, and even
// then the server refuses it until P6 — the UI can never grant what the
// record refuses. Bulk Stop / Time-based run per account and list each
// account's own acknowledgement (TM-33): one executor offline shows as that
// account NOT acknowledged, never as an all-stopped success.
import { useState } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import Button from './common/Button.jsx'
import Collapse from './common/Collapse.jsx'
import { agentPost } from '../lib/agent-api.js'
import { useEngineStatus, refreshEngineStatus } from '../lib/use-engine-status.js'
import { engineReading, blockerGroups, tickBlockedReason, ackLine, mixedSummary, MODE_LABEL } from '../lib/engine-status-view.js'

function ageLabel(at) {
  if (!at) return 'not answered'
  const s = Math.round((Date.now() - at) / 1000)
  return s < 5 ? 'just now' : `${s} s ago`
}

function fullIdFor(accounts, redacted) {
  const tail = String(redacted || '').slice(-4)
  const hit = (accounts || []).find(a => String(a.accountId).endsWith(tail))
  return hit ? String(hit.accountId) : null
}

/** The failed checks by class, each with the server's own remedy. */
export function BlockerList({ groups }) {
  return (
    <ul className="mt-1 space-y-1 text-(length:--fs-body)">
      {groups.map(g => (
        <li key={g.key}>
          <span className="font-semibold">{g.label}</span>
          <ul className="ml-3 list-disc">
            {g.checks.map(c => <li key={c.check}><code>{c.check}</code> — observed <i>{c.observed ?? '—'}</i> ({c.source}); remedy: {c.remedy}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  )
}

export function EngineRow({ row, readiness, fullId, busy, onMode, at }) {
  const reading = engineReading(row, { at })
  const groups = blockerGroups(readiness)
  const tickWhy = tickBlockedReason(readiness)
  const disabledAll = busy || !fullId
  const why = !fullId ? 'the full account id is not on this page yet' : null
  return (
    <div className="border-b border-[var(--glass-edge)] py-2 last:border-b-0" data-testid={`engine-row-${row.accountId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold tabular-nums">{row.environment === 'live' ? 'LIVE' : 'DEMO'} {row.accountId}</span>
        <Badge tone={reading.tone} title={reading.detail}>{reading.label}</Badge>
        <span className="text-[var(--color-text-sub)]">requested <b>{MODE_LABEL[row.requestedEntryMode] || row.requestedEntryMode}</b> · effective <b>{MODE_LABEL[row.effectiveEntryMode] || row.effectiveEntryMode}</b> · {row.transitionState}</span>
        <span className="text-[var(--color-text-sub)] tabular-nums">rev {row.configRevision} · epoch {row.modeEpoch}</span>
        <span className="text-[var(--color-text-sub)]">observation <b>{row.tickObservation}</b> · stage <b>{row.validationStage}</b></span>
        {row.entryCounts && <span className="text-[var(--color-text-sub)] tabular-nums">resting {row.entryCounts.resting ?? 0} · in flight {row.entryCounts.inFlight ?? 0} · unknown {row.entryCounts.unknown ?? 0}</span>}
        {readiness && <Badge tone={readiness.ready ? 'on' : 'off'} title={tickWhy || 'every readiness check holds'}>{readiness.ready ? 'tick-ready' : `${readiness.blockedReasons.length} blocker${readiness.blockedReasons.length === 1 ? '' : 's'}`}</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button size="sm" variant="danger" disabled={disabledAll || row.requestedEntryMode === 'STOPPED'} title={why || 'stop every automatic entry on this account; resting entry orders are cancelled by id; manual orders stay admitted'} onClick={() => onMode(fullId, 'STOPPED', row.configRevision)}>Stop entries</Button>
        <Button size="sm" variant="primary" disabled={disabledAll || row.requestedEntryMode === 'TIME_BASED'} title={why || 'bar-based entries; the executor must echo the new epoch before entries resume (WARMING → STABLE)'} onClick={() => onMode(fullId, 'TIME_BASED', row.configRevision)}>Time-based</Button>
        <Button size="sm" variant="ghost" disabled title={tickWhy ? `Tick momentum is refused: ${tickWhy}` : 'Tick momentum: readiness holds, but the entry path (P6) is not built — the server refuses tick_engine_not_built'}>Tick momentum</Button>
      </div>
      {groups.length > 0 && (
        <Collapse id={`engine-blockers-${row.accountId}`} label={`Why not tick-ready (${readiness.blockedReasons.length})`} defaultOpen={false}>
          <BlockerList groups={groups} />
        </Collapse>
      )}
    </div>
  )
}

export default function EngineStatusPanel({ accounts = null, scope = 'all' }) {
  const snap = useEngineStatus()
  const [busy, setBusy] = useState(false)
  const [acks, setAcks] = useState([])
  const rows = snap.engines?.accounts || []

  async function setMode(fullId, mode, expectedRevision) {
    if (!fullId) return { accountId: fullId, error: 'no full account id' }
    try {
      const r = await agentPost('/actions/entry-mode', { accountId: fullId, mode, expectedRevision })
      return { accountId: `…${String(fullId).slice(-4)}`, mode, ...r }
    } catch (e) {
      const msg = e?.message || String(e)
      return { accountId: `…${String(fullId).slice(-4)}`, mode, error: /409|revision/.test(msg) ? 'revision_conflict — changed elsewhere, reloaded' : msg }
    }
  }
  async function onMode(fullId, mode, rev) {
    setBusy(true)
    try {
      const r = await setMode(fullId, mode, rev)
      setAcks([r])
    } finally { setBusy(false); refreshEngineStatus() }
  }
  async function onBulk(mode) {
    setBusy(true)
    const out = []
    try {
      for (const row of rows) {
        if (row.requestedEntryMode === mode) { out.push({ accountId: row.accountId, mode, skipped: true }); continue }
        out.push(await setMode(fullIdFor(accounts, row.accountId), mode, row.configRevision))
      }
      setAcks(out)
    } finally { setBusy(false); refreshEngineStatus() }
  }

  return (
    <Card id="sec-engines" scope={scope} data={snap.engines}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-(length:--fs-body) font-semibold uppercase tracking-wide">Entry engines</span>
          <span className="ml-2 text-(length:--fs-body) text-[var(--color-text-sub)]">{mixedSummary(rows)} · answered {ageLabel(snap.at)}{snap.engines?.globalHalt ? ' · GLOBAL HALT' : ''}</span>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="danger" disabled={busy || !rows.length || !accounts} title="stop entries on EVERY account, one request each; each account's own acknowledgement is listed below" onClick={() => onBulk('STOPPED')}>Stop all</Button>
          <Button size="sm" variant="primary" disabled={busy || !rows.length || !accounts} title="time-based entries on EVERY account, one request each" onClick={() => onBulk('TIME_BASED')}>Time-based all</Button>
        </div>
      </div>
      {snap.error && <div className="mt-1 text-(length:--fs-body) text-[var(--color-down)]">{snap.error}</div>}
      {!snap.engines && !snap.error && <div className="mt-1 text-(length:--fs-body) text-[var(--color-text-sub)]">waiting for /state/entry-engines…</div>}
      <div className="mt-2 text-(length:--fs-body)">
        {rows.map(row => (
          <EngineRow key={row.accountId} row={row} at={snap.at} busy={busy} fullId={fullIdFor(accounts, row.accountId)}
            readiness={snap.readiness?.accounts?.find(a => a.accountId === row.accountId) || null} onMode={onMode} />
        ))}
      </div>
      {acks.length > 0 && (
        <div className="mt-2 text-(length:--fs-body)">
          <div className="font-semibold">Acknowledgements</div>
          <ul className="ml-3 list-disc">
            {acks.map((a, i) => <li key={i}><span className="tabular-nums">{a.accountId}</span> {a.mode ? `→ ${MODE_LABEL[a.mode] || a.mode}: ` : ''}{a.skipped ? 'already requested — skipped' : ackLine(a)}</li>)}
          </ul>
        </div>
      )}
      <div className="mt-2 text-(length:--fs-body) text-[var(--color-text-sub)]">
        Every value here is the server's record: the effective mode is what the executor acknowledged, not what was clicked. Tick momentum stays refused until the readiness checks hold AND the tick entry path (P6) exists.
      </div>
    </Card>
  )
}
