// copy-serialize — one place that turns a card's content into the three copy
// payloads (owner 2026-07-25): Text, JSON, HTML. Table serialisation must
// include the COLUMN HEADS and the first-column head, not just the data —
// "Table must include row-heads and first-column head".
//
// Everything here reads either the rendered DOM or an explicit data prop —
// nothing is recomputed, so a payload can never disagree with the screen.

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/** Heads + body rows of the first rendered <table> under root, or null. */
export function tableScrape(root) {
  const table = root?.querySelector('table')
  if (!table) return null
  const heads = [...table.querySelectorAll('thead th')].map((th, i) => {
    const t = (th.innerText || '').trim().replace(/\s*[↓↑]\s*$/, '')
    return t || `col${i + 1}`
  })
  if (!heads.length) return null
  const rows = [...table.querySelectorAll('tbody tr')]
    .map(tr => [...tr.children])
    // A single-colSpan expansion row isn't a record — skip.
    .filter(cells => cells.length >= 2)
    .map(cells => cells.map(td => (td.innerText || '').trim()))
  return rows.length ? { heads, rows } : null
}

/** Row objects keyed by the column heads — heads travel WITH the data. */
export function tableToJson(root) {
  const t = tableScrape(root)
  if (!t) return null
  return t.rows.map(cells => Object.fromEntries(
    cells.map((v, i) => [t.heads[i] || `col${i + 1}`, v]),
  ))
}

/**
 * Clean semantic HTML table: a real <thead> with every column head (the
 * first-column head included) and <th scope="row"> on each row's first cell,
 * so the row head is markup, not just a data cell. Pastes into Excel, Word,
 * Google Docs and mail clients as a real table.
 */
export function tableToHtml(root, title = '') {
  const t = tableScrape(root)
  if (!t) return null
  const head = `<thead><tr>${t.heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
  const body = t.rows.map(cells =>
    `<tr>${cells.map((v, i) => i === 0
      ? `<th scope="row">${esc(v)}</th>`
      : `<td>${esc(v)}</td>`).join('')}</tr>`,
  ).join('\n')
  return `${title ? `<h3>${esc(title)}</h3>\n` : ''}<table>\n${head}\n<tbody>\n${body}\n</tbody>\n</table>`
}

/** Explicit data (array of flat objects) → the same head-first HTML table. */
export function dataToHtml(data, title = '') {
  const rows = Array.isArray(data) ? data : data != null ? [data] : []
  const flat = rows.filter(r => r && typeof r === 'object')
  if (!flat.length) return null
  const heads = [...new Set(flat.flatMap(r => Object.keys(r)))]
  const head = `<thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
  const body = flat.map(r =>
    `<tr>${heads.map((h, i) => {
      const v = r[h]
      const cell = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return i === 0 ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`
    }).join('')}</tr>`,
  ).join('\n')
  return `${title ? `<h3>${esc(title)}</h3>\n` : ''}<table>\n${head}\n<tbody>\n${body}\n</tbody>\n</table>`
}

/** Prose fallback so the JSON tab always exists: honest lines, not invented
 *  structure. */
export function textToJson(title, text) {
  return { section: title, lines: String(text || '').split('\n').map(l => l.trim()).filter(Boolean) }
}

/** Prose fallback for HTML: escaped preformatted text, nothing invented. */
export function textToHtml(title, text) {
  return `${title ? `<h3>${esc(title)}</h3>\n` : ''}<pre>${esc(text || '')}</pre>`
}
