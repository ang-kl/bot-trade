import { useEffect, useRef } from 'react'
import { useStrategy } from './strategy-store.js'
import { agentPost, agentConfigured, ROLES } from './agent-api.js'

const REFRESH_MARGIN_MS = 5 * 60 * 1000

export default function useTokenRefresh() {
  const { state, dispatch } = useStrategy()
  const { accessToken, refreshToken, tokenExpiresAt, accounts, accountRoles } = state.ctrader
  const refreshing = useRef(false)
  const fetchedAccounts = useRef(false)
  const lastPushed = useRef(null)

  // Auto-refresh token before expiry
  useEffect(() => {
    if (!accessToken || !refreshToken) return

    async function doRefresh() {
      if (refreshing.current) return
      refreshing.current = true
      try {
        const res = await fetch('/api/ctrader', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'refresh-token', refreshToken }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.accessToken) {
          dispatch({
            type: 'CTRADER_SET_TOKENS',
            accessToken: data.accessToken,
            refreshToken: data.refreshToken || refreshToken,
            expiresIn: data.expiresIn || 2592000,
          })
        }
      } catch {}
      refreshing.current = false
    }

    if (!tokenExpiresAt) {
      doRefresh()
      return
    }

    const msUntilRefresh = tokenExpiresAt - Date.now() - REFRESH_MARGIN_MS
    if (msUntilRefresh <= 0) {
      doRefresh()
      return
    }

    const timer = setTimeout(doRefresh, msUntilRefresh)
    return () => clearTimeout(timer)
  }, [accessToken, refreshToken, tokenExpiresAt, dispatch])

  // Auto-fetch accounts on app load if connected but accounts empty
  useEffect(() => {
    if (!accessToken || fetchedAccounts.current) return
    if (accounts && accounts.length > 0) return
    fetchedAccounts.current = true

    ;(async () => {
      try {
        const res = await fetch('/api/ctrader', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'accounts', accessToken }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && Array.isArray(data.accounts) && data.accounts.length > 0) {
          dispatch({ type: 'CTRADER_SET_ACCOUNTS', accounts: data.accounts })
        }
      } catch {}
    })()
  }, [accessToken, accounts, dispatch])

  // Push fresh access token + account roles to every Railway backend the
  // user has wired up (autopilot + copilot). Without this, the backend
  // keeps whatever CTRADER_ACCESS_TOKEN was bootstrapped from env on
  // first boot, so reconcile and order placement silently fail with an
  // expired token. Previously this only ran when the user toggled a
  // role in Settings; we now push on every token change so OAuth
  // completion and the 30-day auto-refresh both reach the backend.
  useEffect(() => {
    if (!accessToken || !accounts || accounts.length === 0) return
    const rolesArray = accounts.map(a => {
      const r = (accountRoles || {})[String(a.accountId)] || { autopilot: false, copilot: false }
      return { accountId: a.accountId, isLive: a.isLive, autopilot: r.autopilot, copilot: r.copilot }
    })
    const payload = { accessToken, accounts: rolesArray }
    const signature = JSON.stringify(payload)
    if (signature === lastPushed.current) return
    lastPushed.current = signature

    const targets = ROLES.filter(r => agentConfigured(r))
    if (targets.length === 0) return
    ;(async () => {
      for (const r of targets) {
        try {
          await agentPost('/actions/ctrader-config', payload, r)
        } catch {}
      }
    })()
  }, [accessToken, accounts, accountRoles])
}
