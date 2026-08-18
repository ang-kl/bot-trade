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
