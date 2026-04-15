// Macro analyst sub-agent prompt.
// Ported verbatim from v1 api/advisor.js L447-487.
// Every LLM call = its own file per HANDOVER-V2.md.

export default function macroPrompt({ globalSlice }) {
  // Dedicated regime agent. Consumes the whole macro + calendar +
  // political snapshot and produces a structured opinion the lead
  // agent can tilt the plan against. Runs in parallel with the other
  // sub-agents so it does not add latency.
  const payload = {
    macro: globalSlice?.macro || {},
    calendar: globalSlice?.calendar || {},
    political: globalSlice?.political || {},
  }
  return `You are a macro analyst sub-agent in a wealth advisor team. Synthesise the FRED + Finnhub + GDELT inputs below into a single structured regime opinion.

Inputs:
${JSON.stringify(payload, null, 2)}

Return ONLY valid JSON:
{
  "regime": "risk-on" | "risk-off" | "neutral",
  "confidence": <0..1 float>,
  "rateTrajectory": "<short string describing Fed policy direction>",
  "vixRegime": "<low-vol|normal|elevated|crisis>",
  "yieldCurveShape": "<short string>",
  "creditConditions": "<short string>",
  "upcomingCatalysts": [
    { "when": "+Nd", "event": "<label>", "impact": "<high|medium|low>" }
  ],
  "politicalFlags": [<short strings describing active political themes that should influence allocation>],
  "sectorTilts": {
    "favour": [<sector names>],
    "avoid":  [<sector names>]
  },
  "summary": "<1 sentence <=30 words>"
}

Rules:
- Base every field on the supplied inputs. Do not invent data not in the payload.
- If a field cannot be determined from the inputs, set it to a short honest string like 'unknown'.
- upcomingCatalysts must come from the calendar.events array, using the 'time' or 'date' field to compute the +Nd relative offset.
- politicalFlags should summarise the loudest theme from political.themes if its 1d article count is non-trivial.
- JSON only, no markdown fences.`
}
