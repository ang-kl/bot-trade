// Source pins for the two UI gates that live in scripts/, not in code:
//
//   scripts/responsive-audit.mjs   the width list the layout audit samples
//   scripts/check-no-green.sh      the colour tokens the colour-blind gate bans
//
// Both are configuration a refactor can drop in silence (failure mode #3: a
// guard whose trigger is out of reach of what it guards). The audit's blind
// band between 700 and 790 px hid a document overflow on /performance for a
// month; a blue-green hex outside the token list painted the EMA-9 line that
// colour for as long. Each pin here is a thing that actually went missing.
//
// THE BANNED TOKENS ARE BUILT BY CONCATENATION AND NEVER NAMED. This file is
// itself scanned by check-no-green.sh — the word pass matches the bare word
// as an identifier or in prose — so neither the hex nor the word appears
// here whole. The gate SHOULD fail on a literal, which is what the last test
// proves by running it against a throwaway file.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = new URL('../../', import.meta.url)
const audit = readFileSync(new URL('scripts/responsive-audit.mjs', root), 'utf8').replace(/\/\/[^\n]*/g, '')
const check = readFileSync(new URL('scripts/check-no-green.sh', root), 'utf8').replace(/^\s*#[^\n]*/gm, '')

describe('responsive-audit width list', () => {
  it('samples 768 and 740 — the band the balance-in/out grid overflowed in', () => {
    const m = /for \(const w of \[([^\]]+)\]\)/.exec(audit)
    expect(m, 'the width loop must still be a literal array').toBeTruthy()
    const widths = m[1].split(',').map(s => Number(s.trim()))
    for (const w of [1024, 820, 768, 740, 390, 375]) expect(widths).toContain(w)
  })
})

describe('check-no-green token list', () => {
  const bannedWord = 'te' + 'al'
  const bannedHex = '#14b8' + 'a6'

  it('bans the bannedWord hex and the word, and matches hex case-insensitively', () => {
    expect(check).toContain(`-e '${bannedHex}'`)
    expect(check).toContain(`-e '\\b${bannedWord}\\b'`)
    // The hex pass carries -i; the word pass does not.
    const hexPass = /HEX_MATCHES="\$\(grep (-\w+)/.exec(check)
    expect(hexPass?.[1]).toMatch(/i/)
    const wordPass = /WORD_MATCHES="\$\(grep (-\w+)/.exec(check)
    expect(wordPass?.[1]).not.toMatch(/i/)
  })

  it('actually FAILS on an uppercase bannedWord hex and on the word — the mutation, not a hope', () => {
    // Run the script against a copy of the repo root? Too slow. Instead run
    // the same grep the script runs, against a scratch directory, by
    // pointing the script's ROOT at it.
    const dir = mkdtempSync(join(tmpdir(), 'no-green-'))
    try {
      writeFileSync(join(dir, 'a.jsx'), `const c = '${bannedHex.toUpperCase()}'\n`)
      writeFileSync(join(dir, 'b.css'), `.x { color: ${bannedWord}; }\n`)
      writeFileSync(join(dir, 'c.jsx'), `// prose mentioning Teal Organisation and Green in a comment is fine\nconst ok = 'var(--color-accent)'\n`)
      const script = readFileSync(new URL('scripts/check-no-green.sh', root), 'utf8')
        .replace(/ROOT="\$\(cd "\$\(dirname "\$0"\)\/\.\." && pwd\)"/, `ROOT="${dir}"`)
      expect(script).toContain(`ROOT="${dir}"`) // the substitution landed
      const scriptPath = join(dir, 'check.sh')
      writeFileSync(scriptPath, script)
      const r = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('a.jsx')
      expect(r.stderr).toContain('b.css')
      expect(r.stderr).not.toContain('c.jsx')
      // And PASSES once the offenders are gone — so the failure above was
      // the tokens, not the harness.
      rmSync(join(dir, 'a.jsx')); rmSync(join(dir, 'b.css'))
      const ok = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
      expect(ok.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
