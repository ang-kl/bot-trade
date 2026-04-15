// Pure function (position, execState) -> story card data model.
// Phase 5 implements; this stub locks the signature and state enum.
import { POSITION_STATES } from './ctrader-client.js'

/**
 * @param {object} position - cTrader position (or intent)
 * @param {string} execState - one of POSITION_STATES
 * @returns {object} story card props for StoryCard.jsx
 */
export function buildStory(position, execState) {
  if (!POSITION_STATES.includes(execState)) {
    throw new Error(`Unknown execState: ${execState}`)
  }
  // Phase 5 fills in: headline, confidence, SL/TP line, progress, updates, actions.
  return { position, execState }
}
