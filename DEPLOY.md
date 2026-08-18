# Deploying bot-trade

Everything the agent needs that does NOT live in the code. Written on
19-08-2026, after an outage where the fix was in `main` for hours and had no
effect, because the platform was still building something else.

## Railway service: `sg-trade`

| setting | value | why it matters |
| --- | --- | --- |
| Root Directory | `/` (repo root) | Decides which Dockerfile is used. With `/agent`, Railway builds `agent/Dockerfile`, whose context cannot see the frontend source — so the API runs and **the web UI does not exist**. |
| Dockerfile Path | `Dockerfile` or empty | An explicit `agent/Dockerfile` here overrides the root directory and reintroduces the same problem. |
| Healthcheck Path | `/health` | Unauthenticated on purpose. |
| Volume mount | `/data` | |
| `DB_PATH` | `/data/agent.db` | Must be **inside** the mount. A path beside it looks identical in the logs and is wiped on every redeploy. |

**How to tell which Dockerfile actually built.** Line 2 of the build log:

- `load build definition from Dockerfile` — correct; the build has a
  `frontend` stage running `npm run build`, and the image contains the UI.
- `load build definition from agent/Dockerfile` — the Root Directory is still
  `/agent`. The deploy will succeed and the pages will 404.

## Reading a boot

The first lines of the **Deploy** log (not the Build log) are diagnostic by
design, because for most of this outage the crash named a mechanism and never
a cause:

```
[boot] Opening database at: /data/agent.db
[reclaim] volume critically low (free=…)      ← only when space is critical
[reclaim]   …MB  <largest files on the volume>
[boot] storage: db=…MB wal=…MB shm=…MB free=…MB journal=wal
[http] serving frontend from /app/dist        ← or: no dist/index.html
[agent] listening on 0.0.0.0:…
```

- `journal=wal-exclusive` means the volume was too full to create the WAL's
  `-shm` file and the agent fell back to holding the wal-index in heap. It is
  running, but no second process can open the database until the next clean
  boot. Treat it as an alarm, not a mode.
- `no dist/index.html` means the image was built without the UI — see the
  Root Directory row above.

## Disk

Retention prunes on a schedule and always has. SQLite does not shrink on
DELETE: freed pages go on the freelist and are reused, so the FILE only ever
grows. `VACUUM` is what returns bytes to the volume, and it needs roughly the
database's own size free to rebuild — which is exactly what a full volume does
not have.

So the order out of a full disk is:

1. Grow the volume. Nothing else reliably works at 100%; the boot-time reclaim
   buys back the WAL and stale files, which may or may not be enough.
2. Let the agent boot. Housekeeping compacts on its next pass.
3. If it still reports `compaction BLOCKED`, it names how much it needs.

`EMERGENCY_PURGE=1` forces the boot-time reclaim even when free space looks
fine — for testing it, or for a volume whose free-space reporting is wrong.

## Outside this repo

- **Spotware** — the Railway origin must be registered as the cTrader app's
  redirect URI, or linking a NEW account fails with a redirect_uri mismatch.
  Existing accounts are unaffected: the agent refreshes its own token directly
  and never used the old Vercel function to do it.
- **Vercel** — the project still builds a preview on every push and still
  costs money. Deleting it is what ends the bill; the code no longer needs it.
