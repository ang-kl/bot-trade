import { useEffect, useRef } from 'react'
import { useStrategy } from './strategy-store.js'

const REFRESH_MARGIN_MS = 5 * 60 * 1000

export default function useTokenRefresh() {
  const { state, dispatch } = useStrategy()
  const { accessToken, refreshToken, tokenExpiresAt } = state.ctrader
  const refreshing = useRef(false)

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
}
