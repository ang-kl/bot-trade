import { setTimeout as delay } from 'node:timers/promises'
import { observeVerifier } from '../agent/services/verify-observer.js'
import { createObserverDelivery, sendObserverTelegram } from '../agent/services/verify-observer-delivery.js'
const env = process.env
const delivery = createObserverDelivery({ path: env.VERIFY_OBSERVER_STATE_PATH,
  enabled: env.VERIFY_OBSERVER_DELIVERY_ENABLED === '1',
  send: event => sendObserverTelegram(event, { token: env.VERIFY_OBSERVER_TELEGRAM_TOKEN, chatId: env.VERIFY_OBSERVER_TELEGRAM_CHAT_ID }) })
const watch = process.argv.includes('--watch')
do {
  const result = await observeVerifier({ url: env.VERIFY_OBSERVER_URL, secret: env.VERIFY_OBSERVER_SECRET })
  let notification
  try { notification = await delivery(result) } catch { notification = { state: 'observer_storage_or_contract_failed', accepted: false } }
  console.log(JSON.stringify({ ...result, notification }))
  process.exitCode = result.ok && ['muted', 'idle', 'telegram_accepted'].includes(notification.state) ? 0 : 2
  if (watch) await delay(30000)
} while (watch)
