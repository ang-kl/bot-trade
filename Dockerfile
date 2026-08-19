# ---------------------------------------------------------------------------
# Dockerfile — the agent AND the web UI in one Railway service.
#
# WHY THIS EXISTS. agent/Dockerfile builds only the backend, because its build
# context is `agent/` and the frontend source lives one level up. That was
# invisible while Vercel served the UI. It stopped being invisible the moment
# the UI moved here: index.js will serve `../dist` when it exists, and in that
# image it never could, so the routes were live and the pages were not.
#
# THE FIX IS THE CONTEXT, not the code. Building the frontend needs `src/`,
# `index.html` and the root package.json in scope, so this Dockerfile sits at
# the repo root and the Railway service's Root Directory must be `/` rather
# than `/agent`. That dashboard change is the one manual step; without it
# Railway keeps using agent/Dockerfile and the UI stays absent.
#
# LAYOUT MIRRORS THE REPO on purpose. index.js resolves the UI as `../dist`
# relative to itself, so the agent lives at /app/agent and the built site at
# /app/dist — exactly as they sit in git. Flattening the agent to /app would
# push that path to a bare `/dist` at the filesystem root, which works right
# up until someone reads the line and disbelieves it.
# ---------------------------------------------------------------------------

# --- stage 1: build the site -----------------------------------------------
# devDependencies are required here (vite lives there), so no --omit=dev.
FROM node:20 AS frontend
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && test -f dist/index.html

# --- stage 2: the agent, plus the built site -------------------------------
FROM node:20
WORKDIR /app

# Backend dependencies first, so a UI-only change does not reinstall
# better-sqlite3 (which compiles).
COPY agent/package*.json ./agent/
WORKDIR /app/agent
RUN npm ci --omit=dev && echo "Agent dependencies installed successfully"

WORKDIR /app
COPY agent ./agent
COPY --from=frontend /build/dist ./dist

# A START SCRIPT AT /app, because the platform may not use the CMD below.
#
# Railway is configured with a custom start command of `npm start`, which
# overrides a Dockerfile CMD entirely. The previous image satisfied that by
# accident: WORKDIR was /app and the AGENT's package.json sat there, so
# `npm start` found `node index.js`. Moving the agent to /app/agent to make
# room for the built site broke it, and the container died before printing a
# single line of its own:
#
#   npm error Could not read package.json:
#     ENOENT: no such file or directory, open '/app/package.json'
#
# Written here rather than copied from the repo root on purpose: the repo's root
# package.json is the FRONTEND's, and `npm start` against it would run vite.
# This one exists only to name the entrypoint, so the image boots the same way
# whether the platform runs `npm start` or the CMD.
#
# No "type" field: Node resolves the nearest package.json per file, so agent
# code keeps using /app/agent/package.json. Declaring a module type here would
# only add a second, contradictory answer for anything that lands in /app.
# AND IT CARRIES THE REAL VERSION, because /app/package.json is not only the
# start script — it is also the file two readers already resolve as "the
# repo-root package.json": APP_VERSION in agent/index.js ('../package.json')
# and versionFooter() in agent/services/telegram.js ('../../package.json').
#
# Before this file existed both reads threw ENOENT in the image and fell into
# their catch. Their fallbacks differ: index.js keeps '0.0.000', but telegram.js
# sets '' and prints NO footer. A version-less file here would succeed and yield
# `String(pkg.version || '0.0.0')`, so every Telegram message would gain a
# `v0.0.000` stamp asserting a build that never existed — a diagnostic inventing
# a measurement, which is the specific thing this codebase keeps paying for.
#
# Interpolating the real version instead makes both truthful for the first time.
# The old comment at index.js:576 — "the Docker build context is agent/, so
# APP_VERSION can't read the repo-root package.json" — was accurate until this
# Dockerfile moved to the repo root, and is corrected in the same commit.
#
# node -e rather than printf because the version must be read, not typed: a
# literal would drift from package.json silently, which is the same class of
# lie one paragraph up.
COPY --from=frontend /build/package.json /tmp/root-package.json
RUN node -e "const v=require('/tmp/root-package.json').version; if(!v) process.exit(1); require('fs').writeFileSync('/app/package.json', JSON.stringify({name:'bot-trade-runtime',private:true,version:v,scripts:{start:'node agent/index.js'}},null,2)+'\n')" \
    && rm /tmp/root-package.json \
    && node -e "const p=require('/app/package.json'); if(p.scripts.start!=='node agent/index.js'||!p.version) process.exit(1)" \
    && cat /app/package.json

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "agent/index.js"]
