// Navigation rosters, outside the components so react-refresh stays happy.
//
// Apple's HIG (owner, 2026-07-29): "Limit tabs to five or fewer on mobile to
// avoid overcrowding and overflow 'More' lists." Four sections plus More is
// the bar; the Setup routes live behind More. Desktop keeps all seven in the
// sidebar, where there is room and no bar to overcrowd.

export const PRIMARY_TABS = [
  { to: '/performance', label: 'Performance', icon: '📊' },
  { to: '/desk', label: 'Desk', icon: '🖥️' },
  { to: '/trade', label: 'Trade', icon: '📈' },
  { to: '/accounts', label: 'Accounts', icon: '💼' },
]

export const MORE_TABS = [
  { to: '/tune', label: 'Tune', icon: '⚙️' },
  { to: '/risk', label: 'Risk', icon: '🛡️' },
  { to: '/connect', label: 'Connect', icon: '🔗' },
]
