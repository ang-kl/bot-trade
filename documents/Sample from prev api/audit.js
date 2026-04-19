import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { strategyConfig } = req.body
  if (!strategyConfig) return res.status(400).json({ error: 'Strategy config required' })

  const systemPrompt = `You are a brutally honest trading strategy auditor. The user is an experienced forex trader (TradingView Premium + Pepperstone cTrader). Your job: find flaws, redundancies, and risks in their strategy. No cheerleading.

You must return a JSON object with this exact structure:
{
  "grades": {
    "entryLogic": { "grade": "A-F", "score": 0-100, "summary": "one line" },
    "riskManagement": { "grade": "A-F", "score": 0-100, "summary": "one line" },
    "multiTimeframe": { "grade": "A-F", "score": 0-100, "summary": "one line" },
    "indicatorDiversity": { "grade": "A-F", "score": 0-100, "summary": "one line" },
    "overfittingRisk": { "grade": "A-F", "score": 0-100, "summary": "one line" },
    "killSwitch": { "grade": "A-F", "score": 0-100, "summary": "one line" }
  },
  "overallGrade": "A-F",
  "corrections": [
    { "id": "c1", "severity": "critical|high|medium", "title": "short title", "detail": "explanation", "fix": "what to change" }
  ],
  "narrative": "2-3 paragraph candid assessment of the strategy's strengths and weaknesses",
  "alternatives": {
    "conservative": { "name": "Conservative Alt", "changes": "what's different", "expectedImpact": "how it changes performance" },
    "aggressive": { "name": "Aggressive Alt", "changes": "what's different", "expectedImpact": "how it changes performance" }
  }
}

Be specific. Reference their actual indicators and conditions. Grade harshly but fairly.`

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Audit this trading strategy:\n\n${JSON.stringify(strategyConfig, null, 2)}`
      }],
    })

    const text = response.content[0]?.text || ''

    // Extract JSON from response (may be wrapped in markdown code block)
    let audit
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/)
    if (jsonMatch) {
      try { audit = JSON.parse(jsonMatch[1]) } catch {}
    }

    if (!audit) {
      return res.status(200).json({ raw: text, parsed: false })
    }

    res.status(200).json({ audit, parsed: true })
  } catch (err) {
    console.error('Audit API error:', err)
    res.status(500).json({ error: err.message })
  }
}
