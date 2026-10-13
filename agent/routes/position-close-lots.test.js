// Claude · № 14,050 13-Oct (owner: "build the partial close lots field"; claude-builder).
// Wiring pin: the /position-close handler sizes a lots request through
// partialCloseVolume (stepped, minimum-checked) and refuses before any broker
// call; the arithmetic itself is tested in agent/lib/partial-close-volume.test.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('/position-close sizes lots with partialCloseVolume and refuses its error before the close', () => {
  const src = readFileSync(new URL('./actions.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const start = src.indexOf("router.post('/position-close'")
  const handler = src.slice(start, src.indexOf('router.post(', start + 10))
  const sized = handler.indexOf('partialCloseVolume({ positionVolume: volume, lots, meta, strict: !preview })')
  const refuse = handler.indexOf('if (sized.error) return res.status(400)')
  const close = handler.indexOf('execClosePosition(')
  assert.ok(sized > 0, 'the handler sizes through partialCloseVolume')
  assert.ok(refuse > sized && close > refuse, 'the refusal comes before the broker close')
  // Codex P1 on #1354: a preview answers before any broker close; the real close is strict.
  const previewReply = handler.indexOf('if (preview) return res.json({ ok: true, preview: true, positionId, lots: sized.lots')
  assert.ok(previewReply > refuse && previewReply < close, 'the preview answers after sizing and before the close')
  assert.match(handler, /const preview = req\.body\?\.preview === true/)
  assert.doesNotMatch(handler, /Math\.min\(volume, Math\.round\(Number\(lots\) \* meta\.lotSize\)\)/, 'the unstepped rounding is gone')
})
