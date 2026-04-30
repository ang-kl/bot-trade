// Catches any render/effect crash in the routed page and shows a recovery
// panel inside <main>, while the top header stays mounted. Without this,
// one thrown error unmounts the whole app and the user sees a blank page
// with no nav.

import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info?.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    const msg = this.state.error?.message || String(this.state.error)
    return (
      <div className="max-w-xl mx-auto mt-8 p-4 rounded-[7px] border border-[var(--color-down)] bg-[var(--color-surface)]">
        <h2 className="t-label mb-2 text-[var(--color-down)]">Page crashed</h2>
        <p className="t-sub text-[var(--color-text-sub)] mb-3">
          The top and bottom bars are still live. You can navigate away or reset this page.
        </p>
        <pre className="text-[11px] bg-[var(--color-bg)] p-2 rounded-[5px] overflow-x-auto mb-3">{msg}</pre>
        <button
          type="button"
          onClick={this.reset}
          className="px-3 py-1 rounded-[5px] bg-[var(--color-accent)] text-white font-bold"
        >
          Try again
        </button>
      </div>
    )
  }
}
