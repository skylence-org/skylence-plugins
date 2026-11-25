// node:test for transcript-scope.js (1.5.38, audit I3: fork scoping).
// Run with: node --test plugins/skyline-claude/hooks/transcript-scope.test.js
// Self-contained: every test writes its transcripts under its own mkdtemp dir.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ownStart, forkParents } = require("./transcript-scope");

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-scope-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const j = (o) => JSON.stringify(o);
const marker = (id, via = "fork") => j({ type: "derived-from", v: 1, sessionId: "fork", sessions: [{ type: "claude_code_session", id, via }] });
const entry = (uuid, text = "x") => j({ type: "assistant", uuid, sessionId: "fork", message: { content: [{ type: "text", text }] } });

// Live shape (Claude Code 2.1.332): header with the marker, the parent's
// entries copied with their uuids, then the fork's own entries.
function forkLines(parentId) {
  return [j({ type: "mode", mode: "normal" }), marker(parentId), j({ type: "queue-operation", operation: "enqueue" }), entry("p1"), entry("p2"), entry("p3"), entry("f1"), entry("f2")];
}

test("no derived-from marker: 0 (the whole transcript)", (t) => {
  const d = tmpDir(t);
  const lines = [entry("a"), entry("b")];
  assert.equal(ownStart(lines, path.join(d, "s.jsonl")), 0);
});

test("fork with the parent transcript present: own entries start after the last inherited uuid", (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, "parent-1.jsonl"), [entry("p1"), entry("p2"), entry("p3")].join("\n") + "\n");
  const lines = forkLines("parent-1");
  assert.equal(ownStart(lines, path.join(d, "fork.jsonl")), 6);
});

test("parent transcript missing, or no uuid overlap: 0 (pre-1.5.38 behaviour)", (t) => {
  const d = tmpDir(t);
  assert.equal(ownStart(forkLines("gone"), path.join(d, "fork.jsonl")), 0);
  fs.writeFileSync(path.join(d, "other.jsonl"), entry("zzz") + "\n");
  assert.equal(ownStart(forkLines("other"), path.join(d, "fork.jsonl")), 0);
});

test("the parent is resolved only as <id>.jsonl in the transcript's own dir; unsafe ids are never read", (t) => {
  const d = tmpDir(t);
  fs.mkdirSync(path.join(d, "sub"));
  fs.writeFileSync(path.join(d, "sub", "p.jsonl"), [entry("p1"), entry("p2"), entry("p3")].join("\n") + "\n");
  for (const id of ["sub/p", "../p", "..", ".", "a b", ""]) {
    assert.equal(ownStart(forkLines(id), path.join(d, "fork.jsonl")), 0, JSON.stringify(id));
  }
  assert.deepEqual(forkParents([marker("ok.id-1"), marker("x", "resume"), marker("../y")]), ["ok.id-1"]);
});

test("garbage lines, a non-array, a missing transcript path: 0, never throws", (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, "parent-2.jsonl"), entry("p1") + "\n");
  const lines = ["{not json", marker("parent-2"), "null", entry("p1"), entry("own")];
  assert.equal(ownStart(lines, path.join(d, "fork.jsonl")), 4);
  assert.equal(ownStart("not an array", path.join(d, "fork.jsonl")), 0);
  assert.equal(ownStart(lines, undefined), 0);
});

test("own entries start at the first non-parent uuid after the inherited block: a parent uuid seen again later hides nothing", (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, "parent-3.jsonl"), [entry("p1"), entry("p2")].join("\n") + "\n");
  const lines = [marker("parent-3"), entry("p1"), entry("p2"), entry("own-1"), entry("own-2"), entry("p1"), entry("own-3")];
  assert.equal(ownStart(lines, path.join(d, "fork.jsonl")), 3);
  // Only inherited entries so far (the fork has not answered yet): nothing is own.
  assert.equal(ownStart([marker("parent-3"), entry("p1"), entry("p2")], path.join(d, "fork.jsonl")), 3);
});

// --- bounce 1: /branch (Minor 3), unreadable parents (Minor 2, nit 5) ---------
const { scopeOf } = require("./transcript-scope");
const { spawnSync } = require("node:child_process");
const stamped = (uuid, parent) => j({ type: "assistant", uuid, sessionId: "br", forkedFrom: { sessionId: parent, messageUuid: uuid }, message: { content: [] } });

test("via fork and branch name a parent; resume / compact entries and the session's own id never do", () => {
  const lines = [marker("p-fork"), marker("p-branch", "branch"), marker("p-resume", "resume"), marker("p-compact", "compact"), marker("self")];
  assert.deepEqual(forkParents(lines, "self"), ["p-fork", "p-branch"]);
});

test("/branch forkedFrom stamps scope with no marker and no parent file; a stamp naming this session is not inherited", (t) => {
  const d = tmpDir(t);
  const br = path.join(d, "br.jsonl");
  const lines = [stamped("p1", "par"), stamped("p2", "par"), entry("own-1"), entry("own-2")];
  assert.deepEqual(scopeOf(lines, br), { start: 2, inherited: true });
  assert.deepEqual(scopeOf([stamped("x1", "br"), entry("own-1")], br), { start: 0, inherited: false });
});

test("inherited but unscoped (marker, parent missing) is reported as such; no marker is not inherited", (t) => {
  const d = tmpDir(t);
  assert.deepEqual(scopeOf(forkLines("gone"), path.join(d, "fork.jsonl")), { start: 0, inherited: true });
  assert.deepEqual(scopeOf(forkLines("sub/unsafe"), path.join(d, "fork.jsonl")), { start: 0, inherited: true });
  assert.deepEqual(scopeOf([entry("a")], path.join(d, "s.jsonl")), { start: 0, inherited: false });
});

test("nit 5: a symlinked parent transcript is never followed", (t) => {
  if (process.platform === "win32") return t.skip("symlinks need a privilege on Windows");
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, "real.jsonl"), [entry("p1"), entry("p2"), entry("p3")].join("\n") + "\n");
  fs.symlinkSync(path.join(d, "real.jsonl"), path.join(d, "linked.jsonl"));
  assert.equal(ownStart(forkLines("linked"), path.join(d, "fork.jsonl")), 0);
  assert.equal(ownStart(forkLines("real"), path.join(d, "fork.jsonl")), 6, "the same file read directly does scope");
});

test("nit 5: a FIFO at the parent path never hangs the hook (checked in a child with a 5 s timeout)", (t) => {
  if (process.platform === "win32") return t.skip("no mkfifo on Windows");
  const d = tmpDir(t);
  const mk = spawnSync("mkfifo", [path.join(d, "fifo.jsonl")]);
  if (mk.status !== 0) return t.skip("mkfifo unavailable");
  const script = `const { ownStart } = require(${JSON.stringify(path.join(__dirname, "transcript-scope.js"))}); const j = JSON.stringify;
const lines = [j({ type: "derived-from", sessions: [{ id: "fifo", via: "fork" }] }), j({ type: "assistant", uuid: "p1", message: { content: [] } })];
process.stdout.write(String(ownStart(lines, ${JSON.stringify(path.join(d, "fork.jsonl"))})));`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5000 });
  assert.equal(r.signal, null, "the read did not hang");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "0");
});
