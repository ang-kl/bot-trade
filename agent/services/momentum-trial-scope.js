// ---------------------------------------------------------------------------
// agent/services/momentum-trial-scope.js — the momentum trial's SCOPE, read
// from the repo's own declarations: which accounts, which strategies and
// which symbols are in the momentum trial / book (§6, owner-approved
// 03-10-2026, № 10,777·B·4).
//
// This module reads; it decides nothing. `momentum-trial-scope.test.js`
// compares what it reads against the committed snapshot beside it, so a PR
// that widens or narrows the trial — one more account in momentum-entries.json,
// a symbol dropped from the universe, a second strategy in the momentum
// family — fails the gate by name until the snapshot is updated on purpose.
//
// Regenerate the snapshot DELIBERATELY, after the owner's yes:
//   node agent/services/momentum-trial-scope.js --write
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { STRATEGY_REGISTRY } from './strategies.js'
import { WEEKS_HORIZON_FAMILIES } from './trade-horizon.js'

export const SNAPSHOT_URL = new URL('./momentum-trial-scope.snapshot.json', import.meta.url)

const cfg = (name) => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'))
const sorted = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map(String))].sort()
/** global-strategies.json `arm` entries carry an optional `:suffix` reseed tag; the key is what precedes it. */
const armKey = (entry) => String(entry).split(':')[0]

/**
 * The scope as one plain object, every list sorted so the comparison is
 * order-blind. Each field names the file it was read from.
 */
export function momentumTrialScope() {
  const account = cfg('momentum-account.json')
  const entries = cfg('momentum-entries.json')
  const pins = cfg('strategy-pins.json')
  const globals = cfg('global-strategies.json')
  const book = cfg('momentum-book.json')
  const universe = cfg('momentum-universe.json')

  const momentumKeys = sorted(STRATEGY_REGISTRY.filter(s => WEEKS_HORIZON_FAMILIES.includes(s.family)).map(s => s.key))
  const trialPins = {}
  for (const key of Object.keys(pins._trial || {}).sort()) trialPins[key] = sorted(pins._trial[key])
  const symbols = {}
  for (const group of Object.keys(universe).filter(k => !k.startsWith('_')).sort()) symbols[group] = sorted(universe[group])

  return {
    accounts: {
      // momentum-account.json: "_all" = every enabled registry account; an id = that one; null = nowhere.
      dailyPassAccountId: account.accountId ?? null,
      // momentum-entries.json: the accounts that take the partial-TP1 plan path (market entries).
      marketEntries: entries.market === true,
      planAccounts: sorted(entries.accounts),
      // strategy-pins.json `_trial`: the per-strategy trial accounts.
      trialPins,
    },
    strategies: {
      // The registry keys in the weeks-horizon (momentum) families — the strategies the book dispatches.
      momentumFamilies: sorted(WEEKS_HORIZON_FAMILIES),
      momentumKeys,
      // global-strategies.json `arm` entries that name a momentum-family strategy (seed-once arms on every account).
      globalArms: sorted((globals.arm || []).filter(e => momentumKeys.includes(armKey(e)))),
    },
    book: {
      // momentum-book.json: the master switch. Off = the trial reaches nobody, whatever the lists say.
      enabled: book.enabled === true,
    },
    // momentum-universe.json: the symbols the book ranks, by group.
    symbols,
  }
}

export function readSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8'))
}

export function writeSnapshot() {
  writeFileSync(SNAPSHOT_URL, `${JSON.stringify(momentumTrialScope(), null, 2)}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write')) {
    writeSnapshot()
    console.log(`momentum trial scope snapshot written: ${fileURLToPath(SNAPSHOT_URL)}`)
  } else {
    console.log(JSON.stringify(momentumTrialScope(), null, 2))
  }
}
