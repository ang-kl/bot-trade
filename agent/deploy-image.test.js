// ---------------------------------------------------------------------------
// The image has to contain the UI, and the UI has to be where index.js looks.
//
// This is a source test, which is normally a last resort — but the thing being
// checked has no injection point at all: it is the relationship between a
// Dockerfile's COPY targets and a path literal in index.js, and it is invisible
// from inside the running process. When it was wrong, nothing failed. The API
// answered, /health was 200, and the pages simply did not exist, because
// `../dist` pointed at a directory the build never created.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
// Comments contain the words the assertions look for; strip them so a test
// cannot pass by matching its own explanation (see CLAUDE.md, failure mode 2).
const code = (p) => read(p).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

test('the root Dockerfile builds the frontend', () => {
  const df = code('Dockerfile')
  assert.match(df, /RUN npm ci\b/, 'the build stage installs devDependencies — vite lives there')
  assert.ok(!/RUN npm ci --omit=dev\s*$[\s\S]*RUN npm run build/m.test(df),
    'the frontend stage must not omit devDependencies, or vite is missing')
  assert.match(df, /npm run build/)
})

test('the build is verified inside the image, not assumed', () => {
  assert.match(code('Dockerfile'), /test -f dist\/index\.html/,
    'a build that silently produced nothing must fail the image build, not ship an empty UI')
})

test('the image layout matches the path index.js actually resolves', () => {
  const df = code('Dockerfile')
  // index.js: resolve(dirname(index.js), '../dist')
  const idx = read('agent/index.js')
  assert.match(idx, /resolve\(dirname\(new URL\(import\.meta\.url\)\.pathname\), '\.\.\/dist'\)/)

  // So agent code and dist must be SIBLINGS in the image.
  assert.match(df, /COPY agent \.\/agent/, 'agent code at /app/agent')
  assert.match(df, /COPY --from=\w+ \/build\/dist \.\/dist/, 'built site at /app/dist — its sibling')
  assert.match(df, /CMD \["node", "agent\/index\.js"\]/)
})

test('backend dependencies are installed from the AGENT package, not the root one', () => {
  const df = code('Dockerfile')
  assert.match(df, /COPY agent\/package\*\.json/)
  // The root package.json has no better-sqlite3/express — installing it for the
  // runtime stage would produce an image that builds fine and cannot boot.
  const rootPkg = JSON.parse(read('package.json'))
  assert.ok(!rootPkg.dependencies?.['better-sqlite3'],
    'root package has no better-sqlite3 — so the runtime stage must not use it')
  const agentPkg = JSON.parse(read('agent/package.json'))
  assert.ok(agentPkg.dependencies?.['better-sqlite3'])
})

test('railway.json points at the root Dockerfile and keeps the healthcheck', () => {
  const rj = JSON.parse(read('railway.json'))
  assert.equal(rj.build.builder, 'DOCKERFILE')
  assert.equal(rj.build.dockerfilePath, 'Dockerfile')
  assert.equal(rj.deploy.healthcheckPath, '/health')
})

test('dist is excluded from the build context', () => {
  // Copying a locally-built dist into the image would mask a broken build
  // stage: the image would serve whatever happened to be on the machine.
  const di = read('.dockerignore').split('\n').map((l) => l.trim())
  assert.ok(di.includes('dist'))
  assert.ok(di.includes('node_modules'))
})

test('a missing UI is announced, never silent', () => {
  const idx = read('agent/index.js')
  assert.match(idx, /no dist\/index\.html/,
    'if the UI is absent the log must say so — that absence is exactly what went unnoticed')
})

test('the image can be started by `npm start`, not only by the CMD', () => {
  // THE FAILURE THIS EXISTS FOR. Railway runs a custom start command of
  // `npm start`, which overrides a Dockerfile CMD entirely. The old image
  // satisfied that by accident — WORKDIR was /app and the AGENT's package.json
  // happened to sit there. Moving the agent to /app/agent to make room for the
  // built site removed it, and the container died on
  // `ENOENT: open '/app/package.json'` before printing one line of its own.
  //
  // Asserting on the CMD alone could never have caught this: the CMD was
  // correct throughout, and was never the thing being run.
  const df = code('Dockerfile')
  assert.match(df, /writeFileSync\('\/app\/package\.json'/,
    'the image must provide a start script at /app, since the platform may use npm start')
  assert.match(df, /start:\s*'node agent\/index\.js'/)

  // And it must not be the repo root package.json, which is the frontend's:
  // `npm start` against that would run vite, not the agent.
  const rootPkg = JSON.parse(read('package.json'))
  assert.notEqual(rootPkg.scripts?.start, 'node agent/index.js',
    'the repo root package.json is the frontend build, not the runtime entrypoint')
})

test('the generated start script is verified inside the build', () => {
  // A generator that silently wrote the wrong thing would reproduce the same
  // crash, so the build checks its own output rather than assuming.
  assert.match(code('Dockerfile'), /scripts\.start!==.node agent\/index\.js.*process\.exit\(1\)/)
})

test('the generated file carries the real version, not a versionless stub', () => {
  // /app/package.json is ALSO what index.js reads as '../package.json' and
  // telegram.js as '../../package.json'. Their fallbacks differ: index.js keeps
  // 0.0.000, but telegram.js prints NO footer on a failed read — so a
  // versionless file here would succeed and stamp `v0.0.000` on every message,
  // asserting a build that never existed.
  const df = code('Dockerfile')
  assert.match(df, /COPY --from=frontend \/build\/package\.json/,
    'the real version has to come from the build context, not be typed in')
  assert.match(df, /version:\s*v/)
  assert.match(df, /!p\.version\) process\.exit\(1\)/,
    'a build that produced no version must fail rather than ship 0.0.000')
  assert.ok(!/version["']?\s*:\s*["']\d/.test(df),
    'a literal version would drift from package.json silently')

  // And the source of truth actually has one.
  assert.match(JSON.parse(read('package.json')).version, /^\d+\.\d+\.\d+$/)
})

test('the stale build-context comment is corrected, not left to mislead', () => {
  const idx = read('agent/index.js')
  assert.ok(!/the Docker build context is agent\/, so APP_VERSION can't/.test(idx),
    'that explanation stopped being true when the Dockerfile moved to the repo root')
})
