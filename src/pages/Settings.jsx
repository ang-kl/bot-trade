// Settings - tab shell for Phase 4. Four tabs per HANDOVER-V2:
// cTrader (OAuth + accounts), Watchlist, News (Market Rundown), Risk.

import { useState } from 'react'
import CTraderTab from '../components/Settings/CTraderTab.jsx'
import WatchlistTab from '../components/Settings/WatchlistTab.jsx'
import NewsTab from '../components/Settings/NewsTab.jsx'
import RiskTab from '../components/Settings/RiskTab.jsx'

const TABS = [
  { id: 'watchlist', label: 'Watchlist', Component: WatchlistTab },
  { id: 'ctrader', label: 'Trading Platform', Component: CTraderTab },
  { id: 'news', label: 'News', Component: NewsTab },
  { id: 'risk', label: 'Risk', Component: RiskTab },
]

function tabClass(active) {
  const base = 'px-3 py-2 t-sub font-medium border-b-2 -mb-px transition-colors'
  return active
    ? `${base} border-[var(--color-accent)] text-[var(--color-text)]`
    : `${base} border-transparent text-[var(--color-text-sub)] hover:text-[var(--color-text)]`
}

export default function Settings() {
  const [active, setActive] = useState('watchlist')
  const current = TABS.find(t => t.id === active) || TABS[0]
  const Tab = current.Component
  return (
    <section>
      <h1 className="text-xl t-label mb-4">Settings</h1>
      <div role="tablist" className="flex gap-1 mb-4 border-b border-[var(--color-border)] overflow-x-auto scrollbar-none">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={active === t.id}
            aria-controls={`settings-panel-${t.id}`}
            onClick={() => setActive(t.id)}
            className={`${tabClass(active === t.id)} whitespace-nowrap`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`settings-panel-${current.id}`} role="tabpanel">
        <Tab />
      </div>
    </section>
  )
}
