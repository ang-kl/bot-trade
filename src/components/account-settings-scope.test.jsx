// The inherited-vs-pinned row. The distinction IS the feature — two accounts
// can show the same value for different reasons, and only one follows a later
// change — so the wording is tested directly.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountSettingsScope, { SettingRow } from './AccountSettingsScope.jsx'

const setting = (over = {}) => ({
  key: 'risk_config_json',
  label: 'Per-trade risk, caps, sizing rules',
  source: 'shared',
  overridden: false,
  hasValue: true,
  hasShared: true,
  differs: false,
  ...over,
})

const row = (s, accountId = '5203012') =>
  renderToStaticMarkup(<SettingRow s={s} accountId={accountId} onRevert={() => {}} busy={false} />)

describe('SettingRow', () => {
  it('leads with the SOURCE word, not the value', () => {
    expect(row(setting())).toContain('inherited')
    expect(row(setting({ overridden: true, source: 'account' }))).toContain('overridden')
  })

  it('warns when a pinned value happens to equal the shared one', () => {
    // The trap: same number, different behaviour. Without this the row reads
    // as "nothing to see here".
    const html = row(setting({ overridden: true, source: 'account', differs: false }))
    expect(html).toContain('will NOT follow')
  })

  it('does not warn when the pinned value genuinely differs', () => {
    const html = row(setting({ overridden: true, source: 'account', differs: true }))
    expect(html).not.toContain('will NOT follow')
  })

  it('offers revert only on a pinned row', () => {
    expect(row(setting({ overridden: true, source: 'account' }))).toContain('Revert to inherited')
    expect(row(setting())).not.toContain('Revert to inherited')
  })

  it('offers no revert when there is no account to revert for', () => {
    expect(row(setting({ overridden: true, source: 'account' }), null)).not.toContain('Revert to inherited')
  })

  it('says so when a setting exists nowhere, instead of showing a blank', () => {
    expect(row(setting({ hasShared: false, hasValue: false }))).toContain('nothing set anywhere')
  })

  it('the revert control explains that it restores inheritance, not a copy', () => {
    expect(row(setting({ overridden: true, source: 'account' }))).toContain('not a copy')
  })
})

describe('AccountSettingsScope', () => {
  it('renders without throwing before any data has arrived', () => {
    expect(renderToStaticMarkup(<AccountSettingsScope />)).toContain('Loading')
  })
})
