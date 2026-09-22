// Account sizing inputs are refreshed independently by the broker loop.
// A form save must carry only fields the operator actually edited.
export function accountInputDraft(account) {
  return {
    accountId: account.accountId,
    balance: account.storedBalance ?? account.balance,
    leverage: account.leverage,
    edited: {},
  }
}

export function editAccountInput(draft, field, value) {
  if (!['balance', 'leverage'].includes(field)) return draft
  return { ...draft, [field]: value, edited: { ...draft.edited, [field]: true } }
}

export function accountInputPatch(draft) {
  const patch = { accountId: draft.accountId }
  for (const field of ['balance', 'leverage']) {
    // Include an explicitly emptied field so server validation rejects it;
    // neither silently ignoring it nor converting it to zero is a save.
    if (draft.edited?.[field]) patch[field] = draft[field]
  }
  return patch
}
