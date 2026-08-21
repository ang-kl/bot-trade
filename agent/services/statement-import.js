// ---------------------------------------------------------------------------
// agent/services/statement-import.js — load cTrader statement exports into
// broker_deals as authoritative history.
//
// WHY THIS EXISTS. Owner, 21-08-2026: "load these into the agent's database as
// the authoritative history." The statements are the broker's own account
// exports — the same ledger the API serves, but reaching back further than the
// windows the loop has ever fetched, and surviving whatever the database
// lost along the way.
//
// HOW THE FILES ARRIVE. Committed under agent/seed-statements/ and imported
// once per boot. That path is deliberate: the operator cannot POST to the
// agent from here, and a seed directory inside the image needs no secret, no
// route and no manual step — the next deploy loads it, and every boot after
// that is a no-op because the upsert is idempotent on the broker's deal id.
//
// THE DEAL ID IS NORMALISED, and this is the one line that keeps two sources
// from double-counting: statements write "DID315186380", the API writes
// 315186380. Stripping the DID prefix makes the same fill from either source
// land on the same broker_deals row instead of beside it.
//
// THE ACCOUNT IS RESOLVED, NEVER TRUSTED FROM THE FILE NAME ALONE. Filenames
// carry the human trader login (Acct_5306502__...); the database keys accounts
// by ctidTraderAccountId (accounts.account_id, e.g. 46130058). The importer
// looks the login up in the accounts table and REFUSES the whole file when it
// cannot: a deal filed under a wrong or unmapped account never heals, and
// NULL-account rows are second-class everywhere else in this codebase.
//
// WHAT A STATEMENT CANNOT PROVIDE, said here so nobody hunts for it later:
// position ids (the export has order ids, which are a different object), so
// matched_trade_id stays NULL and these rows do not join to local trades;
// swap and gross are not broken out (Net includes them), so net_pnl is the
// authoritative money and gross_pnl/swap stay NULL rather than being derived
// by arithmetic the export does not support.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

/** "1 428" / "-1 049.40" — the export uses spaces as thousands separators. */
export function num(text) {
  const t = String(text ?? '').replace(/\s+/g, '').replace(/,/g, '')
  if (t === '' || t === '—') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** "13.8 Lots" / "1 428 Lots" → 1428. */
export function lots(text) {
  return num(String(text ?? '').replace(/lots?/i, ''))
}

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

/**
 * "20 Aug 2026 21:56:13.342" in the export's UTC+8 → ISO-8601 UTC.
 *
 * The offset is fixed at +8 because the header says so ("Opening time
 * (UTC+8)") and Singapore has no DST — there is no ambiguity to handle,
 * only an offset to subtract.
 */
export function statementTimeToIso(text) {
  const m = String(text ?? '').trim()
    .match(/^(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (!m) return null
  const mon = MONTHS[m[2]]
  if (mon == null) return null
  const ms = Date.UTC(+m[3], mon, +m[1], +m[4] - 8, +m[5], +m[6], +(m[7] || 0))
  return new Date(ms).toISOString()
}

/**
 * Parse the Deals section of a cTrader statement export.
 *
 * Only Deals. Positions/Orders/Summary follow in the same file and describe
 * CURRENT state, which the agent already reconciles live from the broker —
 * importing a snapshot of them would plant stale rows beside fresh truth.
 */
export function parseStatement(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const rows = []
  let inDeals = false
  for (const line of lines) {
    const t = line.trim()
    if (t === 'Deals') { inDeals = true; continue }
    if (inDeals && /^(Positions|Orders|Summary|Balance)$/.test(t)) break
    if (!inDeals || !t) continue
    if (t.startsWith('Deal ID,')) continue          // header
    const c = line.split(',')
    // The section's footer is a totals row with no deal id — not a deal.
    if (!/^DID\d+$/.test((c[0] || '').trim())) continue
    rows.push({
      deal_id: c[0].trim().replace(/^DID/, ''),     // collide with the API's id
      position_id: null,                             // exports carry ORDER ids, not position ids
      account_id: null,                              // filled by the caller after resolution
      symbol: (c[2] || '').trim().toUpperCase() || null,
      side: (c[3] || '').trim().toUpperCase() || null, // Opening Direction IS the position's side
      lots: lots(c[9]),
      entry_price: num(c[7]),
      close_price: num(c[8]),
      opened_at: statementTimeToIso(c[5]),
      closed_at: statementTimeToIso(c[6]),
      gross_pnl: null,                               // Net is all the export breaks out
      swap: null,
      commission: num(c[10]),
      net_pnl: num(c[12]),                           // account currency, broker-authoritative
    })
  }
  return rows
}

/** Acct_5306502__statement10_28_21.08.2026.csv → '5306502'. */
export function loginFromFilename(name) {
  const m = String(name ?? '').match(/Acct_(\d+)__/)
  return m ? m[1] : null
}

/**
 * The login → account_id mapping lives in the agent's own accounts table, so
 * it is resolved where the truth is, not guessed where the file was written.
 * Returns null when unknown — and the caller must treat null as REFUSE.
 */
export function resolveAccountId(db, traderLogin) {
  try {
    const r = db.prepare(
      'SELECT account_id FROM accounts WHERE trader_login = ?'
    ).get(String(traderLogin))
    return r?.account_id != null ? String(r.account_id) : null
  } catch {
    return null
  }
}

/**
 * Import every Acct_<login>__*.csv in `dir`. Idempotent; safe to run every
 * boot. Returns a per-file report so the log can say what actually happened —
 * a seed that reports nothing is indistinguishable from one that never ran.
 */
export async function importSeedStatements(db, dir, { log = console.log, warn = console.warn } = {}) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => /^Acct_\d+__.*\.csv$/.test(n)).sort()
  } catch {
    return { files: [], imported: 0, skipped: 0 }   // no seed directory — not an error
  }
  const { persistDeals } = await import('./broker-history-import.js')
  const report = { files: [], imported: 0, skipped: 0 }
  for (const name of names) {
    const login = loginFromFilename(name)
    const accountId = resolveAccountId(db, login)
    if (!accountId) {
      // Fail CLOSED per file: importing under a wrong account never heals.
      warn(`[statements] ${name}: trader login ${login} is not in the accounts table — file SKIPPED, nothing imported from it`)
      report.files.push({ name, login, accountId: null, seen: 0, skipped: true })
      report.skipped += 1
      continue
    }
    const rows = parseStatement(fs.readFileSync(path.join(dir, name), 'utf8'))
      .map((r) => ({ ...r, account_id: accountId }))
    const out = persistDeals(db, rows)
    log(`[statements] ${name}: ${rows.length} deal(s) → account ${accountId} (login ${login}) — ${out.inserted} new, ${out.updated} refreshed`)
    report.files.push({ name, login, accountId, seen: rows.length, inserted: out.inserted, updated: out.updated, skipped: false })
    report.imported += rows.length
  }
  return report
}
