// Telegram Alert configuration page.
// Manages bot token, chat ID, alert triggers, and provides test tools.
// Includes Alert Log with symbol-grouped sub-cards, status tracking, history.

import { useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import Card from '../components/common/Card.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import Badge from '../components/common/Badge.jsx'
import { useStrategy } from '../lib/strategy-store.js'

function maskToken(token) {
  if (!token || token.length < 8) return '\u2022'.repeat(12)
  return token.slice(0, 4) + '\u2022'.repeat(Math.min(token.length - 4, 16))
}

async function callTelegram(body) {
  const res = await fetch('/api/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `telegram ${res.status}`)
  return data
}

export default function Alert() {
  const { state, dispatch } = useStrategy()
  const tg = state.telegram

  const [editing, setEditing] = useState(false)
  const [draftToken, setDraftToken] = useState('')
  const [draftChatId, setDraftChatId] = useState('')

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [discovering, setDiscovering] = useState(false)
  const [chats, setChats] = useState(null)
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState(null)

  const hasToken = !!tg.botToken
  const hasChatId = !!tg.chatId

  const startEdit = useCallback(() => {
    setDraftToken(tg.botToken)
    setDraftChatId(tg.chatId)
    setEditing(true)
    setTestResult(null)
    setChats(null)
    setSendResult(null)
  }, [tg.botToken, tg.chatId])

  const saveConfig = useCallback(() => {
    dispatch({
      type: 'TELEGRAM_SET',
      botToken: draftToken.trim(),
      chatId: draftChatId.trim(),
    })
    setEditing(false)
  }, [dispatch, draftToken, draftChatId])

  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const data = await callTelegram({
        action: 'test-connection',
        botToken: tg.botToken,
      })
      setTestResult({ ok: true, name: data.botName, username: data.botUsername })
    } catch (e) {
      setTestResult({ ok: false, error: e.message })
    } finally {
      setTesting(false)
    }
  }, [tg.botToken])

  const handleDiscover = useCallback(async () => {
    setDiscovering(true)
    setChats(null)
    try {
      const data = await callTelegram({
        action: 'get-updates',
        botToken: tg.botToken,
      })
      setChats(data.chats || [])
    } catch (e) {
      setChats([])
      setTestResult({ ok: false, error: e.message })
    } finally {
      setDiscovering(false)
    }
  }, [tg.botToken])

  const handleUseChatId = useCallback((id) => {
    dispatch({ type: 'TELEGRAM_SET', chatId: String(id) })
  }, [dispatch])

  const handleSendTest = useCallback(async () => {
    setSending(true)
    setSendResult(null)
    try {
      await callTelegram({
        action: 'send-test',
        botToken: tg.botToken,
        chatId: tg.chatId,
      })
      setSendResult({ ok: true })
    } catch (e) {
      setSendResult({ ok: false, error: e.message })
    } finally {
      setSending(false)
    }
  }, [tg.botToken, tg.chatId])

  const toggleEnabled = useCallback(() => {
    dispatch({ type: 'TELEGRAM_SET', enabled: !tg.enabled })
  }, [dispatch, tg.enabled])

  const toggleAlertOnScan = useCallback(() => {
    dispatch({ type: 'TELEGRAM_SET', alertOnScan: !tg.alertOnScan })
  }, [dispatch, tg.alertOnScan])

  const toggleAlertOnTrade = useCallback(() => {
    dispatch({ type: 'TELEGRAM_SET', alertOnTrade: !tg.alertOnTrade })
  }, [dispatch, tg.alertOnTrade])

  const handleMinConfidence = useCallback((e) => {
    dispatch({ type: 'TELEGRAM_SET', minConfidence: Number(e.target.value) })
  }, [dispatch])

  const handleDisconnect = useCallback(() => {
    dispatch({
      type: 'TELEGRAM_SET',
      botToken: '',
      chatId: '',
      enabled: false,
    })
    setEditing(false)
    setTestResult(null)
    setChats(null)
    setSendResult(null)
  }, [dispatch])

  return (
    <section className="space-y-4">
      <h1 className="t-title">Telegram Alerts</h1>

      {/* Status banner */}
      <Card className="flex items-center gap-3 flex-wrap">
        <span className="text-[20px]">{hasToken ? '\u26A1' : '\u{1F4E1}'}</span>
        <div className="flex-1">
          <p className="t-body font-bold">
            {hasToken ? 'Telegram Bot Connected' : 'Telegram Bot Not Configured'}
          </p>
          <p className="t-meta text-[var(--color-muted)]">
            {hasToken && hasChatId
              ? 'Bot token and chat ID set. Alerts can be sent.'
              : hasToken
                ? 'Bot token set but no chat ID. Discover chats below.'
                : 'Add your Telegram bot token to enable alerts.'}
          </p>
        </div>
        <Badge tone={tg.enabled ? 'up' : 'neutral'} pill>
          {tg.enabled ? 'ENABLED' : 'DISABLED'}
        </Badge>
      </Card>

      {/* Bot configuration */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="t-label">Bot Configuration</h2>
          {hasToken && !editing && (
            <Button size="sm" variant="ghost" onClick={startEdit}>Edit</Button>
          )}
        </div>

        {editing || !hasToken ? (
          <div className="space-y-3">
            <div>
              <label className="t-meta text-[var(--color-muted)] mb-1 block">Bot Token</label>
              <Input
                value={editing ? draftToken : ''}
                onChange={(e) => editing ? setDraftToken(e.target.value) : null}
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                onFocus={() => { if (!editing) startEdit() }}
              />
              <p className="t-meta text-[var(--color-muted)] mt-1">
                Get a token from @BotFather on Telegram
              </p>
            </div>
            <div>
              <label className="t-meta text-[var(--color-muted)] mb-1 block">Chat ID</label>
              <Input
                value={editing ? draftChatId : ''}
                onChange={(e) => editing ? setDraftChatId(e.target.value) : null}
                placeholder="-1001234567890"
                onFocus={() => { if (!editing) startEdit() }}
              />
              <p className="t-meta text-[var(--color-muted)] mt-1">
                Message your bot, then use Discover below to find the chat ID
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveConfig} disabled={!draftToken.trim()}>
                Save
              </Button>
              {editing && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="t-meta text-[var(--color-muted)]">Token:</span>
              <span className="t-sub text-[var(--color-text-sub)] font-mono">{maskToken(tg.botToken)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="t-meta text-[var(--color-muted)]">Chat ID:</span>
              <span className="t-sub text-[var(--color-text-sub)] font-mono">
                {tg.chatId || '\u2014 not set'}
              </span>
            </div>
          </div>
        )}
      </Card>

      {/* Connection tools */}
      {hasToken && !editing && (
        <Card>
          <h2 className="t-label mb-3">Connection Tools</h2>
          <div className="flex gap-2 flex-wrap mb-3">
            <Button size="sm" variant="ghost" onClick={handleTestConnection} disabled={testing}>
              {testing ? 'Testing...' : '\u{1F50D} Test Connection'}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleDiscover} disabled={discovering}>
              {discovering ? 'Discovering...' : '\u{1F4AC} Discover Chats'}
            </Button>
            {hasChatId && (
              <Button size="sm" variant="primary" onClick={handleSendTest} disabled={sending}>
                {sending ? 'Sending...' : '\u{1F4E8} Send Test Message'}
              </Button>
            )}
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`rounded-[7px] px-3 py-2 mb-3 t-sub ${testResult.ok
              ? 'bg-[var(--color-success-bg)] text-[var(--color-up)]'
              : 'bg-[var(--color-error-bg)] text-[var(--color-down)]'}`}>
              {testResult.ok
                ? `Connected to @${testResult.username} (${testResult.name})`
                : `Error: ${testResult.error}`}
            </div>
          )}

          {/* Send result */}
          {sendResult && (
            <div className={`rounded-[7px] px-3 py-2 mb-3 t-sub ${sendResult.ok
              ? 'bg-[var(--color-success-bg)] text-[var(--color-up)]'
              : 'bg-[var(--color-error-bg)] text-[var(--color-down)]'}`}>
              {sendResult.ok
                ? 'Test message sent! Check your Telegram.'
                : `Error: ${sendResult.error}`}
            </div>
          )}

          {/* Discovered chats */}
          {chats !== null && (
            <div>
              {chats.length === 0 ? (
                <p className="t-meta text-[var(--color-muted)]">
                  No chats found. Send a message to the bot first, then try again.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="t-meta text-[var(--color-muted)] mb-2">
                    Found {chats.length} chat{chats.length !== 1 ? 's' : ''}:
                  </p>
                  {chats.map((c) => (
                    <div key={c.chatId} className="flex items-center gap-2 px-3 py-2 rounded-[7px] bg-[var(--color-bg)] border border-[var(--color-border)]">
                      <div className="flex-1">
                        <span className="t-sub font-semibold">
                          {c.title || c.firstName || c.username || 'Unknown'}
                        </span>
                        <span className="t-meta text-[var(--color-muted)] ml-2">
                          {c.type} \u00B7 {c.chatId}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant={String(c.chatId) === tg.chatId ? 'ghost' : 'primary'}
                        onClick={() => handleUseChatId(c.chatId)}
                        disabled={String(c.chatId) === tg.chatId}
                      >
                        {String(c.chatId) === tg.chatId ? 'Selected' : 'Use'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Alert settings */}
      {hasToken && !editing && (
        <Card>
          <h2 className="t-label mb-3">Alert Settings</h2>
          <div className="space-y-3">
            {/* Master toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={tg.enabled}
                onChange={toggleEnabled}
                className="w-4 h-4 accent-[var(--color-accent)]"
              />
              <div>
                <span className="t-sub font-semibold">Enable Alerts</span>
                <p className="t-meta text-[var(--color-muted)]">Send Telegram messages on triggers</p>
              </div>
            </label>

            {/* Alert on scan */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={tg.alertOnScan}
                onChange={toggleAlertOnScan}
                disabled={!tg.enabled}
                className="w-4 h-4 accent-[var(--color-accent)]"
              />
              <div>
                <span className={`t-sub ${!tg.enabled ? 'text-[var(--color-muted)]' : ''}`}>
                  Alert on Scan
                </span>
                <p className="t-meta text-[var(--color-muted)]">Send results after watchlist scan completes</p>
              </div>
            </label>

            {/* Alert on trade */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={tg.alertOnTrade}
                onChange={toggleAlertOnTrade}
                disabled={!tg.enabled}
                className="w-4 h-4 accent-[var(--color-accent)]"
              />
              <div>
                <span className={`t-sub ${!tg.enabled ? 'text-[var(--color-muted)]' : ''}`}>
                  Alert on Trade
                </span>
                <p className="t-meta text-[var(--color-muted)]">Notify when AI places or closes a trade</p>
              </div>
            </label>

            {/* Min confidence */}
            <div className="flex items-center gap-3">
              <label className="t-meta text-[var(--color-muted)] shrink-0">Min Confidence</label>
              <select
                value={tg.minConfidence}
                onChange={handleMinConfidence}
                disabled={!tg.enabled}
                className="rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2 py-1.5 text-[13px] min-h-[36px] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                  <option key={n} value={n}>{n}/10</option>
                ))}
              </select>
              <span className="t-meta text-[var(--color-muted)]">
                Only alert on setups with this confidence or higher
              </span>
            </div>
          </div>
        </Card>
      )}

      {/* Disconnect */}
      {hasToken && !editing && (
        <Card className="flex items-center justify-between">
          <p className="t-meta text-[var(--color-muted)]">
            Remove bot token and disconnect Telegram alerts.
          </p>
          <Button size="sm" variant="danger" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Card>
      )}

      {/* Alert Log */}
      <AlertLog alerts={state.alertLog || []} dispatch={dispatch} />
    </section>
  )
}

// ── Alert status colours ──
const STATUS_TONE = { alive: 'up', done: 'info', dead: 'down' }
const STATUS_LABEL = { alive: 'ALIVE', done: 'DONE', dead: 'DEAD' }

// ── Alert Log card ──

function AlertLog({ alerts, dispatch }) {
  const [sortBy, setSortBy] = useState('date') // date | symbol | status
  const [filterStatus, setFilterStatus] = useState('all')

  const filtered = useMemo(() => {
    let list = [...alerts]
    if (filterStatus !== 'all') list = list.filter(a => a.status === filterStatus)
    if (sortBy === 'date') list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    else if (sortBy === 'symbol') list.sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''))
    else if (sortBy === 'status') list.sort((a, b) => (a.status || '').localeCompare(b.status || ''))
    return list
  }, [alerts, sortBy, filterStatus])

  // Group by symbol
  const grouped = useMemo(() => {
    const groups = {}
    for (const a of filtered) {
      const sym = a.symbol || 'Unknown'
      if (!groups[sym]) groups[sym] = []
      groups[sym].push(a)
    }
    return groups
  }, [filtered])

  const symbolKeys = Object.keys(grouped).sort()

  // Token totals
  const totalTokens = alerts.reduce((sum, a) => sum + (a.tokens || 0), 0)

  return (
    <Card>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="t-label">Alert Log</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="t-meta text-[var(--color-muted)]">Sort:</span>
          {['date', 'symbol', 'status'].map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSortBy(s)}
              className={`px-1.5 py-0.5 text-[10px] rounded-[4px] font-semibold cursor-pointer ${
                sortBy === s
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-bg)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]'
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
          <span className="t-meta text-[var(--color-muted)] ml-2">Filter:</span>
          {['all', 'alive', 'done', 'dead'].map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setFilterStatus(s)}
              className={`px-1.5 py-0.5 text-[10px] rounded-[4px] font-semibold cursor-pointer ${
                filterStatus === s
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-bg)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]'
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Token usage summary */}
      {alerts.length > 0 && (
        <div className="flex items-center gap-3 mb-3 text-[10px] text-[var(--color-muted)]">
          <span>{alerts.length} total alerts</span>
          <span>{alerts.filter(a => a.status === 'alive').length} alive</span>
          <span>{alerts.filter(a => a.status === 'done').length} done</span>
          <span>{alerts.filter(a => a.status === 'dead').length} dead</span>
          {totalTokens > 0 && <span>{totalTokens.toLocaleString()} tokens used</span>}
        </div>
      )}

      {alerts.length === 0 ? (
        <p className="t-sub text-[var(--color-muted)] py-4 text-center">
          No alerts yet. Alerts will appear here when the system generates them.
        </p>
      ) : (
        <div className="space-y-3">
          {symbolKeys.map(sym => {
            const items = grouped[sym]
            return (
              <div key={sym} className="border border-[var(--color-border)] rounded-[7px] overflow-hidden">
                {/* Symbol header */}
                <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
                  <span className="font-bold text-[12px] text-[var(--color-text)]">{sym}</span>
                  <Badge tone="info" pill>{items.length}</Badge>
                  <div className="flex-1" />
                  <Link
                    to="/advisory"
                    className="t-meta text-[var(--color-accent)] hover:underline"
                  >
                    View in Feed
                  </Link>
                </div>

                {/* Alert entries */}
                <div className="divide-y divide-[var(--color-border)]">
                  {items.map((a, i) => (
                    <div key={a.id || i} className="px-3 py-2 flex items-start gap-2">
                      <Badge
                        tone={STATUS_TONE[a.status] || 'neutral'}
                        pill
                        className="mt-0.5 shrink-0"
                      >
                        {STATUS_LABEL[a.status] || a.status?.toUpperCase() || 'UNKNOWN'}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="t-sub text-[var(--color-text)]">{a.message || a.type || 'Alert'}</p>
                        {a.details && (
                          <p className="t-meta text-[var(--color-text-sub)]">{a.details}</p>
                        )}
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {a.timestamp && (
                            <span className="t-meta text-[var(--color-muted)]">
                              {new Date(a.timestamp).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                            </span>
                          )}
                          {a.agent && (
                            <span className="t-meta text-[var(--color-muted)]">{a.agent}</span>
                          )}
                          {a.tokens > 0 && (
                            <span className="t-meta text-[var(--color-muted)]">{a.tokens} tok</span>
                          )}
                        </div>
                      </div>
                      {/* Status toggle */}
                      {dispatch && a.id && (
                        <select
                          value={a.status || 'alive'}
                          onChange={(e) => dispatch({ type: 'ALERT_LOG_UPDATE_STATUS', id: a.id, status: e.target.value })}
                          className="text-[10px] rounded-[4px] border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 min-h-[28px]"
                        >
                          <option value="alive">Alive</option>
                          <option value="done">Done</option>
                          <option value="dead">Dead</option>
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
