---
name: review-loop-skill
description: FIRST ACTION of review work — invoke before reading any diff, unasked, whenever the task says review/check/look-at changes, a PR, a branch, or "what X built" and skyline MCP tools are available. Skyline-native review loop — full diff never summary, every claim re-verified by execution, adversarial failure scenarios per finding, ranked findings with anchors, report without patching. Not for fixing (debug-loop-skill) or building (feature-loop-skill).
---

Reviewing changes in skyline workspace. Review ARTIFACTS, never author intent. Report findings; do NOT fix unless explicitly asked.

PATHS: absolute path or cwd= on EVERY skyline call.

SCOPE:
  lore_recall(changed-surface words, unscoped) BEFORE judging — prior marked decision may explain "why done this way"; finding contradicting a marked decision ⇒ cite mark, question design change, not defect
  git diff (branch/refs) or git show (commit) → FULL diff, never summary/description — squash-merge ships EVERYTHING on branch; unrecognized commit or hunk ⇒ finding, review pauses until explained
  diff sections carry ¶path#TAG anchors → cite findings by them

VERIFY CLAIMS (claim = hypothesis until re-checked):
  "tests pass" ⇒ re-run via test tool, counts from output YOU saw
  "command outputs X" ⇒ re-run via run; exit_code first line authoritative; exit codes through pipes lie
  "N occurrences updated" ⇒ grep count yourself
  perf/size claims ⇒ measure or mark unverified
  running reviewed code would dirty shared checkout (checkout PR branch, install deps, seed data) ⇒ skyrift create <slug> from repo MAIN tree → verify inside disposable workspace → skyrift discard after review

ADVERSARIAL READ (per changed surface):
  ├─ failure scenario hunt: concrete inputs/state ⇒ wrong output/crash; no concrete scenario ⇒ not a correctness finding
  ├─ new/changed strings + contracts ⇒ grep consumers; matched-elsewhere literals (error text, state values, config keys) drift silently
  ├─ tests assert what change claims? test asserting nothing new = coverage finding
  ├─ boundary + error paths: empty, zero-match, concurrent writer, first-contact, permission failure
  ├─ semantic tools per posture (lsp_warm project_layer_state, rules as feature-loop-skill); impact where offered for blast radius; posture forbids them ⇒ grep+tests
  └─ template/view changes without request-level render test ⇒ finding (reparse cannot see runtime resolution)

FINDINGS:
  ranked most-severe first; each = file:line anchor + one-sentence defect + concrete failure scenario
  severity: breaks-correctness > silent-drift > missing-coverage > efficiency > style (style only if asked)
  verified-nothing-found = valid result; state what was checked, never manufacture findings

REPORT (file = evidence, chat = verdict + findings):
  ├─ path = the review evidence path the primer named (SessionStart) ⇒ create(path, overwrite:true), one per line: `# review-loop REPORT` → `loop-report: v1` → `repo: <abs root>` → `branch: <name>` → `date: <UTC ISO>` → verification evidence (commands re-run, counts seen) → full findings detail (anchor, defect, failure scenario) → `skylore: <nothing durable | marked <ids>>` at column 0, no tree glyph
  ├─ chat = verdict (approve / bounce with findings) + ONE line per finding (severity, file:line, what); findings stay in chat: they are the deliverable
  ├─ no path given (primer absent, `SKYLINE_LOOP_REPORT=chat`, another harness) ⇒ full REPORT in chat as before
  └─ dispatch brief names a destination (board comment, PR body) ⇒ post there as well; still write the report file (path given ⇒ the file is never skipped)
Recurring defect class worth remembering ⇒ lore_mark(kind=fact).
