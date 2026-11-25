/**
 * Stop deposit-trigger (skylence-plugins #411 scope (d)).
 * Disconfirmed expectations and discovered quirks are the highest-value lore,
 * yet they have no natural deposit trigger, so disconfirmations systematically
 * go unmarked. Fire ONCE per session on Stop: block the stop a single time and
 * feed back a deposit prompt so the agent records learnings before finishing.
 * A session marker (O_EXCL, mirroring skyline-enforce's reminder collapse) makes
 * it exactly-once; stop_hook_active guards the continuation turn against a loop.
 * Fail-open on any error: exit 0, no block.
 *
 * PROMPT WORDING (revised 2026-07-30 after an audit of the 171-mark bank): the
 * original text asked only "did you learn anything?", and a prompt that only
 * asks for deposits only gets deposits — the bank came out ~25% redundant with
 * 1 of 171 marks ever superseded. The corrective rules (recall first, supersede
 * over re-mark, scope it, exclude PR-scoped detail) do NOT live here: a blocked
 * Stop reason is the worst place to put a procedure, since it lands as a wall
 * of text exactly when the agent wants to be finished, and it would have to be
 * kept in sync across the claude and grok twins. They live in
 * skills/skylore-deposit-skill/SKILL.md, which this prompt points at. What
 * stays inline is only what must survive the skill being unavailable: the
 * question itself, and the fact that "nothing durable" is a correct answer.
 *
 * SILENT ANSWER (1.5.37, loop-report file mode, i.e. SKYLINE_LOOP_REPORT is
 * not "chat"): the check stays quiet when the session already answered it,
 *  - an assistant tool_use whose name ends in lore_mark or lore_supersede is
 *    in the transcript (parsed tool_use blocks, never a substring: the tool
 *    listing names lore_mark in every session). lore_recall does NOT count:
 *    it is a read, not an answer, and every compliant skyline session recalls
 *    at start (bounce 1 I1), or
 *  - one of this session's report files (FINAL, debug, review; paths from
 *    loop-report-path.js and stdin session_id) has a line starting
 *    `skylore:` (`skylore: nothing durable`, `skylore: marked 671`).
 * Both run BEFORE the once-marker is taken (after a read-only check that it
 * is not taken yet), so a session still blocks at most once. A block when one
 * of this session's report files exists asks for the answer as a `skylore:`
 * line in the newest of them (append it, or include it in the FINAL / report
 * you write) and nothing or one line in chat. When none exists (1.5.38, M2: a
 * one-line Q&A must not have to create a file, and in default permission mode
 * that file write is a prompt) or without a usable path (no session_id, no
 * home dir) it is the pre-1.5.37 prompt: the answer goes in chat.
 * SKYLINE_LOOP_REPORT=chat: the pre-1.5.37 behavior (no transcript or report
 * read).
 *
 * 1.5.38 (audit of 1.5.37 against live Claude Code 2.1.332 sessions):
 *  - MARKER KEY (I3): the stdin session_id, through the shared sessionFileBase
 *    helper; process.ppid only when it is absent or unusable. Claude Code
 *    sets no CLAUDE_SESSION_ID in the hook env, so the old key (that env var,
 *    else ppid) was per process and re-fired on every resume. Both modes.
 *  - FORKS (I3): the lore-tool scan reads only this session's own entries
 *    (transcript-scope.js ownStart), not a fork parent's inherited calls.
 * The skyline-grok twin is NOT changed (no primer or report files there).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { sessionFileBase } = require("./loop-report-path");

const DEPOSIT_PROMPT =
  "Stop check: anything this session that would cost the next one real time to re-derive? \"Nothing durable\" is a correct answer — say it and stop. If there IS something, invoke skylore-deposit-skill and follow it: it covers recall-before-mark, supersede-instead-of-duplicate, scoping, and what does not belong in the bank.";

const LORE_TOOL = /lore_(?:mark|supersede)$/;
const SKYLORE_LINE = /^skylore:/m;

// M3 (1.5.38): the same wording as the loop gate's Stop message, which writes
// the FINAL with create (overwrite:true): append the line, or include it in
// the FINAL / report being written. Never "never overwrite".
function filePrompt(target, kind) {
  const doc = kind === "final" ? "FINAL" : "report";
  return (
    "Stop check: anything this session that would cost the next one real time to re-derive? \"Nothing durable\" is a correct answer. " +
    `Answer in the session report, not in chat: append the \`skylore:\` line (\`skylore: nothing durable\`) to \`${target}\`, or include it in the ${doc} you write. ` +
    "If there IS something, invoke skylore-deposit-skill and follow it, then write `skylore: marked <ids>` instead (a lore_mark or lore_supersede call also counts as the answer). " +
    "Chat gets nothing, or one line."
  );
}

let sessionKey = String(process.ppid);

function setSessionKey(input) {
  const sid = input && typeof input.session_id === "string" ? sessionFileBase(input.session_id) : null;
  sessionKey = sid || String(process.ppid);
}

function getDepositMarkerPath() {
  return path.join(os.tmpdir(), `skyline-skylore-deposit-${sessionKey}.marker`);
}

/** true on first fire this session (O_EXCL), false on repeats / fs error. */
function isFirstDeposit() {
  try {
    fs.closeSync(fs.openSync(getDepositMarkerPath(), "wx"));
    return true;
  } catch (_err) {
    return false;
  }
}

/** Read-only: has this session's marker already been taken? */
function markerTaken() {
  try {
    return fs.existsSync(getDepositMarkerPath());
  } catch (_err) {
    return false;
  }
}

function transcriptHasLoreCall(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return false;
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch (_e) {
    return false;
  }
  const lines = text.split("\n");
  // A fork's inherited parent entries are not this session's answer.
  const { ownStart } = require("./transcript-scope");
  for (let i = ownStart(lines, transcriptPath); i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes("lore_")) continue; // cheap prefilter, then parse
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const content = entry && entry.type === "assistant" && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === "tool_use" && LORE_TOOL.test(String(block.name || ""))) return true;
    }
  }
  return false;
}

function mtimeOf(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() ? st.mtimeMs : null;
  } catch (_e) {
    return null;
  }
}

// { answered: true } when the session already answered; otherwise the reason
// to block with (null = the pre-1.5.37 prompt). Never throws.
function silentAnswer(input) {
  try {
    if (transcriptHasLoreCall(input.transcript_path)) return { answered: true };
    const { reportPaths, readReportText } = require("./loop-report-path");
    const paths = reportPaths(input.session_id);
    if (!paths) return { answered: false, reason: null };
    let newest = null;
    for (const kind of ["final", "debug", "review"]) {
      const p = paths[kind];
      const text = readReportText(p);
      if (text && SKYLORE_LINE.test(text)) return { answered: true };
      const m = mtimeOf(p);
      if (m !== null && (!newest || m > newest.m)) newest = { p, m, kind };
    }
    // M2: no report file this session => the pre-1.5.37 chat prompt.
    return { answered: false, reason: newest ? filePrompt(newest.p, newest.kind) : null };
  } catch (_e) {
    return { answered: false, reason: null };
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(buf || "{}");
    // Already continuing because a Stop hook blocked: never block again.
    if (input.stop_hook_active === true) process.exit(0);
  } catch (_e) {
    process.exit(0); // malformed => silent exit 0
  }
  setSessionKey(input);

  let reason = DEPOSIT_PROMPT;
  if (process.env.SKYLINE_LOOP_REPORT !== "chat") {
    // An already-fired session never pays for a transcript read.
    if (markerTaken()) process.exit(0);
    const answer = silentAnswer(input || {});
    if (answer.answered) process.exit(0);
    if (answer.reason) reason = answer.reason;
  }

  // Exactly-once per session: the second Stop finds the marker and allows.
  if (!isFirstDeposit()) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason,
    }) + "\n"
  );
  // Natural exit flushes async Windows pipe writes (see skyline-regate.js).
});
