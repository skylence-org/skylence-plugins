/**
 * Fork / branch scoping for transcript scans (1.5.38, audit I3), shared by
 * the loop gate and the skylore deposit hook.
 *
 * `claude --fork-session` (measured live on Claude Code 2.1.332) gives the
 * fork a NEW session_id. Its transcript then holds:
 *  - header lines, among them
 *    `{"type":"derived-from","sessions":[{"id":<parent>,"via":"fork"}]}`;
 *  - every parent entry, copied with its original `uuid` and rewritten to the
 *    new sessionId, Skill and commit tool_use included;
 *  - then the fork's own entries.
 * A scan keyed on session_id would see the parent's history as its own. The
 * derived-from marker comes BEFORE the copied entries, so "after the marker"
 * scopes nothing. Instead, the parent transcript (`<parent id>.jsonl` next to
 * this one) supplies the inherited uuids. The inherited block starts at the
 * first line carrying one of them, and the session's own entries start at the
 * first uuid-bearing line after that whose uuid is NOT one of them. A parent
 * uuid seen again later never hides the session's own entries.
 *
 * `/branch` (bounce 1 Minor 3; a RECONSTRUCTION from the 2.1.332 bundle, not
 * verified live): the copied entries keep their uuid and carry
 * `forkedFrom: {sessionId: <parent>, messageUuid}`; a `via: "branch"` marker
 * follows the copies, and only when data flow is on. So `via` "fork" and
 * "branch" both name a parent (never this session's own id: the bundle also
 * writes `resume` / `compact` entries that name the session itself), and the
 * forkedFrom stamps scope on their own, with no parent read: own entries
 * start at the first uuid-bearing line after the first stamped one that has
 * no foreign stamp. The later of the two starts wins.
 *
 * The parent is read only when such a marker names it, only as
 * `<dirname(transcript_path)>/<id>.jsonl` with an id in [A-Za-z0-9._-] (never
 * "." / ".."), and only as a regular file: lstat rejects a symlink, a FIFO or
 * a directory before any open, and the read goes through a no-follow,
 * non-blocking fd (bounce 1 nit 5: a FIFO there hung the Stop hook).
 *
 * Nothing to skip => start 0 (the whole transcript): no marker and no stamp,
 * an unusable parent id, a parent that cannot be read, or no uuid overlap.
 * That is the pre-1.5.38 behaviour, so a missing parent never hides this
 * session's own entries. `inherited` says a marker or stamp was there; with
 * start 0 the session is inherited but UNSCOPED, and the gate keeps the
 * 1.5.37 session-wide block budget for it (bounce 1 Minor 2). Never throws.
 */

const fs = require("fs");
const path = require("path");
const { REPORT_OPEN_FLAGS } = require("./loop-report-path");

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SCOPED_VIA = new Set(["fork", "branch"]);
// Far above any real transcript (the largest on the dev box: 72 MB); a
// larger parent is left unread (unscoped) rather than slurped into a hook.
const MAX_PARENT_BYTES = 512 * 1024 * 1024;

function parse(line) {
  try {
    return JSON.parse(line);
  } catch (_e) {
    return null;
  }
}

// Every id a fork / branch marker names, except this session's own.
function markerIds(lines, ownId) {
  const ids = [];
  for (const line of lines) {
    if (!line.includes('"derived-from"')) continue; // cheap prefilter, then parse
    const e = parse(line);
    if (!e || e.type !== "derived-from" || !Array.isArray(e.sessions)) continue;
    for (const s of e.sessions) {
      if (s && SCOPED_VIA.has(s.via) && typeof s.id === "string" && s.id !== ownId) ids.push(s.id);
    }
  }
  return ids;
}

// The marker-named parent ids that may be resolved to a file.
function forkParents(lines, ownId) {
  return markerIds(lines, ownId).filter((id) => SAFE_ID.test(id) && id !== "." && id !== "..");
}

// Text of a regular file, or null: never follows a symlink, never opens a
// FIFO or a directory, never blocks.
function readRegularFile(p) {
  let fd;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size === 0 || st.size > MAX_PARENT_BYTES) return null;
    fd = fs.openSync(p, REPORT_OPEN_FLAGS);
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > MAX_PARENT_BYTES) return null;
    const buf = Buffer.alloc(fst.size);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
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

function uuidsOf(file, out) {
  const text = readRegularFile(file);
  if (!text) return out;
  for (const line of text.split("\n")) {
    if (!line.includes('"uuid"')) continue;
    const e = parse(line);
    if (e && typeof e.uuid === "string") out.add(e.uuid);
  }
  return out;
}

// First own line after an inherited block, where isInherited(entry) marks
// the block; 0 when no entry is inherited, lines.length when all are.
function blockEnd(lines, isInherited) {
  let begun = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('"uuid"')) continue;
    const e = parse(lines[i]);
    if (!e || typeof e.uuid !== "string") continue;
    if (isInherited(e)) begun = true;
    else if (begun) return i;
  }
  return begun ? lines.length : 0;
}

// { start, inherited } for `lines` (the transcript split on "\n"): start is
// the index of the first line that belongs to this session itself.
function scopeOf(lines, transcriptPath) {
  try {
    if (!Array.isArray(lines) || typeof transcriptPath !== "string" || !transcriptPath) return { start: 0, inherited: false };
    const ownId = path.basename(transcriptPath, ".jsonl");
    const ids = markerIds(lines, ownId);
    const stampParents = new Set();
    const stamped = lines.some((l) => l.includes('"forkedFrom"'))
      ? blockEnd(lines, (e) => {
          const ff = e.forkedFrom;
          const yes = !!ff && typeof ff === "object" && typeof ff.sessionId === "string" && ff.sessionId !== ownId;
          if (yes) stampParents.add(ff.sessionId);
          return yes;
        })
      : 0;
    let start = stamped;
    const dir = path.dirname(transcriptPath);
    const byParent = new Map();
    for (const id of forkParents(lines, ownId)) byParent.set(id, uuidsOf(path.join(dir, `${id}.jsonl`), new Set()));
    const inheritedUuids = new Set();
    for (const set of byParent.values()) for (const u of set) inheritedUuids.add(u);
    if (inheritedUuids.size) start = Math.max(start, blockEnd(lines, (e) => inheritedUuids.has(e.uuid)));
    // Markers list every ancestor, oldest first, the immediate parent last
    // (live fork-of-fork; bundle kRr / se append). Only the immediate parent
    // covers the whole inherited history: when it is neither read with a uuid
    // overlap nor named by the forkedFrom stamps, an older ancestor's uuids or
    // stamps end the block INSIDE the parent's own inherited entries (a
    // build the session never did). Unscoped then, like any unreadable parent.
    if (ids.length) {
      const imm = ids[ids.length - 1];
      const immUuids = byParent.get(imm);
      const immRead = !!immUuids && immUuids.size > 0 && blockEnd(lines, (e) => immUuids.has(e.uuid)) > 0;
      if (!immRead && !stampParents.has(imm)) start = 0;
    }
    return { start, inherited: ids.length > 0 || stamped > 0 };
  } catch (_e) {
    return { start: 0, inherited: false };
  }
}

function ownStart(lines, transcriptPath) {
  return scopeOf(lines, transcriptPath).start;
}

module.exports = { ownStart, scopeOf, forkParents };
