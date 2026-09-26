// Read, over the Chrome DevTools Protocol, the TLS certificate Chrome received
// for the site, and compare it with what the run expects. Exit non-zero on
// any mismatch, so run-traces.sh stops before the read key is ever sent.
//
// Env: CDP_PORT (9333), TRACE_BASE_URL (production), CERT_EXPECT_SUBJECT,
// CERT_EXPECT_ISSUER. With no expectation set it only prints what it saw.
const PORT = process.env.CDP_PORT || '9333'
const BASE = process.env.TRACE_BASE_URL || 'https://sg-trade.up.railway.app'
const EXPECT = { subjectName: process.env.CERT_EXPECT_SUBJECT || '', issuer: process.env.CERT_EXPECT_ISSUER || '' }

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
const ws = new WebSocket(ver.webSocketDebuggerUrl)
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
let seq = 0
const pending = new Map()
const events = []
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } else events.push(d)
})
const send = (method, params = {}, sessionId) => new Promise(resolve => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
})
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Network.enable', {}, sessionId)
// /health is public: no key is set in this context
await send('Page.navigate', { url: `${BASE}/health` }, sessionId)
await new Promise(resolve => setTimeout(resolve, 5000))
const doc = events.find(e => e.method === 'Network.responseReceived' && e.params?.response?.url === `${BASE}/health`)
const sd = doc?.params?.response?.securityDetails
await send('Target.closeTarget', { targetId })
ws.close()
if (!sd) { console.log('CERTPIN FAIL: no securityDetails for', `${BASE}/health`); process.exit(3) }
const got = { subjectName: sd.subjectName, issuer: sd.issuer, protocol: sd.protocol }
const ok = (!EXPECT.subjectName || got.subjectName === EXPECT.subjectName) && (!EXPECT.issuer || got.issuer === EXPECT.issuer)
console.log(ok ? 'CERTPIN OK' : 'CERTPIN FAIL', JSON.stringify(got))
process.exit(ok ? 0 : 4)
