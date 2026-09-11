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
// server's blocker list as its title until the live readiness predicate
// (/state/tick-readiness `ready`) holds; enabled, it posts the same route and
// the server re-checks readiness at the request — the UI can never grant
// what the record refuses (PR-G). Beside it the switch POLICY (manual |
// auto, EntryModePolicySwitch) says whether the bot's readiness pass may
// throw the switch too. Bulk Stop / Time-based run per account and list each
// account's own acknowledgement (TM-33): one executor offline shows as that
// account NOT acknowledged, never as an all-stopped success.
//
// Unknowns (PR-E, owner principle 4, 11-09-2026): the UNKNOWN intents from
// GET /state/entry-intents — account last-4, symbol, side, age, error — each
// with a resolve form (FILLED / REJECTED + a reason of three characters or
// more) posting to POST /actions/entry-intents/:id/resolve, and a button
// for POST /actions/backfill-trade-origin (dry run first, apply on a second
// click) with the reply's counts shown. Server-derived only: after every
// post the ledger is re-fetched; nothing here marks a row resolved on its
// own word.
import { useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import Button from './common/Button.jsx'
import Collapse from './common/Collapse.jsx'
import EntryModePolicySwitch from './EntryModePolicySwitch.jsx'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import { useEngineStatus, refreshEngineStatus } from '../lib/use-engine-status.js'
import { engineReading, blockerGroups, tickBlockedReason, ackLine, mixedSummary, MODE_LABEL } from '../lib/engine-status-view.js'
import { unknownRows, resolveUnknownIntent, runOriginBackfill, backfillSummary, RESOLVE_STATES, MIN_REASON_LEN } from '../lib/unknown-intents.js'

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
        <Button size="sm" variant="ghost" disabled={disabledAll || !readiness?.ready || row.requestedEntryMode === 'TICK_MOMENTUM'} title={why || (tickWhy ? `Tick momentum is refused: ${tickWhy}` : 'tick-basis entries; every readiness check holds — the server re-checks at the request and the executor must echo the new epoch before entries begin (WARMING → STABLE)')} onClick={() => onMode(fullId, 'TICK_MOMENTUM', row.configRevision)}>Tick momentum</Button>
        <EntryModePolicySwitch row={row} fullId={fullId} busy={busy} />
      </div>
      {groups.length > 0 && (
        <Collapse id={`engine-blockers-${row.accountId}`} label={`Why not tick-ready (${readiness.blockedReasons.length})`} defaultOpen={false}>
          <BlockerList groups={groups} />
        </Collapse>
      )}
    </div>
  )
}

const FIELD = 'rounded-[3px] border border-[var(--color-border)] bg-transparent px-[3px] py-[2px] text-(length:--fs-body) text-[var(--color-text)]'

/**
 * The UNKNOWN rows and their resolve forms — presentational, so a fixture
 * renders without effects. `drafts` is { [id]: { state, reason } }.
 */
export function UnknownsList({ rows, drafts = {}, busyId = null, notes = {}, onDraft = () => {}, onResolve = () => {} }) {
  if (!rows.length) return <div className="text-[var(--color-text-sub)]">no UNKNOWN intent — every send has a verdict</div>
  return (
    <ul className="space-y-1" data-testid="unknowns-list">
      {rows.map(r => {
        const d = drafts[r.id] || { state: 'FILLED', reason: '' }
        const short = String(d.reason || '').trim().length < MIN_REASON_LEN
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-2" data-testid={`unknown-${r.id}`}>
            <code>{r.id}</code>
            <span className="tabular-nums">…{r.account}</span>
            <b>{r.symbol}</b> <span>{r.side}</span>
            <span className="text-[var(--color-text-sub)]">UNKNOWN for {r.age}</span>
            <span className="text-[var(--color-text-sub)]" title="the error the send reported">{r.errorCode}</span>
            <select aria-label={`Resolution for intent ${r.id}`} className={FIELD} value={d.state} disabled={busyId === r.id}
              onChange={e => onDraft(r.id, { ...d, state: e.target.value })}>
              {RESOLVE_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input aria-label={`Reason for intent ${r.id}`} className={`${FIELD} min-w-[14rem]`} placeholder="reason (what the broker's history shows)" value={d.reason} disabled={busyId === r.id}
              onChange={e => onDraft(r.id, { ...d, reason: e.target.value })} />
            <Button size="sm" variant="primary" disabled={busyId === r.id || short}
              title={short ? `a reason of at least ${MIN_REASON_LEN} characters is required` : `POST /actions/entry-intents/${r.id}/resolve — the ledger is re-read afterwards`}
              onClick={() => onResolve(r.id, d)}>Resolve</Button>
            {notes[r.id] && <span className={notes[r.id].ok ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>{notes[r.id].text}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Fetches the ledger once per panel scope, resolves with a reason,
 * re-fetches; runs the origin backfill. `scope` is the panel's ('all' or
 * one account id): the rows shown are the scope's, the fetch is the same
 * whole-ledger read either way (the route redacts ids, so the filter is on
 * the last four).
 */
export function UnknownsBlock({ scope = 'all' }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [notes, setNotes] = useState({})
  const [backfill, setBackfill] = useState({ busy: false, reply: null })

  async function load() {
    if (!agentConfigured()) { setError('agent not configured'); return }
    try { setView(await agentGet('/state/entry-intents')); setError(null) } catch (e) { setError(e?.message || String(e)) }
  }
  useEffect(() => { load() }, [scope]) // one fetch per panel scope (m5)

  async function onResolve(id, draft) {
    setBusyId(id)
    try {
      const r = await resolveUnknownIntent(agentPost, id, draft)
      setNotes(n => ({ ...n, [id]: { ok: !!r.ok, text: r.ok ? `${r.from} → ${r.to} (server)` : (r.reason || r.error || 'refused') } }))
    } catch (e) {
      setNotes(n => ({ ...n, [id]: { ok: false, text: e?.message || String(e) } }))
    } finally { setBusyId(null); await load(); refreshEngineStatus() }
  }
  async function onBackfill(apply) {
    setBackfill({ busy: true, reply: null })
    try { setBackfill({ busy: false, reply: await runOriginBackfill(agentPost, { apply }) }) } catch (e) { setBackfill({ busy: false, reply: { error: e?.message || String(e) } }) }
  }

  const rows = unknownRows(view, Date.now(), { scope })
  const planned = backfill.reply && backfill.reply.mode === 'plan' && !backfill.reply.error
  return (
    <div className="mt-2 text-(length:--fs-body)" data-testid="unknowns-block">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Unknowns</span>
        <span className="text-[var(--color-text-sub)]">{view ? `${rows.length} UNKNOWN intent${rows.length === 1 ? '' : 's'}${scope && scope !== 'all' ? ` on …${String(scope).slice(-4)}` : ''} — an UNKNOWN blocks its account/symbol/side until the broker's evidence or an operator with a reason settles it` : (error || 'reading /state/entry-intents…')}</span>
        <Button size="sm" variant="ghost" onClick={load} title="re-read GET /state/entry-intents">Refresh</Button>
      </div>
      {view && <UnknownsList rows={rows} drafts={drafts} busyId={busyId} notes={notes}
        onDraft={(id, d) => setDrafts(x => ({ ...x, [id]: d }))} onResolve={onResolve} />}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={backfill.busy} title="POST /actions/backfill-trade-origin — dry run: the plan and its counts, nothing written" onClick={() => onBackfill(false)}>Backfill trade origins</Button>
        {planned && <Button size="sm" variant="danger" disabled={backfill.busy} title="POST /actions/backfill-trade-origin { apply: true } — writes the plan above; every row it writes is origin_source = 'backfill' and reversible" onClick={() => onBackfill(true)}>Apply backfill ({backfill.reply.rows ?? 0} rows)</Button>}
        {backfill.reply && <span className={backfill.reply.error ? 'text-[var(--color-down)]' : 'text-[var(--color-text-sub)]'}>{backfillSummary(backfill.reply)}</span>}
      </div>
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
      <UnknownsBlock scope={scope} />
      <div className="mt-2 text-(length:--fs-body) text-[var(--color-text-sub)]">
        Every value here is the server's record: the effective mode is what the executor acknowledged, not what was clicked. Tick momentum is admitted only while every readiness check holds — the server re-checks at the request — and, under switch policy <b>auto</b>, the bot may promote or demote the account on the same checks.
      </div>
    </Card>
  )
}
