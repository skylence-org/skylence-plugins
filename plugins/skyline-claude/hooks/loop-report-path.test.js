// node:test for loop-report-path.js (1.5.37): the ONE report-path helper the
// loop gate, the primer and the skylore deposit hook share.
// Run with: node --test plugins/skyline-claude/hooks/loop-report-path.test.js
//
// Expected names are written from the rule (sidName below), never imported
// from the helper, so a drift in the helper cannot also move the oracle.
// Hermetic: every call passes its own env; temp dirs are removed in t.after.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const helper = require("./loop-report-path");
const GATE = path.resolve(__dirname, "skyline-loop-gate.js");

const UUID = "0679640f-35d5-435b-8e6a-562c61d7bf1f";
const LONG = "x".repeat(300);

function sidName(raw) {
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return clean === raw ? clean : `${clean}-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

function tmpDir(t, tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lrp-${tag}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("sessionFileBase: UUID unchanged, a/b and a 300-char id hash-suffixed, '.', '..', '' and non-strings unusable", () => {
  assert.equal(helper.sessionFileBase(UUID), UUID);
  assert.equal(helper.sessionFileBase("a/b"), sidName("a/b"));
  assert.match(helper.sessionFileBase("a/b"), /^a_b-[0-9a-f]{8}$/);
  assert.equal(helper.sessionFileBase(LONG), sidName(LONG));
  assert.equal(helper.sessionFileBase(LONG).length, 128 + 1 + 8);
  for (const bad of [".", "..", "", null, undefined, 42, {}]) {
    assert.equal(helper.sessionFileBase(bad), null, `unusable: ${String(bad)}`);
  }
});

test("reportPath: final <base>.md, debug <base>.debug.md, review <base>.review.md; unknown kind null", (t) => {
  const dir = tmpDir(t, "kinds");
  const env = { SKYLINE_LOOP_REPORT_DIR: dir };
  for (const raw of [UUID, "a/b", LONG]) {
    const base = sidName(raw);
    assert.equal(helper.reportPath(raw, "final", env), path.join(dir, `${base}.md`));
    assert.equal(helper.reportPath(raw, "debug", env), path.join(dir, `${base}.debug.md`));
    assert.equal(helper.reportPath(raw, "review", env), path.join(dir, `${base}.review.md`));
    assert.deepEqual(helper.reportPaths(raw, env), {
      final: path.join(dir, `${base}.md`),
      debug: path.join(dir, `${base}.debug.md`),
      review: path.join(dir, `${base}.review.md`),
    });
  }
  for (const kind of ["FINAL", "", "toString", "__proto__", undefined]) {
    assert.equal(helper.reportPath(UUID, kind, env), null, `kind ${String(kind)}`);
  }
  assert.equal(helper.reportPath(".", "final", env), null);
  assert.equal(helper.reportPaths(".", env), null);
});

test("reportPath: chat mode and no home dir give null; a relative SKYLINE_LOOP_REPORT_DIR is ignored as if unset", (t) => {
  const home = tmpDir(t, "home");
  const def = path.join(home, ".skylence", "skyline", "loop-reports");
  assert.equal(helper.reportPath(UUID, "debug", { SKYLINE_LOOP_REPORT: "chat", HOME: home }), null);
  assert.equal(helper.reportPaths(UUID, { SKYLINE_LOOP_REPORT: "chat", HOME: home }), null);
  for (const mode of [undefined, "file", "Chat", " chat"]) {
    assert.equal(helper.reportPath(UUID, "final", { SKYLINE_LOOP_REPORT: mode, HOME: home }), path.join(def, `${UUID}.md`), `mode ${mode}`);
  }
  assert.equal(helper.reportPath(UUID, "final", {}), null, "no HOME / USERPROFILE");
  assert.equal(helper.reportPath(UUID, "review", { USERPROFILE: home }), path.join(def, `${UUID}.review.md`));
  for (const rel of ["rel-reports", "."]) {
    assert.equal(helper.reportPath(UUID, "final", { SKYLINE_LOOP_REPORT_DIR: rel, HOME: home }), path.join(def, `${UUID}.md`));
  }
});

test("readReportText: regular file text; symlink, empty, oversized, directory and missing paths give null", (t) => {
  const dir = tmpDir(t, "read");
  const ok = path.join(dir, "ok.md");
  fs.writeFileSync(ok, "loop-report: v1\nskylore: nothing durable\n");
  assert.equal(helper.readReportText(ok), "loop-report: v1\nskylore: nothing durable\n");
  const empty = path.join(dir, "empty.md");
  fs.writeFileSync(empty, "");
  assert.equal(helper.readReportText(empty), null);
  const big = path.join(dir, "big.md");
  fs.writeFileSync(big, "x".repeat(helper.MAX_REPORT_BYTES + 1));
  assert.equal(helper.readReportText(big), null);
  const cap = path.join(dir, "cap.md");
  fs.writeFileSync(cap, "x".repeat(helper.MAX_REPORT_BYTES));
  assert.equal(helper.readReportText(cap).length, helper.MAX_REPORT_BYTES, "exactly the cap reads");
  assert.equal(helper.readReportText(dir), null, "directory");
  assert.equal(helper.readReportText(path.join(dir, "missing.md")), null);
  let linked = true;
  try {
    fs.symlinkSync(ok, path.join(dir, "link.md"));
  } catch (_e) {
    linked = false; // Windows without the symlink privilege
  }
  if (linked) assert.equal(helper.readReportText(path.join(dir, "link.md")), null, "symlink rejected");
});

// Q1 (gate side): the loop gate names exactly the helper's FINAL path. Commit
// mode is used because it writes no block counter (stop mode would bump
// counters in os.tmpdir(), some of which already exist for a/b from older runs).
test("Q1: the loop gate's commit reminder names the helper's FINAL path for a UUID, a/b and a 300-char id; '.' names none", (t) => {
  const dir = tmpDir(t, "gate");
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "feature-loop-skill" } }] },
    }) + "\n"
  );
  const reports = path.join(dir, "reports");
  const env = { ...process.env, SKYLINE_LOOP_REPORT_DIR: reports };
  delete env.SKYLINE_LOOP_REPORT;
  const named = (sid) => {
    const res = spawnSync(process.execPath, [GATE, "commit"], {
      encoding: "utf8",
      env,
      input: JSON.stringify({
        transcript_path: transcript,
        session_id: sid,
        tool_name: "mcp__skyline__git_commit",
        tool_input: { subcommand: "commit" },
      }),
    });
    assert.equal(res.status, 0, res.stderr);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    const m = ctx.match(/write the full FINAL report to `([^`]+)`/);
    return m ? m[1] : null;
  };
  for (const raw of [UUID, "a/b", LONG]) {
    assert.equal(named(raw), path.join(reports, `${sidName(raw)}.md`), raw.slice(0, 20));
    assert.equal(named(raw), helper.reportPath(raw, "final", { SKYLINE_LOOP_REPORT_DIR: reports }));
  }
  assert.equal(named("."), null, "'.' is unusable: legacy reminder, no path");
  assert.equal(fs.existsSync(reports), false, "commit mode never creates the report dir");
});

test("the gate still exports sanitizeSessionId, and it is the helper's sessionFileBase", () => {
  const gate = require(GATE);
  assert.equal(gate.sanitizeSessionId, helper.sessionFileBase);
  assert.equal(gate.MAX_REPORT_BYTES, helper.MAX_REPORT_BYTES);
});

// Q1 (both sides): the paths the primer INJECTS equal the path the loop gate
// NAMES (commit mode) for the same session_id, and debug/review follow the
// per-kind rule. Both hooks spawned, nothing imported from the helper.
test("Q1: primer-injected paths equal the gate's paths for a UUID, a/b and a 300-char id; '.' gives neither a path", (t) => {
  const dir = tmpDir(t, "q1");
  const reports = path.join(dir, "reports");
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "feature-loop-skill" } }] },
    }) + "\n"
  );
  // SKYLINE_PRIMER_NO_DAEMON_CHECK: the primer must not probe the live :7333.
  const env = {
    ...process.env,
    SKYLINE_LOOP_REPORT_DIR: reports,
    SKYLORE_DB: path.join(dir, "no-bank.db"),
    SKYLINE_PRIMER_NO_DAEMON_CHECK: "1",
  };
  delete env.SKYLINE_LOOP_REPORT;
  const spawnHook = (file, args, input) => {
    const res = spawnSync(process.execPath, [path.resolve(__dirname, file), ...args], {
      encoding: "utf8",
      env,
      input: JSON.stringify(input),
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  };
  const primerPaths = (sid) => {
    const ctx = spawnHook("skyline-primer.js", [], { cwd: dir, session_id: sid, source: "compact" });
    const m = ctx.match(/feature FINAL `([^`]+)`, debug REPORT `([^`]+)`, review evidence `([^`]+)`/);
    return m ? { final: m[1], debug: m[2], review: m[3] } : null;
  };
  const gatePath = (sid) => {
    const ctx = spawnHook("skyline-loop-gate.js", ["commit"], {
      transcript_path: transcript,
      session_id: sid,
      tool_name: "mcp__skyline__git_commit",
      tool_input: { subcommand: "commit" },
    });
    const m = ctx.match(/write the full FINAL report to `([^`]+)`/);
    return m ? m[1] : null;
  };
  for (const raw of [UUID, "a/b", LONG]) {
    const base = path.join(reports, sidName(raw));
    const p = primerPaths(raw);
    assert.deepEqual(p, { final: `${base}.md`, debug: `${base}.debug.md`, review: `${base}.review.md` }, raw.slice(0, 20));
    assert.equal(gatePath(raw), p.final, `${raw.slice(0, 20)}: primer and gate agree on the FINAL path`);
  }
  assert.equal(primerPaths("."), null);
  assert.equal(gatePath("."), null);
});
