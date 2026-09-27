#!/usr/bin/env python3
"""Convert the two handover Markdown files into one self-contained HTML page.

A small converter for the subset the documents use: ATX headings, paragraphs,
nested ordered/unordered lists (with tables inside items), pipe tables with
alignment, fenced code (mermaid fences become <pre class="mermaid">),
blockquotes, horizontal rules, raw <a name> anchors, and the
<!-- details: ... --> / <!-- /details --> markers used around file lists.
"""
import html, re, sys

MAIN, APPX, OUT = sys.argv[1], sys.argv[2], sys.argv[3]

LINK_MAP = {
    'handover-2026-09-27-appendix.md': '#appendix-top',
    'handover-2026-09-27.md': '#top',
    'handover-2026-09-27.html': '#top',
}

def fix_href(h):
    for k, v in LINK_MAP.items():
        if h == k:
            return v
        if h.startswith(k + '#'):
            return h[len(k):]
    return h

def inline(s):
    # protect code spans first
    codes = []
    def keep(m):
        codes.append('<code>' + html.escape(m.group(1), quote=False) + '</code>')
        return f'\x00{len(codes)-1}\x00'
    s = re.sub(r'`([^`]+)`', keep, s)
    s = s.replace('\\*', '\x01')
    s = html.escape(s, quote=False)
    # links [text](href)
    def link(m):
        return f'<a href="{html.escape(fix_href(m.group(2)), quote=True)}">{m.group(1)}</a>'
    s = re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', link, s)
    s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])', r'<em>\1</em>', s)
    s = s.replace('\x01', '*')
    s = re.sub('\x00(\\d+)\x00', lambda m: codes[int(m.group(1))], s)
    return s

used_ids = set()
def slug(text):
    t = re.sub(r'<[^>]+>', '', text)
    t = html.unescape(t).lower()
    t = re.sub(r'[`*]', '', t)
    t = re.sub(r'[^a-z0-9\s-]', '', t)
    t = re.sub(r'\s+', '-', t.strip())[:70].strip('-') or 'section'
    base, i = t, 2
    while t in used_ids:
        t = f'{base}-{i}'; i += 1
    used_ids.add(t)
    return t

def split_row(line):
    line = line.strip()
    if line.startswith('|'): line = line[1:]
    if line.endswith('|'): line = line[:-1]
    cells, cur, in_code = [], '', False
    for ch in line:
        if ch == '`': in_code = not in_code
        if ch == '|' and not in_code:
            cells.append(cur); cur = ''
        else:
            cur += ch
    cells.append(cur)
    return [c.strip() for c in cells]

def is_table_sep(line):
    return bool(re.match(r'^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$', line)) and '-' in line

LIST_RE = re.compile(r'^(\s*)([-*]|\d+\.)\s+(.*)$')

class Ctx:
    def __init__(self):
        self.headings = []  # (level, id, text, doc)
        self.doc = 'main'

def render_table(lines):
    head = split_row(lines[0]); sep = split_row(lines[1])
    aligns = []
    for c in sep:
        c = c.strip()
        aligns.append('center' if c.startswith(':') and c.endswith(':') else 'right' if c.endswith(':') else 'left' if c.startswith(':') else '')
    def cell(tag, txt, i):
        a = aligns[i] if i < len(aligns) and aligns[i] else ''
        st = f' class="al-{a}"' if a else ''
        return f'<{tag}{st}>{inline(txt)}</{tag}>'
    out = ['<div class="table-wrap"><table>', '<thead><tr>' + ''.join(cell('th', c, i) for i, c in enumerate(head)) + '</tr></thead>', '<tbody>']
    for l in lines[2:]:
        cs = split_row(l)
        out.append('<tr>' + ''.join(cell('td', c, i) for i, c in enumerate(cs)) + '</tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out)

def parse_blocks(lines, ctx, tight=False):
    out = []
    i = 0
    n = len(lines)
    para = []
    def flush():
        nonlocal para
        if para:
            txt = ' '.join(p.strip() for p in para)
            out.append(inline(txt) if tight else f'<p>{inline(txt)}</p>')
            para = []
    skip_files_line = False
    while i < n:
        line = lines[i]
        s = line.strip()
        if skip_files_line:
            if s == '':
                i += 1; continue
            if s.startswith('**Files of'):
                i += 1; skip_files_line = False; continue
            skip_files_line = False
        if s == '':
            flush(); i += 1; continue
        m = re.match(r'^<!-- details: (.*) -->$', s)
        if m:
            flush(); out.append(f'<details class="files"><summary>{inline(m.group(1))}</summary>')
            skip_files_line = True; i += 1; continue
        if s == '<!-- /details -->':
            flush(); out.append('</details>'); i += 1; continue
        if s.startswith('<!--'):
            flush(); i += 1; continue
        m = re.match(r'^<a name="([^"]+)"></a>$', s)
        if m:
            flush(); out.append(f'<a id="{m.group(1)}" class="anchor"></a>'); i += 1; continue
        m = re.match(r'^(#{1,6})\s+(.*)$', line)
        if m:
            flush()
            lvl = len(m.group(1)); txt = m.group(2).strip()
            if lvl == 1:
                hid = 'top' if ctx.doc == 'main' else 'appendix-top'
                used_ids.add(hid)
            else:
                hid = slug(txt)
            ctx.headings.append((lvl, hid, txt, ctx.doc))
            out.append(f'<h{lvl} id="{hid}">{inline(txt)}</h{lvl}>')
            i += 1; continue
        if s.startswith('```'):
            flush()
            lang = s[3:].strip()
            j = i + 1; body = []
            while j < n and not lines[j].strip().startswith('```'):
                body.append(lines[j]); j += 1
            src = '\n'.join(body)
            if lang == 'mermaid':
                out.append(f'<pre class="mermaid">{html.escape(src, quote=False)}</pre>')
            else:
                out.append(f'<pre class="code"><code>{html.escape(src, quote=False)}</code></pre>')
            i = j + 1; continue
        if re.match(r'^-{3,}$', s):
            flush(); out.append('<hr>'); i += 1; continue
        if s.startswith('>'):
            flush()
            q = []
            while i < n and lines[i].strip().startswith('>'):
                q.append(re.sub(r'^\s*>\s?', '', lines[i])); i += 1
            out.append('<blockquote class="since">' + parse_blocks(q, ctx) + '</blockquote>')
            continue
        if s.startswith('|') and i + 1 < n and is_table_sep(lines[i + 1]):
            flush()
            t = []
            while i < n and lines[i].strip().startswith('|'):
                t.append(lines[i].strip()); i += 1
            out.append(render_table(t))
            continue
        m = LIST_RE.match(line)
        if m and (not para or not m.group(2)[-1] == '.' or m.group(2) == '1.'):
            flush()
            base_indent = len(m.group(1))
            ordered = m.group(2)[-1] == '.'
            items = []
            while i < n:
                if lines[i].strip() == '':
                    k = i
                    while k < n and lines[k].strip() == '':
                        k += 1
                    m3 = LIST_RE.match(lines[k]) if k < n else None
                    if m3 and len(m3.group(1)) == base_indent and (m3.group(2)[-1] == '.') == ordered:
                        i = k
                    else:
                        break
                m2 = LIST_RE.match(lines[i])
                if not m2 or len(m2.group(1)) != base_indent or (m2.group(2)[-1] == '.') != ordered:
                    break
                content_indent = len(m2.group(1)) + len(m2.group(2)) + 1
                item = [m2.group(3)]
                start_num = m2.group(2)[:-1] if ordered else None
                i += 1
                while i < n:
                    l = lines[i]
                    if l.strip() == '':
                        # blank: continue only if next non-blank is indented into this item
                        k = i
                        while k < n and lines[k].strip() == '':
                            k += 1
                        if k < n and (len(lines[k]) - len(lines[k].lstrip())) >= content_indent - (1 if ordered else 0) and (len(lines[k]) - len(lines[k].lstrip())) > base_indent:
                            item.extend([''] * (k - i)); i = k; continue
                        break
                    ind = len(l) - len(l.lstrip())
                    if ind > base_indent:
                        item.append(l[min(ind, content_indent):] if ind >= content_indent else l.lstrip())
                        i += 1; continue
                    break
                items.append((start_num, item))
            tag = 'ol' if ordered else 'ul'
            start = f' start="{items[0][0]}"' if ordered and items and items[0][0] not in (None, '1') else ''
            parts = [f'<{tag}{start}>']
            for _, item in items:
                inner = parse_blocks(item, ctx, tight=True)
                parts.append(f'<li>{inner}</li>')
            parts.append(f'</{tag}>')
            out.append(''.join(parts))
            continue
        para.append(line)
        i += 1
    flush()
    if tight:
        # a tight item: first chunk inline, the rest as blocks
        return '\n'.join(out)
    return '\n'.join(out)

def convert(path, ctx):
    lines = open(path, encoding='utf-8').read().split('\n')
    return parse_blocks(lines, ctx)

ctx = Ctx()
ctx.doc = 'main'
main_html = convert(MAIN, ctx)
ctx.doc = 'appx'
appx_html = convert(APPX, ctx)

# navigation
nav = ['<ul class="nav-l1">']
for doc, label in (('main', 'Handover'), ('appx', 'Appendix')):
    hs = [h for h in ctx.headings if h[3] == doc]
    top = [h for h in hs if h[0] == 1][0]
    nav.append(f'<li class="nav-doc"><a href="#{top[1]}">{label}</a></li>')
    groups = []
    for lvl, hid, txt, _ in hs:
        plain = re.sub(r'<[^>]+>', '', inline(txt))
        if lvl == 2:
            groups.append([(hid, plain), []])
        elif lvl == 3 and doc == 'main' and groups:
            groups[-1][1].append((hid, plain))
    for (hid, plain), kids in groups:
        sub = ''
        if kids:
            sub = '<ul class="nav-l2">' + ''.join(f'<li><a href="#{k}">{t}</a></li>' for k, t in kids) + '</ul>'
        nav.append(f'<li class="nav-h2"><a href="#{hid}">{plain}</a>{sub}</li>')
nav.append('</ul>')
nav_html = '\n'.join(nav)

CSS = r"""
:root {
  --bg: #fbfbf9; --fg: #1c1d20; --muted: #5d6068; --rule: #d9dbe0; --panel: #f0f1f4;
  --code-bg: #eef0f3; --accent: #1f4fb0; --accent-fg: #ffffff; --stripe: #f5f6f8;
  --quote-bg: #f3f0ea; --quote-rule: #8a6d3b; --nav-w: 18rem;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #131417; --fg: #e6e7ea; --muted: #a3a7b0; --rule: #34373e; --panel: #1c1e23;
    --code-bg: #1f2227; --accent: #8fb3f5; --accent-fg: #131417; --stripe: #181a1e;
    --quote-bg: #211e18; --quote-rule: #c9a86a;
  }
}
:root[data-theme="dark"] {
  --bg: #131417; --fg: #e6e7ea; --muted: #a3a7b0; --rule: #34373e; --panel: #1c1e23;
  --code-bg: #1f2227; --accent: #8fb3f5; --accent-fg: #131417; --stripe: #181a1e;
  --quote-bg: #211e18; --quote-rule: #c9a86a;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
a { color: var(--accent); }
.topbar { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--rule);
  display: flex; align-items: center; gap: .75rem; padding: .5rem 16px; }
.topbar .t { font-weight: 650; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar button { font: inherit; font-size: .85rem; background: var(--panel); color: var(--fg); border: 1px solid var(--rule);
  border-radius: 6px; padding: .25rem .6rem; cursor: pointer; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr); }
nav.toc { padding: 0 16px; }
nav.toc details { border-bottom: 1px solid var(--rule); }
nav.toc summary { cursor: pointer; padding: .6rem 0; font-weight: 600; }
nav.toc ul { list-style: none; margin: 0; padding: 0; }
nav.toc .nav-l2 { padding-left: .9rem; }
nav.toc li { margin: .1rem 0; }
nav.toc a { text-decoration: none; color: var(--fg); display: block; padding: .12rem .3rem; border-radius: 4px; font-size: .9rem; }
nav.toc .nav-l2 a { color: var(--muted); font-size: .85rem; }
nav.toc a:hover, nav.toc a:focus { background: var(--panel); }
nav.toc a.current { outline: 2px solid var(--accent); outline-offset: -2px; font-weight: 600; }
nav.toc .nav-doc > a { font-weight: 700; margin-top: .6rem; text-transform: uppercase; letter-spacing: .04em; font-size: .78rem; color: var(--muted); }
main { min-width: 0; padding: 0 16px 4rem; max-width: 72rem; }
h1 { font-size: 1.7rem; line-height: 1.25; margin: 1.4rem 0 .6rem; }
h2 { font-size: 1.35rem; margin: 2.2rem 0 .6rem; padding-top: .6rem; border-top: 2px solid var(--rule); }
h3 { font-size: 1.1rem; margin: 1.6rem 0 .5rem; }
h4 { font-size: 1rem; margin: 1.2rem 0 .4rem; }
h1, h2, h3, h4 { scroll-margin-top: 3.4rem; overflow-wrap: anywhere; }
.anchor { display: block; position: relative; top: -3.4rem; visibility: hidden; }
p, li { overflow-wrap: anywhere; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; background: var(--code-bg);
  padding: .05em .3em; border-radius: 4px; }
pre { overflow-x: auto; background: var(--code-bg); padding: .8rem; border-radius: 6px; border: 1px solid var(--rule); }
pre code { background: none; padding: 0; font-size: .85rem; }
pre.mermaid { background: var(--panel); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .8rem;
  white-space: pre; text-align: left; }
pre.mermaid[data-processed="true"] { white-space: normal; text-align: center; }
pre.mermaid svg { max-width: none; height: auto; }
.table-wrap { overflow-x: auto; margin: .8rem 0; border: 1px solid var(--rule); border-radius: 6px; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { padding: .35rem .55rem; border-bottom: 1px solid var(--rule); vertical-align: top; text-align: left; }
th { background: var(--panel); font-weight: 600; position: sticky; top: 0; }
tbody tr:nth-child(even) td { background: var(--stripe); }
td.al-right, th.al-right { text-align: right; white-space: nowrap; }
td.al-center, th.al-center { text-align: center; }
td code { overflow-wrap: anywhere; }
blockquote.since { margin: 1rem 0; padding: .4rem 1rem; background: var(--quote-bg); border-left: 4px double var(--quote-rule); border-radius: 0 6px 6px 0; }
details.files { margin: .5rem 0 1rem; border: 1px solid var(--rule); border-radius: 6px; padding: 0 .6rem; }
details.files > summary { cursor: pointer; padding: .45rem 0; font-weight: 600; }
details.files[open] > summary { border-bottom: 1px solid var(--rule); margin-bottom: .2rem; }
details.files .table-wrap { border: 0; }
hr + h2 { border-top: 0; padding-top: 0; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 1.5rem 0; }
.doc-sep { margin: 3rem 0 0; border-top: 6px double var(--rule); }
@media (min-width: 1100px) {
  .layout { grid-template-columns: var(--nav-w) minmax(0, 1fr); }
  nav.toc { position: sticky; top: 2.6rem; height: calc(100vh - 2.6rem); overflow-y: auto; border-right: 1px solid var(--rule); padding-top: .4rem; }
  nav.toc details { border-bottom: 0; }
  nav.toc summary { display: none; }
  main { padding: 0 2rem 4rem; }
}
@media print { .topbar, nav.toc { display: none; } .layout { display: block; } }
"""

JS = r"""
(function () {
  var root = document.documentElement;
  var KEY = 'handover-theme';
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function store(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) {} }
  var saved = stored();
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  function effective() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  var btn = document.getElementById('theme-btn');
  function label() { var t = root.getAttribute('data-theme'); btn.textContent = 'Theme: ' + (t ? t : 'auto'); }
  label();
  var nav = document.getElementById('toc-details');
  if (nav && window.matchMedia && !window.matchMedia('(min-width: 1100px)').matches) nav.open = false;
  var sources = [];
  document.querySelectorAll('pre.mermaid').forEach(function (el) { sources.push(el.textContent); });
  function vars() {
    var cs = getComputedStyle(root);
    function v(n) { return cs.getPropertyValue(n).trim(); }
    var dark = effective() === 'dark';
    return {
      darkMode: dark, background: v('--panel'), fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      primaryColor: dark ? '#262a31' : '#e9edf4', primaryTextColor: v('--fg'), primaryBorderColor: v('--muted'),
      secondaryColor: dark ? '#22252b' : '#f2f3f6', tertiaryColor: dark ? '#1c1e23' : '#ffffff',
      lineColor: v('--muted'), textColor: v('--fg'), mainBkg: dark ? '#262a31' : '#e9edf4', nodeBorder: v('--muted'),
      clusterBkg: dark ? '#1a1c20' : '#f6f7f9', clusterBorder: v('--muted'), edgeLabelBackground: v('--panel'),
      titleColor: v('--fg'),
      sectionBkgColor: dark ? '#20232a' : '#eceff4', altSectionBkgColor: dark ? '#17191d' : '#f8f8f6', sectionBkgColor2: dark ? '#252932' : '#e3e7ee',
      taskBkgColor: dark ? '#3a4150' : '#c7d0de', taskBorderColor: v('--muted'), taskTextColor: v('--fg'), taskTextLightColor: v('--fg'),
      taskTextOutsideColor: v('--fg'), taskTextDarkColor: v('--fg'), taskTextClickableColor: v('--accent'),
      activeTaskBkgColor: dark ? '#303644' : '#dbe1ea', activeTaskBorderColor: v('--muted'),
      doneTaskBkgColor: dark ? '#2c2f35' : '#d3d6db', doneTaskBorderColor: v('--muted'),
      critBkgColor: dark ? '#44474e' : '#bfc3ca', critBorderColor: v('--fg'),
      gridColor: v('--rule'), todayLineColor: v('--accent'), excludeBkgColor: v('--panel')
    };
  }
  function draw() {
    if (!window.mermaid) return;
    var els = document.querySelectorAll('pre.mermaid');
    els.forEach(function (el, i) { el.removeAttribute('data-processed'); el.textContent = sources[i]; });
    window.mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: vars(), securityLevel: 'strict',
      flowchart: { useMaxWidth: false, htmlLabels: true }, gantt: { useMaxWidth: false, useWidth: 1000 } });
    window.mermaid.run({ querySelector: 'pre.mermaid' }).catch(function (e) { console.error(e); });
  }
  btn.addEventListener('click', function () {
    var t = root.getAttribute('data-theme');
    var next = t === null ? 'light' : (t === 'light' ? 'dark' : null);
    if (next) root.setAttribute('data-theme', next); else root.removeAttribute('data-theme');
    store(next); label(); draw();
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', function () { if (!root.getAttribute('data-theme')) draw(); });
  }
  window.addEventListener('load', draw);
  // mark the current section in the nav
  var links = {}; document.querySelectorAll('nav.toc a[href^="#"]').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
  if ('IntersectionObserver' in window) {
    var cur = null;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && links[e.target.id]) { if (cur) cur.classList.remove('current'); cur = links[e.target.id]; cur.classList.add('current'); }
      });
    }, { rootMargin: '0px 0px -75% 0px' });
    document.querySelectorAll('main h1[id], main h2[id], main h3[id]').forEach(function (h) { if (links[h.id]) io.observe(h); });
  }
})();
"""

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bot-trade Handover Update</title>
<meta name="description" content="Handover of the bot-trade work since Claude Code took over from Codex (25-09-2026 to the 27-09-2026 06:00 SGT snapshot): 71 merged PRs, open work, the three plans, the challenges, and every file changed.">
<style>{CSS}</style>
</head>
<body>
<div class="topbar"><span class="t">bot-trade handover · snapshot 27-09-2026 06:00 SGT (26-09 22:00Z)</span><button type="button" id="theme-btn">Theme: auto</button></div>
<div class="layout">
<nav class="toc" aria-label="Contents"><details id="toc-details" open><summary>Contents</summary>
{nav_html}
</details></nav>
<main>
{main_html}
<div class="doc-sep" role="separator"></div>
{appx_html}
</main>
</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>{JS}</script>
</body>
</html>
"""
open(OUT, 'w', encoding='utf-8').write(page)
print('headings', len(ctx.headings), 'bytes', len(page.encode()))
