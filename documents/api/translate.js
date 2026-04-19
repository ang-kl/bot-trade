import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { source, direction } = req.body
  // direction: 'pine-to-cbot' or 'cbot-to-pine'
  if (!source?.trim()) return res.status(400).json({ error: 'Source code required' })

  const systemPrompt = direction === 'pine-to-cbot'
    ? `You are an expert at translating TradingView Pine Script to cTrader Automate C# cBot code.

Rules:
- Output a complete, compilable C# cBot class that inherits from Robot
- Map Pine Script indicators to their cTrader API equivalents (e.g. ta.ema → Indicators.ExponentialMovingAverage)
- Map Pine Script strategy functions: strategy.entry → ExecuteMarketOrder, strategy.close → ClosePosition
- Handle Pine Script's bar-by-bar execution model within OnBar()
- Convert alertcondition() to Print() or webhook-ready logic
- Preserve the trading logic exactly — do not simplify or optimize the strategy
- Use proper cTrader namespaces: cAlgo.API, cAlgo.API.Indicators, cAlgo.API.Internals
- Add [Parameter] attributes for configurable values (periods, multipliers, etc.)
- Include position sizing via risk-based calculation using Account.Balance
- Add comments where the Pine → C# mapping is non-obvious

Return ONLY the C# code, no explanation. Wrap in a code block.`
    : `You are an expert at translating cTrader Automate C# cBot code to TradingView Pine Script v5.

Rules:
- Output a complete Pine Script v5 strategy or indicator
- Map cTrader indicators to Pine Script equivalents (e.g. Indicators.ExponentialMovingAverage → ta.ema)
- Map ExecuteMarketOrder → strategy.entry, ClosePosition → strategy.close
- Convert OnBar() logic to Pine's bar-by-bar execution
- Handle [Parameter] attributes as input() declarations
- Preserve the trading logic exactly — do not simplify or optimize
- Use proper Pine Script v5 syntax with strategy() or indicator() declaration
- Add plot() calls for visual indicators on chart
- Add alertcondition() for entry/exit signals

Return ONLY the Pine Script code, no explanation. Wrap in a code block.`

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Translate this code:\n\n${source}` }],
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
      }
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    console.error('Translate API error:', err)
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
    res.end()
  }
}
