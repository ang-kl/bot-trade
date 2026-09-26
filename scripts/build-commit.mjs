// scripts/build-commit.mjs — the commit vite.config.js stamps into the built
// UI as __GIT_COMMIT__, which AgentHealthPanel/agent-health-view.js's
// deployReading compares against the AGENT's own commit
// (agent/index.js's `commit`, read at runtime from the same variable).
//
// UI-4 S2: this deployment runs on Railway (Dockerfile, root), and Railway's
// own build-time variable is RAILWAY_GIT_COMMIT_SHA (Railway docs) — not the
// VERCEL_GIT_COMMIT_SHA this used to read alone, carried over from when the
// UI was a separate Vercel deploy. A Dockerfile build only SEES a Railway
// build variable when the stage that needs it declares `ARG
// RAILWAY_GIT_COMMIT_SHA` (Dockerfile, stage "frontend") — Railway does not
// inject arbitrary env vars into an opaque `docker build`, so the ARG line
// is not optional. VERCEL_GIT_COMMIT_SHA and a bare GIT_COMMIT_SHA stay as
// fallbacks for another host or a manual override.
//
// `.git` is excluded from the Docker build context (.dockerignore), so the
// `git rev-parse` fallback below only ever succeeds OUTSIDE the image —
// inside it, with no env var set, this returns 'dev': an honest "no commit
// available", never a fabricated hash (principle 6, no fake result).
import { execSync } from 'node:child_process'

const defaultGitHead = () => execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()

/**
 * @param {Record<string,string|undefined>} env - typically process.env
 * @param {() => string} gitHead - injectable for tests; defaults to `git rev-parse --short HEAD`
 * @returns {string} a 7-char (or shorter, if the source is shorter) commit, or 'dev'
 */
export function resolveBuildCommit(env = {}, gitHead = defaultGitHead) {
  const fromEnv = env.RAILWAY_GIT_COMMIT_SHA || env.VERCEL_GIT_COMMIT_SHA || env.GIT_COMMIT_SHA
  if (fromEnv) return String(fromEnv).slice(0, 7)
  try {
    const head = gitHead()
    if (head) return String(head).trim()
  } catch { /* no .git here (e.g. inside the Docker build) */ }
  return 'dev'
}
