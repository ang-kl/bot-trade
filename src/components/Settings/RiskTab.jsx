// Risk / guardrails tab - arm switch + daily caps.
// Clamping happens in the reducer so wild inputs never escape this form.

import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import Badge from '../common/Badge.jsx'
import { useStrategy } from '../../lib/strategy-store.js'

function NumberRow({ id, label, value, min, max, step, suffix, onChange }) {
  return (
    <div className="flex items-center gap-2 t-sub mb-3">
      <label htmlFor={id} className="w-40 text-[var(--color-text-sub)]">{label}</label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28"
      />
      <span className="text-[var(--color-text-sub)]">{suffix}</span>
    </div>
  )
}

export default function RiskTab() {
  const { state, dispatch } = useStrategy()
  const { armed, perTradePct, dailyMaxLossPct, maxTradesPerDay } = state.risk
  const setRisk = (patch) => dispatch({ type: 'RISK_SET', ...patch })

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="t-label flex-1">Risk &amp; guardrails</h2>
        <Badge tone={armed ? 'up' : 'neutral'}>{armed ? 'ARMED' : 'SAFE'}</Badge>
        <Button
          size="sm"
          variant={armed ? 'danger' : 'primary'}
          onClick={() => dispatch({ type: 'RISK_TOGGLE_ARMED' })}
        >
          {armed ? 'Disarm' : 'Arm'}
        </Button>
      </div>
      <p className="t-sub text-[var(--color-text-sub)] mb-4">
        The agent can only place live orders while <strong>ARMED</strong>. Disarming blocks all new entries but leaves open positions untouched.
      </p>
      <NumberRow
        id="risk-per-trade"
        label="Per-trade risk"
        value={perTradePct}
        min={0}
        max={100}
        step={0.1}
        suffix="%"
        onChange={(v) => setRisk({ perTradePct: v })}
      />
      <NumberRow
        id="risk-daily-loss"
        label="Daily max loss"
        value={dailyMaxLossPct}
        min={0}
        max={100}
        step={0.1}
        suffix="%"
        onChange={(v) => setRisk({ dailyMaxLossPct: v })}
      />
      <NumberRow
        id="risk-max-trades"
        label="Max trades / day"
        value={maxTradesPerDay}
        min={0}
        max={1000}
        step={1}
        suffix="trades"
        onChange={(v) => setRisk({ maxTradesPerDay: v })}
      />
    </Card>
  )
}
