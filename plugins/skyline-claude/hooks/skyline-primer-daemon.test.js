// node:test for the skyline-primer.js daemon probe (1.5.40, binary-skyline#1121).
// Run with: node --test plugins/skyline-claude/hooks/skyline-primer-daemon.test.js
//
// A plugin-only user never runs the binary, so the SessionStart primer makes
// ONE bounded GET /health and, when no daemon answers, adds one line to its
// context. Outcome classes (orchestrator ruling on the lane, 2026-11-25):
//   (a) unreachable: refused, reset before any byte, DNS failure -> a hint to
//       run `skyline setup`;
//   (b) unanswered: a connection (or bytes) but no complete response within
//       300 ms -> a different hint pointing at `skyline daemon status`;
//   (c) any complete HTTP status -> no hint, stdout byte-identical to the
//       probe-less (opt-out) run;
//   (d) the probe cannot run (bad port, invalid host chars) -> no hint, same
//       bytes as the opt-out run.
// Like skyline-enforce-failopen.test.js: dummies run IN this process on
// ephemeral ports (never 7333) and the hook is spawned ASYNC (spawnSync would
// block the dummy). Timing assertions are relative to a refused-connection run
// of the same hook (same startup cost), so a loaded box does not flake them.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.resolve(__dirname, "skyline-primer.js");
const ABS_PREFIX = "The skyline daemon runs with cwd /";
const UNREACHABLE = "The skyline daemon is not reachable on ";
const UNANSWERED = "Something accepted a connection on ";

function cleanup(d) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {}
}

// A plain cwd (no marker, no .git) and an empty HOME; both must stay empty.
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "primer-daemon-"));
  const cwd = path.join(root, "cwd");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  t.after(() => {
    assert.deepEqual(fs.readdirSync(home), [], "the primer wrote nothing under HOME");
    assert.deepEqual(fs.readdirSync(cwd), [], "the primer wrote nothing in cwd");
    cleanup(root);
  });
  return { cwd, home };
}

function runPrimer(box, env = {}, rawInput, hook = HOOK) {
  const base = { ...process.env };
  for (const k of [
    "SKYLINE_LOOP_REPORT",
    "SKYLINE_LOOP_REPORT_DIR",
    "SKYLINE_PRIMER_NO_DAEMON_CHECK",
    "SKYLINE_DAEMON_TOKEN",
    "SKYLINE_DAEMON_HOST",
    "SKYLINE_DAEMON_PORT",
    "CLAUDE_PROJECT_DIR",
    "HTTP_PROXY",
    "http_proxy",
    "NODE_USE_ENV_PROXY",
  ]) {
    delete base[k];
  }
  const merged = {
    ...base,
    HOME: box.home,
    SKYLORE_DB: path.join(box.home, "no-such-bank.db"),
    CLAUDE_CONFIG_DIR: path.join(box.home, "no-such-claude-dir"),
    SKYLINE_DAEMON_HOST: "127.0.0.1",
    ...env,
  };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const t0 = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { env: merged });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ status, stdout, stderr, ms });
    });
    // No session_id: no loop-report block and no report-dir prune.
    child.stdin.end(rawInput !== undefined ? rawInput : JSON.stringify({ cwd: box.cwd, source: "startup" }));
  });
}

function ctxOf(r) {
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;
}

// The context of a hint run is the opt-out context with exactly ONE extra
// part, a single line, at index 2 (right after the abs-path fact and the focus
// license). Returns that part.
function assertOneHint(r, optOut, prefix) {
  const ctx = ctxOf(r);
  const base = ctxOf(optOut);
  assert.ok(ctx.startsWith(ABS_PREFIX), "env facts stay front-loaded");
  const parts = ctx.split("\n\n");
  const hint = parts[2];
  assert.ok(hint.startsWith(prefix), `hint part: ${hint}`);
  assert.ok(!hint.includes("\n"), "the hint is one line");
  assert.equal([...parts.slice(0, 2), ...parts.slice(3)].join("\n\n"), base, "nothing else changed");
  const hints = parts.filter((p) => p.startsWith(UNREACHABLE) || p.startsWith(UNANSWERED));
  assert.equal(hints.length, 1, "exactly one daemon hint");
  return hint;
}

function track(srv) {
  const sockets = new Set();
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      srv.close(() => resolve());
    });
}

// HTTP dummy answering every request with `status`; records url + auth.
async function httpDaemon(t, status, bind = "127.0.0.1") {
  const requests = [];
  const srv = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? '{"status":"ok"}' : "");
  });
  const close = track(srv);
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, bind, resolve);
  });
  t.after(async () => {
    await close();
    assert.equal(srv.listening, false, "dummy closed");
  });
  return { port: srv.address().port, requests };
}

// Raw TCP dummy: onConn(socket) decides what (if anything) is sent.
async function rawDaemon(t, onConn) {
  const conns = [];
  const srv = net.createServer((s) => {
    conns.push(s.remoteAddress);
    s.on("error", () => {});
    onConn(s);
  });
  const close = track(srv);
  const timers = new Set();
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const x of timers) clearInterval(x);
    await close();
    assert.equal(srv.listening, false, "dummy closed");
  });
  return { port: srv.address().port, conns, timers };
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

// --- (c) answered: no hint, byte-identical ------------------------------------

for (const status of [200, 401, 406]) {
  test(`(c) daemon answers ${status}: no hint, stdout byte-identical to the opt-out run; one GET /health, no bearer`, async (t) => {
    const box = sandbox(t);
    const d = await httpDaemon(t, status);
    const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1", SKYLINE_DAEMON_PORT: String(d.port) });
    assert.equal(d.requests.length, 0, "opt-out opened nothing");
    const r = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(d.port), SKYLINE_DAEMON_TOKEN: "s3cret-token" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, optOut.stdout, "byte-identical");
    assert.ok(r.stdout.length > 0);
    assert.deepEqual(d.requests, [{ url: "/health", authorization: undefined }], "one GET /health, no Authorization");
  });
}

test("(c) a response trickled in under the deadline still counts as answered", async (t) => {
  const box = sandbox(t);
  const chunks = ["HTTP/1.1 2", "00 OK\r\ncontent-", "length: 0\r\n", "\r\n"];
  const d = await rawDaemon(t, (s) => {
    let i = 0;
    const x = setInterval(() => {
      if (s.destroyed) return clearInterval(x);
      s.write(chunks[i++]);
      if (i === chunks.length) clearInterval(x);
    }, 25);
    d.timers.add(x);
  });
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const r = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(d.port) });
  assert.equal(r.stdout, optOut.stdout, "byte-identical");
});

// --- (a) unreachable -----------------------------------------------------------

test("(a) nothing listening: one-line setup hint naming host:port; returns at once, not at the deadline", async (t) => {
  const box = sandbox(t);
  const port = await unusedPort();
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const r = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(port) });
  const hint = assertOneHint(r, optOut, UNREACHABLE);
  assert.ok(hint.includes(`127.0.0.1:${port}`), hint);
  assert.ok(hint.includes("`skyline setup`"), hint);
  assert.ok(hint.includes(`\`skyline daemon start --port ${port}\``), hint);
  assert.ok(!hint.includes("daemon status"), hint);
});

test("(a) accepted then closed before any byte: reset-before-any-byte is unreachable (ruling)", async (t) => {
  const box = sandbox(t);
  const d = await rawDaemon(t, (s) => s.destroy());
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const r = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(d.port) });
  assertOneHint(r, optOut, UNREACHABLE);
  assert.equal(d.conns.length, 1, "one connection");
});

// --- (b) unanswered + timing ---------------------------------------------------

test("(b) accept-then-hang: status hint, bounded by the 300 ms deadline (relative to a refused run)", async (t) => {
  const box = sandbox(t);
  const refusedPort = await unusedPort();
  const d = await rawDaemon(t, () => {}); // accept, never write
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const refused = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(refusedPort) });
  const hung = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(d.port) });
  const hint = assertOneHint(hung, optOut, UNANSWERED);
  assert.ok(hint.includes(`127.0.0.1:${d.port}`), hint);
  assert.ok(hint.includes("`skyline daemon status`"), hint);
  assert.ok(!hint.includes("skyline setup"), "a busy daemon is not told to re-run setup");
  assert.ok(hung.ms >= 290, `waited for the deadline: ${hung.ms}ms`);
  assert.ok(hung.ms - refused.ms < 450, `hang ${hung.ms}ms vs refused ${refused.ms}ms: bounded by the deadline`);
  assert.ok(refused.ms < hung.ms - 150, `refused returns at once: ${refused.ms}ms vs ${hung.ms}ms`);
  assert.ok(hung.ms < 1500, `absolute sanity bound: ${hung.ms}ms`);
});

test("(b) a response trickled past the deadline: status hint, bounded", async (t) => {
  const box = sandbox(t);
  const refusedPort = await unusedPort();
  const d = await rawDaemon(t, (s) => {
    s.write("HTTP/1.1 200 OK\r\n");
    const x = setInterval(() => {
      if (s.destroyed) return clearInterval(x);
      s.write("x"); // a header line that never ends
    }, 40);
    d.timers.add(x);
  });
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const refused = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(refusedPort) });
  const r = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(d.port) });
  assertOneHint(r, optOut, UNANSWERED);
  assert.ok(r.ms - refused.ms < 450, `trickle ${r.ms}ms vs refused ${refused.ms}ms`);
  assert.ok(r.ms < 1500, `absolute sanity bound: ${r.ms}ms`);
});

test("(b) bytes then a reset: status hint (something is there)", async (t) => {
  const box = sandbox(t);
  const d = await rawDaemon(t, (s) => {
    s.write("HTTP/1.1 2");
    setTimeout(() => s.destroy(), 20);
  });
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const r = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(d.port) });
  assertOneHint(r, optOut, UNANSWERED);
});

// --- host / port derivation ------------------------------------------------------

test("host env: exact [::1] is unbracketed for the connect; whitespace is trimmed", async (t) => {
  const box = sandbox(t);
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const v4 = await httpDaemon(t, 200);
  const trimmed = await runPrimer(box, { SKYLINE_DAEMON_HOST: "  127.0.0.1 \t", SKYLINE_DAEMON_PORT: String(v4.port) });
  assert.equal(trimmed.stdout, optOut.stdout, "trimmed host answered");
  let v6;
  try {
    v6 = await httpDaemon(t, 200, "::1");
  } catch (e) {
    t.diagnostic(`no IPv6 loopback here (${e.code}); [::1] leg not run`);
    return;
  }
  const r = await runPrimer(box, { SKYLINE_DAEMON_HOST: "[::1]", SKYLINE_DAEMON_PORT: String(v6.port) });
  assert.equal(r.stdout, optOut.stdout, "[::1] answered");
  assert.equal(v6.requests.length, 1);
});

test("garbage host env never throws: unresolvable names give the setup hint, bounded; control chars give today's output", async (t) => {
  const box = sandbox(t);
  const refusedPort = await unusedPort();
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const refused = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(refusedPort) });
  for (const host of ["[::1", "[127.0.0.1]", "not a host", "::1x"]) {
    const r = await runPrimer(box, { SKYLINE_DAEMON_HOST: host, SKYLINE_DAEMON_PORT: String(refusedPort) });
    const hint = assertOneHint(r, optOut, UNREACHABLE);
    assert.ok(hint.length < 600, "host echo is capped");
    assert.ok(r.ms - refused.ms < 450, `${host}: ${r.ms}ms vs refused ${refused.ms}ms`);
  }
  // A control character in the host is rejected synchronously by http (d).
  const ctl = await runPrimer(box, { SKYLINE_DAEMON_HOST: "bad\u0001host", SKYLINE_DAEMON_PORT: String(refusedPort) });
  assert.equal(ctl.status, 0, ctl.stderr);
  assert.equal(ctl.stdout, optOut.stdout, "control char: today's output");
});

test("a DNS lookup that never finishes cannot hold SessionStart: setup hint, exit at the deadline", async (t) => {
  // destroy() does not cancel an in-flight lookup, and a pending lookup keeps
  // the event loop alive. Simulated hermetically: a --require preload swaps
  // dns.lookup for one that answers ENOTFOUND only after a ref'd 10 s timer.
  // The primer must still exit right after its 300 ms deadline.
  const box = sandbox(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "primer-slowdns-"));
  t.after(() => cleanup(dir));
  const preload = path.join(dir, "slow-dns.js");
  fs.writeFileSync(
    preload,
    'const dns = require("dns");\n' +
      "dns.lookup = function (host, opts, cb) {\n" +
      '  const done = typeof opts === "function" ? opts : cb;\n' +
      '  setTimeout(() => done(Object.assign(new Error("getaddrinfo ENOTFOUND " + host), { code: "ENOTFOUND" })), 10000);\n' +
      "};\n"
  );
  const refusedPort = await unusedPort();
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const refused = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(refusedPort) });
  const r = await runPrimer(box, {
    SKYLINE_DAEMON_HOST: "slow-resolver.invalid",
    SKYLINE_DAEMON_PORT: String(refusedPort),
    NODE_OPTIONS: `--require ${preload}`,
  });
  const hint = assertOneHint(r, optOut, UNREACHABLE);
  assert.ok(hint.includes("slow-resolver.invalid:"), hint);
  assert.ok(r.ms >= 290, `waited for the deadline: ${r.ms}ms`);
  assert.ok(r.ms - refused.ms < 450, `slow DNS ${r.ms}ms vs refused ${refused.ms}ms: not held by the lookup`);
});

// Differential: with a daemon answering 200 and the probe ON, stdout equals
// the pre-probe primer (origin/main ceb71c6, skyline-claude 1.5.39) for the
// same inputs. Needs the base commit in the local object store; a shallow
// clone skips (stated, not silently green).
const PRE_PROBE_SHA = "ceb71c6e3e632151a4a1f6d27928cb90bcf80515";
test("differential: daemon answering, probe on -> stdout equals the 1.5.39 primer byte for byte", async (t) => {
  const repo = path.resolve(__dirname, "..", "..", "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "primer-pre-probe-"));
  t.after(() => cleanup(dir));
  for (const f of ["skyline-primer.js", "loop-report-path.js"]) {
    const res = require("child_process").spawnSync("git", ["show", `${PRE_PROBE_SHA}:plugins/skyline-claude/hooks/${f}`], {
      cwd: repo,
      encoding: "utf8",
    });
    if (res.status !== 0 || !res.stdout) {
      t.skip(`base commit ${PRE_PROBE_SHA.slice(0, 7)} not in the object store`);
      return;
    }
    fs.writeFileSync(path.join(dir, f), res.stdout);
  }
  const oldHook = path.join(dir, "skyline-primer.js");
  const box = sandbox(t);
  const php = path.join(dir, "php");
  fs.mkdirSync(php);
  fs.writeFileSync(path.join(php, "composer.json"), "{}");
  const reports = path.join(dir, "reports");
  const d = await httpDaemon(t, 200);
  const env = { SKYLINE_DAEMON_PORT: String(d.port), SKYLINE_LOOP_REPORT_DIR: reports };
  const inputs = [
    { cwd: box.cwd, source: "startup" },
    { cwd: php, session_id: "0679640f-35d5-435b-8e6a-562c61d7bf1f", source: "compact" },
    { cwd: repo, source: "resume" },
    { session_id: "a/b" },
  ];
  for (const input of inputs) {
    const raw = JSON.stringify(input);
    const now = await runPrimer(box, env, raw);
    const then = await runPrimer(box, env, raw, oldHook);
    assert.equal(now.status, 0, now.stderr);
    assert.equal(then.status, 0, then.stderr);
    assert.ok(now.stdout.length > 0);
    assert.equal(now.stdout, then.stdout, raw);
  }
  assert.equal(d.requests.length, inputs.length, "one GET per new-primer run, none from the old one");
});

test("(d) unusable port env: the probe cannot run, output is today's", async (t) => {
  const box = sandbox(t);
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  for (const port of ["not-a-port", "99999", "-1"]) {
    const r = await runPrimer(box, { SKYLINE_DAEMON_PORT: port });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, optOut.stdout, `port ${port}`);
  }
});

// --- opt-out, malformed stdin, proxy -------------------------------------------

test("SKYLINE_PRIMER_NO_DAEMON_CHECK=1 opens no socket (a recording listener sees nothing)", async (t) => {
  const box = sandbox(t);
  const d = await rawDaemon(t, (s) => s.destroy());
  const r = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1", SKYLINE_DAEMON_PORT: String(d.port) });
  ctxOf(r);
  await settle();
  assert.equal(d.conns.length, 0, "opt-out: no connection");
  // Control: the same listener does see a probing primer.
  await runPrimer(box, { SKYLINE_DAEMON_PORT: String(d.port) });
  await settle();
  assert.equal(d.conns.length, 1, "the recorder sees a probe");
});

test("malformed stdin: silent exit 0 and no socket", async (t) => {
  const box = sandbox(t);
  const d = await rawDaemon(t, (s) => s.destroy());
  const r = await runPrimer(box, { SKYLINE_DAEMON_PORT: String(d.port) }, "{ not json");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  await settle();
  assert.equal(d.conns.length, 0);
});

test("an env HTTP proxy is bypassed (agent: false)", async (t) => {
  const box = sandbox(t);
  const proxy = await rawDaemon(t, (s) => s.destroy());
  const d = await httpDaemon(t, 200);
  const optOut = await runPrimer(box, { SKYLINE_PRIMER_NO_DAEMON_CHECK: "1" });
  const r = await runPrimer(box, {
    SKYLINE_DAEMON_PORT: String(d.port),
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    http_proxy: `http://127.0.0.1:${proxy.port}`,
    NO_PROXY: "",
    NODE_USE_ENV_PROXY: "1",
    NODE_NO_WARNINGS: "1",
  });
  assert.equal(r.stdout, optOut.stdout);
  await settle();
  assert.equal(proxy.conns.length, 0, "proxy never contacted");
  assert.equal(d.requests.length, 1, "daemon probed directly");
});
