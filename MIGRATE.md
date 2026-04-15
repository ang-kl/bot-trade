# Migrate this scaffold into `ang-kl/bot-trade`

This folder was built inside a staging branch of `ang-kl/abot` because the
Claude Code on the web sandbox can only push to `ang-kl/abot`. To land it in
the real `bot-trade` repo, run the recipe below **on your own machine**
(not inside Claude Code).

Prerequisites: `git`, Node 20+, GitHub auth set up locally.

## One-shot recipe

```bash
# 1. Pull the staging branch from ang-kl/abot
git clone --branch claude/bot-trade-phase-1 --depth 1 \
  https://github.com/ang-kl/abot.git abot-staging

# 2. Move into the scaffold subfolder
cd abot-staging/bot-trade

# 3. Sanity-check it installs, builds, and tests cleanly
npm install
npm run build
npm test
npm run check:no-green

# 4. Re-init git and push to the new private repo as the first commit
rm -rf .git 2>/dev/null || true
git init
git add -A
git commit -m "chore: phase 1 scaffold — v2 clean-slate baseline"
git branch -M main
git remote add origin https://github.com/ang-kl/bot-trade.git
git push -u origin main

# 5. Clean up the staging clone
cd ../..
rm -rf abot-staging
```

## After migration

### Vercel
1. Go to https://vercel.com/new
2. Import `ang-kl/bot-trade` (the new private repo)
3. Framework preset: **Vite**
4. Add env vars:
   - `ANTHROPIC_API_KEY`
   - `CTRADER_CLIENT_ID`
   - `CTRADER_CLIENT_SECRET`
   - `X_API_BEARER_TOKEN`
   - `DATA_LAYERS_SECRET`
5. Deploy. The old `cbot-trade.vercel.app` keeps serving v1 untouched.

### Continue with Phase 2+
Open a **fresh Claude Code on the web** session pointed at `ang-kl/bot-trade`,
then paste this prompt:

> Read `HANDOVER-V2.md`. Phase 0 (archive v1) and Phase 1 (scaffold) are
> complete. Start Phase 2 — port the 3 keepers and add integration tests
> beyond the unit tests already present.

That session can write directly to `bot-trade` and won't need this staging
detour.
