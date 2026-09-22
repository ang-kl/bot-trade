const DAY = 86400_000
const parse = value => { try { return value?.length <= 16_000 ? JSON.parse(value) : null } catch { return null } }
const text = value => value == null ? null : String(value).slice(0, 500)
const UPSTREAM = ['account_horizon', 'account_probe', 'account_watchlist', 'armed_scope_prefilter',
  'cluster_conviction', 'equity_stop', 'fundable_universe', 'horizon', 'lesson_decay', 'margin_pool',
  'ratchet_gate', 'stage_matrix', 'style_filter', 'symbol_position_cap', 'symbol_strategy',
  'watchlist_override', 'weekend_quiet', 'entry_mode', 'regime_gate']

// These are evidence boundaries, not a reconstructed execution trace. A
// short-circuited decision cannot establish that any later check passed.
export function blockerEvidence(row) {
  const checks = parse(row.checks_json)
  const details = parse(row.detail_json)
  const reason = text(row.reason)
  const post = row.kind === 'post_approval_failure'
  const approved = row.kind === 'approved'
  const upstream = row.kind === 'upstream_stop'
  const risk = row.kind === 'risk_refusal'
  return {
    recordId: `${row.source}:${row.id}`, source: row.source, id: row.id,
    accountId: row.account_id, symbol: row.symbol, strategy: row.strategy,
    timeframe: row.timeframe, at: row.created_at, lastAt: row.last_at || row.created_at,
    kind: row.kind, stage: row.stage, reason,
    firstBlocker: approved ? null : { stage: row.stage, reason, status: reason ? 'recorded' : 'reason_unrecorded' },
    disposition: row.disposition || null, recordedEvaluations: row.reps,
    opportunityKey: row.opportunity_key || null,
    diagnostics: [
      { stage: 'upstream', status: upstream ? 'stopped' : 'not_recorded' },
      { stage: 'risk_gate', status: upstream ? 'not_evaluated' : post || approved ? 'approved' : risk ? 'stopped' : 'not_recorded' },
      { stage: 'submission', status: post ? 'stopped' : upstream || risk ? 'not_evaluated' : 'not_recorded' },
    ],
    recordedChecks: checks && typeof checks === 'object' && !Array.isArray(checks) ? checks : null,
    recordedChecksStatus: row.checks_json?.length > 16_000 ? 'size_limit' : checks ? 'recorded' : 'unavailable',
    detail: details && typeof details === 'object' ? details : null,
    diagnosticNote: 'Only recorded outcomes are shown. Missing checks are unrecorded; later checks after a stop are not evaluated. Approval is not proof of an order or fill.',
  }
}

export function blockerReport(db, { accountId, from, to = Date.now(), limit = 50, offset = 0, now = Date.now() } = {}) {
  if (accountId !== 'all' && !/^[1-9]\d*$/.test(String(accountId))) throw new RangeError('explicit account or all required')
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to || to - from > 90 * DAY
    || to > now + 60_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new RangeError('invalid reporting window or page')
  if (accountId !== 'all' && !db.prepare('SELECT 1 FROM accounts WHERE account_id = ?').get(String(accountId))) throw new RangeError('account not registered')
  const bounds = [new Date(from).toISOString(), new Date(to).toISOString()]
  const scope = accountId === 'all' ? '' : 'AND account_id = @account'
  const params = { from: bounds[0], to: bounds[1], account: String(accountId), floor: bounds[0].replace('T', ' ').slice(0, 19) }
  // Read retained rows in one unit. No LIMIT is applied to the population or
  // totals. Only details are paged. ISO and SQLite timestamps share UTC.
  const population = `WITH records AS (
    SELECT 'risk_events' source, id, account_id, symbol, created_at, last_at,
      CASE WHEN symbol = 'PORTFOLIO' AND approved IS NOT 1 THEN 'upstream_stop'
           WHEN approved = 1 THEN 'approved'
           WHEN json_valid(checks_json) AND json_extract(checks_json, '$.post_approval') = 1 THEN 'post_approval_failure'
           ELSE 'risk_refusal' END kind,
      CASE WHEN symbol = 'PORTFOLIO' AND approved IS NOT 1 THEN 'margin_pool'
           WHEN approved = 1 THEN 'risk_gate'
           WHEN json_valid(checks_json) AND json_extract(checks_json, '$.post_approval') = 1 THEN 'post_approval'
           ELSE 'risk_gate' END stage,
      veto_reason reason, checks_json, NULL detail_json, disposition, opportunity_key,
      CASE WHEN approved = 1 THEN 1 ELSE MAX(1, COALESCE(repeat_count, 1)) END reps,
      CASE WHEN json_valid(proposal_json) THEN json_extract(proposal_json, '$.strategy') END strategy,
      CASE WHEN json_valid(proposal_json) THEN json_extract(proposal_json, '$.timeframe') END timeframe
    FROM risk_events WHERE created_at >= @floor AND julianday(created_at) >= julianday(@from)
      AND julianday(created_at) < julianday(@to) ${scope}
    UNION ALL
    SELECT 'decision_log', id, account_id, symbol, created_at, created_at,
      CASE WHEN stage = 'gate_redirect' THEN 'risk_refusal'
           WHEN stage = 'submission_dedupe' THEN 'post_approval_failure'
           WHEN stage IN (${UPSTREAM.map(s => `'${s}'`).join(',')}) OR stage GLOB 'account_pregate:*' THEN 'upstream_stop'
           ELSE 'other_stop' END,
      stage, reason, NULL, detail_json, NULL, NULL, 1, strategy, timeframe
    FROM decision_log WHERE created_at >= @floor AND julianday(created_at) >= julianday(@from)
      AND julianday(created_at) < julianday(@to) AND decision IN ('skip', 'veto') ${scope}
  )`
  const groups = db.prepare(`${population} SELECT kind, COUNT(*) records, SUM(reps) recordedEvaluations FROM records GROUP BY kind`).all(params)
  const summary = Object.fromEntries(['upstream_stop', 'risk_refusal', 'post_approval_failure', 'approved', 'other_stop'].map(kind => {
    const g = groups.find(g => g.kind === kind)
    return [kind, { records: g?.records || 0, recordedEvaluations: g?.recordedEvaluations || 0 }]
  }))
  const totalRecords = groups.reduce((n, g) => n + g.records, 0)
  const rows = db.prepare(`${population} SELECT * FROM records ORDER BY julianday(created_at) DESC, source, id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset })
  const counts = db.prepare(`${population} SELECT account_id accountId, kind, COUNT(*) records FROM records GROUP BY account_id, kind ORDER BY account_id, kind`).all(params)
  const unattributed = db.prepare(`SELECT
    (SELECT COUNT(*) FROM risk_events WHERE account_id IS NULL AND created_at >= @floor AND julianday(created_at) >= julianday(@from) AND julianday(created_at) < julianday(@to)) +
    (SELECT COUNT(*) FROM decision_log WHERE account_id IS NULL AND created_at >= @floor AND julianday(created_at) >= julianday(@from) AND julianday(created_at) < julianday(@to) AND decision IN ('skip','veto')) n`).get(params).n
  return {
    status: 'complete', accountId: String(accountId), from, to, generatedAt: new Date(now).toISOString(),
    summary, totalRecords, perAccount: counts, unattributedRecordsInWindow: unattributed,
    records: rows.map(blockerEvidence), offset, limit, hasMore: offset + rows.length < totalRecords,
    nextOffset: offset + rows.length < totalRecords ? offset + rows.length : null,
    countBasis: 'Complete retained records first created in the requested window. The same event may appear in both logs. Repeated risk refusals share a record; recordedEvaluations covers that record’s lifetime, not exact attempts within the window. Records are not distinct opportunities or orders. Other stops include management records whose entry phase is unrecorded.',
    scopeNote: accountId === 'all' ? 'Unassigned records stay explicitly unattributed.' : 'Only this registered account is included. Unassigned records are excluded and counted separately.',
  }
}
