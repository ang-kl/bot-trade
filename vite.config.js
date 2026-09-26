import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolveBuildCommit } from './scripts/build-commit.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
// Display format 0.#.### — patch zero-padded to three digits
const [major, minor, patch] = pkg.version.split('.')
const displayVersion = `${major}.${minor}.${String(patch).padStart(3, '0')}`

// Git commit stamped into the build — the footer's proof of WHICH code is
// actually deployed (package.json versions drifted 12 releases behind once;
// a commit hash can't lie). UI-4 S2: Railway (this deploy's host, Dockerfile
// stage "frontend") exposes RAILWAY_GIT_COMMIT_SHA when the stage declares
// `ARG RAILWAY_GIT_COMMIT_SHA`; Vercel's own var and a bare GIT_COMMIT_SHA
// stay as fallbacks; a local build asks git; 'dev' — read as "unknown", not
// as a mismatch — when none of those resolve (scripts/build-commit.mjs).
const gitCommit = resolveBuildCommit(process.env)

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Vitest transforms .jsx with esbuild directly (plugin-react only covers
  // serve/build), so without this the first component test to render JSX
  // hit "React is not defined". Automatic runtime matches what plugin-react
  // already emits for the app bundle — no behaviour change outside tests.
  esbuild: { jsx: 'automatic' },
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
      // scripts/ had no tests at all until count-interactions.js grew two new
      // output modes; the flags it gained fail SILENTLY when mis-wired, so
      // they need executable evidence rather than a manual run someone
      // remembers to do.
      'scripts/**/*.test.js',
    ],
  },
})
