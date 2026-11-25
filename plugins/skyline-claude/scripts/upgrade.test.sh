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
trap 'chmod -R u+w "$ROOT" 2>/dev/null; rm -rf "$ROOT"' EXIT

# PATH inside each case is ONLY the fakes plus symlinks to the tools
# upgrade.sh and the fakes use, so a real skyline/npm can never be reached
# (not even one installed under /usr/bin), including in the no-skyline case.
TOOLS="$ROOT/tools"
mkdir -p "$TOOLS"
for t in head sed grep cat cp mkdir rm sleep mv date ln; do
  p=$(command -v "$t") || { echo "missing tool: $t"; exit 1; }
  ln -s "$p" "$TOOLS/$t"
done

pass=0
fail=0
HINT="claude plugin marketplace update skylence-plugins"
OLD_BANNER="skyline binary updated and daemon restarted."
FULL_CALLS="skyline update --check | npm i -g @skylence-ai/skyline@latest | skyline setup | skyline daemon restart --port 7333"
# A previous run's finished summary (the stale=1 and f444=1 cases).
STALE_SUMMARY='skyline upgrade started 2000-01-01T00:00:00Z (pid 1).
Upgrade complete.
exit code: 0'
RUN_LINE_RE='^skyline upgrade started [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z \(pid [0-9]+\)\.$'

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
# header_ok: the summary's first line names this run's start (UTC) and pid,
# the same ones as stdout's first line (when there is a stdout).
header_ok() {
  h=$(head -n 1 "$SUMF" 2>/dev/null)
  if printf '%s\n' "$h" | grep -Eq "$RUN_LINE_RE"; then ok; else bad "summary first line [$h] is not the run line"; fi
  first=$(head -n 1 "$OUT" 2>/dev/null)
  case "$first" in
    "skyline upgrade started "*)
      if [ "${first%%): *})." = "$h" ]; then ok; else bad "summary run line [$h] is not stdout's [$first]"; fi ;;
  esac
}
# first_line_ok <rest>: stdout's first line is the run's start and pid, then
# <rest>.
first_line_ok() {
  got=$(head -n 1 "$OUT")
  if printf '%s\n' "$got" | grep -Eq '^skyline upgrade started [0-9TZ:-]+ \(pid [0-9]+\): ' && [ "${got#*): }" = "$1" ]; then
    ok
  else
    bad "first line was: [$got]"
  fi
}
# The summary file is the run line, the closing text of stdout, then
# "exit code: <rc>".
summary_ok() {
  if [ ! -f "$SUMF" ]; then bad "no summary file at $SUMF"; return; fi
  got=$(tail -n 1 "$SUMF")
  if [ "$got" = "exit code: $RC" ]; then ok; else bad "summary last line [$got], rc $RC"; fi
  header_ok
  body=$(sed '1d;$d' "$SUMF")
  if grep -q '^To update the skyline-claude plugin:$' "$OUT"; then
    want=$(sed -n '/^To update the skyline-claude plugin:$/,$p' "$OUT")
  else
    want=$(tail -n 2 "$OUT")
  fi
  if [ "$body" = "$want" ]; then ok; else bad "summary file is not the closing text of stdout"; fi
}
# summary_is <text>: the summary file is the run line, then <text>.
summary_is() {
  header_ok
  if [ "$(sed 1d "$SUMF" 2>/dev/null)" = "$1" ]; then ok; else bad "summary file differs from the expected text"; fi
}
summary_has() { if grep -qF -- "$1" "$SUMF" 2>/dev/null; then ok; else bad "expected summary file to contain: $1"; fi; }
log_has() { if grep -qF -- "$1" "$LOGF" 2>/dev/null; then ok; else bad "expected log $LOGF to contain: $1"; fi; }
# cache_clean <dir>: after a finished run only the log and the summary are
# left there: no step file, no temp file.
cache_clean() {
  left=$(ls -A "$1" 2>/dev/null | grep -vxF -e upgrade.log -e upgrade-summary.txt | tr '\n' ' ')
  if [ -z "$left" ]; then ok; else bad "left behind in $1: $left"; fi
}

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
# sync_point <step>: hand over to another run at marker files (the overlap
# cases): touch the file named in <step>_signal, then wait for the one named
# in <step>_wait. Bounded (~30 s); a timeout leaves sync_timeout, which the
# test fails on.
sync_point() {
  if [ -f "$S/${1}_signal" ]; then : >"$(cat "$S/${1}_signal")"; fi
  if [ -f "$S/${1}_wait" ]; then
    w=$(cat "$S/${1}_wait"); i=0
    while [ ! -f "$w" ]; do
      i=$((i + 1))
      if [ "$i" -gt 600 ]; then : >"$S/sync_timeout"; break; fi
      sleep 0.05
    done
  fi
}
case "$1 ${2:-}" in
  "--version ")
    # Stop the script (its pid is in the pid file, io=bg) before its first
    # step, then wait until it is gone (bounded).
    if [ -f "$S/term_at_version" ] && [ ! -f "$S/termed" ]; then
      : >"$S/termed"
      i=0
      while [ ! -s "$S/pid" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
      p=$(cat "$S/pid")
      kill -TERM "$p"
      i=0
      while kill -0 "$p" 2>/dev/null && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
      exit 0
    fi
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
      degraded) echo "Update check degraded: authentication required"; sync_point update_yes; echo "Offline or unreachable release endpoint; no upgrade applied." ;;
      hardfail) echo "Error: checking for updates" >&2; echo "HTTP status client error (404 Not Found)" >&2; exit 1 ;;
      npm) echo "skyline is managed by npm. To upgrade, run:" ;;
    esac ;;
  "setup ")
    sync_point setup
    # What a reader holding the summary open sees: a hard link to the file as
    # it is now (the summary-replaced case).
    if [ -f "$S/snap_at_setup" ]; then ln "$(cat "$S/snap_at_setup")" "$S/snap"; fi
    # A step killed by a signal (probeT of review M3).
    if [ -f "$S/term_self_at_setup" ]; then kill -TERM $$; fi
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
#   term_self_at_setup term_at_version (needs io=bg)
#   special keys: noskyline=1 (no fake skyline), io=closed (stdout+stderr
#   closed) | io=reader (a reader that takes the first line and exits) |
#   io=bg (the script runs in the background, its pid in the state's pid
#   file), xdg=unset|elsewhere (no XDG_CACHE_HOME, or one outside HOME),
#   xdgfile=1 (XDG_CACHE_HOME is a regular file), tmpfile=1 (so is TMPDIR),
#   stale=1 (a previous run's "Upgrade complete." summary is in place),
#   f444=1 (a previous run's summary and log, both mode 0444), ro=1 (the
#   cache dir is read-only during the run, so the files go to TMPDIR),
#   snap=1 (the fake setup hard-links the summary file to state/snap),
#   mv=fail (every mv fails) | mv=spy (each mv records in state/mvlog whether
#   its target existed, then runs the real mv).
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
  RO=0
  SNAP=0
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
        printf '%s\n' "$STALE_SUMMARY" >"$DIR/home/.cache/skyline/upgrade-summary.txt" ;;
      f444)
        mkdir -p "$DIR/home/.cache/skyline"
        printf '%s\n' "$STALE_SUMMARY" >"$DIR/home/.cache/skyline/upgrade-summary.txt"
        echo "old log" >"$DIR/home/.cache/skyline/upgrade.log"
        chmod 444 "$DIR/home/.cache/skyline/upgrade-summary.txt" "$DIR/home/.cache/skyline/upgrade.log" ;;
      ro)
        RO=1; SUMF="$DIR/tmp/skyline-upgrade-summary.txt"; LOGF="$DIR/tmp/skyline-upgrade.log" ;;
      snap) SNAP=1 ;;
      mv)
        if [ "$v" = fail ]; then
          printf '#!/bin/sh\nexit 1\n' >"$DIR/bin/mv"
        else
          printf '#!/bin/sh\nif [ -e "$3" ]; then echo present; else echo absent; fi >>"$FAKE_STATE/mvlog"\nexec "%s" "$@"\n' \
            "$TOOLS/mv" >"$DIR/bin/mv"
        fi
        chmod +x "$DIR/bin/mv" ;;
      *) echo "$v" >"$STATE/$k" ;;
    esac
  done
  [ "$SNAP" -eq 0 ] || echo "$SUMF" >"$STATE/snap_at_setup"
  [ "$RO" -eq 0 ] || { mkdir -p "$DIR/home/.cache/skyline"; chmod 555 "$DIR/home/.cache/skyline"; }
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
    bg)
      (
        env -i "${ENVV[@]}" "$SHP" "$SCRIPT" >"$OUT" 2>&1 &
        echo "$!" >"$STATE/pid"
        wait "$!"
        exit $?
      ) 2>/dev/null
      RC=$? ;;
  esac
  [ "$RO" -eq 0 ] || chmod 755 "$DIR/home/.cache/skyline"
}

# The overlap cases' runs (review I1). start_run <role> starts one in the
# background ($! is its pid); wait_for <file> waits (bounded, ~30 s) for a
# marker file.
start_run() {
  env -i PATH="$DIR/$1/bin:$TOOLS" HOME="$DIR/home" TMPDIR="$DIR/$1/tmp" FAKE_STATE="$DIR/$1/state" \
    "$SHP" "$SCRIPT" >"$DIR/$1/out" 2>&1 &
}
wait_for() {
  wi=0
  while [ ! -f "$1" ] && [ "$wi" -lt 600 ]; do sleep 0.05; wi=$((wi + 1)); done
  [ -f "$1" ]
}
# overlap_case <shell> <case> victim-first|victim-second
#   Two runs share one HOME, so one cache dir (/upgrade in two sessions, or a
#   re-run while the first is still going). The victim takes the GitHub chain
#   and its `skyline update --yes` degrades ("no upgrade applied", exit 0:
#   #45); the other run takes the npm chain. The fakes hand over at marker
#   files, so the order is fixed and nothing depends on timing:
#   victim-first:  the other run starts once the victim is inside its update
#                  and runs to its end before that update returns.
#   victim-second: the other run starts first and waits in its setup until
#                  the victim is inside its update; the victim's update
#                  returns only after the other run has ended.
#   Sets OUT/STATE/RC for the victim, OUT_OTHER/RC_OTHER, and SYNC_FAIL when
#   a hand-over timed out.
overlap_case() {
  SH="$1"; CASE="$2"
  DIR="$ROOT/$SH-$CASE"
  SYNC="$DIR/sync"
  mkdir -p "$SYNC" "$DIR/home"
  for r in victim other; do
    mkdir -p "$DIR/$r/state" "$DIR/$r/tmp"
    write_fakes "$DIR/$r/bin"
    echo "1.4.0" >"$DIR/$r/state/version"
    echo "1.4.1" >"$DIR/$r/state/next"
    : >"$DIR/$r/state/calls"
  done
  echo degraded >"$DIR/victim/state/mode"
  echo npm >"$DIR/other/state/mode"
  echo "$SYNC/victim-in-update" >"$DIR/victim/state/update_yes_signal"
  echo "$SYNC/other-exited" >"$DIR/victim/state/update_yes_wait"
  STATE="$DIR/victim/state"; OUT="$DIR/victim/out"; OUT_OTHER="$DIR/other/out"
  SUMF="$DIR/home/.cache/skyline/upgrade-summary.txt"; LOGF="$DIR/home/.cache/skyline/upgrade.log"
  SHP=$(command -v "$SH")
  SYNC_FAIL=""
  if [ "$3" = victim-first ]; then
    start_run victim; pv=$!
    wait_for "$SYNC/victim-in-update" || SYNC_FAIL="the victim never reached its update"
    start_run other; po=$!
  else
    echo "$SYNC/other-in-setup" >"$DIR/other/state/setup_signal"
    echo "$SYNC/victim-in-update" >"$DIR/other/state/setup_wait"
    start_run other; po=$!
    wait_for "$SYNC/other-in-setup" || SYNC_FAIL="the other run never reached its setup"
    start_run victim; pv=$!
  fi
  wait "$po"; RC_OTHER=$?
  : >"$SYNC/other-exited"
  wait "$pv"; RC=$?
  for r in victim other; do
    [ ! -f "$DIR/$r/state/sync_timeout" ] || SYNC_FAIL="$SYNC_FAIL; the $r run timed out at a hand-over"
  done
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
  first_line_ok "summary file $SUMF, full log $LOGF. If this output stops early, read the summary file."
  log_has "changed 1 package"
  log_has "fake setup done"
  log_has "Upgrade complete."
  # No step file and no temp file is left behind.
  cache_clean "$DIR/home/.cache/skyline"

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
  if [ "$(wc -l <"$OUT" | tr -d ' ')" = 1 ]; then ok; else bad "the reader saw more than the first line"; fi
  first_line_ok "summary file $SUMF, full log $LOGF. If this output stops early, read the summary file."
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
  # Only this run's own step file is left: no temp file, nothing named like a
  # summary.
  left=$(ls -A "$DIR/home/.cache/skyline" | grep -vxF -e upgrade.log -e upgrade-summary.txt | tr '\n' ' ')
  case "$left" in
    "upgrade-step."[0-9]*".out ") ok ;;
    *) bad "a killed run left: [$left]" ;;
  esac

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

  # Stopped before its first step (probeS of review M3: SIGTERM during the
  # first `skyline --version`) with a previous run's "Upgrade complete." in
  # place: the summary says this run has not finished.
  run_case "$S" term-before-first-step mode=npm io=bg term_at_version=1 stale=1
  if [ "$RC" -ne 0 ]; then ok; else bad "a SIGTERMed run exited 0"; fi
  calls_are ""
  summary_has "has not finished"
  summary_has "Last step started: none yet"
  if grep -qF "Upgrade complete." "$SUMF" 2>/dev/null; then bad "stale summary survived"; else ok; fi
  header_ok

  # A step killed by a signal while the reader is gone (probeT of review M3):
  # bash and sh report it on the shell's own stderr, the dead pipe, and only
  # the ignored SIGPIPE keeps the script alive (dash survives either way).
  # The restart still runs and the summary is final.
  run_case "$S" reader-step-killed mode=npm io=reader term_self_at_setup=1
  rc_is 1
  calls_are "$FULL_CALLS"
  summary_has "setup:  failed (exit 143)"
  summary_has "daemon: restarted on port 7333"
  if [ "$(tail -n 1 "$SUMF" 2>/dev/null)" = "exit code: 1" ]; then ok; else bad "no final summary"; fi

  # --- overlapping runs (review I1) --------------------------------------------
  # Two runs in one cache dir never share a step file: the victim's degraded
  # update is still "update failed", never "already current" (#45).
  for order in victim-first victim-second; do
    overlap_case "$S" "overlap-$order" "$order"
    if [ -z "$SYNC_FAIL" ]; then ok; else bad "overlap hand-over failed: $SYNC_FAIL"; fi
    rc_is 1
    has "binary: update failed: update check (no upgrade applied); skyline is at 1.4.0"
    hasnt "already current"
    last_is "Upgrade did not complete cleanly: update failed: update check (no upgrade applied)"
    calls_are "skyline update --check | skyline update --yes | skyline setup | skyline daemon restart --port 7333"
    if [ "$RC_OTHER" -eq 0 ] && grep -qF "binary: updated 1.4.0 -> 1.4.1" "$OUT_OTHER"; then
      ok
    else
      bad "the other run: rc $RC_OTHER, [$(grep -F 'binary:' "$OUT_OTHER")]"
    fi
    # The victim ends last, so the shared summary is its own.
    summary_ok
    cache_clean "$DIR/home/.cache/skyline"
  done

  # --- the summary is replaced, never rewritten in place (review M1) -----------
  # A reader holding the file (a hard link the fake setup makes) keeps a whole
  # text: the "has not finished" record as it was at setup, never a later
  # text written into the same file.
  run_case "$S" summary-replaced mode=npm snap=1
  rc_is 0
  summary_ok
  if [ -f "$STATE/snap" ] && grep -qF "Last step started: skyline setup (step 2 of 3)" "$STATE/snap" \
    && ! grep -qF "exit code:" "$STATE/snap"; then
    ok
  else
    bad "the summary was rewritten in place: [$(tr '\n' '~' <"$STATE/snap" 2>/dev/null)]"
  fi
  cache_clean "$DIR/home/.cache/skyline"

  # --- a previous run's files (review M2) --------------------------------------
  # The previous summary stays until this run's first summary replaces it by
  # a rename, so a reader never finds the file missing (the mv spy sees the
  # target in place).
  run_case "$S" stale-replaced mode=npm stale=1 mv=spy
  rc_is 0
  summary_ok
  if [ "$(head -n 1 "$STATE/mvlog" 2>/dev/null)" = present ]; then
    ok
  else
    bad "the previous summary was gone before this run's first summary replaced it: [$(tr '\n' ' ' <"$STATE/mvlog" 2>/dev/null)]"
  fi
  # No summary can be written anywhere (every mv fails): the previous run's
  # "Upgrade complete." is removed, never left at the documented path. The
  # outcome and the exit code are unchanged.
  run_case "$S" stale-mv-fails mode=npm stale=1 mv=fail
  rc_is 0
  has "no writable directory for the summary and log files"
  last_is "Upgrade complete."
  if [ -e "$DIR/home/.cache/skyline/upgrade-summary.txt" ]; then
    bad "a previous run's summary was left at the documented path"
  else
    ok
  fi
  left=$(ls -A "$DIR/home/.cache/skyline" "$DIR/tmp" 2>/dev/null | grep -e 'upgrade-step\.' -e 'upgrade-write\.' | tr '\n' ' ')
  if [ -z "$left" ]; then ok; else bad "left behind: $left"; fi
  # Its summary and log are mode 0444: they are removed, and this run's
  # summary is at the documented path.
  run_case "$S" stale-f444 mode=npm f444=1
  rc_is 0
  first_line_ok "summary file $SUMF, full log $LOGF. If this output stops early, read the summary file."
  summary_ok
  cache_clean "$DIR/home/.cache/skyline"
  # The cache dir is read-only and holds a previous run's finished summary,
  # which no script can fix: this run's summary goes to TMPDIR, and its first
  # line names a start time at or after the moment the run began (upgrade.md
  # trusts only such a summary). The run is stopped at the restart.
  if [ "$(id -u)" -eq 0 ]; then
    echo "upgrade.test.sh: stale-readonly not run as root (a read-only dir does not stop root)"
  else
    t0=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    run_case "$S" stale-readonly mode=npm stale=1 ro=1 term_at_restart=1
    if [ "$RC" -ne 0 ]; then ok; else bad "a SIGTERMed run exited 0"; fi
    first_line_ok "summary file $SUMF, full log $LOGF. If this output stops early, read the summary file."
    summary_has "has not finished"
    header_ok
    started=$(head -n 1 "$SUMF" 2>/dev/null | sed -n 's/^skyline upgrade started \([^ ]*\) (pid.*/\1/p')
    if [ -n "$started" ] && [ "$(printf '%s\n%s\n' "$t0" "$started" | sort | head -n 1)" = "$t0" ]; then
      ok
    else
      bad "fallback summary start [$started] is before the run began [$t0]"
    fi
    if grep -qF "2000-01-01T00:00:00Z" "$DIR/home/.cache/skyline/upgrade-summary.txt"; then ok; else bad "the read-only dir was written"; fi
  fi

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
