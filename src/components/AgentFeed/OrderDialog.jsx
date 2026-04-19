// Order placement dialog — pre-filled from synthesis, confirm + send to cTrader.
// Shows volume, entry, SL, TP, R/R ratio, estimated risk.

import { useState } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import Badge from '../common/Badge.jsx'

function fmtPrice(p) {
  if (p == null) return '\u2014'
  const n = Number(p)
  if (!Number.isFinite(n)) return '\u2014'
  return n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
}

export default function OrderDialog({ symbol, synthesis, maxVolume = 0.01, initialOrderType = 'market', marketOpen = true, onConfirm, onCancel }) {
  const [volume, setVolume] = useState(String(maxVolume))
  const [orderType, setOrderType] = useState(!marketOpen && initialOrderType === 'market' ? 'limit' : initialOrderType)
  const [limitPrice, setLimitPrice] = useState(synthesis?.entry ? String(synthesis.entry) : '')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const side = synthesis?.consensus_bias === 'short' ? 'short' : 'long'
  const arrow = side === 'long' ? '\u25B2' : '\u25BC'
  const sideColor = side === 'long' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'

  const aiEntry = Number(synthesis?.entry) || 0
  const effectiveEntry = orderType !== 'market' ? (Number(limitPrice) || aiEntry) : aiEntry
  const [slInput, setSlInput] = useState(synthesis?.sl != null ? String(synthesis.sl) : '')
  const [tpInput, setTpInput] = useState(synthesis?.tp1 != null ? String(synthesis.tp1) : '')

  const sl = Number(slInput) || 0
  const tp1 = Number(tpInput) || 0
  const tp2 = Number(synthesis?.tp2) || null

  const pipSize = symbol?.endsWith('JPY') ? 0.01 : symbol?.startsWith('XAU') ? 0.01 : symbol?.startsWith('XAG') ? 0.001 : symbol?.match(/^(US|NAS|GER|UK|JPN|FRA|SPA|HK|AUS)/) ? 1 : 0.0001
  const slPips = effectiveEntry && sl ? Math.abs(effectiveEntry - sl) / pipSize : 0
  const tp1Pips = effectiveEntry && tp1 ? Math.abs(tp1 - effectiveEntry) / pipSize : 0
  const rr = slPips > 0 ? (tp1Pips / slPips).toFixed(1) : '\u2014'

  const handleSubmit = async () => {
    setSending(true)
    setError(null)
    try {
      await onConfirm({
        symbol,
        side: side === 'long' ? 'BUY' : 'SELL',
        volume: Number(volume) || maxVolume,
        orderType,
        entry: effectiveEntry || null,
        limitPrice: orderType !== 'market' ? (Number(limitPrice) || null) : null,
        stopLoss: sl || null,
        takeProfit: tp1 || null,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <Card className="w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <span className={`t-body font-bold ${sideColor}`}>
            {arrow} {side.toUpperCase()} {symbol}
          </span>
          <Badge tone={side === 'long' ? 'up' : 'down'} pill>{side.toUpperCase()}</Badge>
          {synthesis?.overall_conviction && (
            <Badge tone="info" pill>{synthesis.overall_conviction}/10</Badge>
          )}
        </div>

        {/* Synthesis summary */}
        {synthesis?.synthesis && (
          <p className="t-meta text-[var(--color-text-sub)] mb-3 italic">{synthesis.synthesis}</p>
        )}

        {/* Order type */}
        <div className="flex gap-2 mb-3">
          <Button
            size="sm"
            variant={orderType === 'market' ? 'primary' : 'ghost'}
            onClick={() => marketOpen && setOrderType('market')}
            disabled={!marketOpen}
            title={marketOpen ? '' : 'Market closed — use Limit or Stop Entry'}
          >
            Market{!marketOpen && <span className="ml-1 opacity-50 text-[8px]">closed</span>}
          </Button>
          <Button
            size="sm"
            variant={orderType === 'limit' ? 'primary' : 'ghost'}
            onClick={() => setOrderType('limit')}
          >
            Limit
          </Button>
          <Button
            size="sm"
            variant={orderType === 'stop' ? 'primary' : 'ghost'}
            onClick={() => setOrderType('stop')}
          >
            Stop Entry
          </Button>
        </div>
        {!marketOpen && (
          <p className="text-[10px] text-[var(--color-warning-text)] bg-[var(--color-warning-bg)] border border-[var(--color-warning-border)] rounded-[5px] px-2 py-1 mb-3">
            Market is currently closed. Limit and Stop Entry orders will queue until the market reopens.
          </p>
        )}

        {/* Fields */}
        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-2">
            <label className="t-meta text-[var(--color-muted)] w-16 shrink-0">Volume</label>
            <Input value={volume} onChange={e => setVolume(e.target.value)} className="flex-1" />
            <span className="t-meta text-[var(--color-muted)]">lots</span>
          </div>
          {orderType !== 'market' && (
            <div className="flex items-center gap-2">
              <label className="t-meta text-[var(--color-muted)] w-16 shrink-0">Price</label>
              <Input value={limitPrice} onChange={e => setLimitPrice(e.target.value)} className="flex-1" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="t-meta text-[var(--color-down)] w-16 shrink-0">SL</label>
            <Input value={slInput} onChange={e => setSlInput(e.target.value)} placeholder="Stop Loss" className="flex-1" />
          </div>
          <div className="flex items-center gap-2">
            <label className="t-meta text-[var(--color-up)] w-16 shrink-0">TP</label>
            <Input value={tpInput} onChange={e => setTpInput(e.target.value)} placeholder="Take Profit" className="flex-1" />
          </div>
        </div>

        {/* Levels summary */}
        <div className="rounded-[7px] bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 mb-3 space-y-1 text-[12px]">
          <div className="flex justify-between">
            <span className="text-[var(--color-muted)]">Entry</span>
            <span className="font-mono">
              {orderType === 'market'
                ? <><span className="text-[var(--color-muted)]">Market</span>{aiEntry ? <span className="text-[var(--color-text-sub)] ml-1">(AI: {fmtPrice(aiEntry)})</span> : null}</>
                : fmtPrice(Number(limitPrice) || aiEntry)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-down)]">Stop Loss</span>
            <span className="font-mono">{sl ? <>{fmtPrice(sl)} <span className="text-[var(--color-muted)]">({fmtPrice(slPips)} pips)</span></> : <span className="text-[var(--color-muted)]">Not set</span>}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-up)]">Take Profit</span>
            <span className="font-mono">{tp1 ? <>{fmtPrice(tp1)} <span className="text-[var(--color-muted)]">({fmtPrice(tp1Pips)} pips)</span></> : <span className="text-[var(--color-muted)]">Not set</span>}</span>
          </div>
          {tp2 != null && (
            <div className="flex justify-between">
              <span className="text-[var(--color-up)]">TP2</span>
              <span className="font-mono">{fmtPrice(tp2)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold border-t border-[var(--color-border)] pt-1 mt-1">
            <span className="text-[var(--color-text)]">R/R</span>
            <span className="text-[var(--color-accent)]">1:{rr}</span>
          </div>
        </div>

        {/* Dissent warning */}
        {synthesis?.dissent && (
          <div className="rounded-[7px] bg-[var(--color-warning-bg)] border border-[var(--color-warning-border)] px-3 py-2 mb-3 text-[11px] text-[var(--color-warning-text)]">
            Dissent: {synthesis.dissent}
          </div>
        )}

        {error && (
          <p className="t-meta text-[var(--color-down)] mb-2">{error}</p>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={handleSubmit}
            disabled={sending}
          >
            {sending ? 'Sending...' : `${arrow} Send ${orderType.charAt(0).toUpperCase() + orderType.slice(1)} Order`}
          </Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </Card>
    </div>
  )
}
