// Watchlist compare & copy — two accounts side by side, tick rows, transfer.
//
// Owner (2026-07-29): "i need the option to compare the trading account
// watchlist. like two tables of watch list each account. and each account
// table has 3 tables, i can checkbox transfer."
//
// THE THREE TABLES ARE THE DIFF, not market groups. A compare view whose only
// question is "is this symbol present" would answer "yes, both" for a symbol
// that sits on one account with a 0.5-lot cap and on the other with 0.05 —
// which is not the same instrument arrangement at all. So each panel splits
// into: only here · on both but configured differently · identical. The
// middle table is the one worth looking at, so it renders first.
//
// Copying carries the SETTINGS (enabled, group, Max lots, conviction
// threshold, allowed styles, bias override), because a copy that moved only
// the ticker would silently resize the trade on arrival.
import { Fragment, useEffect, useMemo, useState } from 'react'
import Card from '../common/Card.jsx'
import Badge from '../common/Badge.jsx'
import Button from '../common/Button.jsx'
import { agentGet, agentPost } from '../../lib/agent-api.js'
import Collapse from '../common/Collapse.jsx'
import { buildClassTree, classLabel, groupLabel, symbolsOfBand } from '../../lib/asset-class.js'

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return d.toISOString().slice(0, 10)
}

// null is NOT zero. A symbol with no cached price has an UNKNOWN margin, and
// printing "$0" would read as "this instrument is free to hold".
const fmtMoney = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`)

// THE SAME ACCOUNT HAS TWO IDs, and this picker used to show the one the
// operator never sees anywhere else. cTrader's ctidTraderAccountId (4xxxxxxx)
// is what the registry keys on; the broker LOGIN (5xxxxxx) is what the account
// picker higher up this very page displays. Owner, 2026-07-29: "the account I
// pick to trade starts with five but the account I selected as source to copy
// the watchlist starts with four — how do I know which one am I using now?"
// They could not, and that is a way to copy a watchlist onto the wrong
// account. Lead with the login so the two lists line up, and keep the ctid
// visible so nothing is hidden.
const acctLabel = (a) => [
  a.traderLogin ? `Login ${a.traderLogin}` : `Account ${a.accountId}`,
  a.isLive ? 'LIVE' : 'DEMO',
  a.traderLogin ? `id ${a.accountId}` : null,
  a.isSelected ? '← the bot trades this one' : null,
].filter(Boolean).join(' · ')

/** The settings that travel with a symbol, rendered for the eye. */
function settingsSummary(i) {
  const bits = []
  if (i.enabled === false) bits.push('off')
  if (Number(i.maxVolume) > 0) bits.push(`max ${i.maxVolume}`)
  if (i.autoTradeThreshold != null) bits.push(`conv ≥${i.autoTradeThreshold}`)
  if (Array.isArray(i.allowed_styles) && i.allowed_styles.length) bits.push(i.allowed_styles.join('/'))
  if (i.override_bias) bits.push(`bias ${i.override_bias}`)
  return bits.join(' · ') || '—'
}

/** A band header row: triangle, select-all checkbox, name, counts. */
function BandRow({ open, onOpen, allOn, someOn, onToggleAll, label, count, onCount, indent = 0, strong = false }) {
  return (
    <tr className={`border-b border-[var(--color-border)] ${strong ? 'bg-[var(--glass-bg)]' : ''}`}>
      <td className="py-1 pr-2" style={{ paddingLeft: indent }}>
        <input
          type="checkbox"
          checked={allOn}
          // Indeterminate is the honest state for a partly-ticked band —
          // showing it unchecked would say "none of this is selected".
          ref={el => { if (el) el.indeterminate = !allOn && someOn }}
          onChange={() => onToggleAll(!allOn)}
          aria-label={`Select all — ${label}`}
        />
      </td>
      <td colSpan={5} className="py-1">
        <button
          type="button" onClick={onOpen} aria-expanded={open}
          className={`flex items-center gap-1.5 cursor-pointer ${strong ? 'font-bold' : 'font-semibold'}`}
        >
          <span aria-hidden="true" className="inline-block w-3 text-(length:--fs-body)">{open ? '▾' : '▸'}</span>
          {label}
          <span className="font-normal text-[var(--color-text-sub)]">({count} symbol{count === 1 ? '' : 's'} · {onCount} armed)</span>
        </button>
      </td>
    </tr>
  )
}

function SymbolTable({ title, tone, rows, checked, onToggle, onToggleAll, compareWith = null }) {
  // Classification › Group › Symbol (owner 02-08-2026: "the group should be a
  // tree structure"). The THREE TABLES stay as they are — they are the diff,
  // not market groups, and that distinction is the point of this panel. The
  // tree lives INSIDE each one.
  //
  // The practical win is the checkbox on every band: copying "all Forex" or one
  // preset group was forty ticks and is now one, and a partly-ticked band shows
  // indeterminate rather than pretending to be empty.
  const bands = useMemo(() => buildClassTree(rows), [rows])
  const [shut, setShut] = useState(() => new Set())
  const isOpen = (k) => !shut.has(k)
  const toggleOpen = (k) => setShut(prev => {
    const next = new Set(prev)
    next.has(k) ? next.delete(k) : next.add(k)
    return next
  })

  if (!rows.length) return null
  const allOn = rows.every(r => checked.has(r.symbol))
  const armed = (list) => list.filter(i => i.enabled !== false).length
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 mb-1">
        <label className="flex items-center gap-1.5 text-(length:--fs-body) cursor-pointer">
          <input
            type="checkbox"
            checked={allOn}
            onChange={() => onToggleAll(rows.map(r => r.symbol), !allOn)}
            aria-label={`Select all — ${title}`}
          />
          <Badge tone={tone}>{title}</Badge>
          <span className="text-[var(--color-text-sub)]">{rows.length}</span>
        </label>
      </div>
      <div className="overflow-x-auto">
        <Collapse id="WatchlistCompare_83" label="Watchlist Rows">
        <table className="std-cols w-full text-(length:--fs-body) tabular-nums">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-1 pr-2 w-6" aria-label="Select" />
              <th className="py-1 pr-3 text-left">Symbol</th>
              <th className="py-1 pr-3 text-left">Settings</th>
              <th className="py-1 pr-3 text-left">Last traded</th>
              <th className="py-1 pr-3 text-right">Margin/lot</th>
              <th className="py-1" aria-label="spacer" />
            </tr>
          </thead>
          <tbody>
            {bands.map(([cls, byGroup]) => {
              const clsKey = `${title}|cls:${cls}`
              const clsSyms = symbolsOfBand(byGroup)
              const clsItems = [...byGroup.values()].flat()
              const clsAll = clsSyms.every(s => checked.has(s))
              const clsSome = clsSyms.some(s => checked.has(s))
              return (
                <Fragment key={clsKey}>
                  <BandRow
                    strong open={isOpen(clsKey)} onOpen={() => toggleOpen(clsKey)}
                    allOn={clsAll} someOn={clsSome}
                    onToggleAll={(on) => onToggleAll(clsSyms, on)}
                    label={classLabel(cls)} count={clsSyms.length} onCount={armed(clsItems)}
                  />
                  {isOpen(clsKey) && [...byGroup.entries()].map(([g, items]) => {
                    const gKey = `${clsKey}|grp:${g}`
                    const gSyms = items.map(i => i.symbol)
                    const gAll = gSyms.every(s => checked.has(s))
                    const gSome = gSyms.some(s => checked.has(s))
                    return (
                      <Fragment key={gKey}>
                        <BandRow
                          open={isOpen(gKey)} onOpen={() => toggleOpen(gKey)}
                          allOn={gAll} someOn={gSome}
                          onToggleAll={(on) => onToggleAll(gSyms, on)}
                          label={groupLabel(g)} count={gSyms.length} onCount={armed(items)}
                          indent={12}
                        />
                        {isOpen(gKey) && items.map(r => (
                          <tr key={r.symbol} className="border-b border-[var(--color-border)]">
                            <td className="py-1 pr-2" style={{ paddingLeft: 24 }}>
                              <input
                                type="checkbox"
                                checked={checked.has(r.symbol)}
                                onChange={() => onToggle(r.symbol)}
                                aria-label={`Select ${r.symbol}`}
                              />
                            </td>
                            <td className={`py-1 pr-3 font-semibold ${r.enabled === false ? 'text-[var(--color-text-sub)] line-through' : ''}`}>{r.symbol}</td>
                            <td className="py-1 pr-3 text-[var(--color-text-sub)]">
                              {settingsSummary(r)}
                              {/* On the "differs" table, saying what the OTHER side has is
                                  the whole point — otherwise the operator has to read two
                                  tables side by side and hold the values in their head. */}
                              {compareWith?.[r.symbol] && (
                                <span className="block text-[var(--color-warning-text)]">other: {settingsSummary(compareWith[r.symbol])}</span>
                              )}
                            </td>
                            <td className="py-1 pr-3 text-[var(--color-text-sub)]">{fmtDate(r.lastTradedAt)}</td>
                            <td className="py-1 pr-3 text-right">{fmtMoney(r.marginPerLotUsd)}</td>
                            <td className="py-1" />
                          </tr>
                        ))}
                      </Fragment>
                    )
                  })}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        </Collapse>
      </div>
    </div>
  )
}

function Panel({ role, accounts, value, onChange, other, data, checked, setChecked }) {
  const acct = data?.accounts?.find(a => a.accountId === value) || null
  const otherAcct = data?.accounts?.find(a => a.accountId === other) || null

  // The diff is computed here rather than fetched per selection change: the
  // route already returned every account's full list, so re-asking the server
  // for a pairing it can derive locally would just add a round trip.
  const { onlyHere, differs, same, otherBySym } = useMemo(() => {
    const mine = acct?.items || []
    const theirs = otherAcct?.items || []
    const theirBySym = Object.fromEntries(theirs.map(i => [i.symbol, i]))
    const FIELDS = ['enabled', 'group', 'maxVolume', 'autoTradeThreshold', 'allowed_styles', 'override_bias']
    const eq = (a, b) => FIELDS.every(f => JSON.stringify(a?.[f] ?? null) === JSON.stringify(b?.[f] ?? null))
    const onlyH = [], diff = [], sm = []
    for (const i of mine) {
      const t = theirBySym[i.symbol]
      if (!t) onlyH.push(i)
      else if (eq(i, t)) sm.push(i)
      else diff.push(i)
    }
    const bySym = (l) => [...l].sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.symbol.localeCompare(b.symbol))
    return { onlyHere: bySym(onlyH), differs: bySym(diff), same: bySym(sm), otherBySym: theirBySym }
  }, [acct, otherAcct])

  const toggle = (sym) => setChecked(prev => {
    const next = new Set(prev)
    next.has(sym) ? next.delete(sym) : next.add(sym)
    return next
  })
  const toggleAll = (syms, on) => setChecked(prev => {
    const next = new Set(prev)
    for (const s of syms) on ? next.add(s) : next.delete(s)
    return next
  })

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="text-(length:--fs-body) font-bold uppercase tracking-wide text-[var(--color-accent)]">{role}</span>
        <select
          value={value || ''}
          onChange={e => { onChange(e.target.value || null); setChecked(new Set()) }}
          className="text-(length:--fs-body) bg-transparent border border-[var(--color-border)] rounded-[6px] px-1.5 py-1 max-[430px]:!min-h-[44px]"
          aria-label={`${role} account`}
        >
          <option value="">— pick an account —</option>
          {accounts.map(a => <option key={a.accountId} value={a.accountId}>{acctLabel(a)}</option>)}
        </select>
        {acct && (
          <>
            <Badge tone={acct.isLive ? 'down' : 'info'}>{acct.isLive ? 'LIVE' : 'DEMO'}</Badge>
            {/* The one the bot is actually trading. Without this the operator
                has to hold the login↔id mapping in their head to tell whether
                they are about to overwrite the account that is live-trading. */}
            {acct.isSelected && <Badge tone="warning">the bot trades this one</Badge>}
            <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">
              {acct.traderLogin && <>Login {acct.traderLogin} · id {acct.accountId} · </>}
              {acct.enabledCount}/{acct.count} armed · 1:{acct.leverage}
            </span>
            {/* Two accounts that are both inheriting look identical because
                they ARE the same list — not because anyone synced them. */}
            {acct.inherited && <Badge tone="warning">inheriting the shared list</Badge>}
          </>
        )}
      </div>

      {!acct && <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">Pick an account to see its watchlist.</p>}
      {acct && !otherAcct && (
        <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">Pick the other account to see the comparison.</p>
      )}
      {acct && otherAcct && (
        <>
          <SymbolTable title="Configured differently" tone="warning" rows={differs} compareWith={otherBySym}
            checked={checked} onToggle={toggle} onToggleAll={toggleAll} />
          <SymbolTable title="Only here" tone="info" rows={onlyHere}
            checked={checked} onToggle={toggle} onToggleAll={toggleAll} />
          <SymbolTable title="Identical on both" tone="up" rows={same}
            checked={checked} onToggle={toggle} onToggleAll={toggleAll} />
          {!differs.length && !onlyHere.length && !same.length && (
            <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">This account's watchlist is empty.</p>
          )}
        </>
      )}
    </div>
  )
}

export default function WatchlistCompare() {
  const [data, setData] = useState(null)
  const [source, setSource] = useState(null)
  const [destination, setDestination] = useState(null)
  const [srcChecked, setSrcChecked] = useState(new Set())
  const [dstChecked, setDstChecked] = useState(new Set())
  const [mode, setMode] = useState('merge')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')

  const load = () => agentGet('/state/watchlists')
    .then(r => {
      setData(r)
      // Default the source to the account currently selected in the agent —
      // the one whose watchlist the operator has been curating.
      setSource(s => s ?? (r?.selectedAccountId ? String(r.selectedAccountId) : null))
    })
    .catch(e => setError(e.message))

  useEffect(() => { load() }, [])

  const accounts = data?.accounts || []

  // Name an account the way the operator sees it everywhere else — by broker
  // login — with the internal id in brackets. A confirmation that said only
  // "account 46130058" is not a confirmation anyone can check.
  const nameOf = (id) => {
    const a = accounts.find(x => String(x.accountId) === String(id))
    if (!a) return `account ${id}`
    const bits = [a.isLive ? 'LIVE' : 'demo', `id ${a.accountId}`]
    if (a.isSelected) bits.push('the account the bot trades')
    return `${a.traderLogin ? `Login ${a.traderLogin}` : `account ${a.accountId}`} (${bits.join(', ')})`
  }

  const copy = async (from, to, symbols) => {
    if (!from || !to || !symbols.length) return
    const dst = accounts.find(x => String(x.accountId) === String(to[0]))
    // A copy changes what an account may trade. Onto a LIVE account, or onto
    // the one the bot is currently trading, that is a live-money change and
    // gets named out loud before it happens — the whole reason the owner could
    // not tell which account was which.
    if (dst?.isLive || dst?.isSelected) {
      const ok = window.confirm(
        `This will change what ${nameOf(to[0])} may trade.\n\n` +
        `${symbols.length} symbol(s) from ${nameOf(from)}. Continue?`
      )
      if (!ok) return
    }
    if (mode === 'replace') {
      const ok = window.confirm(
        `REPLACE will make ${nameOf(to[0])}'s watchlist exactly the ${symbols.length} selected symbol(s).\n\n` +
        'Everything else it currently watches will be removed. Continue?'
      )
      if (!ok) return
    }
    setBusy(true); setError(''); setReport(null)
    try {
      const r = await agentPost('/actions/watchlist-copy', { from, to, symbols, mode })
      setReport(r)
      setSrcChecked(new Set()); setDstChecked(new Set())
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h2 className="t-h3" id="sec-watchlists">3 · Compare & Copy Watchlists table</h2>
        <Button size="sm" variant="ghost" onClick={load} disabled={busy}>Refresh</Button>
      </div>
      <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-2">
        Tick symbols on either side and transfer them. A copy carries the symbol's settings —
        armed/off, market group, Max lots, conviction threshold, allowed styles, bias override —
        not just the ticker.
      </p>

      {error && <div className="text-(length:--fs-body) text-[var(--color-down)] mb-2">{error}</div>}
      {!data && !error && <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">Loading…</p>}

      {data && accounts.length < 2 && (
        <p className="text-(length:--fs-body) text-[var(--color-warning-text)]">
          Only {accounts.length} account in the registry — link a second one above to compare.
        </p>
      )}

      {data && accounts.length >= 2 && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel role="Source" accounts={accounts} value={source} onChange={setSource}
              other={destination} data={data} checked={srcChecked} setChecked={setSrcChecked} />
            <Panel role="Destination" accounts={accounts} value={destination} onChange={setDestination}
              other={source} data={data} checked={dstChecked} setChecked={setDstChecked} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
            <Button size="sm" disabled={busy || !srcChecked.size || !source || !destination}
              onClick={() => copy(source, [destination], [...srcChecked])}>
              Copy {srcChecked.size || ''} → Destination
            </Button>
            <Button size="sm" variant="subtle" disabled={busy || !dstChecked.size || !source || !destination}
              onClick={() => copy(destination, [source], [...dstChecked])}>
              Source ← Copy {dstChecked.size || ''}
            </Button>
            <label className="flex items-center gap-1.5 text-(length:--fs-body) cursor-pointer">
              <input type="checkbox" checked={mode === 'replace'}
                onChange={e => setMode(e.target.checked ? 'replace' : 'merge')} />
              {/* Replace is destructive, so it is opt-in by name and confirmed
                  before it runs. Merge never removes anything. */}
              <span>Replace the destination list entirely (otherwise merge)</span>
            </label>
            {busy && <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">Copying…</span>}
          </div>

          {/* "Copied" with no numbers is not something an operator can check. */}
          {report && (
            <div className="mt-2 text-(length:--fs-body)">
              {report.results.map(r => (
                <div key={r.accountId}>
                  <span className="font-semibold">{nameOf(report.from)} → {nameOf(r.accountId)}</span>
                  {' '}({report.mode}): added {r.added.length}, updated {r.updated.length}
                  {r.removed.length > 0 && <span className="text-[var(--color-down)]">, removed {r.removed.length} ({r.removed.join(', ')})</span>}
                  {' '}— now watching {r.total}.
                  {r.inherited && (
                    <span className="text-[var(--color-warning-text)]">
                      {' '}This account was following the shared list; it now owns its own and will no longer pick up shared edits.
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
