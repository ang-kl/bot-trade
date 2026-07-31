// PerfAccountScope — "Am I looking at all accounts, or one?"
//
// Owner (2026-07-30): "The current Performance Ledger does not clearly indicate
// whether the displayed information represents all accounts combined or a
// specific selected account. This ambiguity must be resolved through an explicit
// account-selection model and clear visual state." And the closing principle:
// "At every moment, the user must be able to answer, without inference, 'Am I
// viewing all accounts or one specific account?'"
//
// Three things make that true here:
//
// 1. AN EXPLICIT ALL-SCOPE. The first card is ALL ACCOUNTS · SUMMARY and it is
//    selected by default. Before this there was no such thing as "all" — the
//    cards were a read-only list and the page's numbers came from whatever
//    account happened to be selected elsewhere, which is exactly the ambiguity.
//
// 2. A SCOPE LINE THAT IS ALWAYS ON SCREEN, next to the numbers rather than in
//    the page title. A title is too far from the figures to be read as their
//    label.
//
// 3. SELECTION SHOWN WITHOUT RELYING ON COLOUR: a thicker accent ring, a filled
//    ✓ SELECTED chip, aria-checked on a real radiogroup, and a focus ring that
//    is visually distinct from the selected ring (the owner's spec calls for
//    both, and a keyboard user needs to tell "where I am" from "what is on").
//
// WHOLE-PAGE SCOPE (owner, 2026-07-31: "I select different account, the rest
// of the performance page doesn't refresh"). The first version kept selection
// in local state and re-rendered only its own detail panel — the deliberate
// "partial refresh" reading of the spec. The owner has now ruled the other
// way: these cards ARE the page's account selector, so selection is LIFTED —
// the component is controlled by the page's `acct` state via scope/
// onScopeChange, and choosing a card re-scopes every table and card on the
// page exactly like the header account switch does. One selection model, not
// three.
import { useMemo } from 'react'
import { aggregateAccounts, scopeLabel, ALL_SCOPE } from '../lib/perf-aggregate.js'

// Matches the palette the Performance page already uses (passed in, so this
// component never re-declares the theme).
const cell = { fontSize: 'var(--fs-d9)', fontVariantNumeric: 'tabular-nums' }

/**
 * @param {{acctCards: Array, palette: object, money: Function, signed: Function}} props
 */
export default function PerfAccountScope({ acctCards, palette, money, signed, scope = ALL_SCOPE, onScopeChange }) {
  const { P_GL, P_GBD, P_MU, P_SB, P_UP, P_DN, P_ACC, P_EDG, P_WRN } = palette
  // Controlled: the page owns the scope (its `acct` filter) and every section
  // follows it. This component only reports the click.
  const setScope = (s) => { if (onScopeChange) onScopeChange(s) }

  const agg = useMemo(() => aggregateAccounts(acctCards), [acctCards])
  // A previously-selected account that has since left the in-play list falls
  // back to ALL rather than showing an empty detail panel for something gone.
  const known = scope === ALL_SCOPE || acctCards.some(c => String(c.id) === String(scope))
  const active = known ? scope : ALL_SCOPE
  const label = scopeLabel(active, acctCards)

  const card = (selected, onClick, key, children, aria) => (
    <div
      key={key}
      role="radio"
      aria-checked={selected}
      aria-label={aria}
      tabIndex={selected ? 0 : -1}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      style={{
        background: P_GL,
        // Selection is a 2px accent ring; unselected keeps a 1px neutral edge so
        // the cards do not resize on selection (a shifting grid reads as a reload).
        border: selected ? `2px solid ${P_ACC}` : `1px solid ${P_GBD}`,
        padding: selected ? '5px 9px' : '6px 10px',
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        cursor: 'pointer',
      }}
    >
      {children}
    </div>
  )

  const selChip = (on) => on ? (
    <span style={{ fontSize: 'var(--fs-d8)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: P_ACC }}>
      ✓ selected
    </span>
  ) : null

  return (
    <div>
      {/* The always-visible scope line. Sits directly above the cards AND is
          repeated inside the detail panel, because the panel is what people
          read the numbers from. */}
      <div
        role="status"
        aria-live="polite"
        style={{ ...cell, marginBottom: 6, color: P_SB }}
      >
        <span style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>
          Performance scope:{' '}
        </span>
        <span style={{ fontWeight: 800, color: P_ACC }}>{label}</span>
        {active === ALL_SCOPE && agg.accountCount > 0 && (
          <span style={{ marginLeft: 6, color: P_MU }}>
            {' · '}
            {agg.liveCount} live · {agg.demoCount} demo
            {agg.offCount > 0 ? ` · ${agg.offCount} off in Connect but still holding risk` : ''}
          </span>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label="Performance account scope"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}
      >
        {/* ALL ACCOUNTS · SUMMARY — first, and deliberately NOT dressed as a
            trading account: no LIVE/DEMO/OFF badge, no loss-cap bar of its own,
            because it is a portfolio scope rather than somewhere orders go. */}
        {card(active === ALL_SCOPE, () => setScope(ALL_SCOPE), '__all',
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ flexShrink: 0, fontSize: 'var(--fs-d9)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: P_ACC }}>
                All accounts · summary
              </span>
              <span style={{ marginLeft: 'auto' }}>{selChip(active === ALL_SCOPE)}</span>
            </div>
            <div style={{ ...cell, color: P_MU }}>
              {agg.accountCount} account{agg.accountCount === 1 ? '' : 's'} in play
              {agg.mixedCurrency ? ` · ${agg.currencies.join(' + ')}` : agg.primary ? ` · ${agg.primary.ccy}` : ''}
            </div>
            {agg.primary && (
              <div style={{ ...cell, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 800 }}>{agg.primary.bal != null ? money(agg.primary.bal) : '—'}</span>
                <span style={{ color: agg.primary.day == null ? P_MU : agg.primary.day >= 0 ? P_UP : P_DN }}>
                  day {agg.primary.day != null ? signed(agg.primary.day) : '—'}
                </span>
              </div>
            )}
          </>,
          `All accounts summary, ${agg.accountCount} accounts`)}

        {acctCards.map(a => {
          const on = String(active) === String(a.id)
          return card(on, () => setScope(a.id), a.id,
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ flexShrink: 0, fontSize: 'var(--fs-d9)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>
                  {a.name} · {a.ccy}
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  {selChip(on)}
                  <span style={{ ...cell, fontWeight: 600, color: a.hasToday ? (a.day >= 0 ? P_UP : P_DN) : P_MU }}>
                    day {a.hasToday ? signed(a.day) : '—'}
                  </span>
                </span>
              </div>
              <div style={{ ...cell, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 800 }}>{a.bal != null ? money(a.bal) : '—'}</span>
                <span style={{ color: P_SB }}>equity {a.equity != null ? money(a.equity) : '—'}</span>
              </div>
              <span style={{ ...cell, color: P_MU }}>
                loss-cap used{' '}
                <span style={{ fontWeight: 600, color: a.usedCol }}>{a.used != null ? `${a.used}%` : '—'}</span>
                {' '}of −{a.cap != null ? money(a.cap, 0) : '—'} daily stop
              </span>
            </>,
            `${a.name}, balance ${a.bal != null ? money(a.bal) : 'unknown'}`)
        })}
      </div>

      {/* THE DETAIL PANEL — the only thing that changes when the scope changes. */}
      <div style={{ marginTop: 8, background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, padding: '6px 10px' }}>
        <div style={{ ...cell, marginBottom: 4, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>
            Showing
          </span>
          <span style={{ fontWeight: 800, color: P_ACC }}>{label}</span>
        </div>

        {active === ALL_SCOPE ? (
          agg.groups.length === 0 ? (
            <div style={{ ...cell, color: P_MU }}>No accounts in play — nothing to consolidate.</div>
          ) : (
            <>
              {agg.mixedCurrency && (
                <div style={{ ...cell, color: P_WRN, marginBottom: 4 }}>
                  These accounts hold {agg.currencies.join(' and ')}. Totals are shown per currency —
                  adding them would invent a number, and no FX rate is available on this data.
                </div>
              )}
              {agg.groups.map(g => (
                <div key={g.ccy} style={{ borderTop: `1px solid ${P_EDG}`, paddingTop: 4, marginTop: 4 }}>
                  <div style={{ ...cell, fontWeight: 800, color: P_MU, textTransform: 'uppercase' }}>
                    {g.ccy} · {g.accountCount} account{g.accountCount === 1 ? '' : 's'}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6, marginTop: 3 }}>
                    <Metric label="Total balance" value={g.bal != null ? money(g.bal) : '—'} palette={palette} />
                    <Metric label="Total equity" value={g.equity != null ? money(g.equity) : '—'} palette={palette}
                      hint="Only accounts whose equity the broker snapshot has reported are included." />
                    <Metric label="Day P&L" value={g.day != null ? signed(g.day) : '—'} palette={palette}
                      tone={g.day == null ? null : g.day >= 0 ? P_UP : P_DN} />
                    <Metric label="TP nett today" value={g.gw != null ? signed(g.gw) : '—'} palette={palette} tone={P_UP} />
                    <Metric label="SL nett today" value={g.gl != null ? signed(-g.gl) : '—'} palette={palette} tone={P_DN} />
                    <Metric label="30D pace" value={g.pace30d != null ? `${signed(g.pace30d)}/day` : '—'} palette={palette}
                      tone={g.pace30d == null ? null : g.pace30d >= 0 ? P_UP : P_DN}
                      hint="Σ of each account's 30-day net ÷ 30 — not an average of their individual paces." />
                    <Metric
                      label="Loss-cap used"
                      value={g.usedPct != null ? `${g.usedPct}% of −${money(g.cap, 0)}` : '—'}
                      palette={palette}
                      tone={g.usedPct == null ? null : g.usedPct > 66 ? P_DN : g.usedPct > 33 ? P_WRN : P_ACC}
                      hint="Σ of today's realised losses ÷ Σ of the daily stops. Averaging the per-account percentages would be wrong: unequal caps make the mean meaningless."
                    />
                  </div>
                </div>
              ))}
            </>
          )
        ) : (() => {
          const a = acctCards.find(c => String(c.id) === String(active))
          if (!a) return <div style={{ ...cell, color: P_MU }}>That account is no longer in play.</div>
          return (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6 }}>
              <Metric label="Balance" value={a.bal != null ? money(a.bal) : '—'} palette={palette} />
              <Metric label="Equity" value={a.equity != null ? money(a.equity) : '—'} palette={palette} />
              <Metric label="Day P&L" value={a.hasToday ? signed(a.day) : '—'} palette={palette}
                tone={!a.hasToday ? null : a.day >= 0 ? P_UP : P_DN} />
              <Metric label="TP nett today" value={a.hasToday ? signed(a.gw) : '—'} palette={palette} tone={P_UP} />
              <Metric label="SL nett today" value={a.hasToday ? signed(-a.gl) : '—'} palette={palette} tone={P_DN} />
              <Metric label="30D pace" value={a.n30 != null ? `${signed(a.n30 / 30)}/day` : '—'} palette={palette}
                tone={a.n30 == null ? null : a.n30 >= 0 ? P_UP : P_DN} />
              <Metric label="Loss-cap used"
                value={a.used != null ? `${a.used}% of −${money(a.cap, 0)}` : '—'}
                palette={palette} tone={a.usedCol} />
            </div>
          )
        })()}
      </div>
    </div>
  )
}

function Metric({ label, value, palette, tone = null, hint = null }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column' }} title={hint || undefined}>
      <span style={{ fontSize: 'var(--fs-d9)', fontWeight: 700, textTransform: 'uppercase', color: palette.P_MU }}>{label}</span>
      <span style={{ fontSize: 'var(--fs-d9)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: tone || 'inherit' }}>{value}</span>
    </span>
  )
}
