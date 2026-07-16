import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
// Display format 0.#.### — patch zero-padded to three digits
const [major, minor, patch] = pkg.version.split('.')
const displayVersion = `${major}.${minor}.${String(patch).padStart(3, '0')}`

// Git commit stamped into the build — the footer's proof of WHICH code is
// actually deployed (package.json versions drifted 12 releases behind once;
// a commit hash can't lie). Vercel exposes the sha as an env var; local
// builds ask git; 'dev' when neither exists.
const gitCommit = (() => {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { return 'dev' }
})()

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(displayVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.{js,jsx}',
      'api/**/*.test.js',
      'server/**/*.test.js',
    ],
  },
})
