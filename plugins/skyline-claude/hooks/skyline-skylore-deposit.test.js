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

// Every session id used below MUST be listed here: cleanMarkers() runs at load
// and in after(), and a marker left behind makes the NEXT suite's first fire
// (e.g. the grok twin, which shares $TMPDIR and the marker naming) a silent
// no-block, which surfaces as a JSON.parse of "".
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
    input: JSON.stringify(input),
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
// Marker keys (CLAUDE_SESSION_ID) are pid-suffixed `sess-qlr-*` names, never
// the grok twin's `sess-deposit-*` ones, and every one is pushed onto SESSIONS
// so after(cleanMarkers) removes it. Report dirs are fresh temp dirs.

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
    assert.equal(fs.existsSync(markerPath(sess)), false, "no marker taken by a silent pass");
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

test("Q5: neither: blocks ONCE, names the newest existing report file (append, never overwrite); then never again", (t) => {
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
  assert.ok(reason.includes(`append one line \`skylore: nothing durable\` to \`${fx.paths.debug}\``), reason);
  assert.match(reason, /never overwrite that file/);
  assert.doesNotMatch(reason, /does not exist yet/);
  // The pinned invariants of the prompt survive the file wording.
  assert.match(reason, /re-derive/);
  assert.match(reason, /"Nothing durable" is a correct answer/);
  assert.match(reason, /invoke skylore-deposit-skill/);
  assert.match(reason, /Chat gets nothing, or one line\./);
  assert.ok(reason.length < 800, `still a pointer (${reason.length} chars)`);
  const r2 = runQ(fx, sess);
  assert.equal(r2.out, "", "second Stop: no block");
  const r3 = runQ(fx, qlrSess("once-active"), { extra: { stop_hook_active: true } });
  assert.equal(r3.out, "", "stop_hook_active: no block");
});

test("Q5: no report file yet: names the FINAL path with the create-with-header hint; following it literally answers the next session", (t) => {
  const fx = qFixture(t, "stub");
  const sess = qlrSess("stub");
  const r = runQ(fx, sess);
  assert.equal(r.block.decision, "block");
  const reason = r.block.reason;
  assert.ok(reason.includes(`to \`${fx.paths.final}\` (it does not exist yet: create it with the lines \`# skylore REPORT\` and \`loop-report: v1\` first)`), reason);
  // Follow the instruction literally.
  fs.writeFileSync(fx.paths.final, "# skylore REPORT\nloop-report: v1\nskylore: nothing durable\n");
  const again = runQ(fx, qlrSess("stub-fresh"));
  assert.equal(again.out, "", "fresh marker, same session_id: silent");
  assert.equal(gate.isLoopReport(fx.paths.final), true, "the stub carries the header, so retention can prune it");
  // A stub at the FINAL path never satisfies the Stop gate's FINAL fields.
  assert.deepEqual(gate.missingFields(fs.readFileSync(fx.paths.final, "utf8")).slice(0, 4), ["checkpoint", "deviations", "slices", "tests"]);
});

test("Q5: fail-open: garbage transcript, a directory as transcript, JSON null: exit 0, at most one well-formed block", (t) => {
  const fx = qFixture(t, "garbage");
  fs.writeFileSync(fx.transcript, "\u0000ÿ not json {{{\n" + "x".repeat(1000) + "lore_mark\n");
  let r = runQ(fx, qlrSess("garbage"));
  assert.equal(r.status, 0);
  assert.equal(r.block.decision, "block", "no evidence => the normal single block");
  r = runQ(fx, qlrSess("garbage-dir"), { extra: { transcript_path: fx.dir } });
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
  fs.writeFileSync(markerPath(sess), "");
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

test("Q5: file mode without a usable session_id keeps the legacy prompt", (t) => {
  const fx = qFixture(t, "nosid");
  for (const sid of [undefined, ".", 42]) {
    const r = runQ(fx, qlrSess(`nosid-${String(sid)}`), { extra: { session_id: sid } });
    assert.equal(r.block.reason, DEPOSIT_PROMPT_LEGACY, `session_id ${String(sid)}`);
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
  const cases = [{}, { stop_hook_active: true }, { session_id: undefined }, { transcript_path: undefined }];
  cases.forEach((extra, i) => {
    const now = runQ(fx, qlrSess(`diff-new-${i}`), { mode: "chat", extra });
    const then = runQ(fx, qlrSess(`diff-old-${i}`), { mode: "chat", extra, hook: old });
    assert.equal(now.status, then.status, `case ${i}`);
    assert.equal(now.out, then.out, `case ${i}`);
  });
  // And the repeat Stop (marker taken) in both.
  assert.equal(runQ(fx, `sess-qlr-diff-new-0-${process.pid}`, { mode: "chat" }).out, "");
  assert.equal(runQ(fx, `sess-qlr-diff-old-0-${process.pid}`, { mode: "chat", hook: old }).out, "");
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
