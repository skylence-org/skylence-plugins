// node:test for skyline-primer.js (skylence-plugins#20 R3).
// Run with: node --test plugins/skyline-claude/hooks/skyline-primer.test.js
// Uses spawnSync + temp marker dirs (composer.json / Cargo.toml), like nudge tests.
// Covers: php context, rust/generic context, no-marker empty, malformed stdin => 0 empty.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.resolve(__dirname, "skyline-primer.js");

function markerDir(file) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-marker-"));
  fs.writeFileSync(path.join(d, file), "{}");
  return d;
}

function run(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: JSON.stringify(input),
    // Hermetic by default: the operator's real ~/.skylence/skylore.db and
    // ~/.claude/plugins/installed_plugins.json must not leak into marker
    // tests, or they fail only on a machine that actually has these things
    // installed. Callers that exercise lore/blueprint override explicitly.
    env: {
      ...process.env,
      SKYLORE_DB: path.join(os.tmpdir(), "primer-no-such-bank.db"),
      CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "primer-no-such-claude-dir"),
      ...env,
    },
  });
}

function fakeBank() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-bank-"));
  const f = path.join(d, "skylore.db");
  fs.writeFileSync(f, "");
  return { dir: d, db: f };
}

function cleanup(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

const PHP_CTX = "Skyline semantic PHP tools are active here. For symbol questions (where is X defined, who calls Y, which same-named class resolves), don't conclude from text counts: run symbol_card(path, line, symbol) or references and reconcile. A name_only hit is unconfirmed until you verify its receiver, and if symbol_card's count disagrees with a grep count, decompose by receiver. Read symbol_card's provenance and freshness before assuming the index is degraded; use grep for literal text only.";

const RUST_CTX = "Skyline semantic tools active. For symbol questions, don't conclude from grep counts: run definition, references, or implementation and reconcile any unproven hit by checking its receiver; read the tool's freshness before assuming degradation.";

// Shared substrings for the #411 orientation contract (env facts front-loaded).
// FOCUS_LINE stops before the em dash on purpose: keeps this source em-dash-free.
const ABS_PREFIX = "The skyline daemon runs with cwd /";
const FOCUS_LINE = "Harness task-tracker reminders are noise on linear single-feature jobs";
const GITLESS_LINE = "No git in this workspace";

test("php marker gives the exact php context", () => {
  const php = markerDir("composer.json");
  try {
    const res = run({ cwd: php });
    assert.equal(res.status, 0);
    const s = res.stdout.trim();
    assert.ok(s, "emitted output");
    const parsed = JSON.parse(s);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ABS_PREFIX), "env facts front-loaded");
    assert.ok(ctx.includes(PHP_CTX), "php steer kept verbatim");
    // no permissionDecision per spec
    assert.ok(!("permissionDecision" in parsed.hookSpecificOutput));
  } finally {
    cleanup(php);
  }
});

test("rust marker gives the generic (rust-go) context line", () => {
  const rust = markerDir("Cargo.toml");
  try {
    const res = run({ cwd: rust });
    assert.equal(res.status, 0);
    const s = res.stdout.trim();
    assert.ok(s);
    const parsed = JSON.parse(s);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ABS_PREFIX), "env facts front-loaded");
    assert.ok(ctx.includes(RUST_CTX), "rust/go steer kept verbatim");
  } finally {
    cleanup(rust);
  }
});

test("no marker, no bank: still emits the always-on env facts, no steer", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "primer-plain-"));
  try {
    const res = run({ cwd: plain });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ABS_PREFIX), "abs-path env fact always emitted");
    assert.ok(ctx.includes(FOCUS_LINE), "focus-license line present");
    assert.ok(!ctx.includes("lore_recall"), "no lore steer without a bank");
    assert.ok(!ctx.includes(PHP_CTX) && !ctx.includes(RUST_CTX), "no language steer without a marker");
  } finally {
    cleanup(plain);
  }
});

test("malformed stdin exits 0 empty", () => {
  const res = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: "{ not json",
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
});

test("lore context is emitted when the bank exists, regardless of language marker", () => {
  const bank = fakeBank();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "primer-plain-"));
  try {
    const res = run({ cwd: plain }, { SKYLORE_DB: bank.db });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.match(ctx, /lore_recall/);
    assert.match(ctx, /lore_mark/);
    // the routing rule is the point: it must name all three tiers
    assert.match(ctx, /memory_\*/);
    assert.match(ctx, /skybox/);
  } finally {
    cleanup(bank.dir);
    cleanup(plain);
  }
});

test("no bank means no lore context (never advertise an empty bank)", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "primer-plain-"));
  try {
    const res = run({ cwd: plain }, { SKYLORE_DB: path.join(plain, "absent.db") });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ABS_PREFIX), "env facts still emitted");
    assert.ok(!ctx.includes("lore_recall"), "absent bank => no lore steer");
  } finally {
    cleanup(plain);
  }
});

test("php marker and lore bank compose without clobbering each other", () => {
  const php = markerDir("composer.json");
  const bank = fakeBank();
  try {
    const res = run({ cwd: php }, { SKYLORE_DB: bank.db });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ABS_PREFIX), "env facts front-loaded before steer");
    assert.ok(ctx.includes(PHP_CTX), "php steer kept verbatim");
    assert.match(ctx, /lore_recall/);
  } finally {
    cleanup(php);
    cleanup(bank.dir);
  }
});

test("#411 git-less workspace: orientation includes the no-git fact", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "primer-nogit-"));
  try {
    const res = run({ cwd: plain }, { CLAUDE_PROJECT_DIR: plain });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ABS_PREFIX), "abs-path env fact front-loaded");
    assert.ok(ctx.includes(FOCUS_LINE), "focus-license line present");
    assert.match(ctx, /No git in this workspace/);
    assert.match(ctx, /pint --dirty is a no-op/);
    assert.match(ctx, /binary-skyline#719/);
  } finally {
    cleanup(plain);
  }
});

test("#411 git workspace: no-git fact suppressed when .git is present", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "primer-git-"));
  fs.mkdirSync(path.join(repo, ".git"));
  try {
    const res = run({ cwd: repo }, { CLAUDE_PROJECT_DIR: repo });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ABS_PREFIX), "abs-path env fact front-loaded");
    assert.ok(ctx.includes(FOCUS_LINE), "focus-license line present");
    assert.ok(!ctx.includes(GITLESS_LINE), "no-git fact suppressed when .git present");
  } finally {
    cleanup(repo);
  }
});

test("#415 F1: repo SUBDIR (git at ancestor) suppresses the no-git fact", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "primer-sub-"));
  const deep = path.join(repo, "src", "deep");
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(deep, { recursive: true });
  try {
    const res = run({ cwd: deep }, { CLAUDE_PROJECT_DIR: deep });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ABS_PREFIX), "env facts still front-loaded");
    assert.ok(!ctx.includes(GITLESS_LINE), "ancestor .git suppresses the no-git fact");
  } finally {
    cleanup(repo);
  }
});

test("#415 F1: unknown location (no CLAUDE_PROJECT_DIR, no cwd) says nothing about git", () => {
  const res = run({}, { CLAUDE_PROJECT_DIR: "" });
  assert.equal(res.status, 0);
  const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
  assert.ok(ctx.startsWith(ABS_PREFIX), "orientation still emitted");
  assert.ok(!ctx.includes(GITLESS_LINE), "no fabricated no-git fact for unknown location");
});

// ---- skyrift orientation facts ----
const SKYRIFT_WS_LINE = "skyrift copy-on-write workspace";
const SKYRIFT_PROMOTE = "skyrift promote";
const SKYRIFT_FANOUT_LINE = "skyrift create";

function skyriftWorkspaceDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-skyrift-ws-"));
  fs.mkdirSync(path.join(d, ".git")); // a real workspace is a detached clone
  fs.writeFileSync(path.join(d, ".skyrift-workspace"), "{}");
  return d;
}
function gitDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-git-"));
  fs.mkdirSync(path.join(d, ".git"));
  return d;
}
function fakeSkyriftBin() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-skyrift-bin-"));
  const f = path.join(d, "skyrift");
  fs.writeFileSync(f, "#!/bin/sh\necho 'skyrift 0.1.0'\n");
  fs.chmodSync(f, 0o755);
  return d;
}

test("a .skyrift-workspace marker gives the land-with-promote orientation", () => {
  const ws = skyriftWorkspaceDir();
  try {
    const res = run({ cwd: ws }, { CLAUDE_PROJECT_DIR: ws });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput
      .additionalContext;
    assert.ok(ctx.includes(SKYRIFT_WS_LINE), "workspace orientation present");
    assert.ok(ctx.includes(SKYRIFT_PROMOTE), "promote guidance present");
    assert.ok(
      !ctx.includes(SKYRIFT_FANOUT_LINE),
      "fan-out hint suppressed inside a workspace"
    );
  } finally {
    cleanup(ws);
  }
});

test("a git source with skyrift on PATH gives the fan-out hint, not the workspace fact", () => {
  const src = gitDir();
  const bin = fakeSkyriftBin();
  try {
    const res = run(
      { cwd: src },
      { CLAUDE_PROJECT_DIR: src, PATH: bin + path.delimiter + process.env.PATH }
    );
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput
      .additionalContext;
    assert.ok(ctx.includes(SKYRIFT_FANOUT_LINE), "fan-out hint present");
    assert.ok(!ctx.includes(SKYRIFT_WS_LINE), "no workspace fact outside a workspace");
    assert.ok(!ctx.includes(GITLESS_LINE), "git source is not gitless");
  } finally {
    cleanup(src);
    cleanup(bin);
  }
});

test("a git source without skyrift emits neither skyrift line", () => {
  const src = gitDir();
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "primer-empty-bin-"));
  try {
    const res = run({ cwd: src }, { CLAUDE_PROJECT_DIR: src, PATH: emptyBin });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput
      .additionalContext;
    assert.ok(!ctx.includes(SKYRIFT_WS_LINE));
    assert.ok(!ctx.includes(SKYRIFT_FANOUT_LINE));
  } finally {
    cleanup(src);
    cleanup(emptyBin);
  }
});

// ---- blueprint invocation enforcement (Lane H) ----

function composerDir(content) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-composer-"));
  fs.writeFileSync(path.join(d, "composer.json"), content);
  return d;
}

function cargoDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-cargo-"));
  fs.writeFileSync(path.join(d, "Cargo.toml"), '[package]\nname = "x"\n');
  return d;
}

function goModDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-gomod-"));
  fs.writeFileSync(path.join(d, "go.mod"), "module x\n");
  return d;
}

// A fake ~/.claude tree with exactly the given blueprint skills installed,
// wired through installed_plugins.json the same way a real install is.
function fakeClaudeConfig(skillNames) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "primer-claude-"));
  const installPath = path.join(
    root,
    "plugins",
    "cache",
    "fake-marketplace",
    "fake-plugin",
    "0.0.1"
  );
  const skillsDir = path.join(installPath, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const name of skillNames) {
    fs.mkdirSync(path.join(skillsDir, name));
  }
  fs.writeFileSync(
    path.join(root, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "fake-plugin@fake-marketplace": [{ scope: "user", installPath }],
      },
    })
  );
  return root;
}

test("filament composer.json + all three blueprint skills installed: names all three, filament-implies chain order", () => {
  const app = composerDir(JSON.stringify({ require: { "filament/filament": "^5.0" } }));
  const claude = fakeClaudeConfig([
    "filament-blueprint-skill",
    "livewire-blueprint-skill",
    "laravel-blueprint-skill",
  ]);
  try {
    const res = run({ cwd: app }, { CLAUDE_CONFIG_DIR: claude });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.match(
      ctx,
      /invoke `filament-blueprint-skill`, `livewire-blueprint-skill`, `laravel-blueprint-skill`/
    );
    assert.match(ctx, /before the first edit/);
  } finally {
    cleanup(app);
    cleanup(claude);
  }
});

test("filament composer.json, only laravel-blueprint-skill installed: names only the installed one", () => {
  const app = composerDir(JSON.stringify({ require: { "filament/filament": "^5.0" } }));
  const claude = fakeClaudeConfig(["laravel-blueprint-skill"]);
  try {
    const res = run({ cwd: app }, { CLAUDE_CONFIG_DIR: claude });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.match(ctx, /invoke `laravel-blueprint-skill`/);
    assert.ok(!ctx.includes("filament-blueprint-skill"));
    assert.ok(!ctx.includes("livewire-blueprint-skill"));
  } finally {
    cleanup(app);
    cleanup(claude);
  }
});

test("livewire (non-filament) composer.json: names livewire+laravel, never filament", () => {
  const app = composerDir(JSON.stringify({ require: { "livewire/livewire": "^3.0" } }));
  const claude = fakeClaudeConfig([
    "filament-blueprint-skill",
    "livewire-blueprint-skill",
    "laravel-blueprint-skill",
  ]);
  try {
    const res = run({ cwd: app }, { CLAUDE_CONFIG_DIR: claude });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.match(ctx, /invoke `livewire-blueprint-skill`, `laravel-blueprint-skill`/);
    assert.ok(!ctx.includes("filament-blueprint-skill"));
  } finally {
    cleanup(app);
    cleanup(claude);
  }
});

test("laravel-only composer.json + laravel-blueprint-skill installed: names laravel-blueprint-skill", () => {
  const app = composerDir(JSON.stringify({ require: { "laravel/framework": "^12.0" } }));
  const claude = fakeClaudeConfig(["laravel-blueprint-skill"]);
  try {
    const res = run({ cwd: app }, { CLAUDE_CONFIG_DIR: claude });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.match(ctx, /invoke `laravel-blueprint-skill` \(Skill tool\) at plan time/);
  } finally {
    cleanup(app);
    cleanup(claude);
  }
});

test("laravel composer.json, blueprint skill not installed: no injection (zero noise)", () => {
  const app = composerDir(JSON.stringify({ require: { "laravel/framework": "^12.0" } }));
  try {
    const res = run({ cwd: app }); // default env: no such CLAUDE_CONFIG_DIR
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes("blueprint-skill"));
  } finally {
    cleanup(app);
  }
});

test("non-stack composer.json (plain php lib): no injection even with every blueprint skill installed", () => {
  const app = composerDir(JSON.stringify({ require: { "monolog/monolog": "^3.0" } }));
  const claude = fakeClaudeConfig([
    "filament-blueprint-skill",
    "livewire-blueprint-skill",
    "laravel-blueprint-skill",
  ]);
  try {
    const res = run({ cwd: app }, { CLAUDE_CONFIG_DIR: claude });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes("blueprint-skill"));
  } finally {
    cleanup(app);
    cleanup(claude);
  }
});

test("Cargo.toml + rust-blueprint-skill installed: names rust-blueprint-skill", () => {
  const app = cargoDir();
  const claude = fakeClaudeConfig(["rust-blueprint-skill"]);
  try {
    const res = run({ cwd: app }, { CLAUDE_CONFIG_DIR: claude });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.match(ctx, /invoke `rust-blueprint-skill` \(Skill tool\)/);
  } finally {
    cleanup(app);
    cleanup(claude);
  }
});

test("go.mod, blueprint skill not installed: no injection", () => {
  const app = goModDir();
  try {
    const res = run({ cwd: app });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes("blueprint-skill"));
  } finally {
    cleanup(app);
  }
});

// PR 36 bounce (c257): SessionStart cwd in a repo SUBDIRECTORY must still
// find composer.json at the git root (silent false-negative before the fix).
test("subdir cwd: composer.json at repo root still injects blueprint + php context", () => {
  const app = composerDir(JSON.stringify({ require: { "filament/filament": "^5.0" } }));
  fs.mkdirSync(path.join(app, ".git"));
  const deep = path.join(app, "app", "Models");
  fs.mkdirSync(deep, { recursive: true });
  const claude = fakeClaudeConfig([
    "filament-blueprint-skill",
    "livewire-blueprint-skill",
    "laravel-blueprint-skill",
  ]);
  try {
    // No CLAUDE_PROJECT_DIR: pure cwd walk-up (the live-probe failure mode).
    const res = run({ cwd: deep }, { CLAUDE_CONFIG_DIR: claude });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(PHP_CTX), "php semantic line still present from subdir cwd");
    assert.match(
      ctx,
      /invoke `filament-blueprint-skill`, `livewire-blueprint-skill`, `laravel-blueprint-skill`/
    );
  } finally {
    cleanup(app);
    cleanup(claude);
  }
});

// --- 1.5.37: loop report paths at SessionStart (Q2) -------------------------

const UUID = "0679640f-35d5-435b-8e6a-562c61d7bf1f";
const RULE_LINE =
  "Loop reports (feature FINAL, debug REPORT, review evidence) go to these files; chat gets the short summary the skill names.";

// Hermetic report env: a fresh temp report dir, mode unset (file mode).
function reportEnv(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "primer-reports-"));
  t.after(() => cleanup(dir));
  return { dir, env: { SKYLINE_LOOP_REPORT: undefined, SKYLINE_LOOP_REPORT_DIR: dir, ...extra } };
}

function ctxOf(res) {
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext;
}

// Like run(), but every SKYLINE_LOOP_REPORT* var comes only from env (an
// undefined value removes the key), so the operator's shell cannot leak in.
function runEnv(input, env, hook = HOOK) {
  const base = { ...process.env };
  delete base.SKYLINE_LOOP_REPORT;
  delete base.SKYLINE_LOOP_REPORT_DIR;
  const merged = {
    ...base,
    SKYLORE_DB: path.join(os.tmpdir(), "primer-no-such-bank.db"),
    CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "primer-no-such-claude-dir"),
    ...env,
  };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return spawnSync(process.execPath, [hook], { encoding: "utf8", input: JSON.stringify(input), env: merged });
}

test("Q2: file mode names this session's three report files once, on every SessionStart source incl. compact", (t) => {
  const { dir, env } = reportEnv(t);
  for (const source of ["startup", "resume", "clear", "compact", undefined]) {
    const ctx = ctxOf(runEnv({ cwd: os.tmpdir(), session_id: UUID, source }, env));
    const expected =
      `Loop report files for this session: feature FINAL \`${path.join(dir, `${UUID}.md`)}\`, ` +
      `debug REPORT \`${path.join(dir, `${UUID}.debug.md`)}\`, review evidence \`${path.join(dir, `${UUID}.review.md`)}\`. ` +
      RULE_LINE;
    assert.ok(ctx.includes(expected), `source ${source}: ${ctx}`);
    assert.equal(ctx.split("Loop report files for this session").length, 2, "exactly one block");
    assert.ok(ctx.startsWith(ABS_PREFIX), "env facts stay front-loaded");
  }
  assert.deepEqual(fs.readdirSync(dir), [], "the primer never creates a report file");
});

test("Q2: the primer's SessionStart entry in hooks.json has no matcher, so it also runs on source=compact", () => {
  const hooks = JSON.parse(fs.readFileSync(path.resolve(__dirname, "hooks.json"), "utf8")).hooks.SessionStart;
  const primer = hooks.filter((e) => e.hooks.some((h) => (h.args || []).some((a) => a.endsWith("/skyline-primer.js"))));
  assert.equal(primer.length, 1, "one primer entry");
  assert.equal(primer[0].matcher, undefined, "no matcher: every source (startup, resume, clear, compact)");
});

test("Q2/Q6: chat mode, an unusable session_id and no home dir add nothing: output equals the no-session output", (t) => {
  const { env } = reportEnv(t);
  const cwd = os.tmpdir();
  const plain = ctxOf(runEnv({ cwd, source: "compact" }, env));
  assert.ok(!plain.includes("Loop report files"), plain);
  assert.equal(ctxOf(runEnv({ cwd, session_id: UUID, source: "compact" }, { ...env, SKYLINE_LOOP_REPORT: "chat" })), plain);
  for (const sid of [".", "..", "", 42, null]) {
    assert.equal(ctxOf(runEnv({ cwd, session_id: sid, source: "compact" }, env)), plain, `session_id ${String(sid)}`);
  }
  const noHome = { SKYLINE_LOOP_REPORT_DIR: undefined, HOME: undefined, USERPROFILE: undefined };
  assert.equal(ctxOf(runEnv({ cwd, session_id: UUID }, noHome)), ctxOf(runEnv({ cwd }, noHome)), "no home dir");
  // File mode is the chat output plus the one block, nothing else changed.
  const file = ctxOf(runEnv({ cwd, session_id: UUID, source: "compact" }, env));
  assert.ok(file.startsWith(plain + "\n\n"), file);
  assert.ok(file.slice(plain.length + 2).startsWith("Loop report files for this session"));
});

// Q6 differential: chat mode output equals the pre-change primer (origin/main
// 11a0426, skyline-claude 1.5.36) for the same inputs. Needs the base commit in
// the local object store; a shallow clone skips (stated, not silently green).
const BASE_SHA = "11a04269a6ada5f923581c246a7560eb5d9d3665";
function baseHook(t, rel) {
  const repo = path.resolve(__dirname, "..", "..", "..");
  const res = spawnSync("git", ["show", `${BASE_SHA}:${rel}`], { cwd: repo, encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return null;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "primer-base-"));
  t.after(() => cleanup(d));
  const p = path.join(d, path.basename(rel));
  fs.writeFileSync(p, res.stdout);
  return p;
}

test("Q6 differential: SKYLINE_LOOP_REPORT=chat output equals the 1.5.36 primer for the same inputs", (t) => {
  const old = baseHook(t, "plugins/skyline-claude/hooks/skyline-primer.js");
  if (!old) {
    t.skip(`base commit ${BASE_SHA.slice(0, 7)} not in the object store`);
    return;
  }
  const { env } = reportEnv(t, { SKYLINE_LOOP_REPORT: "chat" });
  const php = markerDir("composer.json");
  t.after(() => cleanup(php));
  for (const input of [
    { cwd: os.tmpdir(), session_id: UUID, source: "startup" },
    { cwd: php, session_id: UUID, source: "compact" },
    { cwd: php, session_id: "a/b", source: "resume" },
    { session_id: UUID },
  ]) {
    const now = runEnv(input, env);
    const then = runEnv(input, env, old);
    assert.equal(now.status, then.status);
    assert.equal(now.stdout, then.stdout, JSON.stringify(input));
    assert.ok(now.stdout.length > 0);
  }
});

// Bounce 1 M3: a box that only runs debug / review / non-loop sessions never
// reaches the gate's prune, so the primer prunes too (same function, file
// mode only, never the current session's three files).
test("M3: SessionStart prunes other sessions' old headered debug/review/stub reports; current files and non-reports survive", (t) => {
  const { dir, env } = reportEnv(t);
  const at = (n) => path.join(dir, n);
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const put = (n, body, aged = true) => {
    fs.writeFileSync(at(n), body);
    if (aged) fs.utimesSync(at(n), old, old);
  };
  const hdr = (k) => `# ${k}-loop REPORT\nloop-report: v1\nx\n`;
  put("other.debug.md", hdr("debug"));
  put("other.review.md", hdr("review"));
  put("stub-session.md", "# skylore REPORT\nloop-report: v1\nskylore: nothing durable\n");
  put("recent.debug.md", hdr("debug"), false);
  put("old-headerless.review.md", "# notes\n");
  put("README.md", "# readme\n");
  put(`${UUID}.md`, "# feature-loop FINAL\nloop-report: v1\n");
  put(`${UUID}.debug.md`, hdr("debug"));
  put(`${UUID}.review.md`, hdr("review"));
  const before = fs.readdirSync(dir).sort();

  // Chat mode and an unusable session_id prune nothing.
  ctxOf(runEnv({ cwd: os.tmpdir(), session_id: UUID }, { ...env, SKYLINE_LOOP_REPORT: "chat" }));
  ctxOf(runEnv({ cwd: os.tmpdir(), session_id: "." }, env));
  ctxOf(runEnv({ cwd: os.tmpdir(), session_id: UUID }, { ...env, SKYLINE_LOOP_REPORT_RETENTION_DAYS: "0" }));
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "chat mode, no usable id, retention 0: nothing pruned");

  ctxOf(runEnv({ cwd: os.tmpdir(), session_id: UUID, source: "startup" }, env));
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ["README.md", "old-headerless.review.md", "recent.debug.md", `${UUID}.debug.md`, `${UUID}.md`, `${UUID}.review.md`].sort()
  );
});
