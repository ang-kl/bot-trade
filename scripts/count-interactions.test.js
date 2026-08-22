// scripts/count-interactions.test.js
//
// WHY THIS FILE EXISTS. count-interactions.js produces the serial — the number
// CLAUDE.md spends sixty lines insisting must be MEASURED rather than
// remembered — and until now nothing in the repo executed it. Two of the three
// defects this file pins were shipped and invisible:
//
//   1. `--agents` was not in the flag list, so it fell through to the directory
//      argument, printed "No .jsonl files found under: --agents" and exited 0.
//      A silent no-op that reads exactly like a measurement.
//   2. `cache_creation_input_tokens` was never read, so a cached session's
//      input bill was reported as the small uncached remainder — a confident
//      wrong number, which is worse than "unavailable".
//   3. "latest session" was the tail of a sort by FIRST timestamp, and
//      `String(null)` sorts after any real timestamp, so a transcript with no
//      parseable timestamps became "latest" and its all-zero counts printed as
//      measurements.
//
// The flag-coverage case iterates MODE_FLAGS rather than hardcoding three
// strings, so flag four is covered the day it is added rather than the day
// someone remembers this file.
//
// The CLI is exercised as a CLI (spawned, stdout asserted) rather than by
// calling internals: the failures above all lived in argument handling and
// output, which importing a function would step straight past.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODE_FLAGS } from './count-interactions.js'

const SCRIPT = fileURLToPath(new URL('./count-interactions.js', import.meta.url))

/** Write a synthetic transcript and return its path. */
function transcript(name, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.map(o => JSON.stringify(o)).join('\n') + '\n')
  return file
}

function run(args) {
  try {
    return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '')
  }
}

const assistant = (extra = {}) => ({
  type: 'assistant',
  timestamp: '2026-08-22T00:00:00Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ...extra,
})

describe('--agents', () => {
  it('counts Task tool_use blocks and breaks them down by subagent_type', () => {
    const file = transcript('a.jsonl', [
      assistant({
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Task', input: { subagent_type: 'Explore' } },
            { type: 'tool_use', name: 'Task', input: { subagent_type: 'Explore' } },
          ],
        },
      }),
      assistant({
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'Plan' } }],
        },
      }),
      // A non-Task tool call must not be counted as a subagent.
      assistant({
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      }),
    ])
    const out = run(['--file', file, '--agents'])
    expect(out).toMatch(/agents_total: 3/)
    expect(out).toMatch(/Explore: 2/)
    expect(out).toMatch(/Plan: 1/)
  })

  it('a Task block with no subagent_type is counted, not dropped', () => {
    const file = transcript('b.jsonl', [
      assistant({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Task', input: {} }] } }),
    ])
    const out = run(['--file', file, '--agents'])
    expect(out).toMatch(/agents_total: 1/)
    expect(out).toMatch(/unspecified: 1/)
  })
})

describe('--tokens', () => {
  it('reports unavailable — never 0 — when no entry carries a usage block', () => {
    const file = transcript('c.jsonl', [assistant(), assistant()])
    const out = run(['--file', file, '--tokens'])
    expect(out).toMatch(/unavailable/)
    expect(out).not.toMatch(/tokens_in_total: 0/)
  })

  it('counts cache_creation_input_tokens — the field that used to vanish', () => {
    const file = transcript('d.jsonl', [
      assistant({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 1000,
          },
        },
      }),
    ])
    const out = run(['--file', file, '--tokens'])
    expect(out).toMatch(/tokens_in_uncached: 10/)
    expect(out).toMatch(/tokens_cache_read: 100/)
    expect(out).toMatch(/tokens_cache_creation: 1000/)
    // The three input lines must visibly reconcile, so the uncached remainder
    // can never be mistaken for the whole input bill.
    expect(out).toMatch(/tokens_in_total: 1110/)
  })

  it('an assistant entry missing usage is disclosed, not folded in as zero', () => {
    const file = transcript('e.jsonl', [
      assistant({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      }),
      assistant(), // no usage block
    ])
    const out = run(['--file', file, '--tokens'])
    expect(out).toMatch(/tokens_in_total: 7/)
    expect(out).toMatch(/assistant_entries_without_usage: 1/)
  })
})

describe('latest session selection', () => {
  it('a transcript with no timestamps cannot become "latest" and report zeros', () => {
    // Reproduces the sort defect directly: String(null) sorts after any real
    // timestamp, so this file used to win "latest" and print 0 as a measurement.
    const file = transcript('f.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'no timestamp' }] } },
    ])
    const out = run(['--file', file, '--agents'])
    expect(out).toMatch(/agents_latest_session: unavailable/)
    expect(out).not.toMatch(/agents_latest_session: 0$/m)
  })
})

describe('mode flags', () => {
  it('every MODE_FLAG is consumed — none reaches the directory argument', () => {
    // Derived from MODE_FLAGS, not from a hardcoded list: flag four is covered
    // the day it is added. This is the regression that shipped silently.
    for (const flag of MODE_FLAGS) {
      const out = run([flag, '/nonexistent-log-dir-for-this-test'])
      expect(out).not.toMatch(new RegExp(`No \\.jsonl files found under: ${flag}`))
    }
  })

  it('MODE_FLAGS lists every flag the script advertises — an INDEPENDENT source', () => {
    // The case above iterates MODE_FLAGS, so it cannot catch a flag being
    // DELETED from MODE_FLAGS: the loop shrinks with the list and stays green.
    // That is a test asserted against a copy of itself. The usage header is an
    // independent statement of what this CLI accepts, so compare the two.
    // Deleting '--agents' from MODE_FLAGS now goes red while the header still
    // advertises it — which is the actual regression to guard.
    const src = fs.readFileSync(SCRIPT, 'utf8')
    const usage = src.slice(src.indexOf(' * USAGE'), src.indexOf(' * DEFAULT LOG LOCATION'))
    expect(usage.length).toBeGreaterThan(0)
    const advertised = [...new Set(usage.match(/--[a-z-]+/g) || [])]
    expect(advertised.length).toBeGreaterThan(2)
    for (const flag of advertised) {
      // '--file' takes a value and is consumed positionally, not as a mode.
      if (flag === '--file') continue
      expect(MODE_FLAGS, `${flag} is advertised in USAGE but not registered in MODE_FLAGS`).toContain(flag)
    }
  })

  it('refuses two mode flags rather than silently honouring one', () => {
    const out = run(['--serial', '--tokens'])
    expect(out).toMatch(/mutually exclusive/)
  })

  it('--serial still prints a bare number', () => {
    const file = transcript('g.jsonl', [assistant(), assistant()])
    const out = run(['--file', file, '--serial']).trim()
    expect(out).toBe('2')
  })
})
