// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// One pre-order check's answer (GET /state/preorder): Ready or the first
// block IN WORDS (the state tint is never the only signal), then the gate's
// own figures. Phone-first: a two-column list that wraps at 390 px, no table.
import { verdictLine, preorderLines } from '../lib/preorder-check.js'

export default function PreorderResult({ result, busy = false }) {
  if (busy) return <p role="status" className="text-(length:--fs-body) text-[var(--color-text-sub)]">Checking with the risk gate…</p>
  if (!result) return null
  const ok = !!result.ok
  const ready = ok && !result.firstBlock
  const lines = preorderLines(result)
  return (
    <div className="mt-1 text-(length:--fs-body)" data-preorder={ready ? 'ready' : ok ? 'blocked' : 'unavailable'}>
      <p role="status" className={`font-semibold ${ready ? 'text-[var(--color-state-on-text)]' : 'text-[var(--color-warning-text)]'}`}>
        <span aria-hidden="true">{ready ? '✓ ' : '■ '}</span>{verdictLine(result)}
      </p>
      {ok && result.firstBlock?.stage && result.firstBlock.stage !== 'risk_gate' && (
        <p className="text-[var(--color-text-sub)]">Stopped before the risk gate ({result.firstBlock.stage.replace(/_/g, ' ')}); the gate's own verdict: {result.gate?.approved ? 'would approve' : (result.gate?.vetoReason || '—')}.</p>
      )}
      {lines.length > 0 && (
        <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {lines.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--color-text-sub)] whitespace-nowrap">{k}</dt>
              <dd className="m-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {ok && (
        <p className="mt-0.5 text-[var(--color-text-sub)]" title={(result.notChecked || []).join(' · ')}>
          Dry run — nothing was recorded or sent. Expected R: {result.expectedR?.value ?? result.expectedR?.reason ?? 'not computed'}.
          {result.notChecked?.length ? ` ${result.notChecked.length} later steps are not reproduced here.` : ''}
        </p>
      )}
    </div>
  )
}
