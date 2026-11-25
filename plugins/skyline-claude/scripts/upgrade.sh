#!/usr/bin/env bash
# Upgrade skyline for the skyline-claude plugin: update the binary, run
# `skyline setup`, restart the daemon, then say honestly what happened.
#
# This runs from an agent shell (no TTY), where the binary's interactive
# auto-setup never fires (binary-skyline#1121), so `skyline setup` is called
# explicitly: it refreshes the daemon unit, the marketplace plugins and the
# agent wiring after a binary update.
#
# No `set -e` (#46): every step runs and records its own result, so a failed
# update still gets the setup + restart repair and the plugin-refresh hint.
# The summary says which outcome happened and the exit code is 1 when any
# step failed (#45). Keep the body POSIX sh (the test runs `sh -n` on it).

PORT=7333
failed=""

note_fail() {
  if [ -z "$failed" ]; then failed="$1"; else failed="$failed; $1"; fi
}

skyline_version() {
  skyline --version 2>/dev/null | head -n 1 | sed 's/^skyline[[:space:]]*//'
}

if ! command -v skyline >/dev/null 2>&1; then
  echo "skyline is not on PATH; nothing was upgraded." >&2
  echo "Install it with: npm i -g @skylence-ai/skyline@latest && skyline setup" >&2
  exit 1
fi

before=$(skyline_version)
[ -n "$before" ] || before="unknown"

# 1. Update the skyline binary. Public-npm installs (the end-user distribution)
# are routed to npm by `skyline update` itself since binary-skyline#772, so
# pick the updater that actually applies: npm for an npm-managed install,
# skyline's own GitHub update chain otherwise. `skyline update` exits 0 when
# its release check degrades ("no upgrade applied"), so its output is checked
# too: that case is a failed update, not "already current" (#45).
update_step=""
update_failed=""
update_out=""
check_out=$(skyline update --check 2>&1)
if printf '%s\n' "$check_out" | grep -qi 'managed by npm'; then
  update_step="npm i -g @skylence-ai/skyline@latest"
  npm i -g @skylence-ai/skyline@latest
  update_rc=$?
else
  update_step="skyline update --yes"
  update_out=$(skyline update --yes 2>&1)
  update_rc=$?
  [ -z "$update_out" ] || printf '%s\n' "$update_out"
fi
if [ "$update_rc" -ne 0 ]; then
  update_failed="$update_step (exit $update_rc)"
elif printf '%s\n' "$update_out" | grep -qi 'no upgrade applied'; then
  update_failed="update check (no upgrade applied)"
fi
[ -z "$update_failed" ] || note_fail "update failed: $update_failed"

# The update may have moved the binary; drop the shell's cached path.
hash -r 2>/dev/null || true

# 2. Re-run setup: daemon unit, marketplace plugins, agent wiring. It runs
# before the restart because it does not replace it: setup returns early when
# its fingerprint already matches, and its own restart is best-effort.
skyline setup </dev/null
setup_rc=$?
if [ "$setup_rc" -eq 0 ]; then
  setup_status="ok"
else
  setup_status="failed (exit $setup_rc)"
  note_fail "setup failed: skyline setup (exit $setup_rc)"
fi

# 3. Restart the daemon so it runs the freshly installed binary; install the
# service when there is nothing to restart.
if skyline daemon restart --port "$PORT" 2>/dev/null; then
  daemon_status="restarted on port $PORT"
elif skyline daemon install --port "$PORT"; then
  daemon_status="installed on port $PORT (restart failed)"
else
  daemon_status="failed: skyline daemon restart and install --port $PORT"
  note_fail "daemon restart failed: skyline daemon restart/install --port $PORT"
fi

after=$(skyline_version)
[ -n "$after" ] || after="unknown"
bin_path=$(command -v skyline)

if [ -n "$update_failed" ]; then
  binary_status="update failed: $update_failed; skyline is at $after"
elif [ "$before" != "$after" ]; then
  binary_status="updated $before -> $after"
else
  binary_status="already current at $after"
fi

echo ""
echo "skyline upgrade summary:"
echo "  binary: $binary_status ($bin_path)"
echo "  setup:  $setup_status"
echo "  daemon: $daemon_status"
echo ""
echo "To update the skyline-claude plugin:"
echo "  claude plugin marketplace update skylence-plugins && claude plugin update skyline-claude@skylence-plugins"
echo "  codex plugin marketplace upgrade skylence-plugins"
echo ""
echo "Restart your agent session to load the updated plugin."

if [ -n "$failed" ]; then
  echo ""
  echo "Upgrade did not complete cleanly: $failed" >&2
  exit 1
fi
exit 0
