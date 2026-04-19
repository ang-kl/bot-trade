import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { imageData, mediaType } = req.body
  if (!imageData) return res.status(400).json({ error: 'Image data required' })

  const systemPrompt = `You are an expert chart analyst with deep knowledge of technical analysis, smart money concepts, and institutional order flow. Analyze the uploaded chart image.

Return a JSON object with this exact structure:
{
  "patterns": [
    { "name": "pattern name", "confidence": 0-100, "note": "explanation" }
  ],
  "smartMoney": [
    { "label": "concept name", "note": "what you see and why it matters" }
  ],
  "thinkAhead": [
    { "scenario": "Bullish", "probability": 0-100, "color": "text-blue-400", "targets": "what happens if this plays out" },
    { "scenario": "Neutral", "probability": 0-100, "color": "text-yellow-400", "targets": "range scenario" },
    { "scenario": "Bearish", "probability": 0-100, "color": "text-red-400", "targets": "downside scenario" }
  ],
  "keyLevels": [
    { "type": "Resistance|Support|Target 1|Target 2", "price": "price or —", "note": "why this level matters" }
  ],
  "narrative": "2-3 paragraph candid assessment. Use **bold** for emphasis. Include: What's real, What's suspicious, My honest take."
}

Be specific about what you see. If the chart is unclear, say so. Probabilities must sum to 100. Reference actual price levels when visible. Identify smart money concepts: liquidity grabs, order blocks, stop hunts, accumulation/distribution, fair value gaps.`

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType || 'image/png',
              data: imageData,
            },
          },
          { type: 'text', text: 'Analyze this chart. Return the JSON analysis.' },
        ],
      }],
    })

    const text = response.content[0]?.text || ''

    let analysis
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/)
    if (jsonMatch) {
      try { analysis = JSON.parse(jsonMatch[1]) } catch {}
    }

    if (!analysis) {
      return res.status(200).json({ raw: text, parsed: false })
    }

    res.status(200).json({ analysis, parsed: true })
  } catch (err) {
    console.error('Vision API error:', err)
    res.status(500).json({ error: err.message })
  }
}
