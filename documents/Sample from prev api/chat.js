import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { messages, strategyContext } = req.body
  if (!messages?.length) return res.status(400).json({ error: 'Messages required' })

  const systemPrompt = `You are an expert forex trading risk calibrator inside a strategy-building app called "abot". The user is an active forex trader using TradingView Premium + Pepperstone (cTrader).

Your role: Help calibrate risk parameters for their trading strategy. Be direct, data-driven, and honest. No sugarcoating.

Current strategy context:
${strategyContext || 'No strategy loaded yet.'}

Guidelines:
- Give specific, actionable advice on stop loss, take profit, position sizing, trailing stops
- Explain trade-offs clearly: "Tightening SL from 30 to 20 pips increases win rate but reduces avg winner by ~40%"
- Reference their actual indicator setup when relevant
- Warn about over-optimization and curve fitting
- If they ask about something outside risk management, briefly answer but redirect to risk topics
- Keep responses concise — 2-4 paragraphs max unless they ask for detail`

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
      }
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    console.error('Chat API error:', err)
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
    res.end()
  }
}
