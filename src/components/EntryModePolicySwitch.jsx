// EntryModePolicySwitch — the per-account switch POLICY (PR-G, owner
// principle 2): who may throw the entry-mode switch. Renders the SERVER's
// value (row.entryModePolicy from /state/entry-engines); a change posts
// /actions/entry-mode-policy with the row's revision and re-fetches, so what
// is shown after the click is what the server stored, never the click.
import { useState } from 'react'
import { agentPost } from '../lib/agent-api.js'
import { refreshEngineStatusAfterAction } from '../lib/use-engine-status.js'
import { ENTRY_MODE_POLICIES, POLICY_LABEL, submitEntryModePolicy } from '../lib/entry-mode-policy.js'

export default function EntryModePolicySwitch({ row, fullId, busy = false, post = agentPost, onDone = null }) {
  const [pending, setPending] = useState(false)
  const [note, setNote] = useState(null)
  const value = ENTRY_MODE_POLICIES.includes(row?.entryModePolicy) ? row.entryModePolicy : 'manual'
  const disabled = busy || pending || !fullId
  async function onChange(e) {
    const policy = e.target.value
    setPending(true); setNote(null)
    try {
      const r = await submitEntryModePolicy({ post, accountId: fullId, policy, expectedRevision: row.configRevision })
      setNote(r.ok ? `policy → ${r.status?.entryModePolicy || policy} (rev ${r.status?.configRevision ?? '?'})` : r.error)
      if (onDone) onDone(r)
    } finally {
      setPending(false)
      refreshEngineStatusAfterAction() // a poll already in flight predates the post: wait for it, then fetch the stored value
    }
  }
  return (
    <label className="inline-flex items-center gap-1 text-(length:--fs-body)" title={!fullId ? 'the full account id is not on this page yet' : 'manual: only a human throws the entry-mode switch; auto: the bot adds tick next to time after consecutive ready evaluations with tick opportunity ≥ the time path, and removes tick on one failing check'}>
      <span className="text-[var(--color-text-sub)]">switch policy</span>
      <select data-testid={`entry-mode-policy-${row?.accountId}`} value={value} disabled={disabled} onChange={onChange} className="rounded border border-[var(--glass-edge)] bg-transparent px-1">
        {ENTRY_MODE_POLICIES.map(p => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}
      </select>
      {note && <span className="text-[var(--color-text-sub)]">{note}</span>}
    </label>
  )
}
