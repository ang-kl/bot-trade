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
  const rest = args.filter(a => a !== '--serial');

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

  const n = x => x.toLocaleString('en-US');

  console.log('\nPER-SESSION BREAKDOWN\n' + '='.repeat(72));
  for (const r of results) {
    console.log(path.basename(r.file));
    console.log(`  reply turns (→ serial) : ${n(r.replyTurns)}`);
    console.log(`  owner turns            : ${n(r.ownerTurns)}`);
    console.log(`  assistant turns (all)  : ${n(r.assistantTurns)}  (${n(r.sidechainAssistant)} sidechain)`);
    console.log(`  user turns (all)       : ${n(r.userTurns)}`);
    console.log(`  compact events         : ${n(r.compactEvents)}`);
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
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
