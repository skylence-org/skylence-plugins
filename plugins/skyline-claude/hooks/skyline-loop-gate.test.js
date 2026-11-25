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

// #57: the pre-1.5.35 tests above never remove the block counters their
// blocked Stops leave in os.tmpdir() (the same dir the hook writes them to).
// Delete only this run's: name prefix AND "-<pid>-" (uniqueSessionId embeds
// process.pid), so concurrent runs and unrelated files are untouched.
function cleanupLegacyCounters(dir = os.tmpdir(), pid = process.pid) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_e) {
    return;
  }
  for (const n of names) {
    if (!n.startsWith("skyline-loop-gate-lg-test-") || !n.includes(`-${pid}-`)) continue;
    try {
      fs.rmSync(path.join(dir, n), { force: true });
    } catch (_e) {
      /* swallow */
    }
  }
}
after(() => cleanupLegacyCounters());

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

// Literals of the pre-1.5.35 source (origin/main 3265a42, skyline-loop-gate.js
// :215 and :231), except the 1.5.36 deliberate change: the checkpoint clause of
// the stop message now asks for `= not-emitted`. Chat mode must emit exactly these.
const LEGACY_COMMIT_CONTEXT =
  "feature-loop-skill ADVISOR GATE: slice just committed. If that was the model slice or the first user-facing surface, consult the advisor NOW, before the next slice. Every checkpoint must appear in FINAL as done or skipped+reason.";
const LEGACY_STOP_MESSAGE =
  "feature-loop-skill FINAL attestation missing. Before ending: produce the mandatory FINAL report — slices shipped + commit ids; test counts; advisor checkpoints: COPY the live CHECKPOINT lines emitted during build, one per [post-model / post-first-surface / pre-final] — do not restate or reconstruct them from memory; for a checkpoint with no live CHECKPOINT line write `CHECKPOINT: <name> = not-emitted` and list it under deviations by name (then \"None\" is not allowed); deviations from the skill, where \"None\" is permitted only if every rule was followed as written.";

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

// 1.5.38: a session's gate state is its session-wide counter, its per-turn
// counters (`@<prompt_id>`) and its merit-pass line (`+pass`). Exact names
// only, so files of other runs and other sessions are never touched.
function removeGateState(sid) {
  const base = `skyline-loop-gate-${sid}`;
  let names = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch (_e) {
    return;
  }
  for (const n of names) {
    if (n === base || n === `${base}+pass` || n.startsWith(`${base}@`)) {
      fs.rmSync(path.join(os.tmpdir(), n), { force: true });
    }
  }
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
// sessionId null to omit session_id from the payload. The default
// transcript carries the live CHECKPOINT appends for VALID_REPORT's lines
// (1.5.37 C2), so a valid report passes; addLive() adds them for another path.

// 1.5.37 C2: the build-time trail of live CHECKPOINT appends, one tool_use
// per line, in the skyline edit shape (anchor header names the report path).
function liveWrites(reportPath, lines = ["CHECKPOINT: post-model = done", "CHECKPOINT: pre-final = done"]) {
  return lines.map((l) =>
    line({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "mcp__skyline__edit",
            input: { patch: `¶${reportPath}#AB12\ninsert tail:\n+${l}` },
          },
        ],
      },
    })
  );
}

function reportFixture(t, tag, entries) {
  const tmp = freshTmp();
  const dir = path.join(tmp, "a", "b", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const sid = uniqueSessionId(tag);
  const report = path.join(dir, `${sid}.md`);
  const transcript = writeTranscript(
    tmp,
    entries || [
      assistantSkillInvoke("feature-loop-skill"),
      assistantGitCommit(),
      ...liveWrites(report),
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
    report,
    // Live CHECKPOINT appends for another report path (another sid or dir).
    addLive(reportPath, lines) {
      fs.appendFileSync(transcript, liveWrites(reportPath, lines).join("\n") + "\n");
    },
    stop(env, sessionId, cwd, extra) {
      return runHook("stop", payload(sessionId, extra), { SKYLINE_LOOP_REPORT_DIR: dir, ...(env || {}) }, cwd);
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
    for (const c of counters) removeGateState(c);
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
  assert.ok(r.err.includes(`The report file \`${fx.report}\` is missing fields: \`slices shipped\` (slices), \`test counts\` (tests).`), r.err);

  // Order comes from the field table, not from the report's own order.
  fs.writeFileSync(fx.report, "deviations: None\nslices shipped: 2 slices, a1b2c3d\n");
  r = fx.stop();
  assert.equal(r.code, 2);
  assert.ok(
    r.err.includes("is missing fields: `CHECKPOINT: <name> = done|skipped(<reason>)|n/a|not-emitted` (checkpoint), `test counts` (tests)."),
    r.err
  );
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
    fx.addLive(inside);
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
  fx.addLive(m[1]);
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
  fx.addLive(path.join(fx.dir, `${plain}.md`));
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
  fx.addLive(path.join(linkDir, `${fx.sid}.md`));
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

// --- 1.5.36 (#56): honest `= not-emitted` checkpoint ------------------------

function finalWith(deviationsLine, checkpointLines) {
  return [
    "FINAL report:",
    "slices shipped: 1 (abc123)",
    "test counts: 4 passed",
    "advisor checkpoints:",
    ...(checkpointLines || ["CHECKPOINT: post-model = not-emitted"]),
    deviationsLine,
  ].join("\n");
}

function chatEntries(text) {
  return [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit(), assistantText(text)];
}

// not-emitted checkpoint named in prose (D2b) without a deviations line, so (f) isolates the None grammar
const NE_NAMED = ["CHECKPOINT: post-model = not-emitted", "(post-model never ran)"];
const COUPLING_HINT = 'deviations cannot be "None"';

test("not-emitted (a): chat text with a not-emitted line and an honest deviation passes (both modes)", (t) => {
  for (const mode of [undefined, "chat"]) {
    const fx = reportFixture(t, "ne-a", chatEntries(finalWith("Deviations: post-model checkpoint not emitted")));
    const r = fx.stop({ SKYLINE_LOOP_REPORT: mode });
    assert.equal(r.code, 0, `${mode}: ${r.err}`);
    assert.equal(r.err, "");
  }
});

test("not-emitted (b): same with 'Deviations: None' is refused and the message names the coupling (both modes)", (t) => {
  for (const mode of [undefined, "chat"]) {
    const fx = reportFixture(t, "ne-b", chatEntries(finalWith("Deviations: None")));
    const r = fx.stop({ SKYLINE_LOOP_REPORT: mode });
    assert.equal(r.code, 2, `${mode}`);
    assert.ok(r.err.includes(COUPLING_HINT), `${mode}: ${r.err}`);
  }
});

test("not-emitted (c): 'None besides X' is a real deviation and passes", (t) => {
  const fx = reportFixture(t, "ne-c", chatEntries(finalWith("Deviations: None besides the missing post-model line")));
  assert.equal(fx.stop().code, 0);
  const fx2 = reportFixture(t, "ne-c2", chatEntries(finalWith("Deviations: none except post-model")));
  assert.equal(fx2.stop().code, 0);
});

test("not-emitted (d): report file path: honest deviation passes, 'None' is refused and names the key + coupling", (t) => {
  const ok = reportFixture(t, "ne-d1");
  fs.writeFileSync(ok.report, "# feature-loop FINAL\nloop-report: v1\n" + finalWith("└─ deviations from this skill: post-model not emitted") + "\n");
  assert.equal(ok.stop().code, 0);
  const bad = reportFixture(t, "ne-d2");
  fs.writeFileSync(bad.report, "# feature-loop FINAL\nloop-report: v1\n" + finalWith("└─ deviations from this skill: None") + "\n");
  const r = bad.stop();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes("deviations-none-with-not-emitted"), r.err);
  assert.ok(r.err.includes(COUPLING_HINT), r.err);
});

test("not-emitted (e): no not-emitted line + 'Deviations: None' still passes (unchanged)", (t) => {
  const fx = reportFixture(t, "ne-e", chatEntries(FINAL_ATTESTATION_TEXT));
  assert.equal(fx.stop().code, 0);
  const fx2 = reportFixture(t, "ne-e2", chatEntries(finalWith("Deviations: None", ["CHECKPOINT: post-model = done"])));
  assert.equal(fx2.stop().code, 0);
});

test("not-emitted (f): bullet / bold / tree variants of a bare None are refused", (t) => {
  for (const dev of [
    "- **Deviations:** None.",
    "└─ deviations: none",
    "**Deviations**: None",
    "# Deviations — none.",
    "│  DEVIATIONS - None ",
    "Deviations from the skill: None",
    "└─ deviations from this skill: None",
    "5. Deviations: None",
    "5) deviations from this skill: None",
    "Deviations from skill: None",
    "Deviations = None",
    "| Deviations | None |",
    "Deviations: `None`",
    'Deviations: "None"',
    '└─ deviations from this skill — "None"',
    "└─ deviations from this skill:\n   None",
    "**Deviations:**\nNone",
    "- **Deviations:**\n  None.",
    "Deviations:\n\nNone",
    "## Deviations\n- None",
  ]) {
    const fx = reportFixture(t, "ne-f", chatEntries(finalWith(dev, NE_NAMED)));
    assert.equal(fx.stop().code, 2, dev);
  }
});

test("not-emitted (f2): no recognisable deviations line keeps the plain mention rule", (t) => {
  const fx = reportFixture(t, "ne-f2", chatEntries(finalWith("Note: a deviation happened in post-model, see above")));
  assert.equal(fx.stop().code, 0);
});

// --- #57: legacy tests clean up their counters --------------------------------

test("cleanup (g): removes this run's lg-test counters in os.tmpdir(), leaves a decoy from another pid", (t) => {
  const fx = reportFixture(t, "g-fx", [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit(), assistantText("wip")]);
  const sid = uniqueSessionId("x");
  // The legacy spawn helper (no explicit env) blocks and leaves a counter.
  const r = runStop(fx.transcript, sid);
  assert.equal(r.code, 2);
  const mine = counterFile(sid);
  const decoy = path.join(os.tmpdir(), `skyline-loop-gate-lg-test-y-99999999-${crypto.randomBytes(4).toString("hex")}-1`);
  fs.writeFileSync(decoy, "1");
  t.after(() => fs.rmSync(decoy, { force: true }));
  t.after(() => fs.rmSync(mine, { force: true }));
  assert.ok(fs.existsSync(mine), "counter exists before cleanup");
  cleanupLegacyCounters();
  assert.ok(!fs.existsSync(mine), "own-pid counter removed");
  assert.ok(fs.existsSync(decoy), "other-pid decoy untouched");
});

test("not-emitted (h): coupling note is not appended beside a report file that lists other missing fields", (t) => {
  const chat = ["slices shipped: 1 (abc)", "test counts: 4 passed", "CHECKPOINT: post-model = not-emitted", "Deviations: None"].join("\n");
  const fx = reportFixture(t, "ne-h", chatEntries(chat));
  fs.writeFileSync(fx.report, "# feature-loop FINAL\nloop-report: v1\nnotes only\n");
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.ok(
    r.err.includes(
      "is missing fields: `CHECKPOINT: <name> = done|skipped(<reason>)|n/a|not-emitted` (checkpoint), `deviations` (deviations), `slices shipped` (slices), `test counts` (tests)."
    ),
    r.err
  );
  assert.ok(!r.err.includes("The only failing check"), r.err);
});

// --- D2b: every not-emitted checkpoint must be NAMED outside its CHECKPOINT line ---

const ALL_NE = [
  "CHECKPOINT: post-model = not-emitted",
  "CHECKPOINT: post-first-surface = not-emitted",
  "CHECKPOINT: pre-final = not-emitted",
];
const NAMED_ALL = "Deviations: post-model, post-first-surface and pre-final checkpoints not emitted";

function reportBody(text) {
  return "# feature-loop FINAL\nloop-report: v1\n" + text + "\n";
}

test("not-emitted (i): 3x not-emitted + 'No deviations.' is refused; naming all three passes (chat and file)", (t) => {
  const bad = reportFixture(t, "ne-i", chatEntries(finalWith("No deviations.", ALL_NE)));
  const r = bad.stop();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes("not named yet: post-model, post-first-surface, pre-final"), r.err);
  const ok = reportFixture(t, "ne-i2", chatEntries(finalWith(NAMED_ALL, ALL_NE)));
  assert.equal(ok.stop().code, 0);
});

test("not-emitted (j): not-emitted post-model + deviations naming post-model passes", (t) => {
  const fx = reportFixture(t, "ne-j", chatEntries(finalWith("Deviations: post-model checkpoint not emitted")));
  assert.equal(fx.stop().code, 0);
});

test("not-emitted (k): post-model and pre-final not-emitted, only post-model named: refused, message names pre-final", (t) => {
  const cps = ["CHECKPOINT: post-model = not-emitted", "CHECKPOINT: pre-final = not-emitted"];
  const fx = reportFixture(t, "ne-k", chatEntries(finalWith("Deviations: post-model was not emitted", cps)));
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes("not named yet: pre-final"), r.err);
  assert.ok(!r.err.includes("not named yet: post-model"), r.err);
});

test("not-emitted (l): (i), (j), (k) through the report file", (t) => {
  const bad = reportFixture(t, "ne-l1");
  fs.writeFileSync(bad.report, reportBody(finalWith("└─ deviations from this skill: No deviations.", ALL_NE)));
  const r1 = bad.stop();
  assert.equal(r1.code, 2);
  assert.ok(r1.err.includes("deviations-not-naming-not-emitted"), r1.err);
  assert.ok(r1.err.includes("not named yet: post-model, post-first-surface, pre-final"), r1.err);
  const ok = reportFixture(t, "ne-l2");
  fs.writeFileSync(ok.report, reportBody(finalWith("└─ deviations from this skill: post-model not emitted")));
  assert.equal(ok.stop().code, 0);
  const part = reportFixture(t, "ne-l3");
  const cps = ["CHECKPOINT: post-model = not-emitted", "CHECKPOINT: pre-final = not-emitted"];
  fs.writeFileSync(part.report, reportBody(finalWith("└─ deviations: post-model was not emitted", cps)));
  const r3 = part.stop();
  assert.equal(r3.code, 2);
  assert.ok(r3.err.includes("not named yet: pre-final"), r3.err);
});

test("not-emitted (m): the CHECKPOINT line itself does not count as naming the checkpoint", (t) => {
  const fx = reportFixture(t, "ne-m", chatEntries(finalWith("Deviations: see above", ["CHECKPOINT: post-model = not-emitted"])));
  assert.equal(fx.stop().code, 2);
});

test("not-emitted (n): the seven reviewer question forms each exit 2", (t) => {
  const forms = [
    "No deviations.",
    "## Deviations\nNone",
    "Deviations:\n- None",
    "Deviations: None (all rules followed)",
    "Deviations: N/A",
    "Deviations: none ✓",
    "We discuss deviations only in passing here.",
  ];
  for (const dev of forms) {
    const fx = reportFixture(t, "ne-n", chatEntries(finalWith(dev)));
    assert.equal(fx.stop().code, 2, JSON.stringify(dev));
  }
});

test("not-emitted (o): a not-emitted line plus 256 KB of blank lines is checked in < 500 ms", () => {
  const { missingFields } = require(HOOK);
  const big = finalWith("Deviations:" + "\n".repeat(262144) + "post-model not emitted");
  const start = process.hrtime.bigint();
  missingFields(big);
  missingFields(finalWith("Deviations:" + " \n".repeat(131072)));
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `took ${ms} ms`);
});

// --- 1.5.37: per-kind report files (debug, review) beside the FINAL --------

test("Q3 (a): retention prunes other sessions' old headered .debug.md / .review.md; the current session's three files are kept", (t) => {
  const fx = reportFixture(t, "q3a");
  const at = (name) => path.join(fx.dir, name);
  const headered = (kind) => `# ${kind}-loop REPORT\nloop-report: v1\nroot cause: x\n`;
  const writeAged = (name, days, body) => {
    fs.writeFileSync(at(name), body);
    age(at(name), days);
  };
  fs.writeFileSync(fx.report, VALID_REPORT);
  writeAged(`${fx.sid}.debug.md`, 40, headered("debug"));
  writeAged(`${fx.sid}.review.md`, 40, headered("review"));
  writeAged("other-session.debug.md", 40, headered("debug"));
  writeAged("other-session.review.md", 40, headered("review"));
  writeAged("recent-session.debug.md", 5, headered("debug"));
  writeAged("headerless.review.md", 40, "# review notes\n");

  const r = fx.stop();
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(at("other-session.debug.md")), false, "old headered debug report pruned");
  assert.equal(fs.existsSync(at("other-session.review.md")), false, "old headered review report pruned");
  assert.ok(fs.existsSync(at("recent-session.debug.md")), "5-day-old debug report kept");
  assert.ok(fs.existsSync(at("headerless.review.md")), "headerless review file kept");
  assert.ok(fs.existsSync(at(`${fx.sid}.debug.md`)), "current session's debug report kept, however old");
  assert.ok(fs.existsSync(at(`${fx.sid}.review.md`)), "current session's review report kept, however old");
  assert.ok(fs.existsSync(fx.report));
});

test("Q3 (b): the Stop gate reads <sid>.md only: a valid FINAL in <sid>.debug.md / <sid>.review.md does not pass", (t) => {
  const fx = reportFixture(t, "q3b");
  fs.writeFileSync(path.join(fx.dir, `${fx.sid}.debug.md`), VALID_REPORT);
  fs.writeFileSync(path.join(fx.dir, `${fx.sid}.review.md`), VALID_REPORT);
  const r = fx.stop();
  assert.equal(r.code, 2, "no FINAL file: blocks");
  assert.ok(r.err.includes(`write the mandatory FINAL report to \`${fx.report}\``), r.err);
  assert.doesNotMatch(r.err, /\.debug\.md|\.review\.md/, "never names a debug/review file");
});

// --- 1.5.37 C2: CHECKPOINT lines go to the report file, written live -------

function toolUse(name, input) {
  return line({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}

function finalCreate(reportPath, content = VALID_REPORT) {
  return toolUse("mcp__skyline__create", { path: reportPath, content, overwrite: true });
}

// Fixture whose transcript is built from the fixture's own report path.
function orderedFixture(t, tag, entriesFor, content = VALID_REPORT) {
  const fx = reportFixture(t, tag);
  fs.writeFileSync(
    fx.transcript,
    [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit(), ...entriesFor(fx.report)].join("\n") + "\n"
  );
  fs.writeFileSync(fx.report, content);
  return fx;
}

test("C2 (1): CHECKPOINT lines appended live by their own calls, then the FINAL create: Stop passes", (t) => {
  const fx = orderedFixture(t, "c2-1", (r) => [...liveWrites(r), finalCreate(r)]);
  const r = fx.stop();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
});

test("C2 (2): FINAL written in one create with its CHECKPOINT lines, no earlier write: blocks checkpoint-not-live, names the lines", (t) => {
  const fx = orderedFixture(t, "c2-2", (r) => [finalCreate(r)]);
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(`The report file \`${fx.report}\` is missing fields: checkpoint-not-live.`), r.err);
  assert.ok(
    r.err.includes("no live write before the FINAL write: `CHECKPOINT: post-model = done`, `CHECKPOINT: pre-final = done`."),
    r.err
  );
  assert.match(r.err, /`CHECKPOINT: <name> = not-emitted`, named under deviations/);
  assert.doesNotMatch(r.err, /may trail/, "the FINAL write is visible: definitive wording");
});

test("C2 (2b): CHECKPOINT appends AFTER the FINAL write do not count as live", (t) => {
  const fx = orderedFixture(t, "c2-2b", (r) => [finalCreate(r), ...liveWrites(r)]);
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.match(r.err, /is missing fields: checkpoint-not-live\./);
});

test("C2 (3): CHECKPOINT lines printed in chat earlier (the pre-1.5.37 habit) plus a file FINAL: Stop passes", (t) => {
  const fx = orderedFixture(t, "c2-3", (r) => [
    assistantText("CHECKPOINT: post-model = done"),
    assistantText("slice 2 committed\nCHECKPOINT: pre-final = done"),
    finalCreate(r),
  ]);
  assert.equal(fx.stop().code, 0);
});

test("C2 (4): a `= not-emitted` line needs no live write; only the live ones are checked", (t) => {
  const report = VALID_REPORT.replace("CHECKPOINT: pre-final = done", "CHECKPOINT: pre-final = not-emitted").replace(
    "deviations from this skill: None",
    "deviations from this skill: pre-final checkpoint not emitted live"
  );
  const fx = orderedFixture(t, "c2-4", (r) => [...liveWrites(r, ["CHECKPOINT: post-model = done"]), finalCreate(r, report)], report);
  const r = fx.stop();
  assert.equal(r.code, 0, r.err);
});

test("C2 (5): FINAL write not in the transcript (it trails the file): blocks with the stop-again-unchanged wording", (t) => {
  const fx = orderedFixture(t, "c2-5", () => []);
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.match(r.err, /is missing fields: checkpoint-not-live\./);
  assert.match(r.err, /may trail the file: if each line was appended by its own call before the FINAL write, stop again without changing those lines/);
});

test("C2 (6): line key = name + state + an immediately following (reason); trailing text, tree glyphs and quotes do not break it", (t) => {
  const report = VALID_REPORT.replace(
    "│  CHECKPOINT: post-model = done",
    "│  **CHECKPOINT: post-model = done** (advisor: approve, 3 notes)"
  ).replace("│  CHECKPOINT: pre-final = done", '│  CHECKPOINT: pre-final = skipped(no "advisor" tool)');
  const live = [
    toolUse("mcp__skyline__create", {
      path: "IGNORED",
      content: "# feature-loop FINAL\nloop-report: v1\nCHECKPOINT: post-model = done\n",
      target: "",
    }),
  ];
  // The create above names no path: not live. The two below name it.
  const fx = orderedFixture(
    t,
    "c2-6",
    (r) => [
      ...live,
      toolUse("Write", { file_path: r, content: "# feature-loop FINAL\nloop-report: v1\ncheckpoint:  POST-MODEL = done\n" }),
      toolUse("Bash", { command: `printf '%s\\n' 'CHECKPOINT: pre-final = skipped(no "advisor" tool)' >> ${r}` }),
      finalCreate(r, report),
    ],
    report
  );
  assert.equal(fx.stop().code, 0);

  const other = orderedFixture(
    t,
    "c2-6b",
    (r) => [...liveWrites(r, ["CHECKPOINT: post-model = done", "CHECKPOINT: pre-final = skipped(other reason)"]), finalCreate(r, report)],
    report
  );
  const r = other.stop();
  assert.equal(r.code, 2, "a different (reason) is a different line");
  assert.ok(r.err.includes('`CHECKPOINT: pre-final = skipped(no "advisor" tool)`'), r.err);
  assert.ok(!r.err.includes("`CHECKPOINT: post-model = done`"), "the live post-model line is not listed");
});

test("C2 (7): a write naming another path (<report>.bak, a longer path) is not a live write to the report", (t) => {
  const fx = orderedFixture(t, "c2-7", (r) => [
    ...liveWrites(`${r}.bak`),
    ...liveWrites(`${r}x`),
    ...liveWrites(`/x${r}`),
    finalCreate(r),
  ]);
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.match(r.err, /no live write before the FINAL write/);
});

test("C2 (8): commit reminder in file mode tells the model to append each CHECKPOINT line to the report file; chat mode is the legacy string", (t) => {
  const fx = reportFixture(t, "c2-8", [assistantSkillInvoke("feature-loop-skill")]);
  const ctx = (r) => JSON.parse(r.out).hookSpecificOutput.additionalContext;
  const fileCtx = ctx(fx.commit());
  assert.ok(fileCtx.startsWith(LEGACY_COMMIT_CONTEXT + " "), fileCtx);
  assert.ok(fileCtx.includes(`CHECKPOINT lines go to the report file \`${fx.report}\`, not chat`), fileCtx);
  assert.match(fileCtx, /append each one by its own tool call the moment it resolves/);
  assert.match(fileCtx, /keeping the CHECKPOINT lines already in it verbatim/);
  assert.equal(ctx(fx.commit({ SKYLINE_LOOP_REPORT: "chat" })), LEGACY_COMMIT_CONTEXT);
});

test("C2 (9): chat mode ignores the ordering check: a FINAL with CHECKPOINT lines in chat passes as before", (t) => {
  const fx = reportFixture(t, "c2-9", [
    assistantSkillInvoke("feature-loop-skill"),
    assistantGitCommit(),
    assistantText(FINAL_ATTESTATION_TEXT),
  ]);
  for (const mode of ["chat", undefined]) assert.equal(fx.stop({ SKYLINE_LOOP_REPORT: mode }).code, 0, `mode ${mode}`);
});

test("C2 (10): a live append whose reason says 'test counts' is not the FINAL write (the mark is read outside CHECKPOINT lines)", (t) => {
  const reason = "CHECKPOINT: pre-final = skipped(docs only, test counts unchanged, slices shipped earlier)";
  const report = VALID_REPORT.replace("│  CHECKPOINT: pre-final = done", `│  ${reason}`);
  const fx = orderedFixture(
    t,
    "c2-10",
    (r) => [...liveWrites(r, ["CHECKPOINT: post-model = done", reason]), finalCreate(r, report)],
    report
  );
  const r = fx.stop();
  assert.equal(r.code, 0, r.err);
});

// Bounce 1 M1: skyline create answers with the REALPATH anchor (/var ->
// /private/var on macOS, a symlinked report dir), and the model's later edit
// appends carry that form. Those are live writes to the same file.
test("C2 (11): live CHECKPOINT edits that carry the realpath anchor of a symlinked report dir count as live", (t) => {
  const fx = reportFixture(t, "c2-11");
  const link = path.join(fx.tmp, "reports-link");
  if (!trySymlink(fx.dir, link)) {
    t.skip("symlinks not permitted on this platform");
    return;
  }
  const literal = path.join(link, `${fx.sid}.md`);
  const real = path.join(fs.realpathSync(fx.dir), `${fx.sid}.md`);
  assert.notEqual(real, literal, "the fixture really goes through a symlink");
  fs.writeFileSync(fx.report, VALID_REPORT);
  const write = (entries) =>
    fs.writeFileSync(
      fx.transcript,
      [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit(), ...entries].join("\n") + "\n"
    );
  // FINAL created under the literal path the gate named.
  write([...liveWrites(real), finalCreate(literal)]);
  let r = fx.stop({ SKYLINE_LOOP_REPORT_DIR: link });
  assert.equal(r.code, 0, r.err);
  // FINAL appended by an edit that also carries the realpath anchor.
  removeGateState(fx.sid); // each scenario below is a new history for this sid
  write([
    ...liveWrites(real),
    toolUse("mcp__skyline__edit", { patch: `¶${real}#CD34\ninsert tail:\n+${VALID_REPORT}` }),
  ]);
  r = fx.stop({ SKYLINE_LOOP_REPORT_DIR: link });
  assert.equal(r.code, 0, r.err);
  // Reconstruction is still caught under the realpath form.
  removeGateState(fx.sid);
  write([toolUse("mcp__skyline__edit", { patch: `¶${real}#EF56\ninsert tail:\n+${VALID_REPORT}` }), ...liveWrites(real)]);
  r = fx.stop({ SKYLINE_LOOP_REPORT_DIR: link });
  assert.equal(r.code, 2);
  assert.match(r.err, /no live write before the FINAL write/);
});

// --- 1.5.38: audit of 1.5.37 with live Claude Code sessions (I1-I4, M1, M5, M8)

function passFileOf(sid) {
  return `${counterFile(sid)}+pass`;
}

// Claude Code appends to the transcript; these tests do too.
function appendEntries(fx, entries) {
  fs.appendFileSync(fx.transcript, entries.join("\n") + "\n");
}

function turnStop(fx, promptId, extra) {
  return fx.stop(undefined, undefined, undefined, { ...(promptId === undefined ? {} : { prompt_id: promptId }), ...(extra || {}) });
}

const INTERIM_REPORT = reportBody(
  [
    "CHECKPOINT: post-model = skipped(no advisor tool)",
    "slices shipped: 1 of 3 (a1b2c3d), paused for a user question",
    "test counts: 4 passed, 0 failed",
    "deviations from this skill: interim FINAL, build paused after slice 1",
  ].join("\n")
);

const DONE_REPORT = reportBody(
  [
    "CHECKPOINT: post-model = skipped(no advisor tool)",
    "CHECKPOINT: post-first-surface = done",
    "CHECKPOINT: pre-final = done",
    "slices shipped: 3 (a1b2c3d e4f5a6b 0c1d2e3)",
    "test counts: 26 passed, 0 failed",
    "deviations from this skill: None",
  ].join("\n")
);

// Turn 1 of a build that pauses after slice 1: blocked once, then an interim
// FINAL passes on merit (the I1 field shape, audit live run b2).
function pausedTurnOne(t, tag) {
  const fx = reportFixture(t, tag, [assistantSkillInvoke("feature-loop-skill")]);
  appendEntries(fx, [...liveWrites(fx.report, ["CHECKPOINT: post-model = skipped(no advisor tool)"]), assistantGitCommit()]);
  const blocked = turnStop(fx, "turn-1");
  fs.writeFileSync(fx.report, INTERIM_REPORT);
  appendEntries(fx, [finalCreate(fx.report, INTERIM_REPORT)]);
  const passed = turnStop(fx, "turn-1");
  return { fx, blocked, passed };
}

test("I1 (1): multi-turn build: interim FINAL passes on merit; turn 2 live checkpoints + FINAL rewrite pass on merit (no checkpoint-not-live)", (t) => {
  const { fx, blocked, passed } = pausedTurnOne(t, "i1-1");
  assert.equal(blocked.code, 2);
  assert.ok(
    blocked.err.includes(
      "Pausing mid-build => write an interim FINAL (slices so far); keep appending CHECKPOINT lines and rewrite the FINAL when done."
    ),
    blocked.err
  );
  assert.equal(passed.code, 0, passed.err);
  assert.ok(fs.existsSync(passFileOf(fx.sid)), "a merit pass stores the transcript position");
  // Turn 2: the build resumes, each checkpoint is appended live, the FINAL is rewritten.
  appendEntries(fx, [
    assistantText("resuming the build"),
    ...liveWrites(fx.report, ["CHECKPOINT: post-first-surface = done"]),
    assistantGitCommit(),
    ...liveWrites(fx.report, ["CHECKPOINT: pre-final = done"]),
  ]);
  fs.writeFileSync(fx.report, DONE_REPORT);
  appendEntries(fx, [finalCreate(fx.report, DONE_REPORT)]);
  const r = turnStop(fx, "turn-2");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
});

test("I1 (2): after a merit pass, C2 (2b) still holds within the new attempt: FINAL rewrite, then the append, is not live", (t) => {
  const { fx, passed } = pausedTurnOne(t, "i1-2");
  assert.equal(passed.code, 0, passed.err);
  appendEntries(fx, [...liveWrites(fx.report, ["CHECKPOINT: post-first-surface = done"]), assistantGitCommit()]);
  fs.writeFileSync(fx.report, DONE_REPORT);
  appendEntries(fx, [finalCreate(fx.report, DONE_REPORT), ...liveWrites(fx.report, ["CHECKPOINT: pre-final = done"])]);
  const r = turnStop(fx, "turn-2");
  assert.equal(r.code, 2);
  assert.ok(r.err.includes("is missing fields: checkpoint-not-live."), r.err);
  assert.ok(r.err.includes("no live write before the FINAL write: `CHECKPOINT: pre-final = done`."), r.err);
});

test("I1 (3): a line that only a FINAL before the last pass carried is not live in the next attempt", (t) => {
  const fx = reportFixture(t, "i1-3", [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit()]);
  // Attempt 1: a reconstructed post-model line, blocked; rewritten honestly, passes.
  const reconstructed = reportBody("CHECKPOINT: post-model = done\nslices shipped: 1 (a1b2c3d)\ntest counts: 4 passed\ndeviations from this skill: None");
  fs.writeFileSync(fx.report, reconstructed);
  appendEntries(fx, [finalCreate(fx.report, reconstructed)]);
  assert.equal(turnStop(fx, "turn-1").code, 2);
  const honest = reportBody(
    "CHECKPOINT: post-model = not-emitted\nslices shipped: 1 (a1b2c3d)\ntest counts: 4 passed\ndeviations from this skill: post-model checkpoint not emitted live"
  );
  fs.writeFileSync(fx.report, honest);
  appendEntries(fx, [finalCreate(fx.report, honest)]);
  const pass = turnStop(fx, "turn-1");
  assert.equal(pass.code, 0, pass.err);
  // Attempt 2: the reconstructed line comes back, copied from the first FINAL.
  fs.writeFileSync(fx.report, reconstructed);
  appendEntries(fx, [assistantGitCommit(), finalCreate(fx.report, reconstructed)]);
  const r = turnStop(fx, "turn-2");
  assert.equal(r.code, 2);
  assert.ok(r.err.includes("no live write before the FINAL write: `CHECKPOINT: post-model = done`."), r.err);
});

test("I1 (4): a stored pass line past the transcript's end is ignored (C2 (2b) is checked as before)", (t) => {
  const fx = orderedFixture(t, "i1-4", (r) => [finalCreate(r), ...liveWrites(r)]);
  fs.writeFileSync(passFileOf(fx.sid), "999999");
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.match(r.err, /is missing fields: checkpoint-not-live\./);
});

test("I2 (1): two blocks in turn 1 do not exhaust turn 2; the block text never advertises the fail-open", (t) => {
  const fx = reportFixture(t, "i2-1");
  const t1 = [turnStop(fx, "turn-1"), turnStop(fx, "turn-1"), turnStop(fx, "turn-1")];
  assert.deepEqual(
    t1.map((r) => r.code),
    [2, 2, 0],
    "per turn: two blocks, then the fail-open"
  );
  const t2 = turnStop(fx, "turn-2");
  assert.equal(t2.code, 2, "turn 2 has its own budget");
  for (const r of [...t1.slice(0, 2), t2]) assert.doesNotMatch(r.err, /fail-open|fails open|advisory|MAX_BLOCKS|third Stop/i);
});

test("I2 (2): a merit pass resets the budget; a fail-open does not", (t) => {
  const fx = reportFixture(t, "i2-2");
  assert.equal(fx.stop().code, 2);
  assert.equal(fx.stop().code, 2);
  fs.writeFileSync(fx.report, VALID_REPORT);
  assert.equal(fx.stop().code, 0, "merit pass");
  assert.equal(fs.existsSync(counterFile(fx.sid)), false, "the merit pass deleted the counter");
  fs.writeFileSync(fx.report, "# feature-loop FINAL\nloop-report: v1\nnotes only\n");
  const again = [fx.stop(), fx.stop(), fx.stop()].map((r) => r.code);
  assert.deepEqual(again, [2, 2, 0], "a fresh budget after the pass (1.5.37: 0 at once)");
  assert.equal(fs.readFileSync(counterFile(fx.sid), "utf8"), "3", "the fail-open left the counter in place");
});

test("I2 (3): without a usable prompt_id the counter is the session-wide pre-1.5.38 file; with one it is per turn", (t) => {
  const fx = reportFixture(t, "i2-3");
  assert.equal(fx.stop().code, 2);
  assert.equal(fs.readFileSync(counterFile(fx.sid), "utf8"), "1");
  assert.equal(turnStop(fx, 42).code, 2, "a non-string prompt_id falls back to the session key");
  assert.equal(fs.readFileSync(counterFile(fx.sid), "utf8"), "2");
  assert.equal(turnStop(fx, "p/1").code, 2);
  assert.equal(fs.readFileSync(`${counterFile(fx.sid)}@${sidName("p/1")}`, "utf8"), "1", "sanitized like a session id");
});

// A fork transcript in the live shape (Claude Code 2.1.332, audit fork run):
// header lines with the derived-from marker, the parent's entries copied with
// their uuids, then the fork's own entries.
function withUuid(entryLine, uuid, sessionId) {
  return JSON.stringify({ ...JSON.parse(entryLine), uuid, sessionId });
}

function forkFixture(t, tag, { parent = true, parentId, ownEntries } = {}) {
  const fx = reportFixture(t, tag, []);
  const pid = parentId || `${fx.sid}-parent`;
  const parentReport = path.join(fx.dir, `${pid}.md`);
  const parentEntries = [
    ...assistantSkillInvoke("feature-loop-skill").split("\n"),
    assistantGitCommit(),
    ...liveWrites(parentReport),
    finalCreate(parentReport),
    assistantText(`FINAL stored: ${parentReport}`),
  ];
  const parentLines = parentEntries.map((l, i) => withUuid(l, `${pid}-u${i}`, pid));
  if (parent) fs.writeFileSync(path.join(fx.tmp, `${pid}.jsonl`), parentLines.join("\n") + "\n");
  const header = [
    line({ type: "mode", mode: "normal", sessionId: fx.sid }),
    line({ type: "derived-from", v: 1, sessionId: fx.sid, sessions: [{ type: "claude_code_session", id: pid, via: "fork" }] }),
    line({ type: "queue-operation", operation: "enqueue", sessionId: fx.sid, content: "Reply with exactly: ok" }),
  ];
  const inherited = parentEntries.map((l, i) => withUuid(l, `${pid}-u${i}`, fx.sid));
  const own = (ownEntries || [line({ type: "user", message: { content: "Reply with exactly: ok" } }), assistantText("ok")]).map((l, i) =>
    withUuid(l, `${fx.sid}-own${i}`, fx.sid)
  );
  fs.writeFileSync(fx.transcript, [...header, ...inherited, ...own].join("\n") + "\n");
  return fx;
}

test("I3 (1): fork of a finished build, trivial own turn: Stop and the commit reminder stay silent; no FINAL is owed", (t) => {
  const fx = forkFixture(t, "i3-1");
  const r = fx.stop();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  assert.equal(fs.existsSync(fx.report), false);
  assert.equal(fx.commit().out, "", "the inherited Skill call does not arm the commit reminder");
});

test("I3 (2): fork whose parent transcript is missing: no scoping, the gate blocks as before", (t) => {
  const fx = forkFixture(t, "i3-2", { parent: false });
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(fx.report), r.err);
});

test("I3 (3): a fork that really invokes the skill and commits is gated on its own activity", (t) => {
  const fx = forkFixture(t, "i3-3", {
    ownEntries: [...assistantSkillInvoke("feature-loop-skill").split("\n"), assistantGitCommit(), assistantText("slice 1 done")],
  });
  const r = fx.stop();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(fx.report), "names the FORK's report path");
  fs.appendFileSync(fx.transcript, [...liveWrites(fx.report), finalCreate(fx.report)].join("\n") + "\n");
  fs.writeFileSync(fx.report, VALID_REPORT);
  const ok = fx.stop();
  assert.equal(ok.code, 0, ok.err);
});

test("I3 (4): a parent id outside [A-Za-z0-9._-] is never resolved, even when that path holds the parent's entries", (t) => {
  const fx = forkFixture(t, "i3-4", { parent: false, parentId: "sub/decoy" });
  fs.mkdirSync(path.join(fx.tmp, "sub"));
  const decoy = fs
    .readFileSync(fx.transcript, "utf8")
    .split("\n")
    .filter((l) => l.includes("sub/decoy-u"));
  fs.writeFileSync(path.join(fx.tmp, "sub", "decoy.jsonl"), decoy.join("\n") + "\n");
  assert.equal(fx.stop().code, 2);
});

test("M1 (1): live writes naming the report as ~/..., with backslashes, //, /./ or seg/.. count as live", (t) => {
  const spellings = [
    ["tilde", (r, home) => "~" + r.slice(home.length)],
    ["backslash", (r) => r.replace(/\//g, "\\")],
    ["double-slash", (r) => r.replace("/reports/", "//reports/")],
    ["dot-segment", (r) => r.replace("/reports/", "/reports/./")],
    ["dotdot", (r) => r.replace("/reports/", "/reports/x/../")],
  ];
  for (const [label, spell] of spellings) {
    const fx = reportFixture(t, `m1-${label}`);
    const s = spell(fx.report, fx.tmp);
    assert.notEqual(s, fx.report);
    fs.writeFileSync(
      fx.transcript,
      [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit(), ...liveWrites(s), finalCreate(s)].join("\n") + "\n"
    );
    fs.writeFileSync(fx.report, VALID_REPORT);
    const r = fx.stop({ HOME: fx.tmp });
    assert.equal(r.code, 0, `${label}: ${r.err}`);
  }
});

test("M1 (2): normalizing never makes another file the report: ~ mid-token, <report>.bak, another home", (t) => {
  const spellings = [
    ["mid-token tilde", (r, home) => "x~" + r.slice(home.length)],
    ["bak", (r, home) => "~" + r.slice(home.length) + ".bak"],
    ["other home", (r, home) => "~/elsewhere" + r.slice(home.length)],
  ];
  for (const [label, spell] of spellings) {
    const fx = reportFixture(t, `m1n-${label.replace(/ /g, "-")}`);
    const s = spell(fx.report, fx.tmp);
    fs.writeFileSync(
      fx.transcript,
      [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit(), ...liveWrites(s), finalCreate(fx.report)].join("\n") + "\n"
    );
    fs.writeFileSync(fx.report, VALID_REPORT);
    const r = fx.stop({ HOME: fx.tmp });
    assert.equal(r.code, 2, label);
    assert.match(r.err, /no live write before the FINAL write/, label);
  }
});

// COMMIT MATCHER CONTRACT (bounce 2 class ruling): isCommitCall is specified
// by this ONE table, folded from the review matrices (m5.js 29 rows,
// u1attack.js 49 rows, fence.js, the M5 (1) rows) plus the bounce-2 rows.
// Every new shape is added HERE, with the value the matcher returns today:
//   ok          = the value is the right answer;
//   known miss  = a real commit the matcher does not see (documented, not fixed);
//   known FP    = prose or a non-commit the matcher reads as a commit.
// Changing a row's value is a contract change: say so in the PR.
const RUN_TOOL = "mcp__plugin_skyline-claude_skyline__run";
const BASH = (command) => ["Bash", { command }];
const WRITE = (content) => ["Write", { file_path: "/x/a.md", content }];
const FENCE_1MB = "```\n" + "x y z commit w\n".repeat(Math.ceil((1024 * 1024) / 15)) + "```\n";
const COMMIT_MATCHER_TABLE = [
  // [label, [tool, input], matches, status]
  // --- real commits, matched
  ["git commit -m x", BASH("git commit -m x"), true, "ok"],
  ["git commit -m wip", BASH("git commit -m wip"), true, "ok"],
  ["git -C /r commit", BASH("git -C /r commit -m x"), true, "ok"],
  ["git -c user.name=a commit", BASH("git -c user.name=a commit -m x"), true, "ok"],
  ['git -c "user.name=A B" commit', BASH('git -c "user.name=A B" commit -m "x"'), true, "ok"],
  ['git -c core.editor="vim; x" commit', BASH('git -c core.editor="vim; x" commit -m m'), true, "ok"],
  ['git -C "a (b)" commit', BASH('git -C "a (b)" commit -m m'), true, "ok"],
  ['git -C "$(git rev-parse --show-toplevel)" commit', BASH('git -C "$(git rev-parse --show-toplevel)" commit -m m'), true, "ok"],
  ["git -C `pwd` commit (backtick value, bounce 2 finding 3)", BASH("git -C `pwd` commit -m m"), true, "ok"],
  ["git -C $REPO commit", BASH("git -C $REPO commit -m m"), true, "ok"],
  ["git -C ${REPO} commit", BASH("git -C ${REPO} commit -m m"), true, "ok"],
  ["/usr/bin/git --no-pager commit", BASH("/usr/bin/git --no-pager commit -m x"), true, "ok"],
  ["git.exe (Windows path) commit", BASH("C:\\Program Files\\Git\\bin\\git.exe commit -m x"), true, "ok"],
  ["GIT_EDITOR=true git commit --amend", BASH("GIT_EDITOR=true git commit --amend --no-edit"), true, "ok"],
  ["FOO=1 git commit", BASH("FOO=1 git commit -m m"), true, "ok"],
  ["env X=1 git commit", BASH("env X=1 git commit -m x"), true, "ok"],
  ["command git commit", BASH("command git commit -m x"), true, "ok"],
  ["nice -n 5 git commit", BASH("nice -n 5 git commit -m x"), true, "ok"],
  ["sudo -u a git commit", BASH("sudo -u a git commit -m x"), true, "ok"],
  ["xargs git commit", BASH("echo x | xargs git commit -m"), true, "ok"],
  ["(cd r; git commit -m x)", BASH("(cd r; git commit -m x)"), true, "ok"],
  ["cd r && git commit", BASH("cd r && git commit -m x"), true, "ok"],
  ["git add -A && git commit", BASH("git add -A && git commit -m x"), true, "ok"],
  ["git add . ; git commit -am x", BASH("git add . ; git commit -am x"), true, "ok"],
  ["git commit 2>&1 | tail", BASH("git commit -m x 2>&1 | tail -3"), true, "ok"],
  ["git commit>log", BASH("git commit -m x>log"), true, "ok"],
  ['git commit -m "$(date)"', BASH('git commit -m "$(date)"'), true, "ok"],
  ["cd /r && git commit -m \"$(cat <<'EOF' ...)\"", BASH("cd /r && git commit -m \"$(cat <<'EOF'\nfix: x\n\nCo-Authored-By: C <n@a.com>\nEOF\n)\""), true, "ok"],
  ["git commit -F - <<'EOF' heredoc", BASH("git commit -F - <<'EOF'\nmsg\nEOF"), true, "ok"],
  ["sh -c 'git commit -m x' (bounce 1 Minor 1)", BASH("sh -c 'git commit -m x'"), true, "ok"],
  ['bash -lc "cd /r && git commit -m x"', BASH('bash -lc "cd /r && git commit -m x"'), true, "ok"],
  ["ssh host 'cd r && git commit -m x'", BASH("ssh host 'cd r && git commit -m x'"), true, "ok"],
  ['timeout 60 sh -c "git -C /r commit -m x"', BASH('timeout 60 sh -c "git -C /r commit -m x"'), true, "ok"],
  ['bash -c "git -c a=\'b; c\' commit"', BASH("bash -c \"git -c a='b; c' commit -m x\""), true, "ok"],
  ["docker exec c sh -c 'cd r && git commit'", BASH("docker exec c sh -c 'cd r && git commit -m x'"), true, "ok"],
  ["eval 'git commit -m x'", BASH("eval 'git commit -m x'"), true, "ok"],
  ["sh -c $'git commit -m x' (ANSI-C quote, bounce 2 finding 4)", BASH("sh -c $'git commit -m x'"), true, "ok"],
  ["argv [git,-c,user.email=a@b,-c,user.name=x,commit]", [RUN_TOOL, { argv: ["git", "-c", "user.email=a@b", "-c", "user.name=x", "commit", "-m", "slice"] }], true, "ok"],
  ["argv [git,-C,/r,commit]", [RUN_TOOL, { argv: ["git", "-C", "/r", "commit", "-m", "x"] }], true, "ok"],
  ["argv [git,--no-pager,-c,k=v,commit]", [RUN_TOOL, { argv: ["git", "--no-pager", "-c", "k=v", "commit", "-m", "x"] }], true, "ok"],
  ["argv [/usr/bin/git,--no-pager,--git-dir,/r/.git,commit]", [RUN_TOOL, { argv: ["/usr/bin/git", "--no-pager", "--git-dir", "/r/.git", "commit"] }], true, "ok"],
  ["argv [git,-c,'a=b;c',commit]", [RUN_TOOL, { argv: ["git", "-c", "a=b;c", "commit"] }], true, "ok"],
  ["argv [git,-C,'a (b)',commit]", [RUN_TOOL, { argv: ["git", "-C", "a (b)", "commit"] }], true, "ok"],
  ["argv [git,-C,'$(pwd)',commit] (literal value)", [RUN_TOOL, { argv: ["git", "-C", "$(pwd)", "commit"] }], true, "ok"],
  ["argv [git,commit,-m,'a; (b)']", [RUN_TOOL, { argv: ["git", "commit", "-m", "a; (b)"] }], true, "ok"],
  ["argv [sh,-c,'git -C /r commit -m x']", [RUN_TOOL, { argv: ["sh", "-c", "git -C /r commit -m x"] }], true, "ok"],
  ["argv [sh,-c,'cd /x && git -C y commit -am ...']", [RUN_TOOL, { argv: ["sh", "-c", "cd /x && git -C y commit -am 'a b'"] }], true, "ok"],
  ["argv [bash,-lc,'cd r && git commit']", [RUN_TOOL, { argv: ["bash", "-lc", "cd r && git commit -m x"] }], true, "ok"],
  ["argv [ssh,h,'cd r; git commit -m x']", [RUN_TOOL, { argv: ["ssh", "h", "cd r; git commit -m x"] }], true, "ok"],
  ["run_batch commands[].argv git -C commit", ["mcp__plugin_skyline-claude_skyline__run_batch", { commands: [{ argv: ["git", "-C", "/r", "commit", "-m", "x"] }] }], true, "ok"],
  ["run_batch commands nested sh -c", ["mcp__plugin_skyline-claude_skyline__run_batch", { commands: [{ argv: ["sh", "-c", "git -C /r commit -m x"] }] }], true, "ok"],
  ["run_job argv git commit", ["mcp__plugin_skyline-claude_skyline__run_job", { argv: ["git", "commit", "-m", "x"] }], true, "ok"],
  ["skyline git_commit tool (any subcommand)", ["mcp__skyline__git_commit", { subcommand: "add" }], true, "ok"],
  ["plugin git_commit tool", ["mcp__plugin_skyline-claude_skyline__git_commit", { subcommand: "commit", args: ["-m", "x"] }], true, "ok"],
  ["1 MB fenced Write with a real git commit inside", WRITE(FENCE_1MB + "```\ngit commit -m x\n```\n"), true, "ok"],
  // --- real commits, NOT matched (documented misses)
  ["git --git-dir=a\\ b commit (escaped space)", BASH("git --git-dir=a\\ b commit -m m"), false, "known miss"],
  ["git -C a\\ b commit (escaped space)", BASH("git -C a\\ b commit -m m"), false, "known miss"],
  ["git -C $(pwd) commit (unquoted $() value)", BASH("git -C $(pwd) commit -m m"), false, "known miss"],
  ["git -c x=$(echo y) commit (unquoted $() value)", BASH("git -c x=$(echo y) commit -m m"), false, "known miss"],
  ["git \\<newline> commit (line continuation)", BASH("git \\\n  commit -m x"), false, "known miss"],
  ["git -C r \\<newline> commit (continuation after option)", BASH("git -C r \\\n  commit -m x"), false, "known miss"],
  ["git -c alias.x=commit x (alias of commit)", BASH("git -c alias.x=commit x -m m"), false, "known miss"],
  // --- not commits, not matched
  ["git log --grep commit", BASH("git log --grep commit"), false, "ok"],
  ["git commit-graph write", BASH("git commit-graph write"), false, "ok"],
  ["argv [git,log,--grep,commit]", [RUN_TOOL, { argv: ["git", "log", "--grep", "commit"] }], false, "ok"],
  ["argv [git,-C,commit,status] (dir named commit)", [RUN_TOOL, { argv: ["git", "-C", "commit", "status"] }], false, "ok"],
  ["argv [git,status]", [RUN_TOOL, { argv: ["git", "status"] }], false, "ok"],
  ["git -C commit status", BASH("git -C commit status"), false, "ok"],
  ["git help commit", BASH("git help commit"), false, "ok"],
  ["git show commit", BASH("git show commit"), false, "ok"],
  ["git log; echo commit", BASH("git log; echo commit"), false, "ok"],
  ["git status | grep commit", BASH("git status | grep commit"), false, "ok"],
  ["git status && echo commit", BASH("git status && echo commit"), false, "ok"],
  ["git -C <(x) commit (nonsense)", BASH("git -C <(x) commit"), false, "ok"],
  ["echo committed", BASH("echo committed"), false, "ok"],
  ["gh pr merge 62", BASH("gh pr merge 62 --squash"), false, "ok"],
  ["prose: use git (commit early)", WRITE("use git (commit early)"), false, "ok"],
  ["prose: configure git\\ncommit hooks", WRITE("configure git\ncommit hooks are optional"), false, "ok"],
  ["prose: pass git -C\\ncommit message (separator is no option value, bounce 2 finding 3)", WRITE("pass git -C\ncommit message"), false, "ok"],
  ["prose: use git -C (commit early) (bounce 2 finding 3)", WRITE("use git -C (commit early)"), false, "ok"],
  ["prose: Run `git` then `commit` the change", WRITE("Run `git` then `commit` the change"), false, "ok"],
  ["prose: Run `git` `commit` (adjacent backtick spans)", WRITE("Run `git` `commit`"), false, "ok"],
  ["prose: the `git` commit graph", WRITE("the `git` commit graph"), false, "ok"],
  ["1 MB fenced Write, no commit (must not throw)", WRITE("# doc\n" + FENCE_1MB), false, "ok"],
  ["many small backtick spans, 1 MB", WRITE("a `b c` commit d\n".repeat(60000)), false, "ok"],
  // --- not commits, matched (documented false positives; 2b1eef9 matched them too)
  ['echo "git commit" (accepted by ruling, as on 2b1eef9)', BASH('echo "git commit"'), true, "known FP"],
  ["grep -r 'git commit' docs/", BASH("grep -r 'git commit' docs/"), true, "known FP"],
  ["heredoc prose mentioning git commit", BASH("cat > notes.md <<'EOF'\nrun git commit after review\nEOF"), true, "known FP"],
  ["argv [rg,'git commit',docs]", [RUN_TOOL, { argv: ["rg", "git commit", "docs"] }], true, "known FP"],
  ["prose: Run `git commit` after review", WRITE("Run `git commit` after review"), true, "known FP"],
  ["prose: never git commit --no-verify", WRITE("never git commit --no-verify"), true, "known FP"],
  ["Edit new_string: then git commit the slice", ["Edit", { file_path: "/a.md", old_string: "a", new_string: "then git commit the slice" }], true, "known FP"],
];

test("commit matcher contract: isCommitCall returns the table's value for every row (any new shape goes into this table)", () => {
  const { isCommitCall } = require("./skyline-loop-gate");
  const statuses = new Set(["ok", "known miss", "known FP"]);
  const wrong = [];
  for (const [label, [tool, input], matches, status] of COMMIT_MATCHER_TABLE) {
    assert.ok(statuses.has(status), `${label}: status ${status}`);
    assert.equal(status === "known miss" ? !matches : status === "known FP" ? matches : true, true, `${label}: status/value mismatch`);
    let got;
    try {
      got = isCommitCall(tool, input);
    } catch (e) {
      got = `THROW ${e && e.name}`;
    }
    if (got !== matches) wrong.push(`${label}: expected ${matches}, got ${got}`);
  }
  assert.deepEqual(wrong, []);
  assert.ok(COMMIT_MATCHER_TABLE.length >= 90, `${COMMIT_MATCHER_TABLE.length} rows`);
});

test("commit matcher: linear on `git` tokens in option-value position (bounce 2 finding 2): 200 KB, bare and inside sh -c, each under 1 s", () => {
  const { isCommitCall } = require("./skyline-loop-gate");
  const K = 200 * 1024;
  const quadratic = "-c git ".repeat(Math.ceil(K / 7)).slice(0, K) + " status commit";
  for (const [label, command] of [
    ["bare", quadratic],
    ["inside sh -c '...'", `sh -c '${quadratic}'`],
  ]) {
    const t0 = process.hrtime.bigint();
    const got = isCommitCall("Bash", { command });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(got, false, label);
    assert.ok(ms < 1000, `${label}: ${ms.toFixed(0)} ms`);
  }
});

test("M5 (2): a `git -c k=v commit` argv arms the Stop gate and `git -C dir commit` the commit reminder; commit-graph does not", (t) => {
  const fx = reportFixture(t, "m5-2", [
    assistantSkillInvoke("feature-loop-skill"),
    toolUse("mcp__skyline__run", { argv: ["git", "-c", "user.email=a@b", "-c", "user.name=x", "commit", "-m", "slice"] }),
  ]);
  assert.equal(fx.stop().code, 2);
  const res = runHook(
    "commit",
    { transcript_path: fx.transcript, session_id: fx.sid, tool_name: "mcp__skyline__run", tool_input: { argv: ["git", "-C", "/repo", "commit", "-m", "s"] } },
    { SKYLINE_LOOP_REPORT_DIR: fx.dir }
  );
  assert.match(JSON.parse(res.out).hookSpecificOutput.additionalContext, /ADVISOR GATE/);
  const neg = reportFixture(t, "m5-2n", [
    assistantSkillInvoke("feature-loop-skill"),
    toolUse("mcp__skyline__run", { argv: ["git", "commit-graph", "write"] }),
    toolUse("Bash", { command: "git log --grep commit" }),
  ]);
  assert.equal(neg.stop().code, 0);
});

test("M8: a last_assistant_message carrying every FINAL field passes when the transcript lacks it (both modes); a partial one blocks", (t) => {
  const fx = reportFixture(t, "m8", [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit(), assistantText("working")]);
  for (const mode of ["chat", undefined]) {
    const r = fx.stop({ SKYLINE_LOOP_REPORT: mode }, undefined, undefined, { last_assistant_message: FINAL_ATTESTATION_TEXT });
    assert.equal(r.code, 0, `mode ${mode}: ${r.err}`);
  }
  const r = fx.stop(undefined, undefined, undefined, { last_assistant_message: "slices shipped: 1 (abc)\nall done" });
  assert.equal(r.code, 2);
});

// --- 1.5.38 bounce 1: unscoped inherited sessions, /branch, counter name cap

test("Minor 2: a fork whose parent cannot be read keeps the 1.5.37 budget: 3 turns x 3 Stops = 2 blocks; a scoped fork's own build keeps the per-turn budget", (t) => {
  const fx = forkFixture(t, "b1m2", { parent: false });
  const codes = [];
  for (const p of ["t1", "t2", "t3"]) for (let k = 0; k < 3; k += 1) codes.push(turnStop(fx, p).code);
  assert.deepEqual(codes, [2, 2, 0, 0, 0, 0, 0, 0, 0], "session-wide, never reset (1.5.37: 2 blocks per session)");
  assert.equal(fs.readFileSync(counterFile(fx.sid), "utf8"), "9");
  const scoped = forkFixture(t, "b1m2s", {
    ownEntries: [...assistantSkillInvoke("feature-loop-skill").split("\n"), assistantGitCommit(), assistantText("slice 1 done")],
  });
  assert.deepEqual([turnStop(scoped, "t1"), turnStop(scoped, "t1"), turnStop(scoped, "t1"), turnStop(scoped, "t2")].map((r) => r.code), [2, 2, 0, 2]);
});

// /branch, reconstructed from the Claude Code 2.1.332 bundle (bounce 1
// Minor 3; not verified live): copied entries keep their uuid and carry
// forkedFrom {sessionId: <parent>, messageUuid}; a via:"branch" marker comes
// AFTER the copies, and only when data flow is on.
function branchFixture(t, tag, { marker = true, parent = true, ownBuild = false } = {}) {
  const fx = reportFixture(t, tag, []);
  const pid = `${fx.sid}-parent`;
  const parentReport = path.join(fx.dir, `${pid}.md`);
  const parentEntries = [
    ...assistantSkillInvoke("feature-loop-skill").split("\n"),
    assistantGitCommit(),
    ...liveWrites(parentReport),
    finalCreate(parentReport),
    assistantText(`FINAL stored: ${parentReport}`),
  ];
  const uuid = (i) => `${pid}-u${i}`;
  if (parent) fs.writeFileSync(path.join(fx.tmp, `${pid}.jsonl`), parentEntries.map((l, i) => withUuid(l, uuid(i), pid)).join("\n") + "\n");
  const copies = parentEntries.map((l, i) => JSON.stringify({ ...JSON.parse(withUuid(l, uuid(i), fx.sid)), forkedFrom: { sessionId: pid, messageUuid: uuid(i) } }));
  const own = [
    line({ type: "user", message: { content: "Reply with exactly: ok" } }),
    ...(ownBuild ? [...assistantSkillInvoke("feature-loop-skill").split("\n"), assistantGitCommit()] : []),
    assistantText("ok"),
  ].map((l, i) => withUuid(l, `${fx.sid}-own${i}`, fx.sid));
  const mark = marker ? [line({ type: "derived-from", v: 1, sessionId: fx.sid, sessions: [{ type: "claude_code_session", id: pid, via: "branch" }] })] : [];
  fs.writeFileSync(fx.transcript, [...copies, ...mark, ...own].join("\n") + "\n");
  return fx;
}

test("Minor 3: /branch shapes (marker + parent, no marker, marker + parent missing) owe no FINAL; the branch's own build is gated", (t) => {
  for (const [label, opts] of [
    ["marker via=branch, parent present", {}],
    ["no marker (data flow off), parent present", { marker: false }],
    ["marker, parent missing", { parent: false }],
  ]) {
    const fx = branchFixture(t, `b1m3-${label.length}`, opts);
    const r = fx.stop();
    assert.equal(r.code, 0, `${label}: ${r.err}`);
  }
  const own = branchFixture(t, "b1m3-own", { ownBuild: true });
  const r = own.stop();
  assert.equal(r.code, 2, "negative control: the branch's own Skill + commit with no FINAL");
  assert.ok(r.err.includes(own.report), "names the branch's own report path");
});

test("nit 6: a 200-char session id and prompt_id still give a usable counter name (hashed turn part); the gate blocks instead of failing open", (t) => {
  const raw = "s".repeat(200);
  const fx = reportFixture(t, "b1n6", [assistantSkillInvoke("feature-loop-skill"), assistantGitCommit()]);
  fx.track(sidName(raw));
  const r = fx.stop({ SKYLINE_LOOP_REPORT: "chat" }, raw, undefined, { prompt_id: "p".repeat(200) });
  assert.equal(r.code, 2, "1.5.38 before the cap: ENAMETOOLONG => exit 0 from the first Stop");
  const names = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`skyline-loop-gate-${sidName(raw)}@`));
  assert.equal(names.length, 1, names.join(","));
  assert.match(names[0], /@~[0-9a-f]{16}$/);
  assert.ok(names[0].length <= 200, `${names[0].length} chars`);
});

// --- bounce 2 finding 1: fork chains. Markers list every ancestor, oldest
// first, the immediate parent last (live fork-of-fork). Only the immediate
// parent covers the whole inherited history; when it is neither read nor
// named by the stamps the session is unscoped (1.5.37 budget). Shapes from
// the round-2 review's u3chain.js: A = grandparent (Q&A), B = immediate parent
// (inherits A, then builds: Skill + commit, no FINAL), C = this session.
function chainFixture(t, tag, build) {
  const fx = reportFixture(t, tag, []);
  const A = `${fx.sid}-A`;
  const B = `${fx.sid}-B`;
  const ent = (type, uuid, content, x = {}) => JSON.stringify({ type, uuid, ...x, message: { role: type, content } });
  const stamp = (from) => ({ forkedFrom: { sessionId: from, messageUuid: "m" } });
  const skill = (u, x) => ent("assistant", u, [{ type: "tool_use", name: "Skill", input: { skill: "skyline-claude:feature-loop-skill" } }], x);
  const commit = (u, x) => ent("assistant", u, [{ type: "tool_use", name: "Bash", input: { command: "git commit -m x" } }], x);
  const df = (list) => line({ type: "derived-from", v: 1, sessions: list.map(([id, via]) => ({ type: "claude_code_session", id, via })) });
  const aEntries = (x) => [ent("user", "a0", "hi", x), ent("assistant", "a1", [{ type: "text", text: "hello" }], x)];
  const bOwn = (x) => [ent("user", "b0", "build", x), skill("b1", x), commit("b2", x)];
  const cOwnQA = [ent("user", "c0", "Reply ok"), ent("assistant", "c1", [{ type: "text", text: "ok" }])];
  const cOwnBuild = [ent("user", "c0", "go"), skill("c1"), commit("c2")];
  const { lines, files } = build({ A, B, df, stamp, aEntries, bOwn, cOwnQA, cOwnBuild });
  fs.writeFileSync(fx.transcript, lines.join("\n") + "\n");
  for (const [id, ls] of Object.entries(files)) fs.writeFileSync(path.join(fx.tmp, `${id}.jsonl`), ls.join("\n") + "\n");
  return fx;
}

function threeTurns(fx) {
  const codes = [];
  for (const p of ["t1", "t2", "t3"]) for (let k = 0; k < 3; k += 1) codes.push(turnStop(fx, p).code);
  return codes;
}

test("bounce 2 finding 1: a chain whose immediate parent is gone is unscoped (2 blocks over 3 turns), never scoped by an older ancestor", (t) => {
  const shapes = [
    ["chain [A/fork, B/fork], A present, B missing", (s) => ({ lines: [s.df([[s.A, "fork"], [s.B, "fork"]]), ...s.aEntries(), ...s.bOwn(), ...s.cOwnQA], files: { [s.A]: s.aEntries() } })],
    ["H' [A/branch, B/fork], stamps name A, A and B missing", (s) => ({ lines: [s.df([[s.A, "branch"], [s.B, "fork"]]), ...s.aEntries(s.stamp(s.A)), ...s.bOwn(), ...s.cOwnQA], files: {} })],
  ];
  for (const [label, build] of shapes) {
    const fx = chainFixture(t, `b2f1-${label.length}`, build);
    const codes = threeTurns(fx);
    assert.deepEqual(codes, [2, 2, 0, 0, 0, 0, 0, 0, 0], `${label} (980460e: 2,2,0 per turn = 6 blocks)`);
  }
});

test("bounce 2 finding 1 controls: branch of branch, chain with B present, fork of a branch with B present owe nothing; C's own build stays gated per turn", (t) => {
  const zero = [
    ["branch of branch, stamps name B, A and B missing", (s) => ({ lines: [...s.aEntries(s.stamp(s.B)), ...s.bOwn(s.stamp(s.B)), s.df([[s.A, "branch"], [s.B, "branch"]]), ...s.cOwnQA], files: {} })],
    ["chain [A/fork, B/fork], A missing, B present", (s) => ({ lines: [s.df([[s.A, "fork"], [s.B, "fork"]]), ...s.aEntries(), ...s.bOwn(), ...s.cOwnQA], files: { [s.B]: [...s.aEntries(), ...s.bOwn()] } })],
    ["fork of a branch [A/branch, B/fork], B present", (s) => ({ lines: [s.df([[s.A, "branch"], [s.B, "fork"]]), ...s.aEntries(s.stamp(s.A)), ...s.bOwn(), ...s.cOwnQA], files: { [s.B]: [...s.aEntries(s.stamp(s.A)), ...s.bOwn()] } })],
  ];
  for (const [label, build] of zero) {
    const fx = chainFixture(t, `b2c-${label.length}`, build);
    assert.deepEqual(threeTurns(fx), [0, 0, 0, 0, 0, 0, 0, 0, 0], label);
  }
  const own = chainFixture(t, "b2c-own", (s) => ({
    lines: [s.df([[s.A, "fork"], [s.B, "fork"]]), ...s.aEntries(), ...s.bOwn(), ...s.cOwnBuild],
    files: { [s.B]: [...s.aEntries(), ...s.bOwn()] },
  }));
  assert.deepEqual(threeTurns(own), [2, 2, 0, 2, 2, 0, 2, 2, 0], "C's own build: scoped, per-turn budget");
});
