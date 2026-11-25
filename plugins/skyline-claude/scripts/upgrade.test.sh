#!/usr/bin/env bash
# Shell test for upgrade.sh (binary-skyline#1121, skylence-plugins#45/#46).
# Run with: bash plugins/skyline-claude/scripts/upgrade.test.sh
#
# Never touches the real skyline, npm or daemon: each case runs upgrade.sh
# under `env -i` with PATH = a temp dir holding a fake `skyline` and a fake
# `npm` plus symlinks to head/sed/grep/cat/cp, HOME and TMPDIR redirected.
# The fakes record their argv; the fake `npm i -g` and `skyline update --yes`
# "install" a new version by rewriting the version file `skyline --version`
# reads. Every case runs under both `bash` and `sh`, after `sh -n`/`bash -n`.

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/upgrade.sh"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/skyline-upgrade-test.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT

# PATH inside each case is ONLY the fakes plus symlinks to the few tools
# upgrade.sh and the fakes use, so a real skyline/npm can never be reached
# (not even one installed under /usr/bin), including in the no-skyline case.
TOOLS="$ROOT/tools"
mkdir -p "$TOOLS"
for t in head sed grep cat cp; do
  p=$(command -v "$t") || { echo "missing tool: $t"; exit 1; }
  ln -s "$p" "$TOOLS/$t"
done

pass=0
fail=0
HINT="claude plugin marketplace update skylence-plugins"
OLD_BANNER="skyline binary updated and daemon restarted."

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL [$CASE/$SH]: $1"
  echo "---- output ----"
  cat "$OUT"
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
  "--version ") [ -f "$S/noversion" ] || echo "skyline $v" ;;
  "update --check")
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
      available) cp "$S/next" "$S/version"; echo "Installed $(cat "$S/next")" ;;
      degraded) echo "Update check degraded: authentication required"; echo "Offline or unreachable release endpoint; no upgrade applied." ;;
      hardfail) echo "Error: checking for updates" >&2; echo "HTTP status client error (404 Not Found)" >&2; exit 1 ;;
      npm) echo "skyline is managed by npm. To upgrade, run:" ;;
    esac ;;
  "setup ") exit "$(rcfile setup_rc)" ;;
  "daemon restart") exit "$(rcfile restart_rc)" ;;
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
echo "changed 1 package"
EOF
  chmod +x "$bin/skyline" "$bin/npm"
}

# run_case <shell> <case-name> key=value...  (keys: mode version next
# setup_rc restart_rc install_rc npm_rc noskyline)
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
  for kv in "$@"; do
    k=${kv%%=*}; v=${kv#*=}
    if [ "$k" = noskyline ]; then rm -f "$DIR/bin/skyline"; else echo "$v" >"$STATE/$k"; fi
  done
  : >"$STATE/calls"
  env -i PATH="$DIR/bin:$TOOLS" HOME="$DIR/home" TMPDIR="$DIR/tmp" FAKE_STATE="$STATE" \
    "$(command -v "$SH")" "$SCRIPT" >"$OUT" 2>&1
  RC=$?
}

# --- syntax ---------------------------------------------------------------
CASE=syntax; SH=sh; OUT="$ROOT/syntax.out"; STATE="$ROOT"
if sh -n "$SCRIPT" >"$OUT" 2>&1; then ok; else bad "sh -n failed"; fi
SH=bash
if bash -n "$SCRIPT" >"$OUT" 2>&1; then ok; else bad "bash -n failed"; fi

for SHELL_UNDER_TEST in bash sh; do
  S="$SHELL_UNDER_TEST"

  # npm-managed install, new version published: updated, setup, restart, exit 0.
  run_case "$S" npm-updated mode=npm
  rc_is 0
  has "binary: updated 1.4.0 -> 1.4.1"
  has "setup:  ok"
  has "daemon: restarted on port 7333"
  has "$HINT"
  hasnt "$OLD_BANNER"
  calls_are "skyline update --check | npm i -g @skylence-ai/skyline@latest | skyline setup | skyline daemon restart --port 7333"

  # npm-managed, npm reinstalls the same version: already current, exit 0.
  run_case "$S" npm-current mode=npm next=1.4.0
  rc_is 0
  has "binary: already current at 1.4.0"
  hasnt "updated 1.4.0"

  # GitHub update chain, newer release: updated via `skyline update --yes`.
  run_case "$S" gh-updated mode=available
  rc_is 0
  has "binary: updated 1.4.0 -> 1.4.1"
  calls_are "skyline update --check | skyline update --yes | skyline setup | skyline daemon restart --port 7333"

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

  # #46: `skyline update` hard-fails (404) -> reported, later steps still run.
  run_case "$S" gh-hardfail mode=hardfail
  rc_is 1
  has "binary: update failed: skyline update --yes (exit 1); skyline is at 1.4.0"
  has "404 Not Found"
  has "setup:  ok"
  has "daemon: restarted on port 7333"
  has "$HINT"
  calls_are "skyline update --check | skyline update --yes | skyline setup | skyline daemon restart --port 7333"

  # npm itself fails -> reported, setup + restart still run, exit 1.
  run_case "$S" npm-fails mode=npm npm_rc=1
  rc_is 1
  has "binary: update failed: npm i -g @skylence-ai/skyline@latest (exit 1); skyline is at 1.4.0"
  has "daemon: restarted on port 7333"
  has "$HINT"

  # setup fails -> reported, restart still runs, exit 1, binary line still honest.
  run_case "$S" setup-fails mode=npm setup_rc=3
  rc_is 1
  has "binary: updated 1.4.0 -> 1.4.1"
  has "setup:  failed (exit 3)"
  has "daemon: restarted on port 7333"
  has "setup failed: skyline setup (exit 3)"
  calls_are "skyline update --check | npm i -g @skylence-ai/skyline@latest | skyline setup | skyline daemon restart --port 7333"

  # restart fails, install fallback works -> exit 0.
  run_case "$S" restart-falls-back mode=npm restart_rc=1
  rc_is 0
  has "daemon: installed on port 7333 (restart failed)"
  calls_are "skyline update --check | npm i -g @skylence-ai/skyline@latest | skyline setup | skyline daemon restart --port 7333 | skyline daemon install --port 7333"

  # restart and install both fail -> exit 1.
  run_case "$S" daemon-fails mode=npm restart_rc=1 install_rc=2
  rc_is 1
  has "daemon: failed: skyline daemon restart and install --port 7333"
  has "daemon restart failed"

  # skyline not on PATH -> exit 1, nothing runs (npm untouched).
  run_case "$S" no-skyline noskyline=1
  rc_is 1
  has "skyline is not on PATH; nothing was upgraded."
  calls_are ""

  # The summary is the closing text: its last line says complete or not.
  run_case "$S" closing-ok mode=npm
  last_is "Upgrade complete."
  run_case "$S" closing-fail mode=degraded
  last_is "Upgrade did not complete cleanly: update failed: update check (no upgrade applied)"

  # `skyline --version` prints nothing -> a failed step, never "already current".
  run_case "$S" no-version mode=npm noversion=1
  rc_is 1
  has "binary: version unknown: skyline --version printed nothing"
  hasnt "already current"
  has "version check failed: skyline --version printed nothing after the upgrade"
done

echo "upgrade.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
