// Sub-navigation for the Accounts section — Overview (broker truth) and
// the Trade Workflow Audit sub-page live under the one Accounts tab.
import { NavLink } from 'react-router-dom'

const LINKS = [
  { to: '/accounts', label: 'Overview', end: true },
  { to: '/accounts/audit', label: 'Workflow audit', end: false },
]

export default function AccountsSubNav() {
  return (
    <nav className="flex gap-1.5" aria-label="Accounts sections">
      {LINKS.map(l => (
        <NavLink key={l.to} to={l.to} end={l.end}
          className={({ isActive }) =>
            `rounded-full px-3 py-1 min-h-[32px] inline-flex items-center text-[11px] font-semibold ${isActive
              ? 'bg-[var(--color-accent)] text-white shadow-[var(--glow-accent)]'
              : 'glass-inset text-[var(--color-text-sub)]'}`}>
          {l.label}
        </NavLink>
      ))}
    </nav>
  )
}
