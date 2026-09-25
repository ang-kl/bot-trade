import { latestPricesNote } from '../lib/latest-prices.js'

// Says "unavailable" when GET /state/prices could not be read, instead of the
// page quietly converting through an empty map. Renders nothing when the read
// succeeded or has not happened yet.
export default function LatestPricesNote({ read }) {
  const note = latestPricesNote(read)
  if (!note) return null
  return <p role="status" data-testid="latest-prices-unavailable" className="text-(length:--fs-body) text-[var(--color-warning-text)]">{note}</p>
}
