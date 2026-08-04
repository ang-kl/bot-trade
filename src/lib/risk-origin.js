// Where does a risk value come from?
//
//   'account' — this account's own overlay
//   'global'  — inherited from the global config, which itself overrides a default
//   'default' — nobody has ever set it
//
// Mirrors agent/services/risk-matrix.js's originOf so the table and the API
// agree. Its own file because the component and its test both need it, and a
// helper exported from a component file breaks fast refresh.
//
// THE DISTINCTION IS THE POINT OF THE TABLE. Two accounts showing 1.00% for
// different reasons behave differently the moment a default or the global
// value moves, and a grid that renders both the same way hides that.
export function originOf(key, { accountOverridden = [], globalOverridden = [] } = {}) {
  if (accountOverridden.includes(key)) return 'account'
  if (globalOverridden.includes(key)) return 'global'
  return 'default'
}
