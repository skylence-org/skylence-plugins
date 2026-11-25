---
name: debug-loop-skill
description: FIRST ACTION of fix work — invoke before touching any file, unasked, whenever the task says broken/failing/error/crash/wrong/regression/"stopped working" and skyline MCP tools are available. Skyline-native debug loop — recall known quirks before theorizing, red reproduction before any fix, one-hypothesis-one-probe discipline, teed-output forensics instead of reruns, regression test mandatory. Not for building new behavior (feature-loop-skill) or reviewing diffs (review-loop-skill).
---

Fixing something broken in skyline workspace. Follow loop exactly. NEVER fix before red reproduction exists; NEVER stack second fix on unverified first theory.

PATHS: absolute path or cwd= on EVERY skyline call. Zero-match ≠ absence until (searched ...) line names repo root.

ORIENT:
lore_recall(symptom words + component, unscoped) FIRST — known quirk may BE answer → git status + git diff (recent change = prime suspect) → lsp_warm if semantic tools needed (posture per project_layer_state, same rules as feature-loop-skill)
manifest names stack (composer.json: filament ⇒ filament+livewire+laravel; livewire ⇒ livewire+laravel; laravel ⇒ laravel; Cargo.toml ⇒ rust; go.mod ⇒ go) ⇒ invoke EVERY installed skill named `<stack>-blueprint-skill` NOW, before REPRODUCE; skill absent ⇒ proceed, zero friction, no error.

REPRODUCE (before ANY fix):
  failing test exists ⇒ test tool → capture exact failure + anchor
  no failing test ⇒ write one reproducing symptom → confirm RED
  not test-reachable (daemon/CLI behavior) ⇒ capture failing command via run → exit_code + teed raw path = evidence
  cannot reproduce ⇒ STOP, report what was tried; never "fix" unreproduced symptom

ISOLATE:
  ├─ identify EXACT artifact running before theorizing about its behavior: which binary/version/path/route serves the failing call (field lesson: six hypotheses fell because nobody checked which binary executed)
  ├─ prior command output ⇒ run_query on teed raw path, NEVER re-run to re-see
  ├─ logs ⇒ devlog_tail (compressed), not raw tail through shell
  ├─ code ⇒ grep with anchors; diagnostics ONE call paths:[suspects]
  ├─ external state change since last-known-good ⇒ read since_tag delta, not full re-read
  └─ destructive probe needed (bisect, dependency downgrade, migration replay, state-corrupting repro) ⇒ skyrift create <slug> from repo MAIN tree → probe inside disposable workspace → skyrift discard after; NEVER destructive-probe shared checkout

HYPOTHESIS DISCIPLINE:
  one hypothesis ⇒ one CHEAPEST disproof probe ⇒ result
  falsified ⇒ note it (prevents re-testing), next hypothesis
  confirmed ⇒ minimal fix from anchors
  3+ falsified ⇒ back to ISOLATE, wrong layer

FIX:
  minimal edit via ¶path#TAG anchors (stacked ops, multi-file atomic + verify:true when spanning)
  template/view edit: verify:true reparse only, structural damage (root-element count, unbalanced tags) invisible to it ⇒ re-read edited range IMMEDIATELY after edit, pair with request-level render test same change
  regression test in SAME change — red before fix, green after; symptom without test coverage gets coverage now
  diagnostics(batch) → full suite via test tool → formatter via run → git_commit

REPORT (file = full report, chat = 1–3 lines):
  ├─ path = the debug REPORT path the primer named (SessionStart) ⇒ create(path, overwrite:true), one per line: `# debug-loop REPORT` → `loop-report: v1` → `repo: <abs root>` → `branch: <name>` → `date: <UTC ISO>` → root cause (mechanism, not narrative) → falsified-hypothesis trail → fix location → regression test name → suite counts → `skylore: <nothing durable | marked <ids>>` at column 0, no tree glyph
  ├─ chat = 1–3 lines: root cause; fix location + regression test name; suite status
  ├─ no path given (primer absent, `SKYLINE_LOOP_REPORT=chat`, another harness) ⇒ full REPORT in chat as before
  └─ dispatch brief names a destination (board comment, PR body) ⇒ post there as well; still write the report file (path given ⇒ the file is never skipped)
Cause worth remembering machine-wide ⇒ lore_mark(kind=fact, why= names expected-instead); fix invalidates older mark ⇒ lore_mark replacement then lore_supersede(old, new), never leave stale mark outranking truth.
