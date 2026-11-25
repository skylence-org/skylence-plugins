// node:test for the skyline-enforce.js daemon-ready guard (skylence-plugins#53).
// Run with: node --test plugins/skyline-claude/hooks/skyline-enforce-failopen.test.js
//
// The hook must fail OPEN (allow the native tool, exit 0, one-line stderr
// reason) whenever the skyline tools cannot serve this session, and keep
// ENFORCING whenever they can:
//
//   1. GET /mcp answers 401 or 403 (no bearer sent, #50, or the bearer was
//      rejected): the probe cannot show the tools can serve.
//   2. Nothing answers: unchanged fail-open.
//   3. A healthy daemon answers GET /mcp with 406 (measured live, 1.2.4) and
//      /health with status ok: enforcement is unchanged. "Non-2xx means down"
//      would switch enforcement off everywhere; this file pins that it does not.
//   4. /health reports maintenance_locked:true: the daemon answers but refuses
//      every tool call, so the hook must not route the session to it.
//
// What /health CANNOT tell the hook (and these tests pin as ENFORCED, not
// guessed at): the `acceptance` / `account` labels are reported on dev builds
// too, which serve every call, and /health carries no gate_active; the admin
// kill-switch and FreeCap are not in /health at all.
//
// Review I1 (PR #54): when SKYLINE_DAEMON_TOKEN is in the hook environment the
// /mcp probe sends it as a bearer (never /health, which is public), so a
// session whose tools serve stays enforced. 401/403 still fails open, and the
// reason says whether no bearer was sent or the one sent was rejected. The
// token never appears in stderr or stdout. runHook strips the developer's own
// SKYLINE_DAEMON_TOKEN so only the tests decide whether one is present.
//
// Loopback-only bearer (operator ruling, re-review R1 Minor 1): the bearer is
// sent only when SKYLINE_DAEMON_HOST is 127.0.0.1, ::1, [::1] or localhost
// (matched by name, trimmed, case-insensitive, never resolved). Any other host
// gets no Authorization header, and a 401/403 there fails open saying the
// bearer was withheld because the host is not loopback.
//
// The dummy daemon runs IN this process and the hook is spawned ASYNC: a
// spawnSync here would block the event loop and the dummy could never answer
// (the hook would then time out and look fail-open for the wrong reason).
// Dummies bind ephemeral ports only, never 7333 (one loopback-only-bearer test
// binds 0.0.0.0 so the box's own LAN address reaches it).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.resolve(__dirname, "skyline-enforce.js");
const ROOT = path.resolve(__dirname, "../../..");
const README = path.join(ROOT, "README.md");

// Exactly what a healthy live 1.2.4 daemon answered on 2026-11-13.
const HEALTHY_124 =
  '{"status":"ok","version":"1.2.4","acceptance":"accepted","maintenance_locked":false}';
// What binary-skyline main (1.3.0) answers: acceptance/maintenance_locked are gone.
const health13 = (account) =>
  `{"status":"ok","version":"1.3.0","account":"${account}"}`;

const HANG = Symbol("hang");

/**
 * Dummy daemon. `mcp` is the status GET /mcp answers (or HANG); `health` is the
 * body GET /health answers with `healthStatus` (or HANG).
 */
async function startDaemon({
  mcp = 406,
  health = HEALTHY_124,
  healthStatus = 200,
  token = null, // when set, /mcp answers 401 unless it carries `Bearer <token>`
  healthDelayMs = 0, // delay before GET /health answers (late-body tests)
  bind = "127.0.0.1", // interface the dummy listens on (0.0.0.0 / ::1 in the loopback-only bearer tests)
} = {}) {
  const requests = [];
  const auth = []; // {url, authorization} per request, for bearer assertions
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    requests.push(req.url);
    auth.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === "/health") {
      if (health === HANG) return; // never answers
      res.writeHead(healthStatus, { "content-type": "application/json" });
      if (healthDelayMs > 0) setTimeout(() => res.end(health), healthDelayMs);
      else res.end(health);
      return;
    }
    if (mcp === HANG) return; // never answers
    const status = token !== null && req.headers.authorization !== `Bearer ${token}` ? 401 : mcp;
    res.writeHead(status, status === 401 ? { "www-authenticate": 'Bearer realm="skyline"' } : {});
    res.end(status === 401 ? '{"error":"missing or invalid bearer token"}' : "");
  });
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, bind, resolve);
  });
  return {
    port: srv.address().port,
    requests,
    auth,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        srv.close(() => resolve());
      }),
  };
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

function runHook(mode, port, input, extraEnv = {}) {
  const session = `i53-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const marker = path.join(
    os.tmpdir(),
    `skyline-enforce-reminder-${session.replace(/[^a-z0-9_-]/gi, "_")}.marker`
  );
  // A token in the developer's own shell must not change what these tests see.
  const baseEnv = { ...process.env };
  delete baseEnv.SKYLINE_DAEMON_TOKEN;
  const t0 = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, mode], {
      cwd: ROOT,
      env: {
        ...baseEnv,
        SKYLINE_DAEMON_HOST: "127.0.0.1",
        SKYLINE_DAEMON_PORT: String(port),
        CLAUDE_SESSION_ID: session,
        CLAUDE_PROJECT_DIR: ROOT,
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      try {
        fs.rmSync(marker, { force: true });
      } catch {}
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ status, stdout, stderr, ms });
    });
    child.stdin.end(JSON.stringify({ cwd: ROOT, ...input }));
  });
}

// One representative call per enforced surface: Read/Edit/Write/Grep/Glob and a
// long Bash. `substitute` pins the deny text a healthy daemon must keep giving.
const LONG_BASH = `cat ${README} | head -n 5 # padded so the size threshold cannot excuse this command ${"x".repeat(40)}`;
const CALLS = {
  Read: {
    mode: "read",
    input: { tool_name: "Read", tool_input: { file_path: README } },
    substitute: /Use read\(\{path:/,
  },
  Edit: {
    mode: "edit",
    input: {
      tool_name: "Edit",
      tool_input: { file_path: README, old_string: "a", new_string: "b" },
    },
    substitute: /then edit with the returned/,
  },
  Write: {
    mode: "edit",
    input: { tool_name: "Write", tool_input: { file_path: README, content: "x" } },
    substitute: /Use create\(\{path:/,
  },
  Grep: {
    mode: "grep",
    input: {
      tool_name: "Grep",
      tool_input: { pattern: "retry limit exceeded", path: ROOT },
    },
    substitute: /Use grep\(\{pattern:/,
  },
  Glob: {
    mode: "glob",
    input: { tool_name: "Glob", tool_input: { pattern: "**/*.js" } },
    substitute: /Use find\(\{glob:/,
  },
  "long Bash": {
    mode: "bash",
    input: { tool_name: "Bash", tool_input: { command: LONG_BASH } },
    substitute: /instead of Bash/,
  },
};

function assertEnforced(label, r) {
  assert.equal(r.status, 2, `${label}: expected deny (exit 2), got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /^Use /, `${label}: deny text starts with the substitute`);
  assert.match(r.stderr, /ToolSearch\("select:mcp__skyline__/, `${label}: ToolSearch line present`);
  assert.equal(r.stdout, "", `${label}: no stdout`);
}

function assertAllowed(label, r, reason) {
  assert.equal(r.status, 0, `${label}: expected allow (exit 0), got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stdout, "", `${label}: no stdout`);
  assert.match(r.stderr, reason, `${label}: stderr names the reason`);
  assert.match(r.stderr, /allowing native tool/, `${label}: stderr says the native tool is allowed`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `${label}: one-line reason`);
}

async function withDaemon(opts, fn) {
  const d = await startDaemon(opts);
  try {
    return await fn(d);
  } finally {
    await d.close();
  }
}

// --- acceptance 3: a healthy daemon stays enforced ---------------------------

test("healthy daemon (406 on /mcp, 1.2.4 /health) enforces every surface, with the same substitute text", async () => {
  await withDaemon({ mcp: 406, health: HEALTHY_124 }, async (d) => {
    for (const [label, call] of Object.entries(CALLS)) {
      d.requests.length = 0;
      const r = await runHook(call.mode, d.port, call.input);
      assertEnforced(label, r);
      assert.match(r.stderr, call.substitute, `${label}: substitute text`);
      // acceptance 5: at most ONE extra local request per hook invocation.
      assert.ok(d.requests.length <= 2, `${label}: <=2 requests, saw ${JSON.stringify(d.requests)}`);
      assert.ok(
        d.requests.every((u) => u === "/mcp" || u === "/health"),
        `${label}: only /mcp and /health probed, saw ${JSON.stringify(d.requests)}`
      );
    }
  });
});

test("healthy daemon answering 200 on /mcp is enforced too", async () => {
  await withDaemon({ mcp: 200, health: HEALTHY_124 }, async (d) => {
    assertEnforced("Read", await runHook("read", d.port, CALLS.Read.input));
  });
});

test("healthy 1.3.x daemon (/health carries `account`, no maintenance_locked) stays enforced", async () => {
  for (const account of ["entitled", "awaiting_verdict"]) {
    await withDaemon({ mcp: 406, health: health13(account) }, async (d) => {
      assertEnforced(`account=${account}`, await runHook("read", d.port, CALLS.Read.input));
    });
  }
});

// --- the uncovered cases: labels /health reports on dev builds too ------------
// Pinned as ENFORCED on purpose: a dev build (cargo build, never gated) reports
// these labels while serving every call, and /health exposes no gate_active, so
// failing open on them would switch enforcement off on healthy daemons.

test("account=no_account / expired are NOT treated as refusing (dev builds report them while serving)", async () => {
  for (const account of ["no_account", "expired"]) {
    await withDaemon({ mcp: 406, health: health13(account) }, async (d) => {
      assertEnforced(`account=${account}`, await runHook("read", d.port, CALLS.Read.input));
    });
  }
});

test("acceptance other than `accepted` with maintenance_locked:false is NOT treated as refusing", async () => {
  for (const acceptance of ["never accepted", "stale (terms changed)"]) {
    const health = `{"status":"ok","version":"1.2.4","acceptance":"${acceptance}","maintenance_locked":false}`;
    await withDaemon({ mcp: 406, health }, async (d) => {
      assertEnforced(`acceptance=${acceptance}`, await runHook("read", d.port, CALLS.Read.input));
    });
  }
});

// --- /health that says nothing usable must not switch enforcement off ---------

test("unusable /health keeps enforcing (unparsable, non-JSON, wrong shape, error status, empty)", async () => {
  const bodies = [
    ["plain text", "ok", 200],
    ["json null", "null", 200],
    ["json array", "[]", 200],
    ["maintenance_locked as a string", '{"status":"ok","maintenance_locked":"true"}', 200],
    ["maintenance_locked as 1", '{"status":"ok","maintenance_locked":1}', 200],
    ["500 with a locked-looking body", '{"status":"ok","maintenance_locked":true}', 500],
    ["empty body", "", 200],
  ];
  for (const [label, body, status] of bodies) {
    await withDaemon({ mcp: 406, health: body, healthStatus: status }, async (d) => {
      assertEnforced(label, await runHook("read", d.port, CALLS.Read.input));
    });
  }
});

test("a /health body past the size cap is not trusted, even if it ends in maintenance_locked:true", async () => {
  const padded = " ".repeat(20000) + '{"status":"ok","maintenance_locked":true}';
  await withDaemon({ mcp: 406, health: padded }, async (d) => {
    assertEnforced("oversized", await runHook("read", d.port, CALLS.Read.input));
  });
});

test("/health that never answers: enforced, inside the existing 500ms budget", async () => {
  await withDaemon({ mcp: 406, health: HANG }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input);
    assertEnforced("slow /health", r);
    assert.ok(r.ms < 1500, `bounded by the single deadline, took ${r.ms}ms`);
  });
});

// --- acceptance 1: 401 / 403 on /mcp ------------------------------------------

test("401 on /mcp fails open on every surface, with a one-line reason", async () => {
  await withDaemon({ mcp: 401 }, async (d) => {
    for (const [label, call] of Object.entries(CALLS)) {
      d.requests.length = 0;
      const r = await runHook(call.mode, d.port, call.input);
      assertAllowed(label, r, /401/);
      assert.ok(d.requests.length <= 2, `${label}: <=2 requests, saw ${JSON.stringify(d.requests)}`);
    }
  });
});

test("403 on /mcp fails open", async () => {
  await withDaemon({ mcp: 403 }, async (d) => {
    assertAllowed("Read", await runHook("read", d.port, CALLS.Read.input), /403/);
    assertAllowed("long Bash", await runHook("bash", d.port, CALLS["long Bash"].input), /403/);
  });
});

test("401 on /mcp does not wait for a slow /health", async () => {
  // Load-proof: no absolute wall-clock bound. The same hook against a hung
  // /health that is NOT an auth wall (406) must sit out the whole 500ms
  // deadline; the 401 run must beat it by most of that deadline, whatever the
  // box's process-startup cost is right now.
  const waited = await withDaemon({ mcp: 406, health: HANG }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input);
    assertEnforced("406 + hung /health", r);
    return r.ms;
  });
  await withDaemon({ mcp: 401, health: HANG }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input);
    assertAllowed("401 + hung /health", r, /401/);
    assert.ok(
      r.ms < waited - 250,
      `401 answered without waiting on /health: ${r.ms}ms vs ${waited}ms when /health is awaited`
    );
  });
});

// --- acceptance 4: a daemon that reports it refuses every call ----------------

test("maintenance_locked:true on /health fails open on every surface", async () => {
  const locked =
    '{"status":"ok","version":"1.2.4","acceptance":"accepted","maintenance_locked":true}';
  await withDaemon({ mcp: 406, health: locked }, async (d) => {
    for (const [label, call] of Object.entries(CALLS)) {
      const r = await runHook(call.mode, d.port, call.input);
      assertAllowed(label, r, /maintenance/);
    }
  });
});

// --- acceptance 2: nothing listening / nothing answering ----------------------

test("nothing listening: unchanged fail-open, exact legacy wording", async () => {
  const port = await unusedPort();
  const r = await runHook("read", port, CALLS.Read.input);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /skyline daemon unreachable/);
  assert.match(r.stderr, /allowing native tool/);
  assert.equal(r.stdout, "");
});

test("/mcp that never answers: unchanged fail-open as unreachable, bounded by the deadline", async () => {
  await withDaemon({ mcp: HANG, health: HANG }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /skyline daemon unreachable/);
    assert.ok(r.ms < 1500, `bounded by the single deadline, took ${r.ms}ms`);
  });
});

test("/mcp that never answers but /health answers healthy: still unreachable (the tool route is what counts)", async () => {
  await withDaemon({ mcp: HANG, health: HEALTHY_124 }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /skyline daemon unreachable/);
  });
});

// --- review I1 (PR #54): a token-wired session stays enforced -----------------
// `skyline install` wires SKYLINE_DAEMON_TOKEN into ~/.claude/settings.json env
// on auth-enabled machines. The hook's /mcp probe sends it as a bearer (never
// on /health, which is public), so a session whose tools serve is not switched
// off by the daemon's 401 to an anonymous GET.

const TOKEN = "zq7Kd93xLmP2vRw8";
const WRONG_TOKEN = "Hn4Tb61cYsE5uJa0";

// Neither the token nor any 6-character piece of it may reach stderr/stdout.
// Messages never include the piece, so a failure does not leak it either.
function assertNoTokenLeak(label, r, ...tokens) {
  for (const tok of tokens) {
    for (let i = 0; i + 6 <= tok.length; i++) {
      const piece = tok.slice(i, i + 6);
      assert.ok(!r.stderr.includes(piece), `${label}: stderr contains a token fragment (offset ${i})`);
      assert.ok(!r.stdout.includes(piece), `${label}: stdout contains a token fragment (offset ${i})`);
    }
  }
}

const onPath = (d, p) => d.auth.filter((a) => a.url === p);

test("right token in the hook env: bearer goes to /mcp only, healthy daemon stays enforced on every surface", async () => {
  await withDaemon({ mcp: 406, token: TOKEN }, async (d) => {
    for (const [label, call] of Object.entries(CALLS)) {
      d.auth.length = 0;
      const r = await runHook(call.mode, d.port, call.input, { SKYLINE_DAEMON_TOKEN: TOKEN });
      assertEnforced(label, r);
      assert.match(r.stderr, call.substitute, `${label}: substitute text`);
      assertNoTokenLeak(label, r, TOKEN);
      const mcp = onPath(d, "/mcp");
      const health = onPath(d, "/health");
      assert.equal(mcp.length, 1, `${label}: one /mcp probe`);
      assert.ok(mcp[0].authorization === `Bearer ${TOKEN}`, `${label}: /mcp carried the bearer`);
      assert.equal(health.length, 1, `${label}: one /health probe`);
      assert.ok(health[0].authorization === undefined, `${label}: /health carried no Authorization`);
    }
  });
});

test("no token in the hook env: 401 fails open and says no bearer was sent", async () => {
  await withDaemon({ mcp: 406, token: TOKEN }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input);
    assertAllowed("no token", r, /401 on \/mcp/);
    assert.match(r.stderr, /was sent no bearer/);
    assert.match(r.stderr, /SKYLINE_DAEMON_TOKEN is not set or unusable/);
    assert.doesNotMatch(r.stderr, /rejected/);
    assert.doesNotMatch(r.stderr, /cannot serve/, "no claim beyond what the probe knows");
    assertNoTokenLeak("no token", r, TOKEN, WRONG_TOKEN);
    assert.ok(d.auth.every((a) => a.authorization === undefined), "no Authorization header sent anywhere");
  });
});

test("wrong token in the hook env: 401 fails open and says the bearer was rejected", async () => {
  await withDaemon({ mcp: 406, token: TOKEN }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input, { SKYLINE_DAEMON_TOKEN: WRONG_TOKEN });
    assertAllowed("wrong token", r, /401 on \/mcp/);
    assert.match(r.stderr, /rejected the SKYLINE_DAEMON_TOKEN bearer/);
    assert.doesNotMatch(r.stderr, /was sent no bearer/);
    assert.doesNotMatch(r.stderr, /cannot serve/, "no claim beyond what the probe knows");
    assertNoTokenLeak("wrong token", r, TOKEN, WRONG_TOKEN);
    const mcp = onPath(d, "/mcp");
    assert.equal(mcp.length, 1, "one /mcp probe");
    assert.ok(mcp[0].authorization === `Bearer ${WRONG_TOKEN}`, "/mcp carried the (wrong) bearer");
    assert.ok(
      onPath(d, "/health").every((a) => a.authorization === undefined),
      "/health carried no Authorization"
    );
  });
});

test("a token that is not a plain header value is never sent, and the hook still fails open", async () => {
  await withDaemon({ mcp: 406, token: TOKEN }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input, {
      SKYLINE_DAEMON_TOKEN: `${WRONG_TOKEN}\r\nX-Injected: 1`,
    });
    assertAllowed("unusable token", r, /401 on \/mcp/);
    assert.match(r.stderr, /was sent no bearer/);
    assertNoTokenLeak("unusable token", r, WRONG_TOKEN);
    assert.ok(d.auth.every((a) => a.authorization === undefined), "no Authorization header sent anywhere");
  });
});

// --- re-review R1 Minor 1 (PR #54): the bearer goes to loopback only ----------
// The token is only ever meant for the local daemon (binary-skyline binds
// 127.0.0.1 and keeps its token store loopback-only), so a SKYLINE_DAEMON_HOST
// that names anything else must not receive it. Accepted trade-off: an
// auth-enabled daemon behind a tunnel or on another host answers 401 to the
// header-less probe and the hook fails open.

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

test("token + non-loopback host: no Authorization header is sent, 401 fails open saying the bearer was withheld", async (t) => {
  const lan = lanAddress();
  if (!lan) return t.skip("no non-loopback IPv4 address on this box; case not exercisable here");
  await withDaemon({ mcp: 406, token: TOKEN, bind: "0.0.0.0" }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input, {
      SKYLINE_DAEMON_TOKEN: TOKEN,
      SKYLINE_DAEMON_HOST: lan,
    });
    assert.ok(onPath(d, "/mcp").length === 1, "the dummy was reached on /mcp via the non-loopback address");
    assert.ok(
      d.auth.every((a) => a.authorization === undefined),
      "the dummy saw NO Authorization header on any path"
    );
    assertAllowed("non-loopback host", r, /401 on \/mcp/);
    assert.match(r.stderr, /bearer withheld because the host is not loopback/);
    assert.doesNotMatch(r.stderr, /rejected/, "no bearer went out, so none was rejected");
    assert.doesNotMatch(r.stderr, /is not set or unusable/, "the token IS usable; it was withheld");
    assertNoTokenLeak("non-loopback host", r, TOKEN);
  });
});

for (const host of ["127.0.0.1", "localhost", "LocalHost"]) {
  test(`token + loopback host ${host}: bearer sent to /mcp only, healthy daemon stays enforced`, async () => {
    await withDaemon({ mcp: 406, token: TOKEN }, async (d) => {
      const r = await runHook("read", d.port, CALLS.Read.input, {
        SKYLINE_DAEMON_TOKEN: TOKEN,
        SKYLINE_DAEMON_HOST: host,
      });
      assertEnforced(host, r);
      assert.match(r.stderr, CALLS.Read.substitute, `${host}: substitute text`);
      assertNoTokenLeak(host, r, TOKEN);
      const mcp = onPath(d, "/mcp");
      assert.equal(mcp.length, 1, `${host}: one /mcp probe`);
      assert.ok(mcp[0].authorization === `Bearer ${TOKEN}`, `${host}: /mcp carried the bearer`);
      assert.ok(
        onPath(d, "/health").every((a) => a.authorization === undefined),
        `${host}: /health carried no Authorization`
      );
    });
  });
}

test("token + host ::1: bearer sent to /mcp only, healthy daemon stays enforced", async (t) => {
  let d;
  try {
    d = await startDaemon({ mcp: 406, token: TOKEN, bind: "::1" });
  } catch (e) {
    return t.skip(`IPv6 loopback unavailable on this box (${e.code || e.message})`);
  }
  try {
    const r = await runHook("read", d.port, CALLS.Read.input, {
      SKYLINE_DAEMON_TOKEN: TOKEN,
      SKYLINE_DAEMON_HOST: "::1",
    });
    assertEnforced("::1", r);
    assert.match(r.stderr, CALLS.Read.substitute, "::1: substitute text");
    assertNoTokenLeak("::1", r, TOKEN);
    const mcp = onPath(d, "/mcp");
    assert.equal(mcp.length, 1, "::1: one /mcp probe");
    assert.ok(mcp[0].authorization === `Bearer ${TOKEN}`, "::1: /mcp carried the bearer");
    assert.ok(
      onPath(d, "/health").every((a) => a.authorization === undefined),
      "::1: /health carried no Authorization"
    );
  } finally {
    await d.close();
  }
});

// --- re-review R2 m1 + m2 (PR #54, round 3) -----------------------------------
// m1: with Node's env-proxy support on (NODE_USE_ENV_PROXY=1) and HTTP_PROXY
// set without the daemon host in NO_PROXY, http.get's default agent would send
// BOTH probe requests, bearer included, to the proxy. The probe must go direct.
// m2: the host is normalized ONCE (trimmed) and that same value feeds both the
// loopback comparison and the connect, so they can never disagree.

// The env that engages Node's env-proxy support for `proxyPort`, with every
// ambient proxy setting of the developer's shell overridden. NO_PROXY is empty
// so the daemon host is NOT exempted.
function proxyEnv(proxyPort) {
  const url = `http://127.0.0.1:${proxyPort}`;
  return {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: url,
    http_proxy: url,
    HTTPS_PROXY: "",
    https_proxy: "",
    NO_PROXY: "",
    no_proxy: "",
  };
}

// Does THIS Node actually route a default-agent http.get through the env
// proxy? Detected by a control child with the same env: if the proxy dummy
// sees the request the feature is live; if not (older Node, flag unsupported)
// the m1 test cannot exercise the path and skips with a message.
function envProxyEngages(proxy, targetPort) {
  const code =
    `require("http").get({host:"127.0.0.1",port:${targetPort},path:"/control"},` +
    `r=>{r.resume();r.on("end",()=>process.exit(0))}).on("error",()=>process.exit(0))`;
  return new Promise((resolve) => {
    const baseEnv = { ...process.env };
    delete baseEnv.SKYLINE_DAEMON_TOKEN;
    const child = spawn(process.execPath, ["-e", code], {
      env: { ...baseEnv, ...proxyEnv(proxy.port) },
      stdio: "ignore",
    });
    const timer = setTimeout(() => child.kill(), 3000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(proxy.requests.length > 0);
    });
  });
}

// Leading lines matching Node's own warning shape are split off; anything else
// (real unexpected stderr) stays in `rest` and still fails the assertions.
function stripNodeProxyWarning(stderr) {
  const lines = stderr.split("\n");
  const stripped = [];
  while (stripped.length < 2 && lines.length && (/^\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental/.test(lines[0]) || /^\(Use `node --trace-warnings/.test(lines[0]))) {
    stripped.push(lines.shift());
  }
  return { rest: lines.join("\n"), stripped };
}

test("env proxy (NODE_USE_ENV_PROXY=1 + HTTP_PROXY) is bypassed: the proxy sees 0 requests, the daemon gets the bearer on /mcp, enforcement holds", async (t) => {
  // The proxy answers 403 to everything, so a probe that wrongly goes through
  // it would fail OPEN (exit 0) and the daemon would see nothing.
  await withDaemon({ mcp: 403 }, async (proxy) => {
    await withDaemon({ mcp: 406, token: TOKEN }, async (d) => {
      if (!(await envProxyEngages(proxy, d.port))) {
        return t.skip("this Node does not route http.get through NODE_USE_ENV_PROXY/HTTP_PROXY (control request never reached the proxy dummy); case not exercisable here");
      }
      proxy.requests.length = 0;
      d.auth.length = 0;
      d.requests.length = 0;
      const r = await runHook("read", d.port, CALLS.Read.input, {
        ...proxyEnv(proxy.port),
        SKYLINE_DAEMON_TOKEN: TOKEN,
      });
      assert.equal(proxy.requests.length, 0, `the proxy saw requests: ${JSON.stringify(proxy.requests)}`);
      // Node itself prints an experimental-warning preamble on stderr for any
      // process run under NODE_USE_ENV_PROXY=1 (Node 22.23.2). It is not hook
      // output: strip exactly those two lines and nothing else.
      const { rest, stripped } = stripNodeProxyWarning(r.stderr);
      assert.ok(
        stripped.every((l) => /^\(node:\d+\) /.test(l) || /^\(Use `node --trace-warnings/.test(l)),
        `env proxy: unexpected stderr lines stripped: ${JSON.stringify(stripped)}`
      );
      const rClean = { ...r, stderr: rest };
      assertEnforced("env proxy", rClean);
      assert.match(rClean.stderr, CALLS.Read.substitute, "env proxy: substitute text");
      assertNoTokenLeak("env proxy", rClean, TOKEN);
      const mcp = onPath(d, "/mcp");
      assert.equal(mcp.length, 1, "the real daemon saw one /mcp probe");
      assert.ok(mcp[0].authorization === `Bearer ${TOKEN}`, "/mcp carried the bearer to the real daemon");
      assert.equal(onPath(d, "/health").length, 1, "the real daemon saw one /health probe");
      assert.ok(
        onPath(d, "/health").every((a) => a.authorization === undefined),
        "/health carried no Authorization"
      );
    });
  });
});

test("padded loopback host ' 127.0.0.1 ' is trimmed once: bearer sent to the daemon on /mcp only, healthy daemon stays enforced", async () => {
  await withDaemon({ mcp: 406, token: TOKEN }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input, {
      SKYLINE_DAEMON_TOKEN: TOKEN,
      SKYLINE_DAEMON_HOST: " 127.0.0.1 ",
    });
    assertEnforced("padded host", r);
    assert.match(r.stderr, CALLS.Read.substitute, "padded host: substitute text");
    assertNoTokenLeak("padded host", r, TOKEN);
    const mcp = onPath(d, "/mcp");
    assert.equal(mcp.length, 1, "padded host: one /mcp probe");
    assert.ok(mcp[0].authorization === `Bearer ${TOKEN}`, "padded host: /mcp carried the bearer");
    assert.ok(
      onPath(d, "/health").every((a) => a.authorization === undefined),
      "padded host: /health carried no Authorization"
    );
  });
});

test("a blank SKYLINE_DAEMON_HOST falls back to the default 127.0.0.1, not to http.get's implicit localhost", async () => {
  await withDaemon({ mcp: 406, token: TOKEN }, async (d) => {
    const r = await runHook("read", d.port, CALLS.Read.input, {
      SKYLINE_DAEMON_TOKEN: TOKEN,
      SKYLINE_DAEMON_HOST: "   ",
    });
    assertEnforced("blank host", r);
    assertNoTokenLeak("blank host", r, TOKEN);
    const mcp = onPath(d, "/mcp");
    assert.equal(mcp.length, 1, "blank host: one /mcp probe");
    assert.ok(mcp[0].authorization === `Bearer ${TOKEN}`, "blank host: /mcp carried the bearer (default host is loopback)");
  });
});

// --- refusing_tools (binary-skyline >= 1.4.0, #1069/#1081) --------------------
// Field names and values verified against binary-skyline origin/main
// src/mcp_server.rs health_body_with (refusing_tools: bool, refusal:
// "kill_switch" | "subscription" | "free_cap" | null).
const health14 = (refusing, refusal) =>
  `{"status":"ok","version":"1.4.0","account":"x","refusing_tools":${refusing},"refusal":${refusal === null ? "null" : JSON.stringify(refusal)}}`;

for (const kind of ["subscription", "kill_switch", "free_cap"]) {
  test(`refusing_tools:true (${kind}) on /health fails open on every surface, one line naming the label`, async () => {
    await withDaemon({ mcp: 406, health: health14(true, kind) }, async (d) => {
      for (const [label, call] of Object.entries(CALLS)) {
        const r = await runHook(call.mode, d.port, call.input);
        assertAllowed(`${kind} ${label}`, r, new RegExp(`refusing_tools \\(${kind}\\)`));
      }
    });
  });
}

test("refusing_tools:true with a junk refusal label: one line, the label is never echoed", async () => {
  for (const junk of ['"Sub\\u001b[31mX"', '"' + "a".repeat(80) + '"', "7", "null", "{}"]) {
    const body = `{"status":"ok","refusing_tools":true,"refusal":${junk}}`;
    await withDaemon({ mcp: 406, health: body }, async (d) => {
      const r = await runHook("read", d.port, CALLS.Read.input);
      assertAllowed(`junk ${junk.slice(0, 12)}`, r, /refusing_tools \(unknown\)/);
    });
  }
});

test("refusing_tools only counts as strict boolean true on a 200 /health", async () => {
  const rows = [
    ["refusing_tools:false (dev build, expired label)", health14(false, null).replace('"account":"x"', '"account":"expired"'), 200],
    ["refusing_tools as the string \"true\"", '{"status":"ok","refusing_tools":"true","refusal":"subscription"}', 200],
    ["refusing_tools as 1", '{"status":"ok","refusing_tools":1,"refusal":"subscription"}', 200],
    ["refusal label without refusing_tools", '{"status":"ok","refusal":"subscription"}', 200],
    ["healthy 1.4.0 body", health14(false, null), 200],
    ["500 with a refusing body", health14(true, "subscription"), 500],
  ];
  for (const [name, body, status] of rows) {
    await withDaemon({ mcp: 406, health: body, healthStatus: status }, async (d) => {
      assertEnforced(name, await runHook("read", d.port, CALLS.Read.input));
    });
  }
});

test("a refusing /health body that arrives after the hard deadline stays enforced", async () => {
  await withDaemon({ mcp: 406, health: health14(true, "subscription"), healthDelayMs: 900 }, async (d) => {
    assertEnforced("late refusing body", await runHook("read", d.port, CALLS.Read.input));
  });
});

// --- m2: /mcp answered, then the connection broke before /health settled -------
test("406 on /mcp followed by a connection reset still enforces (the daemon answered)", async () => {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    if (req.url === "/health") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(HEALTHY_124);
      }, 150);
      return;
    }
    res.writeHead(406, { "content-length": "100" });
    res.flushHeaders();
    setTimeout(() => req.socket.resetAndDestroy(), 40); // RST, so the client sees an error after the status line
  });
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await runHook("read", srv.address().port, CALLS.Read.input);
    assertEnforced("406 then reset", r);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => srv.close(r));
  }
});

// --- m3: bracketed IPv6 loopback host ------------------------------------------
test("token + host [::1] (bracketed): connects, bearer sent to /mcp only, healthy daemon stays enforced", async (t) => {
  let d;
  try {
    d = await startDaemon({ mcp: 406, token: TOKEN, bind: "::1" });
  } catch (e) {
    return t.skip(`IPv6 loopback unavailable on this box (${e.code || e.message})`);
  }
  try {
    const r = await runHook("read", d.port, CALLS.Read.input, {
      SKYLINE_DAEMON_TOKEN: TOKEN,
      SKYLINE_DAEMON_HOST: "[::1]",
    });
    assertEnforced("[::1]", r);
    assertNoTokenLeak("[::1]", r, TOKEN);
    const mcp = onPath(d, "/mcp");
    assert.equal(mcp.length, 1, "[::1]: one /mcp probe");
    assert.ok(mcp[0].authorization === `Bearer ${TOKEN}`, "[::1]: /mcp carried the bearer");
    assert.ok(onPath(d, "/health").every((a) => a.authorization === undefined), "[::1]: /health carried no Authorization");
  } finally {
    await d.close();
  }
});

// --- m1: the ONE hard deadline is load-bearing -----------------------------------
// The http `timeout` option is idle-only: a /health that keeps trickling bytes
// never goes idle, so only the hard DAEMON_TIMEOUT deadline bounds the hook.
test("/health that trickles a byte every 50ms forever: enforced, bounded by the hard deadline", async () => {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write(" "), 50);
      res.on("close", () => clearInterval(t));
      return;
    }
    res.writeHead(406);
    res.end();
  });
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await runHook("read", srv.address().port, CALLS.Read.input);
    assert.ok(r.ms < 1500, `bounded by the hard deadline, took ${r.ms}ms (status ${r.status})`);
    assertEnforced("trickling /health", r);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => srv.close(r));
  }
});

// --- m4: the Node-warning tolerance is exact, not any `(node:N)` line ------------
test("stripNodeProxyWarning strips only the UNDICI-EHPA line and the trace-warnings hint, at most 2 lines", () => {
  const ehpa = "(node:123) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.";
  const hint = "(Use `node --trace-warnings ...` to show where the warning was created)";
  assert.deepEqual(stripNodeProxyWarning(`${ehpa}\n${hint}\nUse read(x)`), { rest: "Use read(x)", stripped: [ehpa, hint] });
  const other = "(node:123) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.";
  assert.deepEqual(stripNodeProxyWarning(`${other}\nUse read(x)`).stripped, [], "an unrelated Node warning is not stripped");
  assert.deepEqual(stripNodeProxyWarning(`${ehpa}\n${ehpa}\n${ehpa}\nrest`).stripped.length, 2, "capped at 2 lines");
});
