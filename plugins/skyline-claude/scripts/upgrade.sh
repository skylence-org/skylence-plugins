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
# step failed (#45).
#
# The reader of this script's output can go away mid-run: an agent's skyline
# `run` call makes this script a child of the daemon it restarts, and the
# daemon's pipes close when it exits. So:
#   - SIGPIPE is ignored, and a closed stdout/stderr is reopened on /dev/null;
#     in a step file (a command substitution only when no directory is
#     writable), and the shell then copies it to the log and relays it;
#     in a step file, which is copied to the log and then relayed;
#   - the shell itself never writes to stdout (a failed builtin write in bash
#     leaves its buffer to leak into the next redirect): every line goes to
#     the log, then to stdout through `cat`, whose failures are ignored;
#   - the closing text and the exit code always go to the summary file, which
#     says "has not finished" until then.
# The log and summary live in ${XDG_CACHE_HOME:-$HOME/.cache}/skyline/
# (upgrade.log, upgrade-summary.txt), or in ${TMPDIR:-/tmp} (skyline-
# prefixed) when that cannot be written; their paths are printed first. Writes
# to them are best effort and never change the outcome or the exit code.
# Keep the body POSIX sh (the test runs it under bash, sh and dash).

trap '' PIPE
(true 3>&1) 2>/dev/null || exec 1>/dev/null
(true 3>&2) || exec 2>/dev/null

PORT=7333
failed=""
LOG=/dev/null
SUMMARY=""
STEP=/dev/null
NL='
'

# The summary file's text until the run finishes: a run the daemon restart
# (or anything else) stops early leaves this, never a previous run's result.
started_text() {
  printf '%s' "skyline upgrade started (pid $$) and has not finished. If this is still the text after the upgrade call returned, wait a few seconds and read it again. If it still does not change, the script was stopped before its summary (a daemon restart can stop it): the upgrade is NOT confirmed. Full output so far: $LOG"
}
# progress/finished: rewrite the "has not finished" text with the last step
# started and the last step finished (ruling 1611), so a run stopped
# anywhere leaves an honest record.
last_started="none yet"
last_finished="none yet"
progress() {
  last_started="$1"
  write_progress
}
finished() {
  last_finished="$1"
  write_progress
}
write_progress() {
  [ -n "$SUMMARY" ] || return 0
  printf '%s\nLast step started: %s\nLast step finished: %s\n' "$(started_text)" "$last_started" "$last_finished" \
    2>/dev/null >"$SUMMARY"
}

use_dir() {
  mkdir -p "$1" 2>/dev/null || return 1
  LOG="$1/${2}upgrade.log"
  SUMMARY="$1/${2}upgrade-summary.txt"
  STEP="$1/${2}upgrade-step.out"
  printf '' 2>/dev/null >"$LOG" || return 1
  printf '' 2>/dev/null >"$STEP" || return 1
  printf '%s\n' "$(started_text)" 2>/dev/null >"$SUMMARY" || return 1
}
if use_dir "${XDG_CACHE_HOME:-$HOME/.cache}/skyline" ""; then
  true
elif use_dir "${TMPDIR:-/tmp}" "skyline-"; then
  true
else
  LOG=/dev/null
  SUMMARY=""
  STEP=/dev/null
fi

# say: one line to the log, then to stdout through an external cat.
say() {
  printf '%s\n' "$*" 2>/dev/null >>"$LOG"
  { printf '%s\n' "$*" | cat; } 2>/dev/null
}
say_err() {
  printf '%s\n' "$*" 2>/dev/null >>"$LOG"
  { printf '%s\n' "$*" | cat 1>&3 2>/dev/null; } 3>&2 2>/dev/null
}
# run_step: stdin /dev/null, stdout+stderr into the step file (a command
# substitution when no directory is writable); returns its rc and leaves the
# output in STEP_OUT. Matching uses `case` on STEP_OUT, never a pipe.
STEP_OUT=""
run_step() {
  if [ "$STEP" = /dev/null ]; then
    STEP_OUT=$("$@" </dev/null 2>&1)
    return $?
  fi
  "$@" </dev/null >"$STEP" 2>&1
  step_rc=$?
  STEP_OUT=$(cat "$STEP" 2>/dev/null)
  return "$step_rc"
}
log_step() {
  [ -z "$STEP_OUT" ] || printf '%s\n' "$STEP_OUT" 2>/dev/null >>"$LOG"
}
show_step() {
  [ -z "$STEP_OUT" ] || say "$STEP_OUT"
}
# finish <closing text> <exit code> [quiet]: the summary file gets the closing
# text plus the exit code before anything else; stdout gets the text unless
# it was already printed (quiet).
finish() {
  if [ -n "$SUMMARY" ]; then
    printf '%s\nexit code: %s\n' "$1" "$2" 2>/dev/null >"$SUMMARY"
  fi
  [ "${3:-}" = quiet ] || say "$1"
  [ "$STEP" = /dev/null ] || rm -f "$STEP" 2>/dev/null
  exit "$2"
}

note_fail() {
  if [ -z "$failed" ]; then failed="$1"; else failed="$failed; $1"; fi
}

# The version from `skyline --version`, whose shape is `skyline 1.3.0`
# (also `skyline v10.2.3`, `skyline 1.5.0-rc.1`). Any other line, including
# a warning that happens to contain a dotted number, is no version at all.
skyline_version() {
  { skyline --version | sed -n 's/^skyline[[:space:]][[:space:]]*v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*[-+.0-9A-Za-z]*\).*/\1/p' | head -n 1; } 2>/dev/null
}

if [ -n "$SUMMARY" ]; then
  say "skyline upgrade: summary file $SUMMARY, full log $LOG. If this output stops early, read the summary file."
else
  say "skyline upgrade: no writable directory for the summary and log files; this output is the only record."
fi

if ! command -v skyline >/dev/null 2>&1; then
  say_err "skyline is not on PATH; nothing was upgraded."
  say_err "Install it with: npm i -g @skylence-ai/skyline@latest && skyline setup"
  finish "skyline is not on PATH; nothing was upgraded.${NL}Install it with: npm i -g @skylence-ai/skyline@latest && skyline setup" 1 quiet
fi

before=$(skyline_version)
[ -n "$before" ] || before="unknown"

# 1. Update the skyline binary. Public-npm installs (the end-user distribution)
# are routed to npm by `skyline update` itself since binary-skyline#772, so
# pick the updater that actually applies: npm for an npm-managed install,
# skyline's own GitHub update chain otherwise. `skyline update` exits 0 when
# its release check degrades ("no upgrade applied"), so its output is checked
# too: that case is a failed update, not "already current" (#45).
update_failed=""
progress "binary update: skyline update --check, then npm i -g or skyline update --yes (step 1 of 3)"
run_step skyline update --check
log_step
case "$STEP_OUT" in
  *[Mm]"anaged by npm"*) npm_managed=1 ;;
  *) npm_managed=0 ;;
esac
if [ "$npm_managed" -eq 1 ]; then
  update_step="npm i -g @skylence-ai/skyline@latest"
  run_step npm i -g @skylence-ai/skyline@latest
  update_rc=$?
  show_step
else
  update_step="skyline update --yes"
  run_step skyline update --yes
  update_rc=$?
  show_step
fi
if [ "$update_rc" -ne 0 ]; then
  update_failed="$update_step (exit $update_rc)"
else
  case "$STEP_OUT" in
    *[Nn]"o upgrade applied"*) update_failed="update check (no upgrade applied)" ;;
  esac
fi
[ -z "$update_failed" ] || note_fail "update failed: $update_failed"
if [ -n "$update_failed" ]; then
  finished "binary update: failed: $update_failed"
else
  finished "binary update: $update_step exited 0"
fi

# The update may have moved the binary; drop the shell's cached path.
hash -r 2>/dev/null || true

# 2. Re-run setup: daemon unit, marketplace plugins, agent wiring. It runs
# before the restart because it does not replace it: setup returns early when
# its fingerprint already matches, and its own restart is best-effort.
progress "skyline setup (step 2 of 3)"
run_step skyline setup
setup_rc=$?
show_step
if [ "$setup_rc" -eq 0 ]; then
  setup_status="ok"
else
  setup_status="failed (exit $setup_rc)"
  note_fail "setup failed: skyline setup (exit $setup_rc)"
fi
finished "skyline setup: $setup_status"

# 3. Restart the daemon so it runs the freshly installed binary; install the
# service when there is nothing to restart (a failed restart is only logged).
progress "skyline daemon restart --port $PORT (step 3 of 3)"
if run_step skyline daemon restart --port "$PORT"; then
  show_step
  daemon_status="restarted on port $PORT"
else
  log_step
  if run_step skyline daemon install --port "$PORT"; then
    show_step
    daemon_status="installed on port $PORT (restart failed)"
  else
    show_step
    daemon_status="failed: skyline daemon restart and install --port $PORT"
    note_fail "daemon restart failed: skyline daemon restart/install --port $PORT"
  fi
fi
finished "daemon: $daemon_status"

# An unreadable version after the upgrade is a failure, never "already current".
after=$(skyline_version)
if [ -z "$after" ]; then
  after="unknown"
  note_fail "version check failed: skyline --version printed no version number after the upgrade"
fi
bin_path=$(command -v skyline)

if [ -n "$update_failed" ]; then
  binary_status="update failed: $update_failed; skyline is at $after"
elif [ "$after" = "unknown" ]; then
  binary_status="version unknown: skyline --version printed no version number"
elif [ "$before" = "unknown" ]; then
  binary_status="at $after (the version before the upgrade is unknown)"
elif [ "$before" != "$after" ]; then
  binary_status="updated $before -> $after"
else
  binary_status="already current at $after"
fi

if [ -n "$failed" ]; then
  verdict="Upgrade did not complete cleanly: $failed"
  rc=1
else
  verdict="Upgrade complete."
  rc=0
fi

# The summary is the closing text: it is what an operator or agent acts on.
say ""
finish "To update the skyline-claude plugin:
  claude plugin marketplace update skylence-plugins && claude plugin update skyline-claude@skylence-plugins
  codex plugin marketplace upgrade skylence-plugins

Restart your agent session to load the updated plugin.

skyline upgrade summary:
  binary: $binary_status ($bin_path)
  setup:  $setup_status
  daemon: $daemon_status
$verdict" "$rc"
