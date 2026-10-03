// agent/lib/site-gate.js — the login gate in front of the website.
//
// Owner, 03-10-2026 (№ 10,885): "a front log in to match the telegram and
// secret as now those who don't have these two can still see what is this
// website is about." Until this file the site root served the app shell to
// anyone: the panels failed with 401, but the layout, the names and the
// controls were readable. The API's own auth is unchanged (a bearer token on
// every /state and /actions call); this gate decides only whether the PAGE
// and its assets are served at all.
//
// How it works. A GET for anything that is not an API path (the app shell,
// /assets, /fonts, the icons, the manifest) is served only when the request
// carries a session cookie that names a live device session — the same
// 90-day sessions the Telegram login already mints. Without one the response
// is the login page below (HTTP 200, no-store, noindex): secret first, then
// the Telegram code, both checked by POST /auth/login in index.js. On
// success the server sets the HttpOnly cookie and the page stores the session
// token under the key the app reads (`agent_secret`), so the app opens
// connected. The cookie is never read by the API routes: a cookie that
// authorised writes would turn every cross-site request into a forged one,
// and the bearer header is the app's existing, deliberate way of saying who
// is acting.

export const SESSION_COOKIE = 'bt_session'
const NINETY_DAYS_S = 90 * 86_400

/** Paths the gate never touches: the API (bearer-authenticated), the public
 * liveness probe, the login routes and the icon the login page shows. */
export function isApiPath(path) {
  return /^\/(api|state|actions|auth|health|icon\.png)(\/|$)/.test(String(path || ''))
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()) } catch { out[k] = part.slice(i + 1).trim() }
  }
  return out
}

export function sessionCookieHeader(token, { secure = true, maxAgeSec = NINETY_DAYS_S } = {}) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

/** The session token a request carries in its cookie, or ''. */
export function sessionFromRequest(req) {
  return parseCookies(req?.headers?.cookie)[SESSION_COOKIE] || ''
}

/**
 * Express middleware. Mount it BEFORE express.static and the SPA fallback.
 * `isValidSession(token)` is index.js's own check against `device_sessions`,
 * so a revoked session loses the page on its next request.
 */
export function siteGateMiddleware({ isValidSession, html = loginPageHtml } = {}) {
  if (typeof isValidSession !== 'function') throw new Error('siteGateMiddleware needs isValidSession')
  return function siteGate(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (isApiPath(req.path)) return next()
    if (isValidSession(sessionFromRequest(req))) return next()
    res.status(200)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    if (req.method === 'HEAD') return res.end()
    return res.send(html())
  }
}

/**
 * A lockout that recovers on its own: `max` failures inside `windowMs` lock
 * until the oldest of them ages out of the window. A counter that only a
 * success could reset is a lockout nothing can clear once it has tripped
 * (Codex P1 on #1215).
 */
export function createLockout({ max = 10, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
  let failures = []
  const prune = () => { const cutoff = now() - windowMs; failures = failures.filter(t => t > cutoff) }
  return {
    fail() { failures.push(now()); prune() },
    locked() { prune(); return failures.length >= max },
    reset() { failures = [] },
    count() { prune(); return failures.length },
  }
}

/** The login page. Inline, no app code, no green (the owner is red/green
 * colour-blind: blue is positive, red is negative). */
export function loginPageHtml() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in</title>
<link rel="icon" type="image/png" href="/icon.png">
<style>
:root{--bg:#0a0c1c;--panel:#12152b;--ink:#e8eaf2;--muted:#9aa3b8;--line:#2a2f49;--accent:#2563eb;--danger:#dc2626}
@media (prefers-color-scheme: light){:root{--bg:#f4f5f9;--panel:#ffffff;--ink:#141826;--muted:#5b6473;--line:#d5d9e4}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.15rem;margin:0 0 4px;display:flex;align-items:center;gap:10px}
h1 img{width:28px;height:28px;border-radius:6px}
p{margin:0 0 16px;color:var(--muted);font-size:.9rem}
label{display:block;font-size:.85rem;color:var(--muted);margin:12px 0 4px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font-size:1rem}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;margin-top:16px;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:1rem;cursor:pointer}
button[disabled]{opacity:.6;cursor:wait}
.err{color:var(--danger);font-size:.9rem;min-height:1.3em;margin-top:10px}
.hint{font-size:.8rem;color:var(--muted);margin-top:14px}
#code-step{display:none}
</style>
</head>
<body>
<main>
<h1><img src="/icon.png" alt="" onerror="this.remove()">bot-trade</h1>
<p>Sign in with the secret, then the code sent to the owner's Telegram.</p>
<form id="f" autocomplete="off">
<label for="secret">Secret</label>
<input id="secret" type="password" autocomplete="current-password" required>
<div id="code-step">
<label for="code">Telegram code</label>
<input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6 digits">
</div>
<button id="go" type="submit">Send code to Telegram</button>
<div class="err" id="err" role="alert"></div>
</form>
<div class="hint">The session lasts 90 days on this device. A code is valid for five minutes.</div>
</main>
<script>
(function(){
  var f=document.getElementById('f'),secret=document.getElementById('secret'),code=document.getElementById('code'),step=document.getElementById('code-step'),go=document.getElementById('go'),err=document.getElementById('err');
  var sent=false;
  async function post(body){
    var r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'});
    var j={};try{j=await r.json()}catch(e){}
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    return j;
  }
  f.addEventListener('submit',async function(ev){
    ev.preventDefault();err.textContent='';go.disabled=true;
    try{
      if(!sent){
        await post({secret:secret.value});
        sent=true;step.style.display='block';code.focus();go.textContent='Sign in';
      }else{
        var j=await post({secret:secret.value,code:code.value.trim()});
        try{if(j.token)localStorage.setItem('agent_secret',j.token)}catch(e){}
        location.reload();
      }
    }catch(e){err.textContent=e.message||'Sign-in failed'}
    go.disabled=false;
  });
})();
</script>
</body>
</html>
`
}
