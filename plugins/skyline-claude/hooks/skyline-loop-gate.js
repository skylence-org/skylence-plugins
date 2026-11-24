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
 *    burned tokens). Blocks at most MAX_BLOCKS times per session, then fails
 *    open so a wedged model cannot loop forever.
 *
 * FINAL report file (1.5.35; operator: the FINAL block is for the LLM, not
 * for a human reading chat, so it is stored and chat gets one line):
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
 *    files. Never recursing, never following symlinks, never the current
 *    session's file, at most 500 entries scanned, errors swallowed.
 *    Headerless reports are never pruned (a leak, not a loss).
 *
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
 * exist, fails a check, or cannot be read blocks (at most MAX_BLOCKS times).
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

// Report file limits (see header). 256 KiB is far above any real FINAL (a
// few KB) and keeps a runaway write from being slurped into the hook.
const MAX_REPORT_BYTES = 262144;
const DEFAULT_RETENTION_DAYS = 30;
const PRUNE_SCAN_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
// O_NOFOLLOW closes the lstat -> open symlink-swap window; O_NONBLOCK keeps a
// FIFO swapped in after lstat from hanging the Stop hook. Both are absent on
// Windows (0 here), where the lstat check alone stands.
const REPORT_OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
// The header line the skill writes as the report's 2nd line. It marks a file
// as a loop report for pruning; the GATE never requires it (D11).
const LOOP_REPORT_HEADER = /^loop-report: v\d+\s*$/m;
const HEADER_SCAN_BYTES = 256;

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

// Parse the JSONL transcript once; invoke fn(contentBlocks) for every
// assistant message. Shared by skillInvoked (looks for a Skill tool_use)
// and attestationPresent (looks for a CHECKPOINT line in text blocks).
function forEachAssistantMessage(text, fn) {
  const lines = text.trim().split("\n");
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_e) {
      continue; // skip unparseable line
    }
    const msg = entry.message;
    if (entry.type === "assistant" && msg && Array.isArray(msg.content)) {
      fn(msg.content);
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
// carries a git commit. Matched loosely on the transcript side too.
function isCommitCall(toolName, toolInput) {
  const name = String(toolName || "");
  if (/git_commit$/.test(name)) return true;
  const asText = JSON.stringify(toolInput || {});
  return /"git"\s*,\s*"commit"|git commit/.test(asText);
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

// Report path and block counter share one session-id helper: a raw id like
// "../../x" must never steer a path out of its directory (path.join
// normalizes ".." segments), and two distinct raw ids must never share a
// file ("a/b" vs "a_b"): an id the sanitizer changed gets "-" + the first 8
// hex chars of sha256(raw id). Real Claude Code ids are UUIDs and pass
// through unchanged, so the counter path of a real session is what it
// always was.
function sanitizeSessionId(raw) {
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (!clean || clean === "." || clean === "..") return null;
  if (clean === raw) return clean;
  return `${clean}-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

function blockCountFile(input) {
  const sid = sanitizeSessionId(input.session_id ? String(input.session_id) : "");
  return path.join(os.tmpdir(), `skyline-loop-gate-${sid || process.ppid}`);
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

// SKYLINE_LOOP_REPORT: exactly "chat" restores the pre-1.5.35 behavior; unset
// or any other value (including "Chat", " chat") means file mode: an unknown
// value must not silently disable the file path a newer skill text relies
// on, and the one opt-out spelling stays unambiguous.
function fileMode() {
  return process.env.SKYLINE_LOOP_REPORT !== "chat";
}

function reportDir() {
  const explicit = process.env.SKYLINE_LOOP_REPORT_DIR;
  // Absolute only: a relative value would resolve against each hook
  // process's cwd, so commit and stop could name different files. A relative
  // value (".", "reports") is ignored exactly as if unset.
  if (explicit && path.isAbsolute(explicit)) return path.normalize(explicit);
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  return path.join(path.resolve(home), ".skylence", "skyline", "loop-reports");
}

// Absolute report path for this session, or null when file mode is off or
// no usable path exists (no or unusable session_id, no home dir). Never
// falls back to process.ppid: a parent pid is not a session identity and
// could hand one session another session's report.
function reportPath(input) {
  try {
    if (!fileMode()) return null;
    const sid = sanitizeSessionId(input.session_id);
    const dir = reportDir();
    if (!sid || !dir) return null;
    return path.join(dir, `${sid}.md`);
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
function checkReportFile(p) {
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
    return missing.length
      ? { state: "fields-missing", missing, note: softNote(reportText, missing) }
      : { state: "ok" };
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

function retentionDays() {
  const raw = String(process.env.SKYLINE_LOOP_REPORT_RETENTION_DAYS || "").trim();
  // Digits only: parseInt("7days") would read 7, and "-1" / "1.5" are typos,
  // not intent; all of them fall back to the default.
  if (!/^\d+$/.test(raw)) return DEFAULT_RETENTION_DAYS;
  return Number(raw);
}

// True only for a regular file whose first HEADER_SCAN_BYTES carry the
// loop-report header line, read through the same no-follow, non-blocking
// fd as the gate's own read. Any error: false (never prune what cannot be
// proven to be a loop report).
function isLoopReport(p) {
  let fd;
  try {
    fd = fs.openSync(p, REPORT_OPEN_FLAGS);
    if (!fs.fstatSync(fd).isFile()) return false;
    const buf = Buffer.alloc(HEADER_SCAN_BYTES);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    let head = buf.toString("utf8", 0, n);
    // A full scan buffer can end mid-line: test complete lines only, so a
    // line like "loop-report: v1-draft ..." cut at the cap never matches.
    if (n === HEADER_SCAN_BYTES) head = head.slice(0, head.lastIndexOf("\n") + 1);
    return LOOP_REPORT_HEADER.test(head);
  } catch (_e) {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* already closed */
      }
    }
  }
}

// Best-effort retention, run only after a pass via the report file: delete
// regular *.md files directly in the report dir whose mtime is older than
// the retention window AND that carry the loop-report header (isLoopReport),
// so a report dir that is, or links to, a notes or project dir never loses
// a README.md or CLAUDE.md. Never recurses, never follows symlinks (lstat +
// no-follow fd), never touches the current session's report, scans at most
// PRUNE_SCAN_LIMIT entries, swallows every error.
function pruneReports(dir, keepName) {
  const days = retentionDays();
  if (days === 0) return;
  const cutoff = Date.now() - days * DAY_MS;
  let handle;
  try {
    handle = fs.opendirSync(dir);
    for (let i = 0; i < PRUNE_SCAN_LIMIT; i += 1) {
      const ent = handle.readSync();
      if (!ent) break;
      if (ent.name === keepName || !ent.name.endsWith(".md")) continue;
      try {
        const p = path.join(dir, ent.name);
        const st = fs.lstatSync(p);
        if (st.isFile() && st.mtimeMs < cutoff && isLoopReport(p)) fs.unlinkSync(p);
      } catch (_e) {
        /* raced away or not removable: leave it */
      }
    }
  } catch (_e) {
    /* best-effort */
  } finally {
    if (handle) {
      try {
        handle.closeSync();
      } catch (_e) {
        /* already closed */
      }
    }
  }
}

function fileCommitContext(reportFile) {
  return `${COMMIT_CONTEXT} FINAL goes to a file, not chat: write the full FINAL report to \`${reportFile}\` with the skyline create tool (overwrite:true if it exists), then print only \`FINAL stored: ${reportFile}\` plus at most 2 short lines.`;
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
      problem = ` The report file ${at} is missing fields: ${report.missing.join(", ")}.${report.note || ""}`;
      break;
    default:
      break; // absent: the instruction below names the path
  }
  return (
    "feature-loop-skill FINAL attestation missing." +
    problem +
    ` Before ending: write the mandatory FINAL report to ${at} with the skyline create tool (overwrite:true if it exists), then print only \`FINAL stored: ${reportFile}\` plus at most 2 short lines in chat; the report goes in the file, not in chat. The report must carry: ` +
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
  if (!text || !skillInvoked(text)) process.exit(0);

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
    if (!commitActivityInTranscript(text)) process.exit(0);
    // (b) FINAL already given earlier this session: later Stops pass silently.
    //     Legacy text path first: it needs no fs and holds in both modes.
    if (attestationPresent(text)) process.exit(0);
    // (b') File mode: FINAL written to this session's report file.
    const reportFile = reportPath(input);
    let report = null;
    if (reportFile) {
      report = checkReportFile(reportFile);
      if (report.state === "ok") {
        pruneReports(path.dirname(reportFile), path.basename(reportFile));
        process.exit(0);
      }
    }
    // (c) Genuine in-build stop, no attestation ever emitted: keep blocking.
    const n = bumpBlockCount(blockCountFile(input));
    // Fail-open, never wedge a session: past MAX_BLOCKS, or when the counter
    // cannot be persisted (it would never reach MAX_BLOCKS).
    if (n === null || n > MAX_BLOCKS) process.exit(0);
    const base = reportFile ? fileStopMessage(reportFile, report) : LEGACY_STOP_MESSAGE;
    // The chat note only when no report-file problem is listed beside it
    // (null = chat mode / no path, absent = nothing written yet).
    const chatNote = !report || report.state === "absent" ? chatSoftNote(text) : "";
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
  module.exports = { checkReportFile, isLoopReport, missingFields, sanitizeSessionId, MAX_REPORT_BYTES };
}
