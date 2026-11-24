// node:test for skyline-loop-gate.js (field case 2026-07-26: Stop-gate
// re-demanded a FULL attestation on a post-build DEBRIEF turn after FINAL had
// already been given that session).
// Run with: node --test plugins/skyline-claude/hooks/skyline-loop-gate.test.js
//
// Covers:
//   (a) no real feature-loop-skill invocation this session -> Stop passes
//       silently, INCLUDING the deeper bug found while fixing this: the
//       ambient available-skills listing names feature-loop-skill in every
//       session, so a bare substring test false-positives on ANY committing
//       session, not just build sessions.
//   (b) FINAL attestation given earlier this session -> a later Stop (e.g. a
//       debrief turn with no attestation in its own text) passes silently,
//       with a paired fixture that blocks when the earlier attestation is
//       absent.
//   (c) genuine in-build Stop with no attestation ever emitted keeps
//       blocking, with the 1.5.22+ "COPY the live CHECKPOINT lines" demand
//       text, and the MAX_BLOCKS fail-open still holds.
//   Detector precision: prose that only discusses "advisor checkpoints" and
//   "deviations" (no literal CHECKPOINT: line) does not satisfy the gate;
//   invoking a DIFFERENT skill (debug-loop-skill) does not count as
//   feature-loop-skill invocation even alongside the ambient listing.
//
// Self-contained; each test writes its own transcript file under a fresh
// temp dir and uses a unique session_id (os.tmpdir() ignores TMPDIR on
// Windows, so isolation is via session_id, not env).

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.resolve(__dirname, "skyline-loop-gate.js");

// Hermetic default for every spawn in this file that does not build its own
// env (the pre-1.5.35 tests): file mode is the default since 1.5.35, so point
// the report dir at a fresh, never-created temp path instead of the real
// ~/.skylence. The 1.5.35 tests at the bottom set every SKYLINE_LOOP_REPORT*
// var explicitly (hookEnv).
const SHARED_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loop-gate-shared-"));
process.env.SKYLINE_LOOP_REPORT_DIR = path.join(SHARED_TMP, "reports");
after(() => fs.rmSync(SHARED_TMP, { recursive: true, force: true }));

let seq = 0;
function uniqueSessionId(tag) {
  seq += 1;
  return `lg-test-${tag}-${process.pid}-${Date.now()}-${seq}`;
}

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-gate-test-"));
}

function line(entry) {
  return JSON.stringify(entry);
}

// Ambient system-reminder every session carries: lists every installed
// skill by name, including feature-loop-skill, whether or not it was ever
// invoked. This is the false-positive source found while fixing the bug.
function skillListingLine() {
  return line({
    type: "attachment",
    attachment: {
      type: "skill_listing",
      content:
        "- skyline-claude:feature-loop-skill: FIRST ACTION of implementation work...\n- skyline-claude:debug-loop-skill: FIRST ACTION of fix work...",
      skillCount: 2,
      isInitial: true,
      names: ["skyline-claude:feature-loop-skill", "skyline-claude:debug-loop-skill"],
    },
  });
}

function assistantText(text) {
  return line({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

// Real invocation shape (verified against session
// a5bae5ae-914a-411d-acad-60ead2234e28.jsonl:18-20): a Skill tool_use call
// is ALWAYS followed by a "Launching skill: <arg>" tool_result (type
// "user"), then the skill's full body auto-injected as a "Base directory
// for this skill: ..." message (also type "user", isMeta:true). bodyText
// defaults to a snippet mirroring feature-loop-skill/SKILL.md's real
// "...git_commit green slice" line -- the exact literal substring that
// used to false-positive the old whole-transcript commit check
// (Finding 1, review bounce todo 69 c245).
function assistantSkillInvoke(skillArg, bodyText) {
  const toolUseId = `toolu_${skillArg.replace(/[^a-z0-9]/gi, "")}`;
  const injectedBody =
    bodyText !== undefined
      ? bodyText
      : "SLICE CYCLE (repeat per slice):\n  generate/locate -> edit(anchors) -> diagnostics(batch) -> test -> format+commit\n  checkpoint: formatter via run -> git_commit green slice (rollback points)\n";
  return [
    line({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: toolUseId, name: "Skill", input: { skill: skillArg } },
        ],
      },
    }),
    line({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: `Launching skill: ${skillArg}` },
        ],
      },
    }),
    line({
      type: "user",
      isMeta: true,
      message: {
        content: [
          { type: "text", text: `Base directory for this skill: /skills/${skillArg}\n\n${injectedBody}` },
        ],
      },
    }),
  ].join("\n");
}

function assistantGitCommit() {
  return line({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "mcp__skyline__git_commit",
          input: { subcommand: "commit", args: ["-m", "wip"] },
        },
      ],
    },
  });
}

function writeTranscript(dir, entries) {
  const p = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(p, entries.join("\n") + "\n");
  return p;
}

function runStop(transcriptPath, sessionId) {
  const res = spawnSync(process.execPath, [HOOK, "stop"], {
    encoding: "utf8",
    input: JSON.stringify({ transcript_path: transcriptPath, session_id: sessionId }),
  });
  return { code: res.status, err: res.stderr || "", out: res.stdout || "" };
}

function runCommit(transcriptPath, sessionId, toolName, toolInput) {
  const res = spawnSync(process.execPath, [HOOK, "commit"], {
    encoding: "utf8",
    input: JSON.stringify({
      transcript_path: transcriptPath,
      session_id: sessionId,
      tool_name: toolName,
      tool_input: toolInput,
    }),
  });
  return { code: res.status, out: res.stdout || "" };
}

const FINAL_ATTESTATION_TEXT =
  "FINAL report:\nslices shipped: 1 (abc123)\ntest counts: 4 passed\nadvisor checkpoints:\nCHECKPOINT: post-model = done\nCHECKPOINT: pre-final = done\ndeviations: None";

// --- (a) no real build activity -> Stop passes silently --------------------

test("(a) no skill invocation, no commit: Stop passes silently", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [skillListingLine(), assistantText("just chatting")]);
  const { code, err } = runStop(t, uniqueSessionId("a1"));
  assert.equal(code, 0);
  assert.equal(err, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("(a) ambient skill listing + a commit but feature-loop-skill NEVER invoked: Stop passes silently (the deeper bug)", () => {
  const tmp = freshTmp();
  // The listing alone used to satisfy the old substring-based skillInvoked(),
  // false-positiving on any committing session. No Skill tool_use here.
  const t = writeTranscript(tmp, [
    skillListingLine(),
    assistantGitCommit(),
    assistantText("done, committed"),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("a2"));
  assert.equal(code, 0, "must not gate a session that never invoked feature-loop-skill");
  assert.equal(err, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("(a) feature-loop-skill invoked but no commit-shaped call: Stop passes silently", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantText("orienting, nothing committed yet"),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("a3"));
  assert.equal(code, 0);
  assert.equal(err, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("invoking a DIFFERENT skill (debug-loop-skill) does not count as feature-loop-skill invocation", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    skillListingLine(),
    assistantSkillInvoke("debug-loop-skill"),
    assistantGitCommit(),
    assistantText("fixed it"),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("other-skill"));
  assert.equal(code, 0);
  assert.equal(err, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- (b) FINAL given earlier this session -> later Stops pass silently -----

test("(b) FINAL attestation emitted earlier, later debrief turn has no attestation: Stop passes silently", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText(FINAL_ATTESTATION_TEXT),
    // Post-build debrief turn: no CHECKPOINT/deviation text at all.
    assistantText("Sure, here is a plain-English recap of what shipped."),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("b-pass"));
  assert.equal(code, 0, "attestation given earlier must satisfy a later Stop");
  assert.equal(err, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("(b) paired fixture: same shape but the earlier FINAL attestation is absent: Stop still blocks", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText("Shipped the slice, moving on."),
    assistantText("Sure, here is a plain-English recap of what shipped."),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("b-block"));
  assert.equal(code, 2, "no attestation anywhere this session must still block");
  assert.match(err, /FINAL attestation missing/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- (c) genuine in-build stop keeps blocking, with 1.5.22+ demand text ----

test("(c) in-build stop with no attestation: blocks with the COPY-the-CHECKPOINT-lines demand", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText("still working on the next slice"),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("c-demand"));
  assert.equal(code, 2);
  assert.match(err, /COPY the live CHECKPOINT lines/);
  assert.doesNotMatch(err, /EACH stated as done or skipped\+reason/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("(c) MAX_BLOCKS fail-open: blocks twice, then passes on the third Stop of the same session", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText("still working"),
  ]);
  const sid = uniqueSessionId("c-maxblocks");
  const r1 = runStop(t, sid);
  const r2 = runStop(t, sid);
  const r3 = runStop(t, sid);
  assert.equal(r1.code, 2, "block 1");
  assert.equal(r2.code, 2, "block 2");
  assert.equal(r3.code, 0, "fail-open on the 3rd Stop so a wedged model cannot loop forever");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), `skyline-loop-gate-${sid}`), { force: true });
});

// --- detector precision: prose mention is not a CHECKPOINT line ------------

test("mentioning 'advisor checkpoints' and 'deviations' in prose (no literal CHECKPOINT line) does not satisfy the gate", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText(
      "Plan: I will hit the advisor checkpoints at the usual points and report deviations at the end."
    ),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("prose-mention"));
  assert.equal(code, 2, "a plan that only discusses checkpoints/deviations must not disarm the gate");
  assert.match(err, /FINAL attestation missing/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- Finding 1 & Finding 2 regressions (review bounce todo 69 c245) --------

test("Finding 1 repro: skill's own auto-injected body contains literal 'git_commit' text, zero real commit tool_use: Stop passes silently", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantText("Orienting now, nothing built or committed yet this session."),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("finding1-repro"));
  assert.equal(
    code,
    0,
    "the skill's own auto-injected instructional text must never satisfy the commit-activity check"
  );
  assert.equal(err, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Finding 2 repro: message quotes an illustrative CHECKPOINT line while explaining the format, no real slices/test-count data: Stop still blocks", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText(
      "Sure, happy to recap what the format looks like. A CHECKPOINT line during a real build would read:\nCHECKPOINT: post-model = done\nCHECKPOINT: pre-final = done\nI didn't actually run either checkpoint this turn, and there are no deviations to report from this explanation itself."
    ),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("finding2-repro"));
  assert.equal(
    code,
    2,
    "a message that only quotes an illustrative CHECKPOINT line, with no slices-shipped/test-count data, must not satisfy attestation"
  );
  assert.match(err, /FINAL attestation missing/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("positive fixture: FINAL in the skill's prescribed tree shape (SKILL.md FINAL:48-54) satisfies attestation: Stop passes silently", () => {
  const tmp = freshTmp();
  const finalTreeText =
    "FINAL:\n" +
    "├─ SIZE tier: MEDIUM, standard build\n" +
    "├─ slices shipped + commit ids: 1 slice, commit a1b2c3d\n" +
    "├─ test counts (passed/assertions): 16 passed, 0 failed\n" +
    "├─ advisor checkpoints:\n" +
    "CHECKPOINT: post-model = done\n" +
    "CHECKPOINT: pre-final = done\n" +
    "└─ deviations from this skill: None";
  const t = writeTranscript(tmp, [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText(finalTreeText),
  ]);
  const { code, err } = runStop(t, uniqueSessionId("final-tree-shape"));
  assert.equal(code, 0, "a FINAL in the skill's own prescribed field shape must satisfy attestation");
  assert.equal(err, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- commit mode: shares the same invocation detector -----------------------

test("commit mode: reminder fires when feature-loop-skill was really invoked", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [assistantSkillInvoke("feature-loop-skill")]);
  const { code, out } = runCommit(t, uniqueSessionId("commit-fires"), "mcp__skyline__git_commit", {
    subcommand: "commit",
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /ADVISOR GATE/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("commit mode: stays silent when feature-loop-skill was never invoked (ambient listing only)", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [skillListingLine(), assistantText("hello")]);
  const { code, out } = runCommit(t, uniqueSessionId("commit-silent"), "mcp__skyline__git_commit", {
    subcommand: "commit",
  });
  assert.equal(code, 0);
  assert.equal(out, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("commit mode: non-commit-shaped tool call exits before any transcript read", () => {
  const tmp = freshTmp();
  const t = writeTranscript(tmp, [assistantSkillInvoke("feature-loop-skill")]);
  const { code, out } = runCommit(t, uniqueSessionId("commit-noncommit"), "mcp__skyline__run", {
    argv: ["ls"],
  });
  assert.equal(code, 0);
  assert.equal(out, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- fail-open --------------------------------------------------------------

test("missing transcript_path fails open (exit 0, no output)", () => {
  const res = spawnSync(process.execPath, [HOOK, "stop"], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: uniqueSessionId("no-transcript") }),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
});

test("malformed stdin fails open (exit 0, no output)", () => {
  const res = spawnSync(process.execPath, [HOOK, "stop"], {
    encoding: "utf8",
    input: "{not json",
  });
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
});

// --- 1.5.35: FINAL goes to a report file, chat gets one line ---------------
//
// Every spawn below builds its env explicitly (hookEnv): the three
// SKYLINE_LOOP_REPORT* vars are deleted first, then set per test, so this
// file is green both bare and under SKYLINE_LOOP_REPORT=chat. Each test owns
// a report dir under a fresh mkdtemp and a unique session id, cleans up its
// block counters, and never touches the real ~/.skylence.

// Literals copied from the pre-1.5.35 source (origin/main 3265a42,
// skyline-loop-gate.js:215 and :231). Chat mode must emit exactly these.
const LEGACY_COMMIT_CONTEXT =
  "feature-loop-skill ADVISOR GATE: slice just committed. If that was the model slice or the first user-facing surface, consult the advisor NOW, before the next slice. Every checkpoint must appear in FINAL as done or skipped+reason.";
const LEGACY_STOP_MESSAGE =
  "feature-loop-skill FINAL attestation missing. Before ending: produce the mandatory FINAL report — slices shipped + commit ids; test counts; advisor checkpoints: COPY the live CHECKPOINT lines emitted during build, one per [post-model / post-first-surface / pre-final] — do not restate or reconstruct them from memory; a checkpoint with no CHECKPOINT line emitted must be said so and declared a deviation; deviations from the skill, where \"None\" is permitted only if every rule was followed as written.";

const MAX_REPORT_BYTES = 262144;
const DAY_MS = 24 * 60 * 60 * 1000;

// Report in the shape feature-loop-skill/SKILL.md prescribes (1.5.35).
const VALID_REPORT = [
  "# feature-loop FINAL",
  "loop-report: v1",
  "repo: /work/repo",
  "branch: feat/x",
  "date: 2026-11-24T15:00:00Z",
  "├─ SIZE tier chosen + why: standard, 3 slices",
  "├─ slices shipped + commit ids: 3 slices, a1b2c3d e4f5a6b 0c1d2e3",
  "├─ test counts (passed/assertions): 26 passed, 0 failed",
  "├─ advisor checkpoints:",
  "│  CHECKPOINT: post-model = done",
  "│  CHECKPOINT: pre-final = done",
  "└─ deviations from this skill: None",
  "",
].join("\n");

function hookEnv(overrides) {
  const env = { ...process.env };
  delete env.SKYLINE_LOOP_REPORT;
  delete env.SKYLINE_LOOP_REPORT_DIR;
  delete env.SKYLINE_LOOP_REPORT_RETENTION_DAYS;
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runHook(mode, payload, env, cwd, timeout) {
  const res = spawnSync(process.execPath, [HOOK, mode], {
    encoding: "utf8",
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: hookEnv(env),
    cwd,
    timeout,
  });
  return { code: res.status, signal: res.signal, err: res.stderr || "", out: res.stdout || "" };
}

function counterFile(sid) {
  return path.join(os.tmpdir(), `skyline-loop-gate-${sid}`);
}

// Expected file stem for a raw session id, written from the rule rather than
// imported from the hook: chars outside [A-Za-z0-9._-] become "_", cut to
// 128, and "-" + the first 8 hex chars of sha256(raw) when that changed it.
function sidName(raw) {
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return clean === raw ? clean : `${clean}-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

const POSIX_NON_ROOT = process.platform !== "win32" && !(process.getuid && process.getuid() === 0);

// Report dir nested two levels under the temp root, so an unsanitized
// "../../x" join still lands inside this test's own temp tree (decoys).
// stop()/commit() default the report dir to this fixture's; pass
// sessionId null to omit session_id from the payload.
function reportFixture(t, tag, entries) {
  const tmp = freshTmp();
  const dir = path.join(tmp, "a", "b", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const sid = uniqueSessionId(tag);
  const transcript = writeTranscript(
    tmp,
    entries || [
      assistantSkillInvoke("feature-loop-skill"),
      assistantGitCommit(),
      assistantText("still working on the next slice"),
    ]
  );
  const counters = [sid];
  const payload = (sessionId, extra) => {
    const p = { transcript_path: transcript, ...(extra || {}) };
    const id = sessionId === undefined ? sid : sessionId;
    if (id !== null) p.session_id = id;
    return p;
  };
  const fx = {
    tmp,
    dir,
    sid,
    transcript,
    report: path.join(dir, `${sid}.md`),
    stop(env, sessionId, cwd) {
      return runHook("stop", payload(sessionId), { SKYLINE_LOOP_REPORT_DIR: dir, ...(env || {}) }, cwd);
    },
    commit(env, sessionId) {
      return runHook(
        "commit",
        payload(sessionId, { tool_name: "mcp__skyline__git_commit", tool_input: { subcommand: "commit" } }),
        { SKYLINE_LOOP_REPORT_DIR: dir, ...(env || {}) }
      );
    },
    track(counterSid) {
      counters.push(counterSid);
    },
  };
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const c of counters) fs.rmSync(counterFile(c), { force: true });
  });
  return fx;
}

function age(p, days, { link = false } = {}) {
  const when = new Date(Date.now() - days * DAY_MS);
  if (link) fs.lutimesSync(p, when, when);
  else fs.utimesSync(p, when, when);
}

// Symlinks need a privilege on Windows; report false there so the caller
// can skip instead of failing on the platform, not on the hook.
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (e) {
    if (e && (e.code === "EPERM" || e.code === "EACCES")) return false;
    throw e;
  }
}

test("report file (1): valid report file, no text attestation: Stop passes (default, file and unknown mode values)", (t) => {
  const fx = reportFixture(t, "rf1");
  fs.writeFileSync(fx.report, VALID_REPORT);
  for (const mode of [undefined, "file", "bogus"]) {
    const { code, err } = fx.stop({ SKYLINE_LOOP_REPORT: mode });
    assert.equal(code, 0, `mode ${mode}: a valid report file must satisfy the gate`);
    assert.equal(err, "");
  }
});

test("report file (1b): a report WITHOUT the loop-report: v1 header still passes (header is for indexers, not the gate)", (t) => {
  const fx = reportFixture(t, "rf1b");
  fs.writeFileSync(fx.report, VALID_REPORT.replace("# feature-loop FINAL\nloop-report: v1\n", ""));
  const { code, err } = fx.stop();
  assert.equal(code, 0);
  assert.equal(err, "");
});

test("report file (2): no report file and no attestation: blocks, names the absolute path and FINAL stored:", (t) => {
  const fx = reportFixture(t, "rf2");
  const { code, err } = fx.stop();
  assert.equal(code, 2);
  assert.ok(path.isAbsolute(fx.report));
  assert.ok(err.includes(`write the mandatory FINAL report to \`${fx.report}\``), err);
  assert.ok(err.includes(`FINAL stored: ${fx.report}`), err);
  assert.match(err, /skyline create tool \(overwrite:true if it exists\)/);
  assert.match(err, /FINAL attestation missing/);
  assert.match(err, /COPY the live CHECKPOINT lines/);
  assert.doesNotMatch(err, /rejected|missing fields/);
});

test("report file (3): report missing two fields: blocks and names exactly those fields, in fixed order", (t) => {
  const fx = reportFixture(t, "rf3");
  fs.writeFileSync(
    fx.report,
    "# feature-loop FINAL\nloop-report: v1\nCHECKPOINT: post-model = done\ndeviations: None\n"
  );
  let r = fx.stop();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(`The report file \`${fx.report}\` is missing fields: slices, tests.`), r.err);

  // Order comes from the field table, not from the report's own order.
  fs.writeFileSync(fx.report, "deviations: None\nslices shipped: 2 slices, a1b2c3d\n");
  r = fx.stop();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes("is missing fields: checkpoint, tests."), r.err);
});

test("report file (4): report path is a symlink to a valid report: rejected, blocks and says why", (t) => {
  const fx = reportFixture(t, "rf4");
  const target = path.join(fx.tmp, "elsewhere.md");
  fs.writeFileSync(target, VALID_REPORT);
  if (!trySymlink(target, fx.report)) {
    t.skip("symlinks not permitted on this platform");
    return;
  }
  const { code, err } = fx.stop();
  assert.equal(code, 2, "a symlinked report must never satisfy the gate");
  assert.ok(err.includes(`The report file \`${fx.report}\` was rejected: it is a symlink`), err);
  assert.equal(fs.readFileSync(target, "utf8"), VALID_REPORT, "target untouched");
});

test("report file (5): oversized, empty and directory report paths are rejected; exactly the cap passes", (t) => {
  const cases = [
    {
      tag: "rf5-big",
      make: (p) => fs.writeFileSync(p, VALID_REPORT + "x".repeat(MAX_REPORT_BYTES + 1 - Buffer.byteLength(VALID_REPORT))),
      code: 2,
      why: /was rejected: it is larger than 262144 bytes\./,
    },
    { tag: "rf5-empty", make: (p) => fs.writeFileSync(p, ""), code: 2, why: /was rejected: it is empty\./ },
    { tag: "rf5-dir", make: (p) => fs.mkdirSync(p), code: 2, why: /was rejected: it is not a regular file\./ },
    {
      tag: "rf5-cap",
      make: (p) => fs.writeFileSync(p, VALID_REPORT + "x".repeat(MAX_REPORT_BYTES - Buffer.byteLength(VALID_REPORT))),
      code: 0,
      why: null,
    },
  ];
  for (const c of cases) {
    const fx = reportFixture(t, c.tag);
    c.make(fx.report);
    const { code, err } = fx.stop();
    assert.equal(code, c.code, c.tag);
    if (c.why) assert.match(err, c.why, c.tag);
    else assert.equal(err, "", c.tag);
  }
});

test("report file (6): legacy text attestation and no report file: passes in default mode AND in chat mode, report dir untouched", (t) => {
  const fx = reportFixture(t, "rf6", [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText(FINAL_ATTESTATION_TEXT),
  ]);
  for (const mode of [undefined, "chat"]) {
    const { code, err } = fx.stop({ SKYLINE_LOOP_REPORT: mode });
    assert.equal(code, 0, `mode ${mode}`);
    assert.equal(err, "");
  }
  assert.deepEqual(fs.readdirSync(fx.dir), [], "the hook never writes a report");
});

test("report file (6b): a pass via the legacy text path prunes nothing (pruning only follows a pass via the file)", (t) => {
  const fx = reportFixture(t, "rf6b", [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText(FINAL_ATTESTATION_TEXT),
  ]);
  const old = path.join(fx.dir, "old-session.md");
  fs.writeFileSync(old, VALID_REPORT);
  age(old, 40);
  const { code } = fx.stop();
  assert.equal(code, 0);
  assert.ok(fs.existsSync(old));
});

test("report file (7): SKYLINE_LOOP_REPORT=chat: a valid report file alone does NOT pass and stderr is the pre-1.5.35 message exactly", (t) => {
  const fx = reportFixture(t, "rf7");
  fs.writeFileSync(fx.report, VALID_REPORT);
  fs.rmSync(counterFile(fx.sid), { force: true });
  const { code, err } = fx.stop({ SKYLINE_LOOP_REPORT: "chat" });
  assert.equal(code, 2, "chat mode ignores the report file");
  assert.equal(err, LEGACY_STOP_MESSAGE);

  // Only the exact spelling opts out: anything else is file mode (D3).
  fs.rmSync(counterFile(fx.sid), { force: true });
  const other = fx.stop({ SKYLINE_LOOP_REPORT: "Chat" });
  assert.equal(other.code, 0, "\"Chat\" is an unknown value, so file mode, so the report passes");
});

test("report file (8): session ids with path characters are sanitized; the file consulted stays inside the report dir", (t) => {
  const fx = reportFixture(t, "rf8");
  const u = `${process.pid}-${Date.now()}`;
  const cases = [
    // [raw session id, where an unsanitized join would point]
    [`../../lgx-${u}`, path.join(fx.dir, "..", "..", `lgx-${u}.md`)],
    [`sub/lgy-${u}`, path.join(fx.dir, "sub", `lgy-${u}.md`)],
  ];
  for (const [raw, decoy] of cases) {
    const clean = sidName(raw);
    fx.track(clean);
    fs.mkdirSync(path.dirname(decoy), { recursive: true });
    fs.writeFileSync(decoy, VALID_REPORT);
    assert.ok(decoy.startsWith(fx.tmp), "decoy stays inside this test's temp tree");
    const inside = path.join(fx.dir, `${clean}.md`);
    assert.equal(path.dirname(inside), fx.dir);
    let r = fx.stop({}, raw);
    assert.equal(r.code, 2, `${raw}: a decoy outside the sanitized name must not be read`);
    assert.ok(r.err.includes(`\`${inside}\``), r.err);
    fs.writeFileSync(inside, VALID_REPORT);
    r = fx.stop({}, raw);
    assert.equal(r.code, 0, `${raw}: the report at the sanitized name inside the dir satisfies the gate`);
  }
  // A 300+ char id is cut to 128 chars plus the 9-char hash suffix, inside the dir.
  const long = `lgz-${u}-` + "z".repeat(300);
  const longName = sidName(long);
  assert.ok(longName.length <= 128 + 9, String(longName.length));
  fx.track(longName);
  const r = fx.stop({}, long);
  assert.equal(r.code, 2);
  const m = r.err.match(/write the mandatory FINAL report to `([^`]+)`/);
  assert.ok(m, r.err);
  assert.equal(path.dirname(m[1]), fx.dir, "inside the report dir");
  assert.equal(path.basename(m[1]), `${longName}.md`);
  fs.writeFileSync(m[1], VALID_REPORT);
  assert.equal(fx.stop({}, long).code, 0);
});

test("report file (8b): a ../../x session id leaves no block counter outside the skyline-loop-gate-* namespace", (t) => {
  const fx = reportFixture(t, "rf8b");
  const u = `${process.pid}-${Date.now()}`;
  const raw = `../../lgc-${u}`;
  const escaped = path.join(os.tmpdir(), `lgc-${u}`); // where path.join would normalize the raw id to
  fx.track(sidName(raw));
  t.after(() => fs.rmSync(escaped, { force: true }));
  for (const mode of [undefined, "chat"]) {
    const { code } = fx.stop({ SKYLINE_LOOP_REPORT: mode }, raw);
    assert.equal(code, 2);
  }
  assert.equal(fs.existsSync(escaped), false, "no counter written outside the namespace");
  assert.equal(fs.readFileSync(counterFile(sidName(raw)), "utf8"), "2", "counter lives at the sanitized name");
});

test("report file (8c): distinct raw ids never share a file (a/b vs a_b); a UUID maps to <uuid>.md exactly", (t) => {
  const fx = reportFixture(t, "rf8c");
  const u = `${process.pid}-${Date.now()}`;
  const plain = `a_b-${u}`; // unchanged by the sanitizer
  const slashed = `a/b-${u}`; // sanitizes to the same characters as plain
  assert.notEqual(sidName(slashed), plain);
  fx.track(plain);
  fx.track(sidName(slashed));
  fs.writeFileSync(path.join(fx.dir, `${plain}.md`), VALID_REPORT);
  assert.equal(fx.stop({}, plain).code, 0, "an unchanged id reads <id>.md");
  const r = fx.stop({}, slashed);
  assert.equal(r.code, 2, "a/b must not read a_b's report");
  assert.ok(r.err.includes(`\`${path.join(fx.dir, `${sidName(slashed)}.md`)}\``), r.err);
  const uuid = crypto.randomUUID(); // the shape of a real Claude Code session id
  fx.track(uuid);
  const ru = fx.stop({}, uuid);
  assert.equal(ru.code, 2);
  assert.ok(ru.err.includes(`\`${path.join(fx.dir, `${uuid}.md`)}\``), ru.err);
});

test("report file (9): no usable session_id (absent, '.', '..', non-string): legacy behavior, pre-1.5.35 message, no path", (t) => {
  const fx = reportFixture(t, "rf9");
  const ppidCounter = counterFile(String(process.pid)); // the hook's process.ppid
  const num = 900000000 + (Date.now() % 1000000);
  fx.track(String(num));
  t.after(() => fs.rmSync(ppidCounter, { force: true }));
  for (const sid of [null, ".", "..", num]) {
    fs.rmSync(ppidCounter, { force: true });
    const { code, err } = fx.stop({}, sid);
    assert.equal(code, 2, `session_id ${JSON.stringify(sid)}`);
    assert.equal(err, LEGACY_STOP_MESSAGE, `session_id ${JSON.stringify(sid)}`);
  }
  assert.deepEqual(fs.readdirSync(fx.dir), []);
});

test("report file (9b): report dir falls back to $HOME/.skylence/skyline/loop-reports; no home dir means legacy", (t) => {
  const fx = reportFixture(t, "rf9b");
  const home = path.join(fx.tmp, "home");
  let r = fx.stop({ SKYLINE_LOOP_REPORT_DIR: "", HOME: home, USERPROFILE: undefined });
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(`\`${path.join(home, ".skylence", "skyline", "loop-reports", `${fx.sid}.md`)}\``), r.err);
  assert.equal(fs.existsSync(home), false, "the hook never creates the report dir");

  fs.rmSync(counterFile(fx.sid), { force: true });
  r = fx.stop({ SKYLINE_LOOP_REPORT_DIR: undefined, HOME: "", USERPROFILE: "" });
  assert.equal(r.code, 2);
  assert.equal(r.err, LEGACY_STOP_MESSAGE);
});

test("report file (9c): a relative SKYLINE_LOOP_REPORT_DIR ('rel-reports', '.') is ignored as if unset: the HOME default applies", (t) => {
  const fx = reportFixture(t, "rf9c");
  const home = path.join(fx.tmp, "home");
  const env = (rel) => ({ SKYLINE_LOOP_REPORT_DIR: rel, HOME: home, USERPROFILE: undefined });
  const expected = path.join(home, ".skylence", "skyline", "loop-reports", `${fx.sid}.md`);
  for (const rel of ["rel-reports", "."]) {
    fs.rmSync(counterFile(fx.sid), { force: true });
    const { code, err } = fx.stop(env(rel), undefined, fx.tmp);
    assert.equal(code, 2, rel);
    assert.ok(err.includes(`\`${expected}\``), `${rel}: ${err}`);
  }
  // A valid report at the cwd-relative location must not satisfy the gate.
  fs.mkdirSync(path.join(fx.tmp, "rel-reports"));
  fs.writeFileSync(path.join(fx.tmp, "rel-reports", `${fx.sid}.md`), VALID_REPORT);
  fs.writeFileSync(path.join(fx.tmp, `${fx.sid}.md`), VALID_REPORT);
  for (const rel of ["rel-reports", "."]) {
    fs.rmSync(counterFile(fx.sid), { force: true });
    assert.equal(fx.stop(env(rel), undefined, fx.tmp).code, 2, rel);
  }
});

test("report file (10): commit mode: file mode appends the report path to the verbatim legacy sentence; chat mode is the legacy string exactly", (t) => {
  const fx = reportFixture(t, "rf10", [assistantSkillInvoke("feature-loop-skill")]);
  const ctx = (r) => {
    assert.equal(r.code, 0);
    return JSON.parse(r.out).hookSpecificOutput.additionalContext;
  };
  const fileCtx = ctx(fx.commit());
  assert.ok(fileCtx.startsWith(LEGACY_COMMIT_CONTEXT + " "), fileCtx);
  assert.ok(fileCtx.includes(`write the full FINAL report to \`${fx.report}\``), fileCtx);
  assert.ok(fileCtx.includes(`FINAL stored: ${fx.report}`), fileCtx);
  assert.equal(ctx(fx.commit({ SKYLINE_LOOP_REPORT: "chat" })), LEGACY_COMMIT_CONTEXT);
  assert.equal(ctx(fx.commit({}, null)), LEGACY_COMMIT_CONTEXT, "no session_id: legacy");
  assert.deepEqual(fs.readdirSync(fx.dir), [], "commit mode never writes a report");
});

test("report file (11): retention after a pass via the file prunes only old, headered, regular *.md loop reports directly in the dir", (t) => {
  const fx = reportFixture(t, "rf11");
  const at = (name) => path.join(fx.dir, name);
  const writeAged = (name, days, body = VALID_REPORT) => {
    fs.writeFileSync(at(name), body);
    age(at(name), days);
  };
  fs.writeFileSync(fx.report, VALID_REPORT);
  age(fx.report, 40); // the current session's file is never pruned, however old
  writeAged("old-session.md", 40);
  writeAged("recent-session.md", 5);
  writeAged("old-headerless.md", 40, VALID_REPORT.replace("loop-report: v1\n", ""));
  writeAged("README.md", 40, "# my project\n");
  writeAged("CLAUDE.md", 40, "project rules\n");
  writeAged("old-notes.txt", 40);
  fs.mkdirSync(at("old-dir.md"));
  writeAged(path.join("old-dir.md", "inner.md"), 40);
  age(at("old-dir.md"), 40);
  const outside = path.join(fx.tmp, "outside-target.md");
  fs.writeFileSync(outside, VALID_REPORT);
  age(outside, 40);
  const linked = trySymlink(outside, at("old-link.md"));
  if (linked) age(at("old-link.md"), 40, { link: true });
  const kept = [
    "README.md",
    "CLAUDE.md",
    "old-headerless.md",
    "old-notes.txt",
    "old-dir.md",
    path.join("old-dir.md", "inner.md"),
  ];

  let r = fx.stop(); // default retention: 30 days
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.equal(fs.existsSync(at("old-session.md")), false, "40-day-old headered report pruned");
  assert.ok(fs.existsSync(at("recent-session.md")), "5-day-old report kept");
  for (const name of kept) assert.ok(fs.existsSync(at(name)), `${name} kept`);
  assert.ok(fs.existsSync(fx.report), "current session's report kept");
  if (linked) {
    assert.ok(fs.lstatSync(at("old-link.md")).isSymbolicLink(), "symlink kept");
    assert.ok(fs.existsSync(outside), "symlink target untouched");
  }

  writeAged("old-session.md", 40);
  r = fx.stop({ SKYLINE_LOOP_REPORT_RETENTION_DAYS: "0" });
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(at("old-session.md")), "0 = never prune");

  r = fx.stop({ SKYLINE_LOOP_REPORT_RETENTION_DAYS: "7days" }); // not an integer: default 30
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(at("old-session.md")), false);
  assert.ok(fs.existsSync(at("recent-session.md")));

  r = fx.stop({ SKYLINE_LOOP_REPORT_RETENTION_DAYS: "3" });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(at("recent-session.md")), false, "N parsed: 5 days > 3");
  assert.ok(fs.existsSync(fx.report));
  for (const name of kept) assert.ok(fs.existsSync(at(name)), `${name} survives every pass`);
});

test("report file (11b): a report dir that is a symlink to a notes dir loses nothing but old headered reports", (t) => {
  const fx = reportFixture(t, "rf11b");
  const notes = path.join(fx.tmp, "notes");
  fs.mkdirSync(notes);
  const linkDir = path.join(fx.tmp, "reports-link");
  if (!trySymlink(notes, linkDir)) {
    t.skip("symlinks not permitted on this platform");
    return;
  }
  const put = (name, days, body) => {
    fs.writeFileSync(path.join(notes, name), body);
    age(path.join(notes, name), days);
  };
  put("journal.md", 40, "# journal\n");
  put("README.md", 40, "# readme\n");
  put("CLAUDE.md", 40, "rules\n");
  put("old-headerless.md", 40, VALID_REPORT.replace("loop-report: v1\n", ""));
  put("old-report.md", 40, VALID_REPORT);
  put(`${fx.sid}.md`, 0, VALID_REPORT);
  const r = fx.stop({ SKYLINE_LOOP_REPORT_DIR: linkDir });
  assert.equal(r.code, 0);
  assert.deepEqual(
    fs.readdirSync(notes).sort(),
    ["CLAUDE.md", "README.md", "journal.md", "old-headerless.md", `${fx.sid}.md`].sort()
  );
});

test("report file (11c): prune reads only complete header lines within the first 256 bytes", (t) => {
  const fx = reportFixture(t, "rf11c");
  const at = (name) => path.join(fx.dir, name);
  fs.writeFileSync(fx.report, VALID_REPORT);
  const put = (name, body) => {
    fs.writeFileSync(at(name), body);
    age(at(name), 40);
  };
  put("cut-at-cap.md", "x".repeat(240) + "\n" + "loop-report: v1-draft notes\n");
  put("header-past-cap.md", "x".repeat(299) + "\nloop-report: v1\n");
  put("old-report.md", VALID_REPORT);
  assert.equal(fx.stop().code, 0);
  assert.ok(fs.existsSync(at("cut-at-cap.md")), "a line cut at byte 256 is not a header");
  assert.ok(fs.existsSync(at("header-past-cap.md")), "a header past byte 256 is not read");
  assert.equal(fs.existsSync(at("old-report.md")), false);
});

test("report file (12): MAX_BLOCKS fail-open still holds in file mode", (t) => {
  const fx = reportFixture(t, "rf12");
  const r1 = fx.stop();
  const r2 = fx.stop();
  const r3 = fx.stop();
  assert.equal(r1.code, 2, "block 1");
  assert.equal(r2.code, 2, "block 2");
  assert.ok(r2.err.includes(fx.report));
  assert.equal(r3.code, 0, "fail-open on the 3rd Stop");
  assert.equal(r3.err, "");
});

test("report file (13): fail-open in both modes: garbage or unreadable transcript, JSON null stdin", (t) => {
  const fx = reportFixture(t, "rf13");
  const garbage = path.join(fx.tmp, "garbage.jsonl");
  fs.writeFileSync(garbage, "not json\n{also not\n\u0000\u0001\n");
  for (const mode of [undefined, "chat"]) {
    for (const transcript of [garbage, fx.tmp /* a directory: unreadable */]) {
      const r = runHook(
        "stop",
        { transcript_path: transcript, session_id: fx.sid },
        { SKYLINE_LOOP_REPORT: mode, SKYLINE_LOOP_REPORT_DIR: fx.dir }
      );
      assert.equal(r.code, 0, `${mode} ${transcript}`);
      assert.equal(r.err, "");
    }
    for (const hookMode of ["stop", "commit"]) {
      const r = runHook(hookMode, "null", { SKYLINE_LOOP_REPORT: mode, SKYLINE_LOOP_REPORT_DIR: fx.dir });
      assert.equal(r.code, 0, `${mode} ${hookMode} null stdin`);
      assert.equal(r.err, "");
      assert.equal(r.out, "");
    }
  }
});

test("report file (13b): a report that exists but cannot be read blocks (bounded by MAX_BLOCKS), names the errno, accepts FINAL in chat", (t) => {
  if (!POSIX_NON_ROOT) {
    t.skip("needs POSIX permissions and a non-root user");
    return;
  }
  const fx = reportFixture(t, "rf13b");
  fs.writeFileSync(fx.report, VALID_REPORT);
  fs.chmodSync(fx.report, 0o000); // unlink needs only the dir's write bit: rmSync still cleans up
  const r = fx.stop();
  assert.equal(r.code, 2, "mode-000 report");
  assert.ok(r.err.includes(`The report file \`${fx.report}\` could not be read (EACCES)`), r.err);
  assert.match(r.err, /print the full FINAL in chat instead \(the gate accepts either\)/);
  assert.match(r.err, /could not be read \(EACCES\); fix the path or its permissions, or print/);

  const fx2 = reportFixture(t, "rf13b-dir");
  fs.chmodSync(fx2.dir, 0o000);
  try {
    const runs = [fx2.stop(), fx2.stop(), fx2.stop()];
    assert.deepEqual(runs.map((x) => x.code), [2, 2, 0], "mode-000 report dir: blocks, then MAX_BLOCKS fail-open");
    assert.ok(runs[0].err.includes(`could not be read (EACCES)`), runs[0].err);
  } finally {
    fs.chmodSync(fx2.dir, 0o700);
  }
});

test("report file (14): a FIFO at the report path is rejected without hanging the hook", (t) => {
  if (process.platform === "win32") {
    t.skip("no FIFOs on win32");
    return;
  }
  const fx = reportFixture(t, "rf14");
  if (spawnSync("mkfifo", [fx.report]).status !== 0) {
    t.skip("mkfifo unavailable");
    return;
  }
  const r = runHook(
    "stop",
    { transcript_path: fx.transcript, session_id: fx.sid },
    { SKYLINE_LOOP_REPORT_DIR: fx.dir },
    undefined,
    5000
  );
  assert.equal(r.signal, null, "the hook hung on the FIFO and was killed by the 5 s timeout");
  assert.equal(r.code, 2);
  assert.match(r.err, /was rejected: it is not a regular file\./);
});

test("report file (15): an unwritable block counter fails open instead of blocking forever (both modes)", (t) => {
  if (!POSIX_NON_ROOT) {
    t.skip("needs POSIX permissions and a non-root user");
    return;
  }
  const fx = reportFixture(t, "rf15");
  const rw = path.join(fx.tmp, "rw-tmp");
  const ro = path.join(fx.tmp, "ro-tmp");
  fs.mkdirSync(rw);
  fs.mkdirSync(ro);
  fs.chmodSync(ro, 0o555);
  try {
    for (const mode of [undefined, "chat"]) {
      assert.equal(fx.stop({ SKYLINE_LOOP_REPORT: mode, TMPDIR: rw }).code, 2, `${mode}: control, writable TMPDIR blocks`);
      const r = fx.stop({ SKYLINE_LOOP_REPORT: mode, TMPDIR: ro });
      assert.equal(r.code, 0, `${mode}: counter cannot be written, so fail open`);
      assert.equal(r.err, "");
    }
    assert.deepEqual(fs.readdirSync(ro), []);
  } finally {
    fs.chmodSync(ro, 0o700);
  }
});

test("report file (16): checkReportFile enforces the size cap on the read itself (file grows after lstat)", (t) => {
  const gate = require(HOOK); // required, not run: exports instead of main()
  const tmp = freshTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const p = path.join(tmp, "grows.md");
  fs.writeFileSync(p, VALID_REPORT);
  assert.deepEqual(gate.checkReportFile(p), { state: "ok" }, "control: valid before growth");
  const realLstat = fs.lstatSync;
  fs.lstatSync = function lstatThenGrow(target, ...rest) {
    const st = realLstat.call(this, target, ...rest);
    if (target === p) fs.appendFileSync(p, "x".repeat(gate.MAX_REPORT_BYTES));
    return st;
  };
  let res;
  try {
    res = gate.checkReportFile(p);
  } finally {
    fs.lstatSync = realLstat;
  }
  assert.deepEqual(res, { state: "too-large" });
});
