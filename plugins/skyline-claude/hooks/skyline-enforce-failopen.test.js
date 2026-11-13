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
// The dummy daemon runs IN this process and the hook is spawned ASYNC: a
// spawnSync here would block the event loop and the dummy could never answer
// (the hook would then time out and look fail-open for the wrong reason).
// Dummies bind ephemeral loopback ports only, never 7333.

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
      res.end(health);
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
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
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
