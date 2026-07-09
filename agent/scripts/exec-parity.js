// ---------------------------------------------------------------------------
// agent/scripts/exec-parity.js — prove the C++ sidecar matches the JS path
// before EXEC_ENGINE=cpp ever flips. READ-ONLY by default.
//
//   node agent/scripts/exec-parity.js            # health + reconcile diff
//   node agent/scripts/exec-parity.js --order    # ALSO places ONE minimum
//                                                # order via the sidecar on
//                                                # the demo account, then
//                                                # closes it (asks first)
//
// Env: EXEC_URL (default http://127.0.0.1:8091), EXEC_SECRET, DB_PATH —
// cTrader creds come from the agent DB exactly like the live loop.
// ---------------------------------------------------------------------------

import readline from 'node:readline'

const EXEC_URL = process.env.EXEC_URL || 'http://127.0.0.1:8091'

async function sidecar(method, path, body) {
  const res = await fetch(EXEC_URL + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.EXEC_SECRET || ''}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

const posKey = (p) => `${p.positionId}|${p.tradeData?.symbolId ?? p.symbolId}|${p.tradeData?.volume ?? p.volume}`

async function main() {
  const { initDB } = await import('../db.js')
  const { getCtraderCreds } = await import('../lib/ctrader-creds.js')
  const db = initDB(process.env.DB_PATH || './agent.db')
  const creds = getCtraderCreds(db)
  if (!creds.ready) { console.error('cTrader creds not configured in the agent DB'); process.exit(1) }

  // 1 — sidecar alive and authenticated
  const health = await sidecar('GET', '/health')
  console.log('[parity] sidecar health:', JSON.stringify(health))
  if (!health?.connected) { console.error('[parity] FAIL: sidecar not connected to cTrader'); process.exit(1) }

  // 2 — reconcile via BOTH paths, diff the open-position sets
  const { wsReconcile } = await import('../lib/ctrader-ws.js')
  const [jsRec, cppRec] = await Promise.all([
    wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId),
    sidecar('GET', '/positions'),
  ])
  const jsSet = new Set((jsRec?.position || []).map(posKey))
  const cppSet = new Set((cppRec?.position || []).map(posKey))
  const onlyJs = [...jsSet].filter(k => !cppSet.has(k))
  const onlyCpp = [...cppSet].filter(k => !jsSet.has(k))
  if (onlyJs.length || onlyCpp.length) {
    console.error(`[parity] FAIL: position sets differ — only-js: ${onlyJs.join(' ') || 'none'} · only-cpp: ${onlyCpp.join(' ') || 'none'}`)
    process.exit(1)
  }
  console.log(`[parity] reconcile MATCH — ${jsSet.size} open position(s) identical via both paths`)

  // 3 — optional: one real minimum order through the sidecar (demo only)
  if (process.argv.includes('--order')) {
    if (creds.host?.includes('live')) { console.error('[parity] refusing --order on a LIVE host'); process.exit(1) }
    const symbol = process.argv[process.argv.indexOf('--order') + 1] || 'EURUSD'
    const { getSymbolMap } = await import('../lib/ctrader-creds.js')
    const symbolId = getSymbolMap(db)[symbol.toUpperCase()]
    if (!symbolId) { console.error(`[parity] unknown symbol ${symbol}`); process.exit(1) }
    const { getVolumeMeta } = await import('../lib/lot-sizing.js')
    const meta = await getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ans = await new Promise(r => rl.question(`[parity] place MIN order ${symbol} (${meta.minVolume} units) via the C++ sidecar on DEMO, then close it? yes/no: `, r))
    rl.close()
    if (ans.trim().toLowerCase() !== 'yes') { console.log('[parity] order test skipped'); db.close(); return }
    const exec = await sidecar('POST', '/order', {
      ctidTraderAccountId: parseInt(creds.accountId),
      symbolId: parseInt(symbolId),
      orderType: 'MARKET', tradeSide: 'BUY', volume: meta.minVolume,
      comment: 'parity-test', label: 'parity',
    })
    const positionId = exec?.position?.positionId || exec?.deal?.positionId
    console.log(`[parity] order filled — position ${positionId}, price ${exec?.deal?.executionPrice ?? exec?.position?.price ?? '?'}`)
    const closed = await sidecar('POST', '/close', {
      ctidTraderAccountId: parseInt(creds.accountId),
      positionId: parseInt(positionId), volume: meta.minVolume,
    })
    console.log('[parity] closed —', JSON.stringify(closed)?.slice(0, 200))
    console.log('[parity] ORDER ROUND-TRIP OK via C++ sidecar')
  }
  db.close()
  console.log('[parity] PASS')
}

main().catch(err => { console.error('[parity] error:', err.message); process.exit(1) })
