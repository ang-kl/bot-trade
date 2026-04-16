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
  return Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(5)
}

export default function OrderDialog({ symbol, synthesis, maxVolume = 0.01, onConfirm, onCancel }) {
  const [volume, setVolume] = useState(String(maxVolume))
  const [orderType, setOrderType] = useState('market')
  const [limitPrice, setLimitPrice] = useState(synthesis?.entry ? String(synthesis.entry) : '')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const side = synthesis?.consensus_bias === 'short' ? 'short' : 'long'
  const arrow = side === 'long' ? '\u25B2' : '\u25BC'
  const sideColor = side === 'long' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'

  const entry = Number(synthesis?.entry) || 0
  const sl = Number(synthesis?.sl) || 0
  const tp1 = Number(synthesis?.tp1) || 0
  const tp2 = Number(synthesis?.tp2) || null

  const slPips = entry && sl ? Math.abs(entry - sl) : 0
  const tp1Pips = entry && tp1 ? Math.abs(tp1 - entry) : 0
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
        limitPrice: orderType === 'limit' ? Number(limitPrice) : null,
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
            onClick={() => setOrderType('market')}
          >
            Market
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
        </div>

        {/* Levels summary */}
        <div className="rounded-[7px] bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 mb-3 space-y-1 text-[12px]">
          <div className="flex justify-between">
            <span className="text-[var(--color-muted)]">Entry</span>
            <span className="font-mono">{fmtPrice(entry)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-down)]">Stop Loss</span>
            <span className="font-mono">{fmtPrice(sl)} <span className="text-[var(--color-muted)]">({fmtPrice(slPips)} pips)</span></span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-up)]">Take Profit</span>
            <span className="font-mono">{fmtPrice(tp1)} <span className="text-[var(--color-muted)]">({fmtPrice(tp1Pips)} pips)</span></span>
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
