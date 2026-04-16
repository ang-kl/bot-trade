// Bottom bar - token count + discrete logout.
// Sits at the foot of the feed. Logout clears localStorage and reloads.

export default function BottomBar({ tokenCount = 0 }) {
  const handleLogout = () => {
    if (window.confirm('Clear all local data and reload?')) {
      localStorage.clear()
      window.location.reload()
    }
  }

  return (
    <footer className="flex items-center justify-between border-t border-[var(--color-border)] pt-3 mt-4">
      <span className="t-meta text-[var(--color-muted-light)]">
        Tokens generated: {tokenCount.toLocaleString()}
      </span>
      <button
        type="button"
        onClick={handleLogout}
        className="t-meta text-[var(--color-muted-light)] hover:text-[var(--color-muted)] cursor-pointer underline-offset-2 hover:underline"
      >
        Logout
      </button>
    </footer>
  )
}
