import { describe, it, expect } from 'vitest'
import { accountInputDraft, editAccountInput, accountInputPatch } from './account-input-draft.js'

describe('account sizing draft', () => {
  const loaded = { accountId: '22', storedBalance: 100, balance: 110, leverage: 20 }
  it('a leverage edit does not post the previously displayed balance', () => {
    const draft = editAccountInput(accountInputDraft(loaded), 'leverage', 30)
    expect(accountInputPatch(draft)).toEqual({ accountId: '22', leverage: 30 })
    expect(draft.balance).toBe(100)
  })
  it('a zero balance edit leaves broker-refreshed leverage alone', () => {
    expect(accountInputPatch(editAccountInput(accountInputDraft(loaded), 'balance', 0)))
      .toEqual({ accountId: '22', balance: 0 })
  })
  it('only deliberate edits survive into a request, including invalid blanks for validation', () => {
    const draft = accountInputDraft(loaded)
    expect(accountInputPatch(draft)).toEqual({ accountId: '22' })
    const edited = editAccountInput(editAccountInput(draft, 'balance', null), 'leverage', 50)
    expect(accountInputPatch(edited)).toEqual({ accountId: '22', balance: null, leverage: 50 })
    expect(draft.edited).toEqual({})
  })
  it('a new account or a successful reload resets the edited population', () => {
    const edited = editAccountInput(accountInputDraft(loaded), 'balance', 10)
    const reloaded = accountInputDraft({ ...loaded, storedBalance: 10 })
    expect(accountInputPatch(reloaded)).toEqual({ accountId: '22' })
    expect(accountInputPatch(accountInputDraft({ accountId: '11', storedBalance: 0, leverage: 1 })))
      .toEqual({ accountId: '11' })
    expect(accountInputPatch(edited)).toEqual({ accountId: '22', balance: 10 })
  })
})
