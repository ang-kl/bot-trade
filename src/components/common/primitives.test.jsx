// Phase C primitive contract tests (docs/ui-m3-compact-contract.md).
//
// No jsdom in this repo — hook-free components are called as plain
// functions and their element trees inspected; hook-using components are
// rendered with react-dom/server, which runs hooks fine in node.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Button from './Button.jsx'
import IconButton from './IconButton.jsx'
import Switch from './Switch.jsx'
import Segmented from './Segmented.jsx'
import Disclosure from './Disclosure.jsx'
import Input from './Input.jsx'
import Field from './Field.jsx'

const cls = (el) => el.props.className

describe('Button', () => {
  it('keeps the compact owner geometry: 2px padding, 1px radius token, 1px border', () => {
    const c = cls(Button({ children: 'x' }))
    expect(c).toContain('p-[2px]')
    expect(c).toContain('rounded-[var(--radius-control)]')
    expect(c).toContain('border')
  })
  it('aliases the M3 names onto the existing treatments (no visual fork)', () => {
    expect(cls(Button({ children: 'x', variant: 'outlined' }))).toBe(cls(Button({ children: 'x', variant: 'ghost' })))
    expect(cls(Button({ children: 'x', variant: 'text' }))).toBe(cls(Button({ children: 'x', variant: 'subtle' })))
  })
  it('renders an unknown variant as primary (documented fallback, inventory finding 19)', () => {
    expect(cls(Button({ children: 'x', variant: 'secondary' }))).toBe(cls(Button({ children: 'x', variant: 'primary' })))
  })
  it('carries a visible focus-visible outline, not the old 1px half-alpha ring', () => {
    const c = cls(Button({ children: 'x' }))
    expect(c).toContain('focus-visible:outline-2')
    expect(c).toContain('focus-visible:outline-[var(--color-accent)]')
    expect(c).not.toContain('focus:ring-1')
  })
  it('loading blocks double-submits machine-readably without resizing', () => {
    const el = Button({ children: 'Saving…', loading: true })
    expect(el.props['aria-busy']).toBe(true)
    expect(el.props.disabled).toBe(true)
    // no injected spinner node — children pass through untouched
    expect(el.props.children).toBe('Saving…')
  })
})

describe('IconButton', () => {
  it('writes the required label to aria-label and title, hides the glyph from AT', () => {
    const html = renderToStaticMarkup(<IconButton label="Close this sheet">✕</IconButton>)
    expect(html).toContain('aria-label="Close this sheet"')
    expect(html).toContain('title="Close this sheet"')
    expect(html).toContain('aria-hidden="true"')
  })
})

describe('Switch', () => {
  it('is a real switch: role, aria-checked, and the state word beside the colour', () => {
    const on = Switch({ checked: true, label: 'Autotrade' })
    expect(on.props.role).toBe('switch')
    expect(on.props['aria-checked']).toBe(true)
    expect(on.props['aria-label']).toBe('Autotrade: ON')
    expect(cls(on)).toContain('--color-state-on-bg')
    const off = Switch({ checked: false, label: 'Autotrade' })
    expect(off.props['aria-checked']).toBe(false)
    expect(off.props['aria-label']).toBe('Autotrade: OFF')
    expect(cls(off)).toContain('--color-state-off-bg')
  })
  it('uses state tokens, never P&L up/down or the navigation accent fill', () => {
    const c = cls(Switch({ checked: true, label: 'x' }))
    expect(c).not.toContain('--color-up')
    expect(c).not.toContain('bg-[var(--color-accent)]')
  })
  it('pending marks the in-flight write and blocks re-taps', () => {
    const el = Switch({ checked: true, pending: true, label: 'x' })
    expect(el.props['aria-busy']).toBe(true)
    expect(el.props.disabled).toBe(true)
  })
})

describe('Segmented', () => {
  const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]
  it('is a radiogroup with roving tabindex and aria-checked on the selection', () => {
    const html = renderToStaticMarkup(<Segmented options={opts} value="b" label="Range" />)
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-label="Range"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('tabindex="-1"')
  })
  it('paints the selection with the M3 tonal pair, never a saturated fill or hard-coded #fff', () => {
    const html = renderToStaticMarkup(<Segmented options={opts} value="a" />)
    expect(html).toContain('--md-secondary-container')
    expect(html).toContain('--md-on-secondary-container')
    expect(html).not.toContain('bg-[var(--color-accent)]')
    expect(html).not.toContain('text-white')
  })
})

describe('Disclosure', () => {
  it('is a native button with aria-expanded and the canonical glyphs', () => {
    const open = Disclosure({ open: true, children: 'Section' })
    expect(open.type).toBe('button')
    expect(open.props['aria-expanded']).toBe(true)
    expect(renderToStaticMarkup(<Disclosure open>{'S'}</Disclosure>)).toContain('▾')
    expect(renderToStaticMarkup(<Disclosure open={false}>{'S'}</Disclosure>)).toContain('▸')
  })
})

describe('Input density variants', () => {
  it('standard keeps its full-size BOX, at the canon text size', () => {
    // 05-08-2026: the type size moved 14px → 9px with the canon; the 36px box
    // did NOT, because that is the tap target and has nothing to do with the
    // type scale. Splitting them here on purpose — the earlier assertion bound
    // the two together and would have read as "the field shrank".
    // In practice the unlayered `input { font-size: min(calc(1em + 1px), 10px)
    // } !important` rule in index.css still governs what renders; this class
    // is what it computes `1em` against.
    const c = cls(Input({}))
    expect(c).toContain('w-full')
    expect(c).toContain('min-h-[36px]')
    expect(c).toContain('text-[9px]')
  })
  it('compact reproduces the Field treatment class-for-class (pixel parity)', () => {
    const c = cls(Input({ density: 'compact' }))
    for (const frag of ['!w-[76px]', '!min-h-[26px]', 'max-[430px]:!min-h-[44px]', '!py-0.5', '!px-2', '!text-[9px]', 'text-right']) {
      expect(c).toContain(frag)
    }
    expect(c).not.toContain('w-full')
  })
})

describe('Field after the density refactor', () => {
  it('renders its input with the exact legacy override classes via density=compact', () => {
    const html = renderToStaticMarkup(<Field label="Guardian move %" value={0.5} onChange={() => {}} />)
    for (const frag of ['!w-[76px]', '!min-h-[26px]', '!text-[9px]', 'text-right']) {
      expect(html).toContain(frag)
    }
    expect(html).toContain('aria-label="Guardian move %"')
  })
  it('duration mode keeps the invalid-border seam', () => {
    const html = renderToStaticMarkup(<Field label="Scan every" value={90} duration onChange={() => {}} />)
    expect(html).toContain('!w-[76px]')
  })
})
