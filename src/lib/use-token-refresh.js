import { useEffect, useRef } from 'react'
import { useStrategy } from './strategy-store.js'

const REFRESH_MARGIN_MS = 5 * 60 * 1000

export default function useTokenRefresh() {
  const { state, dispatch } = useStrategy()
  const { accessToken, refreshToken, tokenExpiresAt, accounts } = state.ctrader
  const refreshing = useRef(false)
  const fetchedAccounts = useRef(false)

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
}
