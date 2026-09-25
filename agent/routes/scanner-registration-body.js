import express from 'express'
import { SCANNER_PROFILES_PATH, SCANNER_REGISTRATION_BYTES } from '../lib/scanner-bounds.js'

// The profile registration body is the only one larger than Express's 100 KB
// default. Parsing it before authentication would let any client make Node
// buffer and parse 512 KiB, so the global parser leaves exactly this path
// alone and index.js mounts the larger parser AFTER authMiddleware. Express
// routing is case-insensitive and ignores one trailing slash, so the skip
// matches the same way; any path it skips is covered by the scoped mount.
const REGISTRATION_PATH = /^\/actions\/scanner-profiles\/?$/i

export function jsonExceptScannerRegistration(parser = express.json()) {
  return (req, res, next) => REGISTRATION_PATH.test(req.path) ? next() : parser(req, res, next)
}

export function scannerRegistrationJson() {
  return express.json({ limit: SCANNER_REGISTRATION_BYTES })
}

export { SCANNER_PROFILES_PATH, SCANNER_REGISTRATION_BYTES }
