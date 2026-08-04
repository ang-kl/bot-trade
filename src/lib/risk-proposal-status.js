// Applied, still holding, or applied-and-since-changed?
//
// Mirrors agent/services/risk-config-history.js's proposalStatus so the table
// and the API agree on the word. Its own file because both the component and
// its test need it, and a helper exported from a component file breaks fast
// refresh.
//
// THE MIDDLE STATE IS THE POINT. The Risk page's proposal table had only two:
// applied or not. So a row that WAS applied and had since been changed showed
// as "applied", and its own footer said "the settings below hold these values
// now" — a claim it had never verified. The owner found it by searching for
// the daily loss limit and getting a different number than the row asserted.
export function proposalStatus({ applied, proposed, live }) {
  if (!applied) return 'not_applied'
  return JSON.stringify(live ?? null) === JSON.stringify(proposed ?? null) ? 'holds' : 'superseded'
}

