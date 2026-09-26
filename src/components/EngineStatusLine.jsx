// EngineStatusLine — the shared-header line (plan §13 "Shared account header
// / all pages: requested/effective engine; warming/shadow/active/stopped/
// switching/blocked; stale/unknown status; mixed-account counts"). Reads the
// same store as the Accounts panel, so the sidebar and the page can never
// disagree about the same account.
import { useEngineStatus, engineRowFor } from '../lib/use-engine-status.js'
import { engineReading, mixedSummary } from '../lib/engine-status-view.js'

const COLOR = {
  on: 'text-[var(--color-state-on-text)]', off: 'text-[var(--color-state-off-text)]', warning: 'text-[var(--color-warning-text)]',
  down: 'text-[var(--color-down)]', neutral: 'text-[var(--color-muted)]',
}

/**
 * The readiness fragment shown beside the mode — S1a/S1b: what
 * GET /state/tick-readiness answered for THIS account, from the fixed
 * engineRowFor join (never a hardcoded word). "no record" when this
 * account's readiness was not part of the last answer — honest for a
 * `?account=` narrowed read (S3's viewed-account wiring), which carries no
 * data for any other account — rather than the line silently going quiet.
 */
function readinessNote(readiness) {
  if (!readiness) return 'no record'
  if (readiness.ready) return 'tick-ready'
  const n = readiness.blockedReasons?.length || 0
  return `${n} blocker${n === 1 ? '' : 's'}`
}

export default function EngineStatusLine({ accountId, className = '' }) {
  const snap = useEngineStatus()
  const row = engineRowFor(snap, accountId)
  const r = engineReading(row, { at: snap.at })
  const mixed = snap.engines?.accounts ? mixedSummary(snap.engines.accounts) : null
  return (
    <div className={`flex items-baseline justify-between gap-1 text-(length:--fs-body) ${className}`} title={`${r.detail}${mixed ? ` — all accounts: ${mixed}` : ''}`}>
      <span className="uppercase tracking-wide text-[var(--color-text-sub)]">Entries</span>
      <span className={`font-semibold ${COLOR[r.tone] || COLOR.neutral}`}>
        {r.label}{row?.tickObservation && row.tickObservation !== 'OFF' ? ` · ${row.tickObservation.toLowerCase()}` : ''}{r.stale ? ' · stale' : ''}{row ? ` · ${readinessNote(row.readiness)}` : ''}
      </span>
    </div>
  )
}
