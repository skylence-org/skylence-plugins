/**
 * Loop report paths (1.5.37), shared by every hook that names or reads a
 * session's loop report files, so the path a hook TELLS the model and the
 * path a hook READS can never drift:
 *  - skyline-loop-gate.js: names and checks the feature FINAL file, prunes.
 *  - skyline-primer.js: injects all three paths at every SessionStart.
 *  - skyline-skylore-deposit.js: reads the `skylore:` answer line.
 *
 * Files, one set per session, all directly in reportDir:
 *   final  -> <base>.md         (feature-loop FINAL; unchanged since 1.5.35)
 *   debug  -> <base>.debug.md   (debug-loop REPORT)
 *   review -> <base>.review.md  (review-loop REPORT)
 *
 * reportDir(env) = $SKYLINE_LOOP_REPORT_DIR when it is an ABSOLUTE path (a
 * relative value is ignored as if unset: it would resolve against each hook
 * process's cwd), else <$HOME || $USERPROFILE>/.skylence/skyline/loop-reports;
 * null without a home dir.
 *
 * sessionFileBase(raw): every char outside [A-Za-z0-9._-] becomes "_", cut to
 * 128 chars; when that changed the id, "-" + the first 8 hex chars of
 * sha256(raw id) is appended so distinct ids never share a file (UUIDs pass
 * through unchanged). Empty, "." or ".." (or a non-string) => null. A raw id
 * like "../../x" can never steer a path out of the dir. Known limits, crafted
 * ids only (no lowercase Claude Code UUID can reach them): an unchanged id that
 * already looks hashed (`a_b-c14cddc0`) shares the files of the id that hashes
 * to it (`a/b`); lone surrogates share one name (UTF-8 turns both into
 * U+FFFD); ids differing only in case share files on case-insensitive
 * filesystems; an id ending in `.debug` / `.review` (`x.debug`) has a FINAL
 * file equal to another id's (`x`) debug/review file.
 *
 * SKYLINE_LOOP_REPORT = file (default, also any unknown value) | chat. chat:
 * reportPath/reportPaths return null, so every caller falls back to its
 * pre-file behavior.
 *
 * Pure functions, no top-level side effects; every function takes env
 * explicitly (default process.env) so in-process tests stay hermetic.
 * pruneReports / pruneForSession (below) delete old headered reports.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPORT_KINDS = ["final", "debug", "review"];
const KIND_SUFFIX = { final: ".md", debug: ".debug.md", review: ".review.md" };

// 256 KiB is far above any real report (a few KB) and keeps a runaway write
// from being slurped into a hook.
const MAX_REPORT_BYTES = 262144;
// O_NOFOLLOW closes the lstat -> open symlink-swap window; O_NONBLOCK keeps a
// FIFO swapped in after lstat from hanging a hook. Both are absent on Windows
// (0 here), where the lstat check alone stands.
const REPORT_OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

// Exactly "chat" restores the pre-file behavior; unset or any other value
// (including "Chat", " chat") means file mode: an unknown value must not
// silently disable the file path a newer skill text relies on.
function fileMode(env = process.env) {
  return env.SKYLINE_LOOP_REPORT !== "chat";
}

function reportDir(env = process.env) {
  const explicit = env.SKYLINE_LOOP_REPORT_DIR;
  if (explicit && path.isAbsolute(explicit)) return path.normalize(explicit);
  const home = env.HOME || env.USERPROFILE;
  if (!home) return null;
  return path.join(path.resolve(home), ".skylence", "skyline", "loop-reports");
}

function sessionFileBase(raw) {
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (!clean || clean === "." || clean === "..") return null;
  if (clean === raw) return clean;
  return `${clean}-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

// Absolute path of one report file for this session, or null when file mode
// is off, the id is unusable, there is no home dir, or the kind is unknown.
// Never falls back to process.ppid: a parent pid is not a session identity.
function reportPath(sessionId, kind, env = process.env) {
  try {
    if (!fileMode(env) || !Object.prototype.hasOwnProperty.call(KIND_SUFFIX, kind)) return null;
    const base = sessionFileBase(sessionId);
    const dir = reportDir(env);
    if (!base || !dir) return null;
    return path.join(dir, base + KIND_SUFFIX[kind]);
  } catch (_e) {
    return null;
  }
}

// { final, debug, review } absolute paths, or null (same conditions).
function reportPaths(sessionId, env = process.env) {
  const out = {};
  for (const kind of REPORT_KINDS) {
    out[kind] = reportPath(sessionId, kind, env);
    if (!out[kind]) return null;
  }
  return out;
}

// Text of a report file, or null unless it is a regular, non-empty file of
// at most maxBytes (lstat: symlinks and non-regular files rejected; read
// through a no-follow, non-blocking fd re-checked by fstat; cap enforced on
// the read too). Never throws.
function readReportText(p, maxBytes = MAX_REPORT_BYTES) {
  let fd;
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile() || st.size === 0 || st.size > maxBytes) return null;
    fd = fs.openSync(p, REPORT_OPEN_FLAGS);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n === 0 || n > maxBytes) return null;
    return buf.toString("utf8", 0, n);
  } catch (_e) {
    return null;
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

// --- Retention: ONE implementation for the loop gate (after a pass via the
// FINAL file) and the primer (every SessionStart, so a box that only runs
// debug / review / non-loop sessions still prunes; moved here from
// skyline-loop-gate.js in 1.5.37). Deletes regular *.md files directly in the
// report dir whose mtime is older than the retention window AND that carry
// the `loop-report: v<N>` header line in their first HEADER_SCAN_BYTES
// (isLoopReport), so a report dir that is, or links to, a notes or project
// dir never loses a README.md or CLAUDE.md. Never recurses, never follows
// symlinks (lstat + no-follow fd), never touches keepNames (the current
// session's three files), scans at most PRUNE_SCAN_LIMIT entries, swallows
// every error. SKYLINE_LOOP_REPORT_RETENTION_DAYS: non-negative integer,
// default 30, 0 = never prune.
const DEFAULT_RETENTION_DAYS = 30;
const PRUNE_SCAN_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
// The header line the skills write as a report's 2nd line. It marks a file
// as a loop report for pruning; the Stop gate never requires it.
const LOOP_REPORT_HEADER = /^loop-report: v\d+\s*$/m;
const HEADER_SCAN_BYTES = 256;

function retentionDays(env = process.env) {
  const raw = String(env.SKYLINE_LOOP_REPORT_RETENTION_DAYS || "").trim();
  // Digits only: parseInt("7days") would read 7, and "-1" / "1.5" are typos,
  // not intent; all of them fall back to the default.
  if (!/^\d+$/.test(raw)) return DEFAULT_RETENTION_DAYS;
  return Number(raw);
}

// True only for a regular file whose first HEADER_SCAN_BYTES carry the
// header line, read through the no-follow, non-blocking fd. Any error: false
// (never prune what cannot be proven to be a loop report).
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

function pruneReports(dir, keepNames, env = process.env) {
  const days = retentionDays(env);
  if (days === 0) return;
  const cutoff = Date.now() - days * DAY_MS;
  let handle;
  try {
    handle = fs.opendirSync(dir);
    for (let i = 0; i < PRUNE_SCAN_LIMIT; i += 1) {
      const ent = handle.readSync();
      if (!ent) break;
      if (keepNames.has(ent.name) || !ent.name.endsWith(".md")) continue;
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

// The primer's entry: prune this session's report dir, keeping its three
// files. File mode with a usable session_id and dir only (reportPaths null =>
// nothing). Never throws.
function pruneForSession(sessionId, env = process.env) {
  try {
    const paths = reportPaths(sessionId, env);
    if (!paths) return;
    const keep = new Set(Object.values(paths).map((p) => path.basename(p)));
    pruneReports(path.dirname(paths.final), keep, env);
  } catch (_e) {
    /* best-effort */
  }
}

module.exports = {
  REPORT_KINDS,
  MAX_REPORT_BYTES,
  REPORT_OPEN_FLAGS,
  fileMode,
  reportDir,
  sessionFileBase,
  reportPath,
  reportPaths,
  readReportText,
  isLoopReport,
  pruneReports,
  pruneForSession,
};
