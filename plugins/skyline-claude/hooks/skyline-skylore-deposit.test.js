// node:test for skyline-skylore-deposit.js (skylence-plugins #411 scope (d)).
// Run with: node --test plugins/skyline-claude/hooks/skyline-skylore-deposit.test.js
// Once-per-session Stop deposit trigger: the first Stop blocks with the deposit
// prompt, a repeat Stop (or stop_hook_active) allows, malformed stdin exits 0.
// Self-contained; cleans its marker files.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.resolve(__dirname, "skyline-skylore-deposit.js");

// Every marker key used below MUST be listed here: cleanMarkers() runs at load
// and in after(), and a marker left behind makes the NEXT suite's first fire
// (e.g. the grok twin, which shares $TMPDIR and the marker naming) a silent
// no-block, which surfaces as a JSON.parse of "". Since 1.5.38 the key is the
// stdin session_id (else the parent pid), so run() sends sess as session_id.
const SESSIONS = [
  "sess-deposit-once",
  "sess-deposit-active",
  "sess-deposit-bad",
  "sess-deposit-skill-ref",
];

function markerPath(sess) {
  const key = String(sess).replace(/[^a-z0-9_-]/gi, "_");
  return path.join(os.tmpdir(), `skyline-skylore-deposit-${key}.marker`);
}

function cleanMarkers() {
  for (const s of SESSIONS) {
    try {
      fs.rmSync(markerPath(s), { force: true });
    } catch {}
  }
}

cleanMarkers();
after(cleanMarkers);

function run(input, sess) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: sess, ...input }),
    env: { ...process.env, CLAUDE_SESSION_ID: sess },
  });
}

test("fires exactly once per session: first Stop blocks, second allows", () => {
  const sess = "sess-deposit-once";
  const r1 = run({ stop_hook_active: false }, sess);
  const r2 = run({ stop_hook_active: false }, sess);

  assert.equal(r1.status, 0, "first fire exits 0 with JSON");
  const out = JSON.parse(r1.stdout.trim());
  assert.equal(out.decision, "block", "first Stop blocks");
  // The prompt is a POINTER now: the procedure lives in the skill. Assert the
  // two things that must survive inline (the question, and that an empty
  // deposit is allowed) plus the handoff itself. A prompt that names the skill
  // but no longer offers the exit ramp would push every session into a deposit.
  assert.match(out.reason, /re-derive/, "asks the durability question inline");
  assert.match(out.reason, /"Nothing durable" is a correct answer/, "empty deposit stays an explicit answer");
  assert.match(out.reason, /invoke skylore-deposit-skill/, "hands off to the skill");
  assert.ok(
    out.reason.length < 400,
    `prompt must stay a pointer, not a procedure (was ${out.reason.length} chars)`
  );

  assert.equal(r2.status, 0, "second fire exits 0");
  assert.equal(r2.stdout.trim(), "", "second Stop in the same session does not block");
});

test("stop_hook_active=true never blocks (loop guard)", () => {
  const res = run({ stop_hook_active: true }, "sess-deposit-active");
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "", "no block while already continuing from a stop hook");
});

test("malformed stdin exits 0 silent", () => {
  const res = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: "{ not json",
    env: { ...process.env, CLAUDE_SESSION_ID: "sess-deposit-bad" },
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
});

// The prompt hands off to a skill by NAME. A pointer to a skill that does not
// exist, or whose frontmatter name has drifted, dies silently: the agent is
// told to invoke something unloadable and is left with no procedure at all.
// Same failure class as a hooks.json matcher that can never match.
test("the skill the prompt names exists and its frontmatter name matches", () => {
  const res = run({ stop_hook_active: false }, "sess-deposit-skill-ref");
  const named = JSON.parse(res.stdout.trim()).reason.match(
    /invoke ([a-z0-9-]+-skill)/
  );
  assert.ok(named, "prompt names a skill to invoke");

  const skillFile = path.resolve(
    __dirname,
    "..",
    "skills",
    named[1],
    "SKILL.md"
  );
  assert.ok(fs.existsSync(skillFile), `${named[1]} ships at skills/${named[1]}/SKILL.md`);

  const frontmatter = fs.readFileSync(skillFile, "utf8").split("---")[1] || "";
  assert.match(
    frontmatter,
    new RegExp(`name:\\s*${named[1]}\\b`),
    "SKILL.md frontmatter name matches the name the prompt invokes"
  );
});

// --- 1.5.37: silent answer (Q5) and the chat switch (Q6) --------------------
// Marker keys are the stdin session_id since 1.5.38: each fixture's own
// pid-suffixed `qlr-*` id (pushed onto SESSIONS, so after(cleanMarkers)
// removes it), never the grok twin's `sess-deposit-*` ones. CLAUDE_SESSION_ID
// (`sess-qlr-*`) only keys the 1.5.36 hook of the differential test. Report
// dirs are fresh temp dirs.

const helper = require("./loop-report-path");
const gate = require("./skyline-loop-gate");

// The pre-1.5.37 prompt, byte for byte (chat mode and no-path file mode).
const DEPOSIT_PROMPT_LEGACY =
  "Stop check: anything this session that would cost the next one real time to re-derive? \"Nothing durable\" is a correct answer — say it and stop. If there IS something, invoke skylore-deposit-skill and follow it: it covers recall-before-mark, supersede-instead-of-duplicate, scoping, and what does not belong in the bank.";

function qlrSess(tag) {
  const s = `sess-qlr-${tag}-${process.pid}`;
  SESSIONS.push(s);
  fs.rmSync(markerPath(s), { force: true });
  return s;
}

function qFixture(t, tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-qlr-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, "reports");
  fs.mkdirSync(dir);
  const sessionId = `qlr-${tag}-${process.pid}-${Date.now()}`;
  SESSIONS.push(sessionId);
  fs.rmSync(markerPath(sessionId), { force: true });
  const transcript = path.join(tmp, "transcript.jsonl");
  fs.writeFileSync(transcript, "");
  const paths = helper.reportPaths(sessionId, { SKYLINE_LOOP_REPORT_DIR: dir });
  return { tmp, dir, sessionId, transcript, paths };
}

function runQ(fx, sess, { mode, extra, hook = HOOK } = {}) {
  const env = { ...process.env, CLAUDE_SESSION_ID: sess, SKYLINE_LOOP_REPORT_DIR: fx.dir };
  delete env.SKYLINE_LOOP_REPORT;
  if (mode !== undefined) env.SKYLINE_LOOP_REPORT = mode;
  const input = { session_id: fx.sessionId, transcript_path: fx.transcript, stop_hook_active: false, ...(extra || {}) };
  const res = spawnSync(process.execPath, [hook], { encoding: "utf8", input: JSON.stringify(input), env });
  const out = res.stdout.trim();
  return { status: res.status, out, block: out ? JSON.parse(out) : null };
}

function jsonl(entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function toolUse(name, input = {}) {
  return { type: "assistant", message: { content: [{ type: "tool_use", name, input }] } };
}

test("Q5: an assistant lore_mark / lore_supersede tool_use in the transcript answers the check: no block, marker not taken", (t) => {
  for (const name of ["mcp__skyline__lore_mark", "mcp__plugin_skyline-claude_skyline__lore_supersede"]) {
    const fx = qFixture(t, "lore");
    const sess = qlrSess(`lore-${name.length}`);
    fs.writeFileSync(fx.transcript, jsonl([{ type: "user", message: { content: "hi" } }, toolUse(name, { body: "x" })]));
    const r = runQ(fx, sess);
    assert.equal(r.status, 0);
    assert.equal(r.out, "", `${name}: silent`);
    assert.equal(fs.existsSync(markerPath(fx.sessionId)), false, "no marker taken by a silent pass");
  }
});

// Bounce 1 I1: lore_recall is a READ, not an answer. Every compliant skyline
// session recalls at start, so counting it would silence the check for good.
test("Q5 (I1): a transcript whose only lore call is lore_recall still blocks once", (t) => {
  const fx = qFixture(t, "recall-only");
  const sess = qlrSess("recall-only");
  fs.writeFileSync(
    fx.transcript,
    jsonl([
      toolUse("mcp__plugin_skyline-claude_skyline__lore_recall", { query: "x" }),
      toolUse("mcp__skyline__lore_recall", { query: "y" }),
    ])
  );
  const r = runQ(fx, sess);
  assert.equal(r.status, 0);
  assert.ok(r.block && r.block.decision === "block", "lore_recall alone does not answer the check");
  assert.equal(runQ(fx, sess).out, "", "and it still blocks only once");
});

test("Q5: lore_* named only in prose, a tool listing or a non-lore tool does not answer it (parsed blocks, not substrings)", (t) => {
  const fx = qFixture(t, "ambient");
  const sess = qlrSess("ambient");
  fs.writeFileSync(
    fx.transcript,
    jsonl([
      { type: "attachment", attachment: { type: "deferred_tools", names: ["mcp__skyline__lore_mark", "mcp__skyline__lore_recall"] } },
      { type: "assistant", message: { content: [{ type: "text", text: "I could call lore_mark or lore_recall here." }] } },
      toolUse("mcp__skyline__lore_mark_helper"),
      toolUse("ToolSearch", { query: "select:mcp__skyline__lore_mark" }),
      { type: "user", message: { content: [{ type: "tool_use", name: "mcp__skyline__lore_mark" }] } },
    ])
  );
  const r = runQ(fx, sess);
  assert.equal(r.status, 0);
  assert.ok(r.block && r.block.decision === "block", "still blocks");
});

test("Q5: a `skylore:` line at column 0 in the FINAL, debug or review report answers it; a tree-prefixed one does not", (t) => {
  for (const kind of ["final", "debug", "review"]) {
    for (const line of ["skylore: nothing durable", "skylore: marked 671"]) {
      const fx = qFixture(t, `line-${kind}`);
      const sess = qlrSess(`line-${kind}-${line.length}`);
      fs.writeFileSync(fx.paths[kind], `# ${kind}-loop REPORT\nloop-report: v1\nroot cause: x\n${line}\n`);
      const r = runQ(fx, sess);
      assert.equal(r.status, 0);
      assert.equal(r.out, "", `${kind} / ${line}: silent`);
    }
  }
  const fx = qFixture(t, "prefixed");
  const sess = qlrSess("prefixed");
  fs.writeFileSync(fx.paths.final, "# feature-loop FINAL\nloop-report: v1\n└─ skylore: nothing durable\n");
  const r = runQ(fx, sess);
  assert.ok(r.block, "a tree-prefixed skylore line is not a column-0 answer");
});

test("Q5: neither: blocks ONCE, names the newest existing report file (append, or include it in the report you write); then never again", (t) => {
  const fx = qFixture(t, "once");
  const sess = qlrSess("once");
  fs.writeFileSync(fx.paths.final, "# feature-loop FINAL\nloop-report: v1\nslices shipped: 1\n");
  fs.writeFileSync(fx.paths.debug, "# debug-loop REPORT\nloop-report: v1\nroot cause: x\n");
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(fx.paths.final, old, old);
  const r1 = runQ(fx, sess);
  assert.equal(r1.status, 0);
  assert.equal(r1.block.decision, "block");
  const reason = r1.block.reason;
  assert.ok(
    reason.includes(`append the \`skylore:\` line (\`skylore: nothing durable\`) to \`${fx.paths.debug}\`, or include it in the report you write.`),
    reason
  );
  assert.doesNotMatch(reason, /never overwrite/, "M3: no contradiction with the gate's create (overwrite:true)");
  assert.doesNotMatch(reason, /does not exist yet/);
  // The pinned invariants of the prompt survive the file wording.
  assert.match(reason, /re-derive/);
  assert.match(reason, /"Nothing durable" is a correct answer/);
  assert.match(reason, /invoke skylore-deposit-skill/);
  assert.match(reason, /Chat gets nothing, or one line\./);
  assert.ok(reason.length < 800, `still a pointer (${reason.length} chars)`);
  const r2 = runQ(fx, sess);
  assert.equal(r2.out, "", "second Stop: no block");
  const r3 = runQ(fx, qlrSess("once-active"), { extra: { stop_hook_active: true, session_id: `${fx.sessionId}-active` } });
  assert.equal(r3.out, "", "stop_hook_active: no block");
});

test("M2: no report file this session: the pre-1.5.37 chat prompt, no file named, nothing written", (t) => {
  const fx = qFixture(t, "nofile");
  const r = runQ(fx, qlrSess("nofile"));
  assert.equal(r.block.decision, "block");
  assert.equal(r.block.reason, DEPOSIT_PROMPT_LEGACY);
  assert.deepEqual(fs.readdirSync(fx.dir), [], "no stub report is asked for or created");
});

test("M2/M3: a FINAL report file exists: the prompt names it and says append, or include it in the FINAL you write", (t) => {
  const fx = qFixture(t, "final-only");
  fs.writeFileSync(fx.paths.final, "# feature-loop FINAL\nloop-report: v1\nCHECKPOINT: post-model = done\n");
  const r = runQ(fx, qlrSess("final-only"));
  assert.ok(
    r.block.reason.includes(`append the \`skylore:\` line (\`skylore: nothing durable\`) to \`${fx.paths.final}\`, or include it in the FINAL you write.`),
    r.block.reason
  );
  // The gate's Stop message gives the same instruction for the same file.
  const gateSrc = fs.readFileSync(path.join(__dirname, "skyline-loop-gate.js"), "utf8");
  assert.ok(gateSrc.includes("append the \\`skylore:\\` line, or include it in the FINAL you write"));
});

test("Q5: fail-open: garbage transcript, a directory as transcript, JSON null: exit 0, at most one well-formed block", (t) => {
  const fx = qFixture(t, "garbage");
  fs.writeFileSync(fx.transcript, "\u0000ÿ not json {{{\n" + "x".repeat(1000) + "lore_mark\n");
  let r = runQ(fx, qlrSess("garbage"));
  assert.equal(r.status, 0);
  assert.equal(r.block.decision, "block", "no evidence => the normal single block");
  const dirSid = `${fx.sessionId}-dir`;
  SESSIONS.push(dirSid);
  r = runQ(fx, qlrSess("garbage-dir"), { extra: { transcript_path: fx.dir, session_id: dirSid } });
  assert.equal(r.status, 0);
  assert.equal(r.block.decision, "block");
  const nul = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: "null",
    env: { ...process.env, CLAUDE_SESSION_ID: qlrSess("garbage-null") },
  });
  assert.equal(nul.status, 0);
  assert.equal(nul.stdout.trim(), "");
});

test("Q5: an already-taken marker exits before any transcript or report read", (t) => {
  const fx = qFixture(t, "taken");
  const sess = qlrSess("taken");
  fs.writeFileSync(markerPath(fx.sessionId), "");
  // A transcript path that would answer the check is irrelevant: the marker wins.
  const r = runQ(fx, sess, { extra: { transcript_path: path.join(fx.tmp, "missing.jsonl") } });
  assert.equal(r.status, 0);
  assert.equal(r.out, "");
});

test("Q6: SKYLINE_LOOP_REPORT=chat blocks as before: lore_* calls and skylore lines are ignored, the prompt is the legacy one", (t) => {
  const fx = qFixture(t, "chat");
  fs.writeFileSync(fx.transcript, jsonl([toolUse("mcp__skyline__lore_recall")]));
  fs.writeFileSync(fx.paths.final, "loop-report: v1\nskylore: nothing durable\n");
  const sess = qlrSess("chat");
  const r = runQ(fx, sess, { mode: "chat" });
  assert.equal(r.status, 0);
  assert.equal(r.block.decision, "block");
  assert.equal(r.block.reason, DEPOSIT_PROMPT_LEGACY);
  assert.equal(runQ(fx, sess, { mode: "chat" }).out, "", "still exactly once");
});

test("Q5: file mode without a usable session_id keeps the legacy prompt (marker keyed by the parent pid)", (t) => {
  const fx = qFixture(t, "nosid");
  const ppidKey = String(process.pid); // the hook's ppid is this test process
  SESSIONS.push(ppidKey);
  for (const sid of [undefined, ".", 42]) {
    fs.rmSync(markerPath(ppidKey), { force: true });
    const r = runQ(fx, qlrSess(`nosid-${String(sid)}`), { extra: { session_id: sid } });
    assert.equal(r.block.reason, DEPOSIT_PROMPT_LEGACY, `session_id ${String(sid)}`);
    assert.ok(fs.existsSync(markerPath(ppidKey)), "ppid fallback key");
  }
});

// Q6 differential vs origin/main 11a0426 (1.5.36): in chat mode the hook's
// stdout and exit code equal the old hook's for inputs where file mode would
// differ. Old and new runs use distinct marker keys (they share the naming).
const BASE_SHA = "11a04269a6ada5f923581c246a7560eb5d9d3665";

test("Q6 differential: chat mode output equals the 1.5.36 deposit hook for the same inputs", (t) => {
  const repo = path.resolve(__dirname, "..", "..", "..");
  const show = spawnSync("git", ["show", `${BASE_SHA}:plugins/skyline-claude/hooks/skyline-skylore-deposit.js`], { cwd: repo, encoding: "utf8" });
  if (show.status !== 0 || !show.stdout) {
    t.skip(`base commit ${BASE_SHA.slice(0, 7)} not in the object store`);
    return;
  }
  const fx = qFixture(t, "diff");
  const old = path.join(fx.tmp, "old-deposit.js");
  fs.writeFileSync(old, show.stdout);
  fs.writeFileSync(fx.transcript, jsonl([toolUse("mcp__skyline__lore_mark")]));
  fs.writeFileSync(fx.paths.review, "loop-report: v1\nskylore: nothing durable\n");
  // Distinct stdin session ids per case: the new hook keys its marker on it,
  // the old one on CLAUDE_SESSION_ID (qlrSess), so neither run sees the
  // other's marker. Case 2 (no session_id) keys the new hook on the ppid.
  const ppidKey = String(process.pid);
  SESSIONS.push(ppidKey);
  const cases = [{}, { stop_hook_active: true }, { session_id: undefined }, { transcript_path: undefined }];
  cases.forEach((extra, i) => {
    const sid = `${fx.sessionId}-c${i}`;
    SESSIONS.push(sid);
    if (i === 2) fs.rmSync(markerPath(ppidKey), { force: true });
    const now = runQ(fx, qlrSess(`diff-new-${i}`), { mode: "chat", extra: { session_id: sid, ...extra } });
    const then = runQ(fx, qlrSess(`diff-old-${i}`), { mode: "chat", extra: { session_id: sid, ...extra }, hook: old });
    assert.equal(now.status, then.status, `case ${i}`);
    assert.equal(now.out, then.out, `case ${i}`);
  });
  // And the repeat Stop (marker taken) in both.
  assert.equal(runQ(fx, `sess-qlr-diff-new-0-${process.pid}`, { mode: "chat", extra: { session_id: `${fx.sessionId}-c0` } }).out, "");
  assert.equal(runQ(fx, `sess-qlr-diff-old-0-${process.pid}`, { mode: "chat", extra: { session_id: `${fx.sessionId}-c0` }, hook: old }).out, "");
});

// Skill text <-> hook contract: each loop skill prescribes its report header
// and a column-0 `skylore:` line; a report in exactly that shape answers the
// Stop check, so the normal path of a loop session never blocks.
test("Q5: the report shape each loop SKILL.md prescribes (header + column-0 skylore line) answers the check", (t) => {
  const skills = path.resolve(__dirname, "..", "skills");
  const shapes = [
    ["feature-loop-skill", "# feature-loop FINAL", "final"],
    ["debug-loop-skill", "# debug-loop REPORT", "debug"],
    ["review-loop-skill", "# review-loop REPORT", "review"],
  ];
  for (const [skill, header, kind] of shapes) {
    const text = fs.readFileSync(path.join(skills, skill, "SKILL.md"), "utf8");
    assert.ok(text.includes(`\`${header}\` → \`loop-report: v1\``), `${skill} prescribes its header`);
    assert.ok(text.includes("`skylore: <nothing durable | marked <ids>>` at column 0"), `${skill} prescribes the skylore line`);
    assert.match(text, /dispatch brief names a destination .* ⇒ post there as well; .*still .*(report file|FINAL there)/, `${skill}: brief adds a destination, never replaces the file`);
    assert.doesNotMatch(text, /brief wins/, `${skill}: no "brief wins" (read as "skip the file")`);
    assert.match(text, /no path given \(.*SKYLINE_LOOP_REPORT=chat.*\) ⇒ .*in chat as before/, `${skill}: no-path fallback`);
    const fx = qFixture(t, `shape-${kind}`);
    fs.writeFileSync(fx.paths[kind], `${header}\nloop-report: v1\nrepo: /r\nbranch: b\ndate: 2026-11-25T00:00:00Z\nskylore: nothing durable\n`);
    const r = runQ(fx, qlrSess(`shape-${kind}`));
    assert.equal(r.status, 0);
    assert.equal(r.out, "", `${skill} shape: silent`);
  }
});

// --- 1.5.38: marker key and fork scoping (audit I3) -------------------------

// Runs the hook as the child of a fresh intermediate process, so its ppid
// differs from the other runs' (a resumed Claude Code session is a new
// process with the same session_id).
function runViaNewParent(input, reportDir) {
  const res = spawnSync(
    process.execPath,
    [
      "-e",
      'const r = require("child_process").spawnSync(process.execPath, [process.argv[1]], { input: process.argv[2], encoding: "utf8", env: process.env }); process.stdout.write(r.stdout || "");',
      HOOK,
      JSON.stringify(input),
    ],
    {
      encoding: "utf8",
      env: (() => {
        const e = { ...process.env, SKYLINE_LOOP_REPORT_DIR: reportDir };
        delete e.CLAUDE_SESSION_ID;
        delete e.SKYLINE_LOOP_REPORT;
        return e;
      })(),
    }
  );
  return res.stdout.trim();
}

test("I3 marker: keyed by the stdin session_id: two sessions under one parent each block once; a resume (new process, same id) does not re-fire", (t) => {
  const fx = qFixture(t, "key-a");
  const other = `${fx.sessionId}-b`;
  SESSIONS.push(other);
  const env = { ...process.env, SKYLINE_LOOP_REPORT_DIR: fx.dir };
  delete env.CLAUDE_SESSION_ID; // the real hook env has none (audit live facts)
  delete env.SKYLINE_LOOP_REPORT;
  const go = (sid) =>
    spawnSync(process.execPath, [HOOK], { encoding: "utf8", env, input: JSON.stringify({ session_id: sid, transcript_path: fx.transcript }) }).stdout.trim();
  assert.ok(go(fx.sessionId), "session A blocks once");
  assert.ok(go(other), "session B under the same parent process blocks once too");
  assert.equal(go(fx.sessionId), "", "A again: marker taken");
  assert.ok(fs.existsSync(markerPath(fx.sessionId)));
  assert.equal(runViaNewParent({ session_id: fx.sessionId, transcript_path: fx.transcript }, fx.dir), "", "resume of A from a new process: no re-fire");
});

function forkTranscript(fx, { parent = true, ownLore = false } = {}) {
  const pid = `${fx.sessionId}-parent`;
  const parentEntries = [toolUse("mcp__skyline__lore_mark", { body: "x" }), { type: "assistant", message: { content: [{ type: "text", text: "marked" }] } }];
  const withUuid = (e, uuid, sid) => ({ ...e, uuid, sessionId: sid });
  if (parent) fs.writeFileSync(path.join(fx.tmp, `${pid}.jsonl`), jsonl(parentEntries.map((e, i) => withUuid(e, `${pid}-u${i}`, pid))));
  const own = [{ type: "user", message: { content: "Reply with exactly: ok" } }, ...(ownLore ? [toolUse("mcp__skyline__lore_supersede", { id: 1 })] : [])];
  fs.writeFileSync(
    fx.transcript,
    jsonl([
      { type: "derived-from", v: 1, sessionId: fx.sessionId, sessions: [{ type: "claude_code_session", id: pid, via: "fork" }] },
      ...parentEntries.map((e, i) => withUuid(e, `${pid}-u${i}`, fx.sessionId)),
      ...own.map((e, i) => withUuid(e, `${fx.sessionId}-own${i}`, fx.sessionId)),
    ])
  );
}

test("I3 fork: a lore_mark inherited from the fork parent does not answer the check; the fork's own lore call does; parent missing => counted as before", (t) => {
  const inherited = qFixture(t, "fork-inh");
  forkTranscript(inherited);
  const r1 = runQ(inherited, qlrSess("fork-inh"));
  assert.ok(r1.block && r1.block.decision === "block", "the parent's answer is not the fork's");
  const own = qFixture(t, "fork-own");
  forkTranscript(own, { ownLore: true });
  assert.equal(runQ(own, qlrSess("fork-own")).out, "", "the fork's own lore_supersede answers it");
  const orphan = qFixture(t, "fork-orphan");
  forkTranscript(orphan, { parent: false });
  assert.equal(runQ(orphan, qlrSess("fork-orphan")).out, "", "parent transcript missing: no scoping (pre-1.5.38 behaviour)");
});
