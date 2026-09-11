// The switch-policy post (PR-G, owner principle 2): manual — a human alone
// throws the account's entry-mode switch; auto — the bot's readiness pass may
// too. Pure so the component's action is testable without a DOM: the payload
// names the account, the policy and the revision the server must still be at.
export const ENTRY_MODE_POLICIES = ['manual', 'auto']
export const POLICY_LABEL = { manual: 'Manual (human only)', auto: 'Auto (bot may switch)' }

export async function submitEntryModePolicy({ post, accountId, policy, expectedRevision }) {
  if (!accountId) return { ok: false, error: 'no full account id' }
  if (!ENTRY_MODE_POLICIES.includes(policy)) return { ok: false, error: `unknown policy ${policy}` }
  try {
    const r = await post('/actions/entry-mode-policy', { accountId, policy, expectedRevision })
    return { ok: true, ...r }
  } catch (e) {
    const msg = e?.message || String(e)
    return { ok: false, error: /409|revision/.test(msg) ? 'revision_conflict — changed elsewhere, reloaded' : msg }
  }
}
