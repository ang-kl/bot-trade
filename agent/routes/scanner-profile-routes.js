import { Router } from 'express'
import { registerScannerProfiles, scannerProfileRegistry } from '../services/scanner-profile-registry.js'
export default function scannerProfileRoutes(db, deps = {}) {
  const router = Router()
  router.get('/', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(scannerProfileRegistry(db)) })
  router.post('/', (req, res) => {
    try { res.json(registerScannerProfiles(db, req.body, deps)) }
    catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'profile_registration_failed' }) }
  })
  return router
}
