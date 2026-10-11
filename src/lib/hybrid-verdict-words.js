// W3 — plain words for the capped hybrid's verdict on one open position.
// Claude · № 13,362 12-Oct (ordered after № 13,350, owner "W1 W2 W3 W4 W11";
// claude-builder). The codes are the agent's allow-listed reasons
// (capped-hybrid-policy.js, manual-hybrid-policy.js, capped-hybrid-
// enrolment.js, diagnostic-readout.js); an unknown code is shown as itself,
// never guessed into a different reason.

const REASON_WORDS = {
  // Who owns the position's exit instead
  strategy_not_momentum: 'not a trend, breakout or momentum strategy (mean reversion keeps its own +1R half)',
  strategy_label_mismatch: 'its strategy label does not match the entry\'s',
  momentum_book_owned: 'a momentum book position: the book\'s own rules manage its exit',
  monitor_paused: 'its management is paused',
  monitor_guarded: 'held by the session-open guard',
  monitor_already_scaled: 'already scaled out',
  monitor_bank_owned: 'a bank partial already owns it',
  competing_profit_policy: 'another profit rule owns it (a +1R half or a bank target)',
  competing_profit_intent: 'a momentum TP1 plan owns it',
  prior_position_override: 'it was already trimmed, scaled, reversed or overridden',
  existing_partial_plan: 'it already has its own partial plan',
  // Where it came from
  trade_origin_not_bot: 'not a bot market entry',
  monitor_external: 'opened outside the bot',
  monitor_not_autopilot: 'not an autopilot position',
  manual_account_not_authorised: 'a manual position on an account outside the manual hybrid scope',
  manual_trade_origin_unverified: 'a manual position whose origin is not proven',
  manual_keeper_disabled: 'a manual position, and the profit keeper is off',
  manual_keeper_opt_out: 'a manual position opted out of the profit keeper',
  manual_opening_proof_required: 'a manual position with no opening-fill proof yet',
  manual_original_stop_missing: 'a manual position with no original stop on record',
  // The account
  account_missing: 'its account is not registered',
  account_mode_excluded: 'its account is neither active nor manage-only',
  managed_exit_disabled: 'managed exits are off for its account',
  own_credentials_unavailable: 'its account\'s broker session is not available',
  // The entry record
  tick_entry_proof_missing: 'a tick entry without its entry receipt',
  trade_risk_link_missing: 'its entry record is incomplete (no risk event)',
  trade_intent_link_missing: 'its entry record is incomplete (no entry intent)',
  entry_intent_missing: 'its entry intent is missing',
  entry_not_filled: 'its entry is not recorded as filled',
  active_monitor_missing: 'no active position monitor',
  initial_risk_missing: 'no initial risk on record, so 2R cannot be measured',
  recorded_risk_required: 'no recorded initial risk, so 2R cannot be measured',
  // The plan itself
  existing_tp_caps_before_runner: 'its broker take-profit sits at or before 2R, leaving no room for a runner',
  half_and_runner_not_representable: 'too small to split into two broker-valid halves',
  broker_volume_invalid: 'the broker\'s volume limits could not be read',
  broker_precision_required: 'the broker\'s price precision could not be read',
  opening_receipts_required: 'its opening fills could not be proven from the broker',
  broker_position_unverified: 'the broker read did not confirm the position',
  broker_protection_unverified: 'the broker read did not confirm its original stop',
  symbol_account_unverified: 'the broker\'s symbol read was for another account',
  symbol_metadata_unverified: 'the broker\'s symbol read was incomplete',
  ownership_changed: 'its record changed during the check',
  enrolment_budget: 'the pass reached its time budget first',
  candidate_not_selected: 'the pass did not select it',
  // Errors (redacted to a code by the agent)
  timeout_or_deadline: 'a broker read timed out',
  unclassified_error_redacted: 'an error (details withheld)',
  // The record itself
  missing: 'the hybrid has not stored a pass on this agent',
  invalid_json: 'the stored pass could not be read',
  invalid_or_oversized: 'the stored pass could not be read',
  hybrid_section_missing: 'the last pass recorded no hybrid section',
  schema_unavailable: 'the database tables it needs are missing',
  record_truncated: 'the stored record was cut at its size limit',
}

export function reasonWords(code) {
  if (code == null || code === '') return null
  return REASON_WORDS[code] ?? String(code).replace(/_/g, ' ')
}

/** One sentence for one position's verdict row from GET /state/capped-hybrid. */
export function verdictLine(p) {
  if (!p) return 'Not available'
  const why = reasonWords(p.reason)
  switch (p.verdict) {
    case 'enrolled':
      return `Enrolled: closes ${p.closeVolume ?? '?'} units (half) when price reaches ${p.trigger ?? '?'}; the runner keeps the broker stop and take-profit ${p.brokerTarget ?? '?'}`
    case 'delegated':
      return `Left to its own partial plan${p.planState ? ` (${p.planState})` : ''}`
    case 'excluded':
      return p.reason === 'monitor_paused' && p.book
        ? 'Not eligible: a momentum book position, paused here because the book\'s own rules manage its exit'
        : `Not eligible: ${why ?? 'no reason recorded'}`
    case 'deferred':
      return `Waiting: ${why ?? 'deferred'}; checked again on a later pass`
    case 'error':
      return `The last check failed: ${why ?? 'no reason recorded'}; retried on the next pass`
    case 'not_in_last_pass':
      return p.reason === 'record_truncated'
        ? 'Not in the readable record: the stored record was cut at its size limit'
        : 'Not in the last pass\'s record yet'
    case 'not_available':
      return `Not available: ${why ?? 'no pass record'}`
    default:
      return `Unknown verdict: ${String(p.verdict)}`
  }
}
