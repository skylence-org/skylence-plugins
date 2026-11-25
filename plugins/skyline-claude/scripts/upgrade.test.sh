#!/usr/bin/env bash
# Shell test for upgrade.sh (binary-skyline#1121, skylence-plugins#45/#46).
# Run with: bash plugins/skyline-claude/scripts/upgrade.test.sh
#   UPGRADE_TEST_SHELLS="bash sh dash"  shells to run each case under (default
#                                       "bash sh"; a missing one is skipped)
#   UPGRADE_SH=<path>                   script under test (default: ./upgrade.sh)
#
# Never touches the real skyline, npm or daemon: each case runs upgrade.sh
# under `env -i` with PATH = a temp dir holding a fake `skyline` and a fake
# `npm` plus symlinks to the few tools used, HOME and TMPDIR redirected (so
# the summary/log land in the case's own HOME). The fakes record their argv;
# the fake `npm i -g` and `skyline update --yes` "install" a new version by
# rewriting the version file `skyline --version` reads.

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="${UPGRADE_SH:-$HERE/upgrade.sh}"
SHELLS="${UPGRADE_TEST_SHELLS:-bash sh}"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/skyline-upgrade-test.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT

# PATH inside each case is ONLY the fakes plus symlinks to the tools
# upgrade.sh and the fakes use, so a real skyline/npm can never be reached
# (not even one installed under /usr/bin), including in the no-skyline case.
TOOLS="$ROOT/tools"
mkdir -p "$TOOLS"
for t in head sed grep cat cp mkdir rm sleep; do
  p=$(command -v "$t") || { echo "missing tool: $t"; exit 1; }
  ln -s "$p" "$TOOLS/$t"
done

pass=0
fail=0
HINT="claude plugin marketplace update skylence-plugins"
OLD_BANNER="skyline binary updated and daemon restarted."
FULL_CALLS="skyline update --check | npm i -g @skylence-ai/skyline@latest | skyline setup | skyline daemon restart --port 7333"

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL [$CASE/$SH]: $1"
  echo "---- output ----"
  cat "$OUT" 2>/dev/null
  echo "---- summary file ----"
  cat "$SUMF" 2>/dev/null
  echo "---- calls ----"
  cat "$STATE/calls" 2>/dev/null
  echo "----------------"
}
has() { if grep -qF -- "$1" "$OUT"; then ok; else bad "expected output to contain: $1"; fi; }
hasnt() { if grep -qF -- "$1" "$OUT"; then bad "expected output NOT to contain: $1"; else ok; fi; }
rc_is() { if [ "$RC" -eq "$1" ]; then ok; else bad "exit code $RC, expected $1"; fi; }
last_is() {
  got=$(tail -n 1 "$OUT")
  if [ "$got" = "$1" ]; then ok; else bad "last line was: [$got] expected: [$1]"; fi
}
calls_are() {
  # The non --version calls, in order, joined with " | ".
  got=$(grep -v -- ' --version$' "$STATE/calls" 2>/dev/null | tr '\n' '|' | sed 's/|$//; s/|/ | /g')
  if [ "$got" = "$1" ]; then ok; else bad "calls were: [$got] expected: [$1]"; fi
}
# The summary file is the closing text of stdout plus "exit code: <rc>".
summary_ok() {
  if [ ! -f "$SUMF" ]; then bad "no summary file at $SUMF"; return; fi
  got=$(tail -n 1 "$SUMF")
  if [ "$got" = "exit code: $RC" ]; then ok; else bad "summary last line [$got], rc $RC"; fi
  body=$(sed '$d' "$SUMF")
  if grep -q '^To update the skyline-claude plugin:$' "$OUT"; then
    want=$(sed -n '/^To update the skyline-claude plugin:$/,$p' "$OUT")
  else
    want=$(tail -n 2 "$OUT")
  fi
  if [ "$body" = "$want" ]; then ok; else bad "summary file is not the closing text of stdout"; fi
}
summary_is() {
  if [ "$(cat "$SUMF" 2>/dev/null)" = "$1" ]; then ok; else bad "summary file differs from the expected text"; fi
}
summary_has() { if grep -qF -- "$1" "$SUMF" 2>/dev/null; then ok; else bad "expected summary file to contain: $1"; fi; }
log_has() { if grep -qF -- "$1" "$LOGF" 2>/dev/null; then ok; else bad "expected log $LOGF to contain: $1"; fi; }

write_fakes() {
  bin="$1"
  mkdir -p "$bin"
  cat >"$bin/skyline" <<'EOF'
#!/bin/sh
S="$FAKE_STATE"
echo "skyline $*" >>"$S/calls"
v=$(cat "$S/version")
mode=$(cat "$S/mode")
rcfile() { if [ -f "$S/$1" ]; then cat "$S/$1"; else echo 0; fi; }
case "$1 ${2:-}" in
  "--version ")
    if [ -f "$S/noversion" ]; then :
    elif [ -f "$S/garbage" ]; then echo "warning: deprecated flag"
    elif [ -f "$S/garbage_text" ]; then cat "$S/garbage_text"
    elif [ -f "$S/garbage_until_update" ] && [ ! -f "$S/updated" ]; then echo "warning: deprecated flag"
    elif [ -f "$S/vprefix" ]; then echo "skyline v$v"
    else echo "skyline $v"
    fi ;;
  "update --check")
    # Reader case: block until the test's reader has gone, so every later
    # write of upgrade.sh meets a closed pipe (bounded: ~10 s).
    if [ -f "$S/wait_reader" ]; then
      i=0
      while [ ! -f "$S/reader_gone" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
    fi
    case "$mode" in
      npm) echo "skyline is managed by npm. To upgrade, run:"; echo "  npm i -g @skylence-ai/skyline@latest" ;;
      uptodate) echo "Already up to date: $v" ;;
      available) echo "Update available: $v -> $(cat "$S/next")"; echo "Run \`skyline update\` to install." ;;
      degraded) echo "Update check degraded: authentication required"; echo "Offline or unreachable release endpoint; no upgrade applied." ;;
      hardfail) echo "Error: checking for updates" >&2; echo "HTTP status client error (404 Not Found)" >&2; exit 1 ;;
    esac ;;
  "update --yes")
    case "$mode" in
      uptodate) echo "Already up to date: $v" ;;
      available) cp "$S/next" "$S/version"; : >"$S/updated"; echo "Installed $(cat "$S/next")" ;;
      degraded) echo "Update check degraded: authentication required"; echo "Offline or unreachable release endpoint; no upgrade applied." ;;
      hardfail) echo "Error: checking for updates" >&2; echo "HTTP status client error (404 Not Found)" >&2; exit 1 ;;
      npm) echo "skyline is managed by npm. To upgrade, run:" ;;
    esac ;;
  "setup ")
    # A write to a dead pipe fails here (SIGPIPE is ignored by upgrade.sh and
    # stays ignored in its children), which the case sees as a failed setup.
    echo "fake setup done" || exit 7
    [ -f "$S/kill_at_setup" ] && kill -9 "$PPID"
    exit "$(rcfile setup_rc)" ;;
  "daemon restart")
    # A systemd restart SIGTERMs every process of the daemon's unit.
    [ -f "$S/term_at_restart" ] && kill -TERM "$PPID"
    exit "$(rcfile restart_rc)" ;;
  "daemon install") exit "$(rcfile install_rc)" ;;
  *) echo "fake skyline: unexpected argv: $*" >&2; exit 99 ;;
esac
exit 0
EOF
  cat >"$bin/npm" <<'EOF'
#!/bin/sh
S="$FAKE_STATE"
echo "npm $*" >>"$S/calls"
rc=0
[ -f "$S/npm_rc" ] && rc=$(cat "$S/npm_rc")
[ "$rc" -eq 0 ] || { echo "npm ERR! fake failure" >&2; exit "$rc"; }
cp "$S/next" "$S/version"
: >"$S/updated"
echo "changed 1 package"
EOF
  chmod +x "$bin/skyline" "$bin/npm"
}

# run_case <shell> <case-name> key=value...
#   state keys (written to the fakes' state dir): mode version next setup_rc
#   restart_rc install_rc npm_rc noversion garbage garbage_text
#   garbage_until_update vprefix kill_at_setup term_at_restart
#   special keys: noskyline=1 (no fake skyline), io=closed (stdout+stderr
#   closed) | io=reader (a reader that takes the first line and exits),
#   xdg=unset|elsewhere (no XDG_CACHE_HOME, or one outside HOME), xdgfile=1
#   (XDG_CACHE_HOME is a regular file), tmpfile=1 (so is TMPDIR), stale=1
#   (a previous run's "Upgrade complete." summary is in place).
run_case() {
  SH="$1"; CASE="$2"; shift 2
  DIR="$ROOT/$SH-$CASE"
  STATE="$DIR/state"
  OUT="$DIR/out"
  mkdir -p "$STATE" "$DIR/home" "$DIR/tmp"
  write_fakes "$DIR/bin"
  echo "1.4.0" >"$STATE/version"
  echo "1.4.1" >"$STATE/next"
  echo "npm" >"$STATE/mode"
  io=normal
  XDG="$DIR/home/.cache"
  TMPD="$DIR/tmp"
  SUMF="$DIR/home/.cache/skyline/upgrade-summary.txt"
  LOGF="$DIR/home/.cache/skyline/upgrade.log"
  for kv in "$@"; do
    k=${kv%%=*}; v=${kv#*=}
    case "$k" in
      noskyline) rm -f "$DIR/bin/skyline" ;;
      io) io="$v" ;;
      xdg)
        if [ "$v" = unset ]; then XDG=unset; else XDG="$DIR/xdg"; fi
        if [ "$v" = elsewhere ]; then
          SUMF="$DIR/xdg/skyline/upgrade-summary.txt"; LOGF="$DIR/xdg/skyline/upgrade.log"
        fi ;;
      xdgfile)
        XDG="$DIR/xdg-is-a-file"; : >"$XDG"
        SUMF="$DIR/tmp/skyline-upgrade-summary.txt"; LOGF="$DIR/tmp/skyline-upgrade.log" ;;
      tmpfile)
        TMPD="$DIR/tmp-is-a-file"; : >"$TMPD"; SUMF="" ; LOGF="" ;;
      stale)
        mkdir -p "$DIR/home/.cache/skyline"
        printf 'Upgrade complete.\nexit code: 0\n' >"$DIR/home/.cache/skyline/upgrade-summary.txt" ;;
      *) echo "$v" >"$STATE/$k" ;;
    esac
  done
  : >"$STATE/calls"
  : >"$OUT"
  SHP=$(command -v "$SH")
  ENVV=(PATH="$DIR/bin:$TOOLS" HOME="$DIR/home" TMPDIR="$TMPD" FAKE_STATE="$STATE")
  [ "$XDG" = unset ] || ENVV+=(XDG_CACHE_HOME="$XDG")
  case "$io" in
    normal)
      # In a subshell (the trailing exit keeps it from exec'ing env), so the
      # "Killed" notice of the kill case goes to /dev/null, not the report.
      (
        env -i "${ENVV[@]}" "$SHP" "$SCRIPT" >"$OUT" 2>&1
        exit $?
      ) 2>/dev/null
      RC=$? ;;
    closed)
      env -i "${ENVV[@]}" "$SHP" "$SCRIPT" >&- 2>&-
      RC=$? ;;
    reader)
      echo 1 >"$STATE/wait_reader"
      # The reader closes its end before it signals, so the pipe is dead for
      # every write after the first line.
      env -i "${ENVV[@]}" "$SHP" "$SCRIPT" 2>&1 | { head -n 1 >"$OUT"; exec 0<&-; : >"$STATE/reader_gone"; }
      RC=${PIPESTATUS[0]} ;;
  esac
}

expected_summary() {
  # expected_summary <binary status> <verdict> <rc>
  printf '%s\n' \
    "To update the skyline-claude plugin:" \
    "  claude plugin marketplace update skylence-plugins && claude plugin update skyline-claude@skylence-plugins" \
    "  codex plugin marketplace upgrade skylence-plugins" \
    "" \
    "Restart your agent session to load the updated plugin." \
    "" \
    "skyline upgrade summary:" \
    "  binary: $1 ($DIR/bin/skyline)" \
    "  setup:  ok" \
    "  daemon: restarted on port 7333" \
    "$2" \
    "exit code: $3"
}

# --- syntax ---------------------------------------------------------------
CASE=syntax; SH=sh; OUT="$ROOT/syntax.out"; STATE="$ROOT"; SUMF=""
if sh -n "$SCRIPT" >"$OUT" 2>&1; then ok; else bad "sh -n failed"; fi
SH=bash
if bash -n "$SCRIPT" >"$OUT" 2>&1; then ok; else bad "bash -n failed"; fi

for SHELL_UNDER_TEST in $SHELLS; do
  S="$SHELL_UNDER_TEST"
  if ! command -v "$S" >/dev/null 2>&1; then
    echo "upgrade.test.sh: shell $S not found; its cases not run"
    continue
  fi
  if [ "$S" != bash ] && [ "$S" != sh ]; then
    CASE=syntax; SH=$S; OUT="$ROOT/syntax.out"; STATE="$ROOT"; SUMF=""
    if "$S" -n "$SCRIPT" >"$OUT" 2>&1; then ok; else bad "$S -n failed"; fi
  fi

  # npm-managed install, new version published: updated, setup, restart, exit 0.
  run_case "$S" npm-updated mode=npm
  rc_is 0
  has "binary: updated 1.4.0 -> 1.4.1"
  has "setup:  ok"
  has "daemon: restarted on port 7333"
  has "$HINT"
  hasnt "$OLD_BANNER"
  calls_are "$FULL_CALLS"
  summary_ok
  # The paths come first, and the log holds the step output and the closing.
  got=$(head -n 1 "$OUT")
  if [ "$got" = "skyline upgrade: summary file $SUMF, full log $LOGF. If this output stops early, read the summary file." ]; then ok; else bad "first line was: [$got]"; fi
  log_has "changed 1 package"
  log_has "fake setup done"
  log_has "Upgrade complete."
  if [ -e "$DIR/home/.cache/skyline/upgrade-step.out" ]; then bad "step file left behind"; else ok; fi

  # npm-managed, npm reinstalls the same version: already current, exit 0.
  run_case "$S" npm-current mode=npm next=1.4.0
  rc_is 0
  has "binary: already current at 1.4.0"
  hasnt "updated 1.4.0"
  summary_ok

  # GitHub update chain, newer release: updated via `skyline update --yes`.
  run_case "$S" gh-updated mode=available
  rc_is 0
  has "binary: updated 1.4.0 -> 1.4.1"
  calls_are "skyline update --check | skyline update --yes | skyline setup | skyline daemon restart --port 7333"
  summary_ok

  # GitHub chain, up to date: already current, exit 0.
  run_case "$S" gh-uptodate mode=uptodate
  rc_is 0
  has "binary: already current at 1.4.0"

  # #45: degraded check exits 0 with "no upgrade applied" -> a FAILED update,
  # never "already current"; setup + restart still run; exit 1.
  run_case "$S" gh-degraded mode=degraded
  rc_is 1
  has "binary: update failed: update check (no upgrade applied); skyline is at 1.4.0"
  hasnt "already current"
  hasnt "$OLD_BANNER"
  has "$HINT"
  has "Upgrade did not complete cleanly: update failed: update check (no upgrade applied)"
  calls_are "skyline update --check | skyline update --yes | skyline setup | skyline daemon restart --port 7333"
  summary_ok

  # #46: `skyline update` hard-fails (404) -> reported, later steps still run.
  run_case "$S" gh-hardfail mode=hardfail
  rc_is 1
  has "binary: update failed: skyline update --yes (exit 1); skyline is at 1.4.0"
  has "404 Not Found"
  has "setup:  ok"
  has "daemon: restarted on port 7333"
  has "$HINT"
  calls_are "skyline update --check | skyline update --yes | skyline setup | skyline daemon restart --port 7333"
  summary_ok

  # npm itself fails -> reported, setup + restart still run, exit 1.
  run_case "$S" npm-fails mode=npm npm_rc=1
  rc_is 1
  has "binary: update failed: npm i -g @skylence-ai/skyline@latest (exit 1); skyline is at 1.4.0"
  has "npm ERR! fake failure"
  has "daemon: restarted on port 7333"
  has "$HINT"
  summary_ok

  # setup fails -> reported, restart still runs, exit 1, binary line still honest.
  run_case "$S" setup-fails mode=npm setup_rc=3
  rc_is 1
  has "binary: updated 1.4.0 -> 1.4.1"
  has "setup:  failed (exit 3)"
  has "daemon: restarted on port 7333"
  has "setup failed: skyline setup (exit 3)"
  calls_are "$FULL_CALLS"
  summary_ok

  # restart fails, install fallback works -> exit 0.
  run_case "$S" restart-falls-back mode=npm restart_rc=1
  rc_is 0
  has "daemon: installed on port 7333 (restart failed)"
  calls_are "$FULL_CALLS | skyline daemon install --port 7333"
  summary_ok

  # restart and install both fail -> exit 1.
  run_case "$S" daemon-fails mode=npm restart_rc=1 install_rc=2
  rc_is 1
  has "daemon: failed: skyline daemon restart and install --port 7333"
  has "daemon restart failed"
  summary_ok

  # skyline not on PATH -> exit 1, nothing runs (npm untouched), summary says so.
  run_case "$S" no-skyline noskyline=1
  rc_is 1
  has "skyline is not on PATH; nothing was upgraded."
  calls_are ""
  summary_ok
  summary_has "skyline is not on PATH; nothing was upgraded."

  # The summary is the closing text: its last line says complete or not.
  run_case "$S" closing-ok mode=npm
  last_is "Upgrade complete."
  run_case "$S" closing-fail mode=degraded
  last_is "Upgrade did not complete cleanly: update failed: update check (no upgrade applied)"

  # `skyline --version` prints nothing -> a failed step, never "already current".
  run_case "$S" no-version mode=npm noversion=1
  rc_is 1
  has "binary: version unknown: skyline --version printed no version number"
  hasnt "already current"
  has "version check failed: skyline --version printed no version number after the upgrade"
  summary_ok

  # --- version parsing (review M3) ------------------------------------------
  # A first --version line with no version number is unknown, never "already
  # current", and fails the run.
  run_case "$S" garbage-version mode=npm garbage=1
  rc_is 1
  has "binary: version unknown: skyline --version printed no version number"
  hasnt "already current"
  hasnt "deprecated flag ->"
  summary_ok
  # Unknown before, known after: say so, no invented "updated" line.
  run_case "$S" garbage-before mode=npm garbage_until_update=1
  rc_is 0
  has "binary: at 1.4.1 (the version before the upgrade is unknown)"
  hasnt "updated unknown"
  # A warning line that happens to hold a dotted number is no version either.
  run_case "$S" dotted-garbage-since mode=npm "garbage_text=warning: deprecated since 2.0.0"
  rc_is 1
  has "binary: version unknown: skyline --version printed no version number"
  hasnt "already current"
  run_case "$S" dotted-garbage-ip mode=npm "garbage_text=error: 127.0.0.1 refused"
  rc_is 1
  has "binary: version unknown: skyline --version printed no version number"
  hasnt "already current"
  # Two-digit major, two-digit patch, pre-release suffix, leading v.
  run_case "$S" two-digit-major mode=npm version=10.2.3 next=10.2.4
  rc_is 0
  has "binary: updated 10.2.3 -> 10.2.4"
  run_case "$S" two-digit-patch mode=npm version=1.4.9 next=1.4.10
  rc_is 0
  has "binary: updated 1.4.9 -> 1.4.10"
  run_case "$S" rc-to-final mode=npm version=1.4.1-rc.1 next=1.4.1
  rc_is 0
  has "binary: updated 1.4.1-rc.1 -> 1.4.1"
  run_case "$S" leading-v mode=npm vprefix=1
  rc_is 0
  has "binary: updated 1.4.0 -> 1.4.1"

  # --- the reader goes away (review I3) -------------------------------------
  # stdout and stderr closed: every step runs, exit code right, summary exact.
  run_case "$S" closed-ok mode=npm io=closed
  rc_is 0
  calls_are "$FULL_CALLS"
  summary_is "$(expected_summary "updated 1.4.0 -> 1.4.1" "Upgrade complete." 0)"
  log_has "fake setup done"
  run_case "$S" closed-degraded mode=degraded io=closed
  rc_is 1
  calls_are "skyline update --check | skyline update --yes | skyline setup | skyline daemon restart --port 7333"
  summary_is "$(expected_summary "update failed: update check (no upgrade applied); skyline is at 1.4.0" \
    "Upgrade did not complete cleanly: update failed: update check (no upgrade applied)" 1)"

  # A reader that takes the first line (the paths) and exits before the first
  # step: every later write meets a dead pipe. Every step still runs, no child
  # writes to the dead pipe (setup would fail), the summary is exact (no
  # leaked or doubled lines) and the exit code is right.
  run_case "$S" reader-ok mode=npm io=reader
  rc_is 0
  calls_are "$FULL_CALLS"
  summary_is "$(expected_summary "updated 1.4.0 -> 1.4.1" "Upgrade complete." 0)"
  got=$(cat "$OUT")
  if [ "$got" = "skyline upgrade: summary file $SUMF, full log $LOGF. If this output stops early, read the summary file." ]; then ok; else bad "reader saw: [$got]"; fi
  log_has "changed 1 package"
  log_has "Upgrade complete."
  run_case "$S" reader-degraded mode=degraded io=reader
  rc_is 1
  calls_are "skyline update --check | skyline update --yes | skyline setup | skyline daemon restart --port 7333"
  summary_is "$(expected_summary "update failed: update check (no upgrade applied); skyline is at 1.4.0" \
    "Upgrade did not complete cleanly: update failed: update check (no upgrade applied)" 1)"

  # Killed mid-run: a previous run's "Upgrade complete." never survives; the
  # summary says the run has not finished.
  run_case "$S" killed-mid-run mode=npm kill_at_setup=1 stale=1
  if [ "$RC" -ne 0 ]; then ok; else bad "a killed run exited 0"; fi
  calls_are "skyline update --check | npm i -g @skylence-ai/skyline@latest | skyline setup"
  summary_has "has not finished"
  summary_has "Last step started: skyline setup (step 2 of 3)"
  summary_has "the upgrade is NOT confirmed"
  summary_has "Last step finished: binary update: npm i -g @skylence-ai/skyline@latest exited 0"

  # SIGTERM right after the setup step, as a systemd restart does to every
  # process of the daemon's unit (ruling 1611): the record says not finished,
  # restart started, setup finished, and carries no final exit code.
  run_case "$S" term-after-setup mode=npm term_at_restart=1
  if [ "$RC" -ne 0 ]; then ok; else bad "a SIGTERMed run exited 0"; fi
  calls_are "$FULL_CALLS"
  summary_has "has not finished"
  summary_has "Last step started: skyline daemon restart --port 7333 (step 3 of 3)"
  summary_has "Last step finished: skyline setup: ok"
  if grep -qF "exit code:" "$SUMF"; then bad "a stopped run wrote a final summary"; else ok; fi
  if grep -qF "Upgrade complete." "$SUMF"; then bad "stale summary survived"; else ok; fi

  # --- where the summary goes ---------------------------------------------------
  # XDG_CACHE_HOME unset: $HOME/.cache/skyline. Set elsewhere: $XDG/skyline.
  run_case "$S" xdg-unset mode=npm xdg=unset
  rc_is 0
  summary_ok
  has "summary file $DIR/home/.cache/skyline/upgrade-summary.txt"
  run_case "$S" xdg-elsewhere mode=npm xdg=elsewhere
  rc_is 0
  summary_ok
  has "summary file $DIR/xdg/skyline/upgrade-summary.txt"
  if [ -e "$DIR/home/.cache" ]; then bad "wrote under HOME/.cache although XDG_CACHE_HOME is set"; else ok; fi
  # Cache dir cannot be created: ${TMPDIR}/skyline-upgrade-summary.txt.
  run_case "$S" xdg-unwritable mode=npm xdgfile=1
  rc_is 0
  calls_are "$FULL_CALLS"
  summary_ok
  has "summary file $DIR/tmp/skyline-upgrade-summary.txt"
  # Neither is writable: said up front; the outcome and exit code are unchanged.
  run_case "$S" nothing-writable mode=npm xdgfile=1 tmpfile=1
  rc_is 0
  calls_are "$FULL_CALLS"
  has "no writable directory for the summary and log files"
  last_is "Upgrade complete."
  run_case "$S" nothing-writable-fail mode=npm xdgfile=1 tmpfile=1 setup_rc=4
  rc_is 1
  has "setup:  failed (exit 4)"
done

echo "upgrade.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
