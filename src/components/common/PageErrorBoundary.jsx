// PageErrorBoundary — the missing floor under every page.
//
// Owner, 03-08-2026: "I am trying to change the pipeline but the page keeps
// crashing", with the Railway logs attached. Every request in those logs
// returned 200 — the server was fine. The crash is a React render throwing,
// and until now THERE WAS NO ERROR BOUNDARY ANYWHERE IN src/. React's default
// on an uncaught render error is to unmount the whole tree, so one bad
// property access on one card blanks the entire application: no message, no
// stack, no way back except a reload, and nothing for the owner to report.
//
// That is why the `?arm=fib_confluence` crash sat open for days as "needs the
// browser console error" — the app was throwing away the one thing that would
// have identified it.
//
// WHAT THIS DOES, and deliberately does not do:
//
//   · It catches render errors for the ROUTED PAGE ONLY. The sidebar, the
//     account switches and the S·A·T controls stay mounted and usable, so a
//     broken page can never strand the operator with no way to disarm.
//   · It SHOWS the error and the component stack, and offers to copy them.
//     A trading desk that crashes silently is worse than one that crashes
//     loudly; the owner should be able to paste the cause in one tap.
//   · It resets on navigation, so moving to another page recovers without a
//     reload — `key` is driven by the route path at the call site.
//   · It does NOT swallow the error: it is re-thrown to the console via
//     console.error in componentDidCatch, so the browser's own reporting and
//     any future telemetry still see it.
//
// It is a class because React has no hook equivalent — getDerivedStateFromError
// and componentDidCatch exist only on classes. That is a framework constraint,
// not a style choice.
import { Component } from 'react'

export default class PageErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Keep the browser console authoritative. Swallowing here would trade one
    // invisible failure for another.
    console.error('[page crash]', error, info?.componentStack)
    this.setState({ info })
  }

  copy = () => {
    const { error, info } = this.state
    const text = [
      `page: ${typeof window !== 'undefined' ? window.location.pathname + window.location.search : '?'}`,
      `error: ${error?.name || 'Error'}: ${error?.message || String(error)}`,
      '',
      error?.stack || '(no stack)',
      '',
      'component stack:',
      info?.componentStack || '(none)',
    ].join('\n')
    try { navigator.clipboard?.writeText(text) } catch { /* clipboard denied — the text is on screen anyway */ }
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    return (
      <div className="p-4">
        <div
          className="glass-inset rounded-[2px] p-3 text-[9px]"
          style={{ borderTop: '2px solid var(--color-down)' }}
          role="alert"
        >
          <div className="font-semibold" style={{ color: 'var(--color-down)' }}>
            This page hit an error and stopped rendering.
          </div>
          <p className="mt-1 text-[var(--color-text-sub)]">
            The agent is unaffected — this is the browser, not the bot. Your positions, stops
            and switches are untouched, and the sidebar still works. Switch to another page to
            carry on, or copy the detail below so it can be fixed.
          </p>

          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[2px] bg-[var(--color-bg)] p-2 text-[9px] text-[var(--color-text)]">
{`${error.name || 'Error'}: ${error.message || String(error)}`}
{info?.componentStack ? `\n${info.componentStack.split('\n').slice(0, 8).join('\n')}` : ''}
          </pre>

          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button" onClick={this.copy}
              className="cursor-pointer rounded-[4px] border border-[var(--color-border)] px-2 py-1 text-[9px] font-semibold"
            >
              Copy error detail
            </button>
            <button
              type="button" onClick={() => this.setState({ error: null, info: null })}
              className="cursor-pointer rounded-[4px] border border-[var(--color-border)] px-2 py-1 text-[9px]"
            >
              Try rendering again
            </button>
            <button
              type="button" onClick={() => { try { window.location.reload() } catch { /* no-op */ } }}
              className="cursor-pointer rounded-[4px] border border-transparent px-2 py-1 text-[9px] text-[var(--color-text-sub)] hover:border-[var(--color-border)]"
            >
              Reload the app
            </button>
          </div>
        </div>
      </div>
    )
  }
}
