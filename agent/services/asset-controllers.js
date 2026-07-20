// ---------------------------------------------------------------------------
// agent/services/asset-controllers.js — per-asset-class trade management.
//
// Owner: "have a separate controllers for active trade tweaking such as
// controller for forex, controller for different indices, controller for
// each different commodities. you seem to be trading like a beginner."
//
// A EURUSD trade and a NatGas trade should NOT be managed with identical
// breakeven / partial / trailing triggers — energy whipsaws, indices trend
// hard and clean, FX sits in the middle, thin softs/grains gap. Before this,
// evaluatePosition() used ONE global rule set for everything.
//
// Each asset class (from lib/sessions.js categoriseSymbol) gets its own rule
// overrides on top of position-manager's DEFAULT_RULES. These are reasoned
// starting points tuned to each class's volatility character, not
// backtested-optimal — the owner can override any class's numbers, and any
// class with no override inherits the global default.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { categoriseSymbol } from '../lib/sessions.js'
import { DEFAULT_RULES } from './position-manager.js'

// Only the trade-management triggers vary by class; sizing/RR live elsewhere.
// beTriggerR   — lock breakeven sooner in whippy classes, later in clean trends
// partialTriggerR — bank half sooner where reversals are vicious
// runnerTriggerR / runnerTrailR — how far to let a runner go, how tight to trail
export const CLASS_RULE_DEFAULTS = {
  fx:        { beTriggerR: 0.7, partialTriggerR: 1.5, runnerTriggerR: 2.5, runnerTrailR: 1.0 },
  metal:     { beTriggerR: 0.8, partialTriggerR: 1.6, runnerTriggerR: 3.0, runnerTrailR: 1.2 }, // gold trends — give runners room
  index:     { beTriggerR: 0.8, partialTriggerR: 1.6, runnerTriggerR: 3.0, runnerTrailR: 1.2 }, // indices trend clean
  crypto:    { beTriggerR: 0.5, partialTriggerR: 1.2, runnerTriggerR: 2.5, runnerTrailR: 0.8 }, // violent — protect early
  commodity: { beTriggerR: 0.6, partialTriggerR: 1.3, runnerTriggerR: 2.5, runnerTrailR: 0.9 }, // energy whipsaws
  soft:      { beTriggerR: 0.6, partialTriggerR: 1.3, runnerTriggerR: 2.5, runnerTrailR: 0.9 }, // thin, gappy
  grain:     { beTriggerR: 0.6, partialTriggerR: 1.3, runnerTriggerR: 2.5, runnerTrailR: 0.9 },
  stock:     { beTriggerR: 0.7, partialTriggerR: 1.5, runnerTriggerR: 2.5, runnerTrailR: 1.0 },
}

export const MANAGED_KEYS = ['beTriggerR', 'partialTriggerR', 'runnerTriggerR', 'runnerTrailR']

/** Owner overrides per class from agent_state, if any. */
export function loadAssetControllers(db) {
  try {
    const p = JSON.parse(getState(db, 'asset_controllers_json') || 'null')
    return p && typeof p === 'object' ? p : {}
  } catch { return {} }
}

/** Effective management rules for one symbol: global default ← class default ← owner override. */
export function rulesForSymbol(db, symbol) {
  const cls = categoriseSymbol(symbol)
  const classDefault = CLASS_RULE_DEFAULTS[cls] || {}
  const overrides = loadAssetControllers(db)[cls] || {}
  // Only the managed keys are allowed through — an override can't rewrite
  // partialFraction or the time cap by accident.
  const clean = {}
  for (const k of MANAGED_KEYS) {
    if (Number.isFinite(Number(overrides[k]))) clean[k] = Number(overrides[k])
    else if (Number.isFinite(Number(classDefault[k]))) clean[k] = Number(classDefault[k])
  }
  return { ...DEFAULT_RULES, ...clean, _assetClass: cls }
}

/** Full per-class view for the UI: effective values + whether owner-overridden. */
export function assetControllersView(db) {
  const overrides = loadAssetControllers(db)
  return Object.keys(CLASS_RULE_DEFAULTS).map(cls => {
    const ov = overrides[cls] || {}
    const eff = {}
    for (const k of MANAGED_KEYS) {
      eff[k] = Number.isFinite(Number(ov[k])) ? Number(ov[k]) : CLASS_RULE_DEFAULTS[cls][k]
    }
    return { class: cls, ...eff, overridden: MANAGED_KEYS.some(k => Number.isFinite(Number(ov[k]))) }
  })
}

/**
 * Set (or clear) one class's overrides. `patch` with a null/empty value for a
 * key clears that key back to the class default; an empty patch clears the
 * whole class.
 */
export function setAssetController(db, cls, patch) {
  if (!CLASS_RULE_DEFAULTS[cls]) throw new Error(`unknown asset class: ${cls}`)
  const all = loadAssetControllers(db)
  const cur = { ...(all[cls] || {}) }
  for (const k of MANAGED_KEYS) {
    if (patch && k in patch) {
      const v = Number(patch[k])
      if (Number.isFinite(v) && v > 0) cur[k] = Math.min(20, v)
      else delete cur[k] // clear back to default
    }
  }
  if (Object.keys(cur).length) all[cls] = cur
  else delete all[cls]
  setState(db, 'asset_controllers_json', JSON.stringify(all))
  return assetControllersView(db)
}
