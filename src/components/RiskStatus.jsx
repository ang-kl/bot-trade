// RiskStatus.jsx — "Capital safety now", the top of the Risk page.
//
// Claude · № 12,812 10-Oct (ordered № 12,810; claude-builder).
// Owner, 10-10-2026: the Performance page's "Accounts — capital safety" card,
// brought onto the Risk page, phone first. Read-only. Each row is the server's
// account-overview reading (lib/risk-status.js); tapping a row only switches
// which account's limits the page below is editing.

import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import { statusRows, usedBand } from '../lib/risk-status.js'

const nf2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : nf2.format(Number(n)))
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${nf2.format(Math.abs(n))}`)

const BAND = {
  ok: { col: 'var(--color-accent)', word: 'OK' },
  warn: { col: 'var(--color-warning-text)', word: 'WARN' },
  breach: { col: 'var(--color-down)', word: 'BREACH' },
  unknown: { col: 'var(--color-muted)', word: 'NOT READ' },
}

function stopText(v) {
  if (v.capState === 'in_force' && v.cap != null) return `−${money(v.cap)}${v.capCcy ? ` ${v.capCcy}` : ''}`
  if (v.capState === 'uncapped') return 'off (both checks off)'
  return 'not read'
}

export default function RiskStatus({ overview, registry, error, scope, onPick }) {
  const rows = statusRows(overview?.accounts, registry)
  return (
    <Card id="sec-status" data-risk-card className="w3-hover-shadow">
      <h2 className="t-h3 text-[var(--color-accent)]">Capital safety now</h2>
      <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-1">
        Today&apos;s loss against each account&apos;s daily stop — the stop the risk engine enforces, FX day from 17:00 New York. Most at risk first. Tap an account to edit its limits below.
      </p>
      {error && <div className="text-(length:--fs-body) text-[var(--color-warning-text)]">Could not load: {error}</div>}
      {!overview && !error && <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">…</div>}
      <div className="risk-status-grid">
        {rows.map(r => {
          const band = BAND[r.view.capState === 'in_force' ? usedBand(r.view.used) : 'unknown']
          const picked = String(scope) === r.id
          const usedPct = r.view.used != null ? Math.max(0, Math.min(100, r.view.used)) : 0
          return (
            <button key={r.id} type="button" onClick={() => onPick?.(r.id)} aria-pressed={picked}
              className={`risk-status-row text-left w-full cursor-pointer rounded-[12px] border px-3 py-2 ${picked
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                : 'border-[var(--glass-edge)] bg-[var(--color-surface)]'} ${r.dormant ? 'opacity-70' : ''}`}>
              <span className="flex items-center gap-2 text-(length:--fs-body)">
                <Badge tone={r.tone}>{r.tag}</Badge>
                <span className="font-bold">{r.short}</span>
                <span className="text-[var(--color-text-sub)]">{r.ccy || 'currency not read'}</span>
                <span className="ml-auto font-extrabold tabular-nums">{money(r.balance)}</span>
              </span>
              {r.dormant ? (
                <span className="block text-(length:--fs-body) text-[var(--color-muted)] mt-1">
                  Off in the registry · holds nothing
                </span>
              ) : (
                <>
                  <span className="flex items-center gap-2 text-(length:--fs-body) text-[var(--color-text-sub)] mt-1 tabular-nums">
                    <span>floating <b style={{ color: r.floating == null || r.floating === 0 ? 'var(--color-text-sub)' : r.floating > 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{signed(r.floating)}</b></span>
                    <span className="ml-auto">daily stop <b className="text-[var(--color-text)]">{stopText(r.view)}</b></span>
                  </span>
                  <span className="flex items-center gap-2 mt-1.5">
                    <span role="img" aria-label={`${r.view.used ?? 'unknown'} percent of the daily stop used`}
                      className="flex-1 h-2 rounded-full overflow-hidden bg-[color-mix(in_srgb,var(--color-border)_80%,transparent)]">
                      <span className="block h-2 rounded-full" style={{ width: `${Math.max(usedPct, r.view.used != null ? 2 : 0)}%`, background: band.col }} />
                    </span>
                    <span className="text-(length:--fs-body) font-bold tabular-nums min-w-[96px] text-right" style={{ color: band.col }}>
                      {r.view.used != null ? `${r.view.used}% · ${band.word}` : band.word}
                    </span>
                  </span>
                  {r.stopExceedsBalance && (
                    <span className="block text-(length:--fs-body) font-semibold mt-1" style={{ color: 'var(--color-down)' }}>
                      Daily stop ({money(r.view.cap)} {r.view.capCcy}) is larger than the whole balance ({money(r.balanceUsed)} {r.view.capCcy}): it cannot stop this account.
                    </span>
                  )}
                  {!r.stopExceedsBalance && r.view.explain && (
                    <span className="block text-(length:--fs-body) text-[var(--color-text-sub)] mt-1">
                      {r.view.explain}{r.view.remaining != null ? ` · ${money(r.view.remaining)} ${r.view.capCcy || ''} left today` : ''}
                      {r.mode === 'manage_only' ? ' · manage only' : ''}
                    </span>
                  )}
                </>
              )}
            </button>
          )
        })}
      </div>
    </Card>
  )
}
