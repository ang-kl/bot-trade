import { observeVerifier } from '../agent/services/verify-observer.js'
const result = await observeVerifier({ url: process.env.VERIFY_OBSERVER_URL, secret: process.env.VERIFY_OBSERVER_SECRET })
console.log(JSON.stringify(result))
process.exitCode = result.ok ? 0 : 2
