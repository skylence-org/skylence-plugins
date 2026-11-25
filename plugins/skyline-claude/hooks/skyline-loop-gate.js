/**
 * feature-loop-skill compliance gate (field case 2026-07-26: haiku session
 * silently skipped all three advisor checkpoints AND reported "Deviations:
 * None"; prose rules alone do not bind small models mid-flow).
 *
 * Two modes, selected by argv[2]:
 *  - "commit": PostToolUse on commit-shaped tool calls. When feature-loop-skill
 *    was actually INVOKED this session (a real Skill tool_use call — see
 *    skillInvoked below), inject a one-line reminder that the ADVISOR GATE
 *    fires now if the committed slice was the model slice or first
 *    user-facing surface. Reminder at the trigger moment, where a separate
 *    paragraph was proven to get dropped. In file mode with a usable report
 *    path (below) the reminder also names that path, so the model knows
 *    where FINAL goes before the Stop gate ever fires.
 *  - "stop": Stop hook. When feature-loop-skill was invoked AND at least one
 *    commit-shaped call happened, refuse to end the session until the
 *    mandatory FINAL attestation exists, by EITHER path:
 *      (a) legacy text path (both modes, checked first, needs no fs): SOME
 *          assistant TEXT message this session (not necessarily the last
 *          one) carries all FINAL fields (missingFields below): a
 *          literal CHECKPOINT line copied from the build (`= done|skipped|
 *          n/a`, or `= not-emitted` for a checkpoint that never got a live
 *          line), a deviations mention, slices shipped, test counts;
 *          honesty coupling (1.5.36): with a `= not-emitted` line present, a
 *          deviations line that says only "None" is refused;
 *      (b) report file (file mode only): the FINAL report written to this
 *          session's report file passes the same field checks.
 *    Once attested, later Stops in the same session (e.g. a post-build
 *    debrief turn) pass silently instead of re-demanding the report (field
 *    case 2026-07-26: a haiku session's Stop-gate re-fired on a DEBRIEF turn
 *    after FINAL had already been given earlier that session — pure noise,
 *    burned tokens). Blocks at most MAX_BLOCKS times per user turn (1.5.38;
 *    per session before), then fails open so a wedged model cannot loop
 *    forever (BLOCK BUDGET below).
 *
 * FINAL report file (1.5.35; operator: the FINAL block is for the LLM, not
 * for a human reading chat, so it is stored and chat gets one line):
 *  - path rules (dir, sid sanitizing, per-kind names) live in
 *    loop-report-path.js since 1.5.37, shared with the primer and the
 *    skylore deposit hook; the FINAL path below is unchanged.
 *  - path: <reportDir>/<sid>.md. reportDir = $SKYLINE_LOOP_REPORT_DIR when
 *    it is an ABSOLUTE path (a relative value is ignored as if unset: it
 *    would resolve against each hook process's cwd), else
 *    <$HOME || $USERPROFILE>/.skylence/skyline/loop-reports. sid =
 *    input.session_id with every char outside [A-Za-z0-9._-] replaced by
 *    "_", cut to 128 chars; when that changed the id, "-" + the first 8 hex
 *    chars of sha256(raw id) is appended so distinct ids never share a file
 *    (UUIDs pass through unchanged). Empty, "." or ".." (or no session_id,
 *    or no home dir) => no usable path, legacy text path only. Never
 *    process.ppid. The block counter uses the same sid helper. Known limits,
 *    crafted ids only (no lowercase Claude Code UUID can reach them): an
 *    unchanged id that already looks hashed (`a_b-c14cddc0`) shares the file
 *    of the id that hashes to it (`a/b`); lone surrogates (`x\uD800`,
 *    `x\uDC00`) share one name because UTF-8 turns both into U+FFFD; ids
 *    differing only in case share one file on case-insensitive filesystems.
 *  - verified ON DISK, never by parsing tool_use shapes (tool names and
 *    harnesses change, a file on disk does not): lstat must say regular file
 *    (symlink, dir, anything else is rejected), 0 < size <= 262144 bytes, the
 *    bytes are read through an O_NOFOLLOW|O_NONBLOCK fd re-checked by fstat
 *    (cap enforced on the read too), and the content must pass the same four
 *    field checks as (a). The `loop-report: v1` header the skill writes is
 *    NOT checked by the gate, so an older skill text or a hand-written report
 *    still passes; it marks the file as a loop report for pruning and for a
 *    later indexer. A report that exists but cannot be read (EACCES on the
 *    file or its dir, ...) blocks too, naming the errno and saying a FINAL
 *    printed in chat is accepted instead.
 *  - the hook only READS the report: it never writes it and never creates
 *    the dir. After a pass via the file (and only then) it prunes regular
 *    `*.md` files directly in the report dir that are older than the
 *    retention window AND carry the `loop-report: v<N>` header line in their
 *    first 256 bytes (read through the same no-follow fd), so a report dir
 *    that is, or links to, a notes or project dir never loses the user's
 *    files. Never recursing, never following symlinks, never any of the
 *    current session's files (FINAL, .debug.md, .review.md; other sessions'
 *    debug and review reports are *.md with the header, so they are pruned
 *    by the same rule), at most 500 entries scanned, errors swallowed.
 *    Headerless reports are never pruned (a leak, not a loss).
 *    The prune is loop-report-path.js pruneReports; since 1.5.37 the primer
 *    also runs it at every SessionStart (file mode, usable session_id), so a
 *    box without feature-loop passes still prunes.
 *  - C2 CHECKPOINT liveness (1.5.37, file mode, Stop only): a report that
 *    passes every field check must also show each of its done/skipped/n/a
 *    CHECKPOINT lines written live, before the FINAL write (see
 *    checkpointLiveness below); else field `checkpoint-not-live`.
 *
 *
 * 1.5.38 (audit of 1.5.37 against live Claude Code 2.1.332 sessions):
 *  - MULTI-TURN (I1): a merit pass via the report file stores the
 *    transcript's line count in `<tmpdir>/skyline-loop-gate-<sid>+pass`. The
 *    C2 scan then ends at the first FINAL-marked write AT OR AFTER that
 *    line. A FINAL write of an attempt that already passed neither ends the
 *    scan nor counts as a live write (a line copied from the old FINAL is
 *    not live). Within one attempt C2 is unchanged: blocked, append, rewrite
 *    does not make a line live. A stored line past the transcript's end is
 *    ignored.
 *  - BLOCK BUDGET (I2): the counter is
 *    `<tmpdir>/skyline-loop-gate-<sid>@<prompt_id>`, one per user turn
 *    (Claude Code keeps prompt_id across a turn's block continuations).
 *    Without a usable prompt_id it is the pre-1.5.38 session-wide
 *    `skyline-loop-gate-<sid|ppid>`. A merit pass (chat text,
 *    last_assistant_message or report file) deletes the current counter; a
 *    fail-open never does. FAIL-OPEN, stated here and in the PR, never in a
 *    block message (a block that advertises it invites stopping twice): the
 *    (MAX_BLOCKS + 1)th Stop of a turn that is still unattested passes, so
 *    after MAX_BLOCKS blocks the gate is advisory for the rest of that turn.
 *    `@` and `+` are outside the sanitized-id alphabet, so these names never
 *    equal another id's counter. A prompt_id that would push the name past
 *    200 chars is replaced by `~<16 hex of its sha256>` (bounce 1 nit 6:
 *    ENAMETOOLONG made the gate fail open from the first Stop). UNSCOPED
 *    INHERITED SESSIONS (bounce 1 Minor 2): a fork or branch that carries a
 *    marker or forkedFrom stamps but could not be scoped (parent unreadable)
 *    keeps the 1.5.37 budget exactly: the session-wide counter, never reset,
 *    so it is never blocked more often than 1.5.37 blocked it.
 *  - FORKS (I3): every scan reads only this session's own entries
 *    (transcript-scope.js scopeOf: entries inherited from a `--fork-session`
 *    or `/branch` parent are skipped), so a fork never owes a FINAL for its
 *    parent's build.
 *  - PATH SPELLINGS (M1): a write names the report under any spelling of
 *    its path: `~` (HOME, else USERPROFILE), `\` for `/`, `//`, `/./`,
 *    `seg/..`, and letter case on win32 only. The literal and realpath forms
 *    are matched as before.
 *  - COMMITS (M5): a `git` argv or command counts when its subcommand, after
 *    any number of global options (`-c k=v`, `-C dir`, `--no-pager`, ...),
 *    is exactly `commit`; `git commit-graph`, `git log --grep commit` do not.
 *    A shell separator (`;&|()<>`, newline) between `git` and the subcommand
 *    breaks the match and is never an option value (prose: `use git (commit
 *    early)`, `git -C\ncommit`). A quoted sub-command (`sh -c '...'`, `bash
 *    -lc "..."`, `ssh h '...'`) and a backtick span are split and matched
 *    again; `$'...'` is a quote (bounce 1 Minor 1, bounce 2 findings 2-4).
 *    `echo "git commit"` matches, as it did before 1.5.38. THE CONTRACT is
 *    the table in skyline-loop-gate.test.js ("commit matcher contract"),
 *    including its known misses and known false positives.
 *  - FLUSH RACE (M8): the Stop input's last_assistant_message also counts as
 *    the chat FINAL when it passes every field check (skylore 669).
 *  - Chat mode shares I2, I3, M5 and M8; I1 and the fields-missing labels
 *    (I4) are file mode only.
 * Env:
 *  - SKYLINE_LOOP_REPORT = file (default, also any unknown value) | chat.
 *    chat = pre-1.5.35 behavior and messages (except the 1.5.36 not-emitted
 *    wording of the stop message): only (a) counts. Deliberate
 *    fail-open/robustness differences in chat mode too: an uncaught throw
 *    exits 0 instead of 1, and the block counter uses the sanitized sid and
 *    fails open when it cannot be written (a counter that never sticks used
 *    to block forever).
 *  - SKYLINE_LOOP_REPORT_DIR: absolute report dir override.
 *  - SKYLINE_LOOP_REPORT_RETENTION_DAYS: non-negative integer, default 30;
 *    0 = never prune.
 *
 * Fail-open on any stdin/transcript parse error, uncaught throw, or
 * unwritable block counter: exit 0, no output. A report file that does not
 * exist, fails a check, or cannot be read blocks (at most MAX_BLOCKS times
 * per turn).
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MAX_REPORT_BYTES,
  REPORT_OPEN_FLAGS,
  isLoopReport,
  pruneReports,
  reportPath: sessionReportPath,
  reportPaths,
  sessionFileBase,
} = require("./loop-report-path");
const { scopeOf } = require("./transcript-scope");

const MAX_BLOCKS = 2;

// FINAL must COPY a live CHECKPOINT line (1.5.22+ canon), not paraphrase or
// reconstruct one: prose that merely discusses "advisor checkpoints" (a
// plan, a dispatch brief, the skill's own contract text) must not satisfy
// the gate once the scan below covers the whole session instead of just the
// last message.
const CHECKPOINT_LINE =
  /checkpoint:\s*(post-model|post-first-surface|pre-final)\s*=\s*(done|skipped|n\/a|not-emitted)/i;
// A checkpoint the build never emitted a live line for (1.5.36): honest, but
// it IS a deviation, so a deviations line reading just "None" contradicts it.
const NOT_EMITTED_LINE =
  /checkpoint:\s*(post-model|post-first-surface|pre-final)\s*=\s*not-emitted/i;
// A line whose label is "deviations" (optionally "deviations from this
// skill", the SKILL.md FINAL label) after an optional tree glyph / bullet /
// `#` / `**`, a `:` `—` `–` `-` separator, and a value that is exactly
// "none" (optional trailing `.`, `**`). "None besides X" does not match.
const DEVIATIONS_NONE_LINE =
  /^(?:[ \t│├└─┬┌┐┘┤┴┼•·*_+>#|-]|\d+[.)])*deviations?(?:[ \t]+from[ \t]+(?:(?:this|the)[ \t]+)?(?:feature-loop-)?skill)?[*_]*[ \t]*(?:\r?\n[ \t]*){0,3}[:=—–|-][ \t]*(?:\r?\n[ \t]*){0,3}[*_\x60"'“”‘’]*[ \t]*(?:\r?\n[ \t]*){0,3}none[ \t]*\.?[ \t]*[*_\x60"'“”‘’]*[ \t]*\.?[ \t]*\|?[ \t]*\r?$/im;

// FINAL's "slices shipped + commit ids" field (feature-loop-skill/SKILL.md
// FINAL:51): a bare "slices...shipped" mention. NOT coupled to a
// same-line hex token: a commit id is often stated once elsewhere in the
// FINAL (e.g. "see commit above") and a same-line hex requirement both
// misses that real shape AND false-matches ordinary words that happen to
// fall in [0-9a-f] (e.g. "none added" -> "added" reads as a hex run).
// Precision comes from requiring this field AND the test-count field
// alongside the CHECKPOINT line, not from over-fitting this one field.
const SLICES_SHIPPED_LINE = /slices?\s+shipped/i;
// FINAL's "test counts (passed/assertions)" field (SKILL.md FINAL:52): the
// literal phrase, or a count next to passed/failed/tests/assertions.
const TEST_COUNTS_LINE = /test\s*counts?|\b\d+\s*(passed|failed|tests?|assertions?)\b/i;

// One field table for BOTH attestation paths (legacy chat text and the
// report file), in a fixed order, so the two can never drift. The keys are
// what the file-mode block message names when a report is incomplete.
const COUPLING_KEY = "deviations-none-with-not-emitted";
const NAMING_KEY = "deviations-not-naming-not-emitted";
const ANY_CHECKPOINT_LINE_G =
  /checkpoint:\s*(?:post-model|post-first-surface|pre-final)\s*=\s*(?:done|skipped|n\/a|not-emitted)/gi;
const NOT_EMITTED_LINE_G =
  /checkpoint:\s*(post-model|post-first-surface|pre-final)\s*=\s*not-emitted/gi;

// D2b: every not-emitted checkpoint name must also appear OUTSIDE the
// CHECKPOINT lines (named under deviations); the line itself never counts.
function unnamedNotEmitted(t) {
  const names = [...new Set([...t.matchAll(NOT_EMITTED_LINE_G)].map((m) => m[1].toLowerCase()))];
  if (!names.length) return [];
  const rest = t.replace(ANY_CHECKPOINT_LINE_G, "").toLowerCase();
  return names.filter((n) => !rest.includes(n));
}

const FIELD_CHECKS = [
  ["checkpoint", (t) => CHECKPOINT_LINE.test(t)],
  ["deviations", (t) => t.toLowerCase().includes("deviation")],
  ["slices", (t) => SLICES_SHIPPED_LINE.test(t)],
  ["tests", (t) => TEST_COUNTS_LINE.test(t)],
  // Appended last: the key order is fixed and named in file-mode messages.
  [COUPLING_KEY, (t) => !(NOT_EMITTED_LINE.test(t) && DEVIATIONS_NONE_LINE.test(t))],
  [NAMING_KEY, (t) => unnamedNotEmitted(t).length === 0],
];

function missingFields(text) {
  const t = String(text || "");
  return FIELD_CHECKS.filter(([, ok]) => !ok(t)).map(([key]) => key);
}

// I4 (1.5.38): a fields-missing block names the LABELS to write, with the key
// in parentheses (a model wrote `slices: ...` for the key `slices`, which the
// `slices shipped` check misses). Rule keys (coupling, naming, liveness) are
// not labels and are named as they are; their notes explain them.
const FIELD_LABELS = {
  checkpoint: "`CHECKPOINT: <name> = done|skipped(<reason>)|n/a|not-emitted`",
  deviations: "`deviations`",
  slices: "`slices shipped`",
  tests: "`test counts`",
};

function missingLabel(key) {
  return Object.prototype.hasOwnProperty.call(FIELD_LABELS, key) ? `${FIELD_LABELS[key]} (${key})` : key;
}

// Report file limits (see header): MAX_REPORT_BYTES (256 KiB) and the
// no-follow, non-blocking REPORT_OPEN_FLAGS come from loop-report-path.js, as
// do retention (pruneReports, isLoopReport) and its constants.

// C2 (1.5.37): CHECKPOINT liveness in file mode. feature-loop-skill appends
// each live CHECKPOINT line to the FINAL report file by its own tool call the
// moment the checkpoint resolves; FINAL then completes the file. A file
// written in one go at the end could carry reconstructed lines, so a report
// passes only when every done/skipped/n/a CHECKPOINT line in it also appears
// EARLIER in the transcript: in an assistant tool_use whose input names the
// report path (live append), or in an assistant text message (the pre-1.5.37
// chat habit), before the first tool_use that wrote the FINAL fields (slices
// shipped / test counts) to that path. Tool-name agnostic (create, edit, a
// Bash echo): it reads the input's DECODED string values, not JSON text, so
// Windows backslashes and quotes in a skipped(reason) cannot break the match.
// Line key = name + state + an immediately following "(...)", case- and
// whitespace-normalised; trailing text after it is ignored. `= not-emitted`
// needs no live write. FINAL write not in the transcript (it can trail the
// file, skylore 669): still blocks, but the message lets an honest model
// stop again unchanged instead of recording a false deviation. Known limits:
// a FINAL printed in chat passes via the legacy text path without this
// check, and it proves "written before the FINAL write", not "written when
// the checkpoint resolved".
const LIVE_KEY = "checkpoint-not-live";
const CHECKPOINT_KEY_G =
  /checkpoint:[ \t]*(post-model|post-first-surface|pre-final)[ \t]*=[ \t]*(done|skipped|n\/a)(\([^\n)]*\))?/gi;
const FINAL_WRITE_MARK = /slices?\s+shipped|test\s*counts?/i;
const MAX_INPUT_DEPTH = 8;

function checkpointKeys(t) {
  const out = [];
  for (const m of String(t).matchAll(CHECKPOINT_KEY_G)) {
    const reason = m[3] ? m[3].replace(/\s+/g, " ") : "";
    out.push({ key: `${m[1]}=${m[2]}${reason}`.toLowerCase(), line: m[0].trim() });
  }
  return out;
}

function inputStrings(v, out, depth) {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object" && depth < MAX_INPUT_DEPTH) {
    for (const x of Object.values(v)) inputStrings(x, out, depth + 1);
  }
  return out;
}

// p occurs in s as a whole path: not glued to more name characters before it
// or after it (`x<p>`, `<p>x`, `<p>.bak` do not count; `<p>#TAG`, `<p>"` do).
function containsPath(s, p) {
  for (let i = s.indexOf(p); i !== -1; i = s.indexOf(p, i + 1)) {
    const before = i > 0 ? s[i - 1] : "";
    const rest = s.slice(i + p.length, i + p.length + 2);
    if (/^[A-Za-z0-9._-]$/.test(before) || /^(?:[A-Za-z0-9_-]|\.[A-Za-z0-9])/.test(rest)) continue;
    return true;
  }
  return false;
}

// M1 (1.5.38): one spelling for every way of writing the same path, applied
// to both sides before matching: `\` -> `/`, a `~` at a token start -> the
// home dir (HOME, else USERPROFILE, as reportDir), `//` -> `/`, `/./` and
// `seg/..` resolved, and letter case folded on win32 only.
const IS_WIN32 = process.platform === "win32";

function normPathText(s) {
  let t = String(s).replace(/\\/g, "/");
  const home = String(process.env.HOME || process.env.USERPROFILE || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (home) t = t.replace(/(^|[\s"'`¶=(<>|;,])~(?=\/|$)/g, (_m, pre) => pre + home);
  t = t.replace(/\/{2,}/g, "/");
  let prev;
  do {
    prev = t;
    t = t.replace(/\/\.(?=\/|$)/g, "").replace(/\/(?!\.\.?(?:\/|$))[^/\s"'`]+\/\.\.(?=\/|$)/g, "");
  } while (t !== prev);
  return IS_WIN32 ? t.toLowerCase() : t;
}

// The report path in every form a live write may carry: literal, realpath
// (bounce 1 M1, skylore 676: skyline create answers with the realpath anchor,
// /tmp -> /private/tmp or a symlinked ~/.skylence, and later edit appends
// carry it), and both normalized (M1).
function reportNames(reportFile) {
  const names = [reportFile];
  try {
    const real = path.join(fs.realpathSync(path.dirname(reportFile)), path.basename(reportFile));
    if (real !== reportFile) names.push(real);
  } catch (_e) {
    /* dir missing or unreadable: the literal path only */
  }
  const norm = [...new Set(names.map((n) => normPathText(path.resolve(n))))];
  const base = path.basename(reportFile);
  return { names, norm, base: IS_WIN32 ? base.toLowerCase() : base };
}

function namesReport(s, r) {
  if (r.names.some((p) => containsPath(s, p))) return true;
  // Normalizing costs a few regex passes: only inputs naming the basename.
  if (!(IS_WIN32 ? s.toLowerCase() : s).includes(r.base)) return false;
  const t = normPathText(s);
  return r.norm.some((p) => containsPath(t, p));
}

// anchor (I1, 1.5.38): index into `transcript`'s lines of the last merit
// pass; a FINAL-marked write before it belongs to an attempt that already
// passed, so it neither ends this scan nor counts as live.
function checkpointLiveness(transcript, reportFile, reportText, anchor = 0) {
  const wanted = checkpointKeys(reportText);
  if (!wanted.length) return { notLive: [], finalVisible: true };
  const live = new Set();
  let finalVisible = false;
  const r = reportNames(reportFile);
  forEachAssistantMessage(transcript, (content, i) => {
    for (const block of content) {
      if (finalVisible) return;
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        if (typeof block.text === "string" && /checkpoint:/i.test(block.text)) {
          for (const k of checkpointKeys(block.text)) live.add(k.key);
        }
      } else if (block.type === "tool_use") {
        const s = inputStrings(block.input, [], 0).join("\n");
        if (!namesReport(s, r)) continue;
        // The FINAL mark is looked for OUTSIDE CHECKPOINT lines: a reason
        // such as skipped(docs only, test counts unchanged) is not a FINAL.
        if (FINAL_WRITE_MARK.test(s.replace(CHECKPOINT_KEY_G, ""))) {
          if (i < anchor) continue;
          finalVisible = true;
          return;
        }
        for (const k of checkpointKeys(s)) live.add(k.key);
      }
    }
  });
  const notLive = [];
  const seen = new Set();
  for (const w of wanted) {
    if (live.has(w.key) || seen.has(w.key)) continue;
    seen.add(w.key);
    notLive.push(w.line);
  }
  return { notLive, finalVisible };
}

function liveNote(notLive, finalVisible) {
  const lines = notLive.map((l) => `\`${l}\``).join(", ");
  return finalVisible
    ? ` CHECKPOINT line(s) with no live write before the FINAL write: ${lines}. Each CHECKPOINT line is appended to this file by its own tool call the moment its checkpoint resolves, before the FINAL write; a checkpoint whose line was not written then is \`CHECKPOINT: <name> = not-emitted\`, named under deviations.`
    : ` CHECKPOINT line(s) with no live write visible: ${lines}. The transcript does not show the FINAL write yet, so it may trail the file: if each line was appended by its own call before the FINAL write, stop again without changing those lines; otherwise mark it \`CHECKPOINT: <name> = not-emitted\` and name it under deviations.`;
}

// Pre-1.5.35 texts, byte for byte, except the 1.5.36 checkpoint clause of
// FINAL_FIELDS_DEMAND (now asks for `= not-emitted`). Chat mode (SKYLINE_LOOP_REPORT=chat) and
// any call without a usable report path emit exactly these.
const COMMIT_CONTEXT =
  "feature-loop-skill ADVISOR GATE: slice just committed. If that was the model slice or the first user-facing surface, consult the advisor NOW, before the next slice. Every checkpoint must appear in FINAL as done or skipped+reason.";
const FINAL_FIELDS_DEMAND =
  "slices shipped + commit ids; test counts; advisor checkpoints: COPY the live CHECKPOINT lines emitted during build, one per [post-model / post-first-surface / pre-final] — do not restate or reconstruct them from memory; for a checkpoint with no live CHECKPOINT line write `CHECKPOINT: <name> = not-emitted` and list it under deviations by name (then \"None\" is not allowed); deviations from the skill, where \"None\" is permitted only if every rule was followed as written.";
const COUPLING_NOTE =
  " The only failing check: a `CHECKPOINT: <name> = not-emitted` line is present, so deviations cannot be \"None\" — list the not-emitted checkpoint under deviations.";
const LEGACY_STOP_MESSAGE =
  "feature-loop-skill FINAL attestation missing. Before ending: produce the mandatory FINAL report — " +
  FINAL_FIELDS_DEMAND;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (_e) {
    return "";
  }
}

function transcriptText(input) {
  try {
    const p = input.transcript_path;
    if (!p || !fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8");
  } catch (_e) {
    return "";
  }
}

// Parse the JSONL transcript (a string, or its lines already split) once;
// invoke fn(contentBlocks, lineIndex) for every assistant message. Shared by
// skillInvoked (looks for a Skill tool_use), attestationPresent (looks for a
// CHECKPOINT line in text blocks) and checkpointLiveness (line order).
function forEachAssistantMessage(text, fn) {
  const lines = Array.isArray(text) ? text : String(text).trim().split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch (_e) {
      continue; // skip unparseable line
    }
    const msg = entry.message;
    if (entry.type === "assistant" && msg && Array.isArray(msg.content)) {
      fn(msg.content, i);
    }
  }
}

// Real invocation only: a Skill tool_use call whose input names
// feature-loop-skill (bare or namespaced, e.g. "skyline-claude:feature-loop-skill").
// Deliberately NOT a substring match on the raw transcript text: the ambient
// available-skills listing names every INSTALLED skill, including
// feature-loop-skill, in EVERY session on a box with this plugin present —
// whether or not the skill was ever invoked. A substring test gates every
// committing session on the box, not just build sessions (worse false
// positive than the debrief case this fix targets).
function skillInvoked(text) {
  let found = false;
  forEachAssistantMessage(text, (content) => {
    if (found) return;
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "Skill") {
        const arg = String((block.input && block.input.skill) || "");
        if (arg === "feature-loop-skill" || arg.endsWith(":feature-loop-skill")) {
          found = true;
          break;
        }
      }
    }
  });
  return found;
}

// Commit-shaped: skyline git_commit tools, or a run/Bash call whose input
// carries a git commit (M5, 1.5.38): an argv array, or a command string split
// shell-style, in which `git` is followed by global options and then the
// subcommand `commit` exactly. Matched the same way on the transcript side.
const GIT_OPTS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);

function isGitExe(tok) {
  const b = String(tok).replace(/\\/g, "/").split("/").pop().toLowerCase();
  return b === "git" || b === "git.exe";
}

// A shell command separator inside a token stream (shellTokens): `git` and
// its subcommand never span one (`use git (commit early)`, `git\ncommit`).
const SEP = null;

function argvCommits(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === SEP || !isGitExe(tokens[i])) continue;
    let j = i + 1;
    for (; j < tokens.length; j += 1) {
      if (tokens[j] === SEP) break;
      const t = String(tokens[j]);
      if (GIT_OPTS_WITH_VALUE.has(t)) {
        if (tokens[j + 1] === SEP) break; // a separator is never an option value
        j += 1;
        continue;
      }
      if (t.startsWith("-")) continue;
      if (t === "commit") return true;
      break;
    }
    // Every git token in (i, j) was an option value, so a scan from it ends at
    // the same j with the same answer: resume at j (linear, not quadratic).
    i = Math.max(i, j - 1);
  }
  return false;
}

// Quote-aware split: whitespace ends a token; a command separator or
// redirection (`; & | ( ) < >`, newline) ends it and adds SEP. `$'...'` is a
// quote. A backtick substitution stays part of its word (`git -C \`pwd\`
// commit`) and its text is split again after a SEP.
function shellTokens(s) {
  const out = [];
  const subs = [];
  let cur = "";
  let quote = null;
  let quoted = false;
  const flush = () => {
    if (cur || quoted) out.push(cur);
    cur = "";
    quoted = false;
  };
  const sep = () => {
    flush();
    if (out.length && out[out.length - 1] !== SEP) out.push(SEP);
  };
  for (let k = 0; k < s.length; k += 1) {
    const ch = s[k];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
    } else if (ch === "$" && s[k + 1] === "'") {
      quote = "'";
      quoted = true;
      k += 1;
    } else if (ch === "`") {
      const end = s.indexOf("`", k + 1);
      if (end === -1) {
        sep();
      } else {
        subs.push(s.slice(k + 1, end));
        cur += "``"; // placeholder: the span's text is matched once, below, never re-split per depth
        k = end;
      }
    } else if (/[;&|()<>\n]/.test(ch)) {
      sep();
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  for (const sub of subs) {
    if (out.length && out[out.length - 1] !== SEP) out.push(SEP);
    for (const t of shellTokens(sub)) out.push(t); // no spread: a 1 MB span overflows the argument limit
  }
  return out;
}

// A quoted sub-command (`sh -c '...'`, `bash -lc "..."`, `ssh h '...'`) is
// one token: it is split and matched again (bounce 1 Minor 1), bounded by
// MAX_INPUT_DEPTH like the object walk.
function commitInValue(v, depth) {
  if (typeof v === "string") {
    if (!v.includes("commit")) return false;
    const toks = shellTokens(v);
    return (
      argvCommits(toks) ||
      (depth < MAX_INPUT_DEPTH && toks.some((t) => t !== SEP && /\s/.test(t) && commitInValue(t, depth + 1)))
    );
  }
  if (!v || typeof v !== "object" || depth >= MAX_INPUT_DEPTH) return false;
  if (Array.isArray(v) && v.every((x) => typeof x === "string") && argvCommits(v)) return true;
  for (const x of Object.values(v)) if (commitInValue(x, depth + 1)) return true;
  return false;
}

function isCommitCall(toolName, toolInput) {
  const name = String(toolName || "");
  if (/git_commit$/.test(name)) return true;
  // Cheap pre-check first (commit mode runs it on every run/Bash call).
  let asText;
  try {
    asText = JSON.stringify(toolInput || {});
  } catch (_e) {
    return false;
  }
  if (!asText || !asText.includes("commit")) return false;
  return commitInValue(toolInput, 0);
}

// (a) commit-activity check: same real-tool_use discipline as
// skillInvoked() above — scan assistant tool_use blocks for a
// commit-shaped call, never a raw substring test over the whole
// transcript. A skill's own auto-injected instructional body (delivered
// as plain assistant-turn TEXT, e.g. feature-loop-skill/SKILL.md's
// literal "...git_commit green slice") must never stand in for an actual
// commit (Finding 1, review bounce todo 69 c245).
function commitActivityInTranscript(text) {
  let found = false;
  forEachAssistantMessage(text, (content) => {
    if (found) return;
    for (const block of content) {
      if (block.type === "tool_use" && isCommitCall(block.name, block.input)) {
        found = true;
        break;
      }
    }
  });
  return found;
}

// FINAL attestation: a literal CHECKPOINT line (copied, not reconstructed)
// plus a deviations mention, on ANY assistant message this session — not
// just the last one. FINAL can land several turns before the Stop hook
// actually fires (a debrief turn, a follow-up question); requiring it to be
// the LAST message is what produced the field false positive.
function attestationPresent(text) {
  let found = false;
  forEachAssistantMessage(text, (content) => {
    if (found) return;
    const t = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (missingFields(t).length === 0) found = true;
  });
  return found;
}

// Explicit note for the not-emitted honesty rules (coupling, naming) when
// they are the ONLY failing checks of a text; "" otherwise.
function softNote(t, missing) {
  if (!missing.length || !missing.every((k) => k === COUPLING_KEY || k === NAMING_KEY)) return "";
  let note = "";
  if (missing.includes(COUPLING_KEY)) note += COUPLING_NOTE;
  if (missing.includes(NAMING_KEY)) {
    note += ` Name each not-emitted checkpoint under deviations (not named yet: ${unnamedNotEmitted(t).join(", ")}).`;
  }
  return note;
}

// The soft note of the first assistant message that fails only those rules.
function chatSoftNote(text) {
  let note = "";
  forEachAssistantMessage(text, (content) => {
    if (note) return;
    const t = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    note = softNote(t, missingFields(t));
  });
  return note;
}

// Report path and block counter share one session-id helper
// (loop-report-path.js sessionFileBase, moved there unchanged in 1.5.37): a
// raw id like "../../x" never steers a path out of its directory, and two
// distinct raw ids never share a file ("a/b" vs "a_b"). Real Claude Code ids
// are UUIDs and pass through unchanged, so the counter path of a real session
// is what it always was.
const sanitizeSessionId = sessionFileBase;

const MAX_COUNTER_NAME = 200;

// perTurn false (an unscoped inherited session, bounce 1 Minor 2): the
// pre-1.5.38 session-wide counter, whatever prompt_id says.
function blockCountFile(input, perTurn = true) {
  const sid = sanitizeSessionId(input.session_id ? String(input.session_id) : "");
  const base = `skyline-loop-gate-${sid || process.ppid}`;
  // I2 (1.5.38): one budget per user turn when the Stop input names it.
  const raw = perTurn && typeof input.prompt_id === "string" ? input.prompt_id : null;
  let turn = raw === null ? null : sanitizeSessionId(raw);
  if (turn && base.length + 1 + turn.length > MAX_COUNTER_NAME) {
    turn = `~${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
  }
  return path.join(os.tmpdir(), turn ? `${base}@${turn}` : base);
}

// Returns the new count, or null when it could not be persisted: a counter
// that never sticks (unwritable TMPDIR, unusable name) would never reach
// MAX_BLOCKS and block forever, so the caller fails open instead.
function bumpBlockCount(file) {
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(file, "utf8"), 10) || 0;
  } catch (_e) {
    /* first block */
  }
  n += 1;
  try {
    fs.writeFileSync(file, String(n));
  } catch (_e) {
    return null;
  }
  return n;
}

// I2: a merit pass resets this turn's budget; a fail-open never calls this.
function clearBlockCount(input) {
  try {
    fs.rmSync(blockCountFile(input), { force: true });
  } catch (_e) {
    /* best-effort */
  }
}

// I1 (1.5.38): transcript line count at the last merit pass via the report
// file. Keyed by the sanitized session id only (null without one: file mode
// has no report path then either).
function passFile(input) {
  const sid = sanitizeSessionId(input.session_id ? String(input.session_id) : "");
  return sid ? path.join(os.tmpdir(), `skyline-loop-gate-${sid}+pass`) : null;
}

function readPassLine(input) {
  const f = passFile(input);
  if (!f) return 0;
  try {
    const n = parseInt(fs.readFileSync(f, "utf8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_e) {
    return 0;
  }
}

function savePassLine(input, n) {
  const f = passFile(input);
  if (!f) return;
  try {
    fs.writeFileSync(f, String(n));
  } catch (_e) {
    /* best-effort: without it the next attempt is anchored as before */
  }
}

// M8 (1.5.38): the Stop input carries the turn's final text, which the
// transcript may not hold yet (skylore 669).
function lastMessageAttests(input) {
  const m = input.last_assistant_message;
  return typeof m === "string" && m !== "" && missingFields(m).length === 0;
}

// FINAL report path for this session (loop-report-path.js: file mode only,
// usable session_id and home dir, else null; never process.ppid).
function reportPath(input) {
  try {
    return sessionReportPath(input.session_id, "final");
  } catch (_e) {
    return null;
  }
}

function isAbsent(e) {
  return !!e && (e.code === "ENOENT" || e.code === "ENOTDIR");
}

function unreadable(e) {
  return { state: "unreadable", code: (e && e.code) || "error" };
}

// Closed outcome set: ok | absent | symlink | not-regular | empty |
// too-large | fields-missing (+missing) | unreadable (+code). Every non-ok
// state blocks (bounded by MAX_BLOCKS) and the block message says why;
// "unreadable" is an fs error other than absence (EACCES on the file or its
// dir, a failing read) and its message also accepts a FINAL in chat.
function checkReportFile(p, transcript, anchor = 0) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    return isAbsent(e) ? { state: "absent" } : unreadable(e);
  }
  if (st.isSymbolicLink()) return { state: "symlink" };
  if (!st.isFile()) return { state: "not-regular" };
  if (st.size === 0) return { state: "empty" };
  if (st.size > MAX_REPORT_BYTES) return { state: "too-large" };
  let fd;
  try {
    fd = fs.openSync(p, REPORT_OPEN_FLAGS);
  } catch (e) {
    // ELOOP (Linux, macOS) / EMLINK (BSD): swapped to a symlink after lstat.
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) return { state: "symlink" };
    return isAbsent(e) ? { state: "absent" } : unreadable(e);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { state: "not-regular" };
    // Cap enforced on the read itself, not only on the stat: read at most
    // MAX_REPORT_BYTES + 1 so a file that grew after lstat is still caught.
    const buf = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n === 0) return { state: "empty" };
    // Grew after lstat (bound by the checkReportFile unit test in the suite).
    if (n > MAX_REPORT_BYTES) return { state: "too-large" };
    const reportText = buf.toString("utf8", 0, n);
    const missing = missingFields(reportText);
    let note = softNote(reportText, missing);
    // C2 liveness, only when the caller hands the transcript (the Stop path);
    // the key is appended after the field-table keys.
    if (transcript !== undefined) {
      const { notLive, finalVisible } = checkpointLiveness(transcript, p, reportText, anchor);
      if (notLive.length) {
        missing.push(LIVE_KEY);
        note += liveNote(notLive, finalVisible);
      }
    }
    return missing.length ? { state: "fields-missing", missing, note } : { state: "ok" };
  } catch (e) {
    return unreadable(e);
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_e) {
      /* already closed */
    }
  }
}


// Basenames of all three of this session's report files (loop-report-path.js
// kinds): prune never touches any of them, however old.
function currentSessionNames(input, reportFile) {
  const names = new Set([path.basename(reportFile)]);
  const all = reportPaths(input.session_id);
  if (all) for (const p of Object.values(all)) names.add(path.basename(p));
  return names;
}


function fileCommitContext(reportFile) {
  const at = `\`${reportFile}\``;
  return `${COMMIT_CONTEXT} CHECKPOINT lines go to the report file ${at}, not chat: append each one by its own tool call the moment it resolves (file absent: create it with the lines \`# feature-loop FINAL\` and \`loop-report: v1\` first); a line written later, or inside the FINAL write, is not live. FINAL goes to a file, not chat: write the full FINAL report to ${at} with the skyline create tool (overwrite:true if it exists) keeping the CHECKPOINT lines already in it verbatim, then print only \`FINAL stored: ${reportFile}\` plus at most 2 short lines.`;
}

function fileStopMessage(reportFile, report) {
  const at = `\`${reportFile}\``;
  let problem = "";
  switch (report && report.state) {
    case "symlink":
      problem = ` The report file ${at} was rejected: it is a symlink (replace it with a regular file).`;
      break;
    case "not-regular":
      problem = ` The report file ${at} was rejected: it is not a regular file.`;
      break;
    case "empty":
      problem = ` The report file ${at} was rejected: it is empty.`;
      break;
    case "too-large":
      problem = ` The report file ${at} was rejected: it is larger than ${MAX_REPORT_BYTES} bytes.`;
      break;
    case "unreadable":
      problem = ` The report file ${at} could not be read (${report.code}); fix the path or its permissions, or print the full FINAL in chat instead (the gate accepts either).`;
      break;
    case "fields-missing":
      problem = ` The report file ${at} is missing fields: ${report.missing.map(missingLabel).join(", ")}.${report.note || ""}`;
      break;
    default:
      break; // absent: the instruction below names the path
  }
  return (
    "feature-loop-skill FINAL attestation missing." +
    problem +
    ` Before ending: write the mandatory FINAL report to ${at} with the skyline create tool (overwrite:true if it exists) keeping the CHECKPOINT lines already in it verbatim (append the \`skylore:\` line, or include it in the FINAL you write), then print only \`FINAL stored: ${reportFile}\` plus at most 2 short lines in chat; the report goes in the file, not in chat. Pausing mid-build => write an interim FINAL (slices so far); keep appending CHECKPOINT lines and rewrite the FINAL when done. A CHECKPOINT line counts as live only when an earlier tool call of its own appended it to this file (or it was printed in chat at the time). The report must carry: ` +
    FINAL_FIELDS_DEMAND
  );
}

function main() {
  const mode = process.argv[2];
  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch (_e) {
    process.exit(0);
  }
  // Cheap check first: commit mode exits before any transcript read when the
  // call is not commit-shaped (run/Bash fire constantly on busy sessions).
  if (mode === "commit" && !isCommitCall(input.tool_name, input.tool_input)) {
    process.exit(0);
  }
  const text = transcriptText(input);
  if (!text) process.exit(0);
  // I3 (1.5.38): this session's own entries only; a fork's or branch's
  // inherited parent history (Skill, commits, FINAL) is skipped.
  const all = text.trim().split("\n");
  const scope = scopeOf(all, input.transcript_path);
  const from = scope.start;
  const own = from ? all.slice(from) : all;
  // Bounce 1 Minor 2: inherited but not scoped => the 1.5.37 budget (one
  // session-wide counter, never reset), never the per-turn one.
  const perTurn = !(scope.inherited && from === 0);
  if (!skillInvoked(own)) process.exit(0);

  if (mode === "commit") {
    const reportFile = reportPath(input);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: reportFile ? fileCommitContext(reportFile) : COMMIT_CONTEXT,
        },
      }) + "\n"
    );
    process.exit(0);
  }

  if (mode === "stop") {
    // (a) Only gate sessions that actually built something this session.
    if (!commitActivityInTranscript(own)) process.exit(0);
    // (b) FINAL already given earlier this session: later Stops pass silently.
    //     Legacy text path first: it needs no fs and holds in both modes;
    //     the Stop input's last_assistant_message counts too (M8).
    if (attestationPresent(own) || lastMessageAttests(input)) {
      if (perTurn) clearBlockCount(input);
      process.exit(0);
    }
    // (b') File mode: FINAL written to this session's report file, its
    //      liveness scan anchored at the last merit pass (I1).
    const reportFile = reportPath(input);
    let report = null;
    if (reportFile) {
      const passAt = readPassLine(input);
      const anchor = passAt > from && passAt <= all.length ? passAt - from : 0;
      report = checkReportFile(reportFile, own, anchor);
      if (report.state === "ok") {
        savePassLine(input, all.length);
        if (perTurn) clearBlockCount(input);
        pruneReports(path.dirname(reportFile), currentSessionNames(input, reportFile));
        process.exit(0);
      }
    }
    // (c) Genuine in-build stop, no attestation ever emitted: keep blocking.
    const n = bumpBlockCount(blockCountFile(input, perTurn));
    // Fail-open, never wedge a session: past MAX_BLOCKS in this turn, or when
    // the counter cannot be persisted (it would never reach MAX_BLOCKS).
    if (n === null || n > MAX_BLOCKS) process.exit(0);
    const base = reportFile ? fileStopMessage(reportFile, report) : LEGACY_STOP_MESSAGE;
    // The chat note only when no report-file problem is listed beside it
    // (null = chat mode / no path, absent = nothing written yet).
    const chatNote = !report || report.state === "absent" ? chatSoftNote(own) : "";
    process.stderr.write(chatNote && !base.includes(chatNote) ? base + chatNote : base);
    process.exit(2);
  }

  process.exit(0);
}

// Run as a hook (`node skyline-loop-gate.js <mode>`); when required (unit
// tests) export the pure pieces instead of reading stdin and exiting.
if (require.main === module) {
  // Fail-open backstop: an uncaught throw would exit 1 (neither pass nor
  // block) and print a stack trace into the session.
  try {
    main();
  } catch (_e) {
    process.exit(0);
  }
} else {
  module.exports = { checkReportFile, isCommitCall, isLoopReport, missingFields, sanitizeSessionId, MAX_REPORT_BYTES };
}
