// Performance traces of the website through the Chrome DevTools MCP server
// (chrome-devtools-mcp), driven over MCP stdio. Owner mandate 26-09-2026.
//
// GET-only by construction: it loads pages with the read key, which cannot
// authorise any non-GET request (agent/lib/auth-tiers.js). The key is never
// printed: every tool response is scrubbed before it is written or logged.
//
// Each trace runs in a FRESH isolated browser context (cold cache, no
// connections left from the previous page), RUNS times per page and profile;
// summary.md reports the median. Env: TRACE_BASE_URL, AGENT_SECRET_READ,
// PAGES (comma list), PROFILE (desktop|phone), RUNS (3), WINDOW_MS (15000),
// CDP_PORT (9333), TRACE_OUT (./out), TRACE_TOOLS (node_modules prefix).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { withSynthetic, syntheticInit } from './synthetic.mjs'

const TOOLS = process.env.TRACE_TOOLS
const OUT = path.resolve(process.env.TRACE_OUT || 'out')
const BASE = process.env.TRACE_BASE_URL || 'https://sg-trade.up.railway.app'
const SECRET = process.env.AGENT_SECRET_READ || ''
if (!TOOLS) { console.error('TRACE_TOOLS is not set (run through run-traces.sh)'); process.exit(2) }
if (!SECRET) { console.error('AGENT_SECRET_READ is not set'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const req = createRequire(path.join(TOOLS, 'package.json'))
const load = spec => import(pathToFileURL(req.resolve(spec)).href)
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await load('@modelcontextprotocol/sdk/client/stdio.js')
const bin = req.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')

const scrub = s => String(s ?? '').split(SECRET).join('***')
const PAGES = (process.env.PAGES || '/,/performance,/reasons,/trade,/risk').split(',')
const PROFILES = [
  { name: 'desktop', w: 1440, h: 900, cpu: 1 },
  { name: 'phone', w: 390, h: 844, cpu: 4, net: 'Fast 4G' },
].filter(p => !process.env.PROFILE || p.name === process.env.PROFILE)
const RUNS = Math.max(1, Number(process.env.RUNS || 3))
const WINDOW_MS = Number(process.env.WINDOW_MS || 15000)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin, '--browserUrl', `http://127.0.0.1:${process.env.CDP_PORT || '9333'}`,
    '--no-performance-crux', '--no-usage-statistics', '--redactNetworkHeaders', '--no-page-id-routing', '--workspace', OUT],
  env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
  stderr: 'ignore',
})
const client = new Client({ name: 'bot-trade-perf-trace', version: '1.0.0' })
await client.connect(transport)
const text = r => scrub((r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'))
const call = async (name, args) => text(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }))
// NEW-1: every tab this harness opens says it is synthetic (synthetic.mjs),
// so its presence pings never count as the owner's visible tabs.
const init = `try{localStorage.setItem('agent_url',${JSON.stringify(BASE)});localStorage.setItem('agent_secret',${JSON.stringify(SECRET)})}catch(e){}` + syntheticInit()
const DOM_PROBE = `() => JSON.stringify({ nodes: document.getElementsByTagName('*').length, rows: document.querySelectorAll('tr').length,
  height: document.documentElement.scrollHeight,
  api: performance.getEntriesByType('resource').filter(r => /\\/state\\/|\\/actions\\/|\\/health/.test(r.name)).length,
  apiKB: Math.round(performance.getEntriesByType('resource').filter(r => /\\/state\\/|\\/actions\\/|\\/health/.test(r.name)).reduce((a, r) => a + (r.transferSize || 0), 0) / 1024) })`

const results = []
for (const prof of PROFILES) {
  for (const p of PAGES) {
    for (let run = 1; run <= RUNS; run++) {
      const tag = `${prof.name}${p === '/' ? '-home' : p.replace(/\//g, '-')}-r${run}`
      await call('new_page', { url: 'about:blank', isolatedContext: tag })
      await call('resize_page', { width: prof.w, height: prof.h })
      await call('emulate', { cpuThrottlingRate: prof.cpu, ...(prof.net ? { networkConditions: prof.net } : {}) })
      await call('navigate_page', { type: 'url', url: `${BASE}/health`, initScript: init })
      await call('navigate_page', { type: 'url', url: withSynthetic(BASE + p), initScript: init })
      await sleep(3000)
      await call('performance_start_trace', { reload: true, autoStop: false })
      await sleep(WINDOW_MS)
      const stopped = await call('performance_stop_trace', { filePath: path.join(OUT, `${tag}.json.gz`) })
      const set = (stopped.match(/insight set id:\s*([A-Za-z0-9_-]+)/i) || [])[1]
      const names = [...new Set([...stopped.matchAll(/insight name:\s*([A-Za-z]+)/gi)].map(m => m[1]))]
      let insights = ''
      for (const n of set ? names : []) insights += `\n\n=== ${n} ===\n${await call('performance_analyze_insight', { insightSetId: set, insightName: n })}`
      const net = await call('list_network_requests', { resourceTypes: ['fetch', 'xhr', 'document'] })
      const cons = await call('list_console_messages', {})
      const domRaw = await call('evaluate_script', { function: DOM_PROBE })
      fs.writeFileSync(path.join(OUT, `${tag}.txt`), `${stopped}\n\n# INSIGHTS${insights}\n\n# NETWORK\n${net}\n\n# CONSOLE\n${cons}\n\n# DOM\n${domRaw}\n`)
      let dom = {}
      try { dom = JSON.parse(JSON.parse((domRaw.match(/```json\n([\s\S]*?)\n```/) || [])[1] || '""')) } catch { dom = {} }
      const num = re => { const m = stopped.match(re); return m ? Number(m[1].replace(/,/g, '')) : null }
      results.push({ profile: prof.name, page: p, run, lcp: num(/LCP: ([\d,]+) ms/), cls: num(/CLS: ([\d.]+)/), ...dom, insights: names })
      console.log(new Date().toISOString().slice(11, 19), tag, 'LCP', results.at(-1).lcp, 'CLS', results.at(-1).cls)
      await call('close_page', {}).catch(() => {})
    }
  }
}
await client.close()

const rows = []
for (const prof of PROFILES) for (const p of PAGES) {
  const rs = results.filter(r => r.profile === prof.name && r.page === p)
  const m = k => median(rs.map(r => r[k]))
  rows.push({ page: p, profile: prof.name, runs: rs.length, lcp: m('lcp'), cls: m('cls'), nodes: m('nodes'), rows: m('rows'), api: m('api'), apiKB: m('apiKB') })
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ base: BASE, runs: RUNS, windowMs: WINDOW_MS, results, medians: rows }, null, 1))
const md = ['| Page | Profile | Runs | LCP (median) | CLS (median) | Elements | Rows | Calls | KB |', '|---|---|---|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.page} | ${r.profile} | ${r.runs} | ${r.lcp ?? 'not measured'} ms | ${r.cls ?? 'not measured'} | ${r.nodes ?? '—'} | ${r.rows ?? '—'} | ${r.api ?? '—'} | ${r.apiKB ?? '—'} |`)]
fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n') + '\n')
console.log(md.join('\n'))
