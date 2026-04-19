import { sql } from '@vercel/postgres'

// Auto-create tables on first request
async function ensureTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tag TEXT DEFAULT 'testing',
      config JSONB NOT NULL,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      strategy_id TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_strategies_user ON strategies(user_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_user ON journal_entries(user_id)`
}

export default async function handler(req, res) {
  // Check if Postgres is configured
  if (!process.env.POSTGRES_URL) {
    return res.status(200).json({ fallback: true, message: 'No database configured — using localStorage' })
  }

  try {
    await ensureTables()
  } catch (err) {
    return res.status(500).json({ error: 'Database setup failed: ' + err.message })
  }

  const userId = req.headers['x-user-id'] || 'anonymous'

  // GET — list strategies
  if (req.method === 'GET') {
    const action = req.query.action
    if (action === 'strategies') {
      const { rows } = await sql`
        SELECT id, name, tag, config, notes, created_at, updated_at
        FROM strategies WHERE user_id = ${userId}
        ORDER BY updated_at DESC
      `
      return res.status(200).json({ strategies: rows })
    }
    if (action === 'journal') {
      const { rows } = await sql`
        SELECT id, strategy_id, content, created_at
        FROM journal_entries WHERE user_id = ${userId}
        ORDER BY created_at DESC LIMIT 100
      `
      return res.status(200).json({ entries: rows })
    }
    return res.status(400).json({ error: 'Unknown action' })
  }

  // POST — create/update
  if (req.method === 'POST') {
    const { action, strategy, entry } = req.body

    if (action === 'save-strategy') {
      const { id, name, tag, config, notes } = strategy
      await sql`
        INSERT INTO strategies (id, user_id, name, tag, config, notes, updated_at)
        VALUES (${id}, ${userId}, ${name}, ${tag || 'testing'}, ${JSON.stringify(config)}, ${notes || ''}, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = ${name}, tag = ${tag || 'testing'}, config = ${JSON.stringify(config)},
          notes = ${notes || ''}, updated_at = NOW()
      `
      return res.status(200).json({ ok: true })
    }

    if (action === 'update-tag') {
      const { id, tag } = req.body
      await sql`UPDATE strategies SET tag = ${tag}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`
      return res.status(200).json({ ok: true })
    }

    if (action === 'save-journal') {
      const { id, strategyId, content } = entry
      await sql`
        INSERT INTO journal_entries (id, user_id, strategy_id, content)
        VALUES (${id}, ${userId}, ${strategyId || null}, ${content})
      `
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  }

  // DELETE
  if (req.method === 'DELETE') {
    const { id, type } = req.body
    if (type === 'strategy') {
      await sql`DELETE FROM strategies WHERE id = ${id} AND user_id = ${userId}`
    } else if (type === 'journal') {
      await sql`DELETE FROM journal_entries WHERE id = ${id} AND user_id = ${userId}`
    }
    return res.status(200).json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
