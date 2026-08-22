#!/usr/bin/env node
/**
 * count-interactions.js
 *
 * Counts turns per Claude Code session by reading the append-only JSONL
 * transcript logs directly from disk. This works even for sessions that used
 * /compact, because compaction rewrites what the model sees in-context but
 * does NOT rewrite the JSONL log file itself — every turn ever sent or
 * received is still on disk, in order.
 *
 * WHY THIS LIVES IN THE REPO
 *   CLAUDE.md's reply protocol stamps every substantive reply with a running
 *   serial (`№ N`). That number has to come from somewhere reproducible: the
 *   first serial ever emitted was invented, which is exactly the failure this
 *   script exists to prevent. Run it against the session transcript and the
 *   serial is a measurement, not a memory.
 *
 * USAGE
 *   node scripts/count-interactions.js                      # scan default log dir
 *   node scripts/count-interactions.js /path/to/projects    # scan a custom dir
 *   node scripts/count-interactions.js --file session.jsonl # scan a single file
 *   node scripts/count-interactions.js --serial             # print just the serial
 *   node scripts/count-interactions.js --agents             # subagent spawns
 *   node scripts/count-interactions.js --tokens            # token usage
 *
 *   --agents and --tokens report PER-SESSION figures, never per-turn. There is
 *   no per-turn accounting in this script, which is why CLAUDE-protocol.md §6
 *   keeps the per-reply footer switched off.
 *
 * DEFAULT LOG LOCATION
 *   macOS / Linux : ~/.claude/projects/**\/*.jsonl
 *   (one JSONL file per session, nested under a per-project folder; this walks
 *   recursively so nesting doesn't matter.)
 *
 * WHAT COUNTS AS WHAT
 *   Raw turn counts are nearly useless for the serial, because most assistant
 *   entries in a transcript are not replies to anyone — they are tool calls,
 *   and most `type: "user"` entries are tool RESULTS, not the owner speaking.
 *   So this reports four numbers per session, narrowest first:
 *
 *     reply turns    — assistant entries on the MAIN thread carrying at least
 *                      one non-empty `text` block. This is "how many times did
 *                      Claude actually say something to the owner", and it is
 *                      the number the `№ N` serial should track.
 *     owner turns    — `type: "user"` entries on the main thread that are real
 *                      prose, excluding tool_result payloads, meta entries,
 *                      command stdout, and system-reminder-only turns.
 *     assistant turns— every assistant entry, tool calls included.
 *     user turns     — every user-role entry, tool results included.
 *
 *   Sidechain entries (`isSidechain: true` — subagent conversations) are
 *   excluded from the two narrow counts: a subagent talking to itself is not a
 *   reply to the owner. They are still included in the raw counts, and
 *   reported separately so the gap is visible rather than silent.
 *
 * NOTES
 *   - Streams line by line; transcripts routinely run to hundreds of MB.
 *   - A "compact event" is detected from a small set of known markers, since
 *     the exact key has changed across CLI versions.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * The subagent tool is named `Task` on older CLI builds and `Agent` on newer
 * ones. Matching only one means a corpus full of subagent calls reports a
 * confident 0 — a matcher out of reach of what it counts, which is
 * indistinguishable from "no agents ran" unless the total tool_use count is
 * printed beside it. That is why --agents reports both.
 */
export const AGENT_TOOLS = new Set(['Task', 'Agent']);

/**
 * Every mode flag this CLI accepts. EXPORTED because the bug that made this
 * list necessary was invisible: an unlisted flag falls through to the
 * directory argument, prints "No .jsonl files found under: --agents" and
 * exits 1 with a confusing message about a directory that was never a
 * directory. A test that iterates
 * this array covers flag four automatically; a test that hardcodes three
 * strings does not.
 */
export const MODE_FLAGS = ['--serial', '--agents', '--tokens'];

function findJsonlFiles(dir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(findJsonlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

function safeParseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function looksLikeCompactMarker(obj) {
  if (!obj) return false;
  if (obj.isCompactSummary) return true;
  if (obj.subtype === 'compact_boundary') return true;
  return obj.type === 'system' && typeof obj.content === 'string' &&
    obj.content.toLowerCase().includes('compact');
}

function getRole(obj) {
  if (!obj) return null;
  if (obj.message && obj.message.role) return obj.message.role;
  if (obj.role) return obj.role;
  if (obj.type === 'user' || obj.type === 'human') return 'user';
  if (obj.type === 'assistant') return 'assistant';
  return null;
}

function blocks(obj) {
  const c = obj?.message?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return [];
}

/** An assistant entry that said something, as opposed to calling a tool. */
function isReplyTurn(obj) {
  if (getRole(obj) !== 'assistant') return false;
  if (obj.isSidechain) return false;
  return blocks(obj).some(b => b.type === 'text' && String(b.text || '').trim() !== '');
}

/**
 * A user entry that is the owner typing, not the harness feeding back a tool
 * result. Tool results arrive as user-role entries with tool_result blocks;
 * hook output, command stdout and lone system-reminders arrive as user-role
 * entries too, and none of them are the owner speaking.
 */
function isOwnerTurn(obj) {
  if (getRole(obj) !== 'user') return false;
  if (obj.isSidechain || obj.isMeta || obj.isCompactSummary) return false;
  if (obj.toolUseResult !== undefined) return false;
  const bs = blocks(obj);
  if (bs.some(b => b.type === 'tool_result')) return false;
  const text = bs
    .filter(b => b.type === 'text')
    .map(b => String(b.text || ''))
    .join('\n')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, '')
    .trim();
  return text !== '';
}

function getTimestamp(obj) {
  return obj?.timestamp || obj?.created_at || obj?.ts || null;
}

function analyzeFile(filePath) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const out = {
      file: filePath,
      bytes: stat.size,
      userTurns: 0,
      assistantTurns: 0,
      ownerTurns: 0,
      replyTurns: 0,
      sidechainAssistant: 0,
      compactEvents: 0,
      agents: 0,
      agentsByType: {},
      inTok: 0,
      outTok: 0,
      cacheTok: 0,
      creationTok: 0,
      usageEntries: 0,
      usageMissing: 0,
      usageDuplicateLines: 0,
      seenMsgIds: new Set(),
      toolUseBlocks: 0,
      badLines: 0,
      firstTs: null,
      lastTs: null,
    };
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', line => {
      if (!line.trim()) return;
      const obj = safeParseLine(line);
      if (!obj) { out.badLines++; return; }

      const role = getRole(obj);
      if (role === 'user') out.userTurns++;
      else if (role === 'assistant') {
        out.assistantTurns++;
        if (obj.isSidechain) out.sidechainAssistant++;
      }

      if (role === 'assistant') {
        // A subagent is spawned per Task tool_use block. Grouped by
        // subagent_type so the breakdown says WHICH kind of agent ran, not
        // just how many.
        for (const b of blocks(obj)) {
          if (b.type === 'tool_use') out.toolUseBlocks++;
          if (b.type === 'tool_use' && AGENT_TOOLS.has(b.name)) {
            out.agents++;
            const t = b.input?.subagent_type || 'unspecified';
            out.agentsByType[t] = (out.agentsByType[t] || 0) + 1;
          }
        }
        // Token usage rides on the assistant entry. ABSENT IS NOT ZERO: a
        // transcript written by a CLI version that did not record usage would
        // otherwise report a confident 0, which is the failure this whole
        // script exists to prevent. Count the misses and report them.
        const u = obj?.message?.usage || obj?.usage;
        if (u && typeof u === 'object') {
          // USAGE IS PER MESSAGE, NOT PER ENTRY. The transcript writes one
          // JSONL line per content block and repeats the IDENTICAL usage
          // object on each, so summing per entry counts one API response once
          // per block it emitted. Measured on this repo's own corpus: 3,919
          // usage-bearing entries across 2,426 distinct message ids — a 1.91x
          // inflation of every token figure. Comparing entries against
          // messages is the unit mismatch this codebase keeps paying for.
          const mid = obj?.message?.id || null;
          if (mid && out.seenMsgIds.has(mid)) {
            out.usageDuplicateLines++;
          } else {
          if (mid) out.seenMsgIds.add(mid);
          out.usageEntries++;
          out.inTok += u.input_tokens || 0;
          out.outTok += u.output_tokens || 0;
          out.cacheTok += u.cache_read_input_tokens || 0;
          // Cache WRITES are input tokens too. Reading input_tokens alone and
          // calling it "tokens in" hands the reader a confident wrong number
          // on any cached session — the bulk of the input sits in the two
          // cache fields. Same rule as the missing-usage case one line up:
          // a field we do not read is not a zero, it is a hole.
          out.creationTok += u.cache_creation_input_tokens || 0;
          }
        } else {
          out.usageMissing++;
        }
      }

      if (isReplyTurn(obj)) out.replyTurns++;
      if (isOwnerTurn(obj)) out.ownerTurns++;
      if (looksLikeCompactMarker(obj)) out.compactEvents++;

      const ts = getTimestamp(obj);
      if (ts) {
        if (!out.firstTs) out.firstTs = ts;
        out.lastTs = ts;
      }
    });
    rl.on('close', () => resolve(out));
    rl.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const serialOnly = args.includes('--serial');
  const agentsOnly = args.includes('--agents');
  const tokensOnly = args.includes('--tokens');
  const FLAGS = new Set(MODE_FLAGS);
  // Every known flag has to come out of `rest`, or it is read as a directory
  // path: `--agents` used to reach findJsonlFiles as a folder name, fail with
  // "No .jsonl files found under: --agents" on stderr and exit 1 — the flag
  // never ran. (An earlier version of this comment said "exit 0, a silent
  // no-op". That was wrong, and wrong because the exit code was read from a
  // shell pipeline, which reports the LAST command's status, not node's.)
  const rest = args.filter(a => !FLAGS.has(a));
  // --serial used to short-circuit before the others, so `--serial --tokens`
  // printed the serial and silently dropped the request for tokens. Refuse
  // instead of picking one: a flag that is accepted and ignored is the same
  // class of lie as a flag read as a directory name.
  const modes = args.filter(a => FLAGS.has(a));
  if (modes.length > 1) {
    console.error(`Pick one mode at a time — got ${modes.join(' ')}. These flags are mutually exclusive.`);
    process.exit(1);
  }

  let targetFiles = [];
  if (rest[0] === '--file' && rest[1]) {
    targetFiles = [rest[1]];
  } else {
    const dir = rest[0] || path.join(os.homedir(), '.claude', 'projects');
    targetFiles = findJsonlFiles(dir);
    if (targetFiles.length === 0) {
      console.error(`No .jsonl files found under: ${dir}`);
      console.error('Pass a directory or --file <path> explicitly if your logs live elsewhere.');
      process.exit(1);
    }
  }

  const results = [];
  for (const f of targetFiles) results.push(await analyzeFile(f));
  results.sort((a, b) => String(a.firstTs).localeCompare(String(b.firstTs)));

  const sum = k => results.reduce((n, r) => n + r[k], 0);

  if (serialOnly) {
    console.log(sum('replyTurns'));
    return;
  }

  // THE LATEST SESSION IS THE ONE THAT ENDED LAST, and it must have actually
  // ended. `results` is sorted by FIRST timestamp, so the tail is the session
  // that STARTED last — a long-lived session still running loses to one opened
  // this morning and closed after two turns. Worse, `analyzeFile` leaves
  // firstTs null when a file has no parseable timestamps, `String(null)` is
  // "null", and localeCompare sorts a leading 'n' after a leading '2' — so an
  // empty or truncated transcript became "latest" and its all-zero counts got
  // printed as measurements. Absent is not zero: with no timestamped session
  // at all, `latest` is null and the callers print "unavailable".
  const timed = results.filter(r => r.lastTs);
  const latest = timed.length
    ? timed.reduce((a, b) => (String(a.lastTs) >= String(b.lastTs) ? a : b))
    : null;

  if (agentsOnly) {
    const byType = {};
    for (const r of results) {
      for (const [t, c] of Object.entries(r.agentsByType)) byType[t] = (byType[t] || 0) + c;
    }
    console.log(`agents_total: ${sum('agents')}`);
    for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t}: ${c}`);
    }
    console.log(`agents_latest_session: ${latest ? latest.agents : 'unavailable (no timestamped session)'}`);
    // 0 of 0 tool calls and 0 of 4,812 are different facts. Without this line
    // a zero cannot be told apart from a matcher that never fires.
    console.log(`tool_use_blocks_seen: ${sum('toolUseBlocks')}`);
    return;
  }

  if (tokensOnly) {
    const missing = sum('usageMissing');
    if (sum('usageEntries') === 0) {
      console.log('tokens: unavailable (no usage blocks in these transcripts)');
      if (missing) console.log(`assistant_entries_without_usage: ${missing}`);
      return;
    }
    // Three input lines that visibly reconcile, so nobody reads the uncached
    // remainder as the whole input bill.
    console.log(`tokens_in_uncached: ${sum('inTok')}`);
    console.log(`tokens_cache_read: ${sum('cacheTok')}`);
    console.log(`tokens_cache_creation: ${sum('creationTok')}`);
    console.log(`tokens_in_total: ${sum('inTok') + sum('cacheTok') + sum('creationTok')}`);
    console.log(`tokens_out: ${sum('outTok')}`);
    if (latest) {
      console.log(`latest_session_in_total: ${latest.inTok + latest.cacheTok + latest.creationTok}`);
      console.log(`latest_session_out: ${latest.outTok}`);
    } else {
      console.log('latest_session: unavailable (no timestamped session)');
    }
    // Never fold a missing usage block into the total silently.
    if (missing) console.log(`assistant_entries_without_usage: ${missing} (excluded, not counted as 0)`);
    const dupes = sum('usageDuplicateLines');
    if (dupes) console.log(`duplicate_usage_lines_skipped: ${dupes} (same message.id, counted once)`);
    return;
  }

  const n = x => x.toLocaleString('en-US');

  console.log('\nPER-SESSION BREAKDOWN\n' + '='.repeat(72));
  for (const r of results) {
    console.log(path.basename(r.file));
    console.log(`  reply turns (→ serial) : ${n(r.replyTurns)}`);
    console.log(`  owner turns            : ${n(r.ownerTurns)}`);
    console.log(`  assistant turns (all)  : ${n(r.assistantTurns)}  (${n(r.sidechainAssistant)} sidechain)`);
    console.log(`  user turns (all)       : ${n(r.userTurns)}`);
    console.log(`  compact events         : ${n(r.compactEvents)}`);
    console.log(`  subagents spawned      : ${n(r.agents)}`);
    console.log(`  tokens in/out          : ${r.usageEntries ? `${n(r.inTok)}/${n(r.outTok)}` : 'unavailable'}`);
    console.log(`  size                   : ${(r.bytes / 1e6).toFixed(1)} MB${r.badLines ? `  (${r.badLines} unparseable lines)` : ''}`);
    if (r.firstTs) console.log(`  first timestamp        : ${r.firstTs}`);
    if (r.lastTs) console.log(`  last timestamp         : ${r.lastTs}`);
    console.log('-'.repeat(72));
  }

  console.log('\nGRAND TOTAL ACROSS ALL SESSIONS\n' + '='.repeat(72));
  console.log(`Sessions scanned       : ${n(results.length)}`);
  console.log(`Reply turns (→ serial) : ${n(sum('replyTurns'))}`);
  console.log(`Owner turns            : ${n(sum('ownerTurns'))}`);
  console.log(`Assistant turns (all)  : ${n(sum('assistantTurns'))}`);
  console.log(`User turns (all)       : ${n(sum('userTurns'))}`);
  console.log(`Compact events seen    : ${n(sum('compactEvents'))}`);
  console.log(`Subagents spawned      : ${n(sum('agents'))}`);
  console.log(`Tokens in/out          : ${sum('usageEntries') ? `${n(sum('inTok'))}/${n(sum('outTok'))}` : 'unavailable'}`);
  console.log('');
}

const runDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) main().catch(err => { console.error(err); process.exit(1); });
