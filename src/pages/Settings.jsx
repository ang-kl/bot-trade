// Settings - tab shell. cTrader lives in the bottom StatusRibbon + Admin.
// News (Market Rundown), Risk.

import { useState } from 'react'
import NewsTab from '../components/Settings/NewsTab.jsx'
import RiskTab from '../components/Settings/RiskTab.jsx'

const TABS = [
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
  const [active, setActive] = useState('news')
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
