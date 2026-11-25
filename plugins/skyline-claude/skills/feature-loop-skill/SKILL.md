---
name: feature-loop-skill
description: FIRST ACTION of implementation work — invoke before touching any file, unasked, whenever the task says build/create/implement/add/make (feature, app, endpoint, behavior-changing refactor) and skyline MCP tools are available. Skyline-native build loop — orientation ritual, route-aware semantic posture, vertical slices each ending green, anchor-based editing, batched diagnostics, test-anchored fixes, commit checkpoints, advisor cadence. Not for pure investigation or single-line fixes.
---

Implementing in skyline workspace. Follow loop exactly; each rule measured/field-derived; deviation recreates known failures. Work unit = vertical slice ending green. Edit unit = ¶path#TAG anchor, never re-read.

PATHS: absolute path or cwd= on EVERY skyline call (daemon cwd ≠ yours). Zero-match ≠ absence until (searched ...) line names repo root.

ORIENT (once, 6 calls):
tree(abs root) → git status (lines carry anchors) → lore_recall(task+stack words, unscoped; consume hits) → lsp_warm(one source file) → read dependency manifest → invoke `<stack>-blueprint-skill` per manifest (filament ⇒ all three; livewire ⇒ +laravel; Cargo.toml ⇒ rust; go.mod ⇒ go; none installed ⇒ skip, zero friction)

POSTURE ← lsp_warm.project_layer_state:
  fresh + ready_semantic:true  ⇒ full semantic surface (definition/references/symbol_card/impact); trust diagnostics
  unprobed_lsp_route           ⇒ diagnostics OK; definition same-file ONLY; references unreliable; symbol_card/impact/unreferenced REFUSE — never call; cross-file questions ⇒ grep+tests; stdlib undefined-symbol errors possibly stale
  mcp_resolve_failed | mcp_call_failed ⇒ same as unprobed_lsp_route; never chase mcp route mid-task (daemon restart retries)
  stale | reindexing | unverified ⇒ structural nav OK; re-warm per hint before trusting semantics
  null (rust/go — field is php-only) ⇒ posture from flags directly: ready_semantic:true ⇒ definition/references/rename_symbol usable + trust diagnostics; else structural nav only; symbol_card/impact/unreferenced never exist for these languages
Repo with own dependency dir: "not covered by any mounted dependency index" info-notes = expected, not errors.

SIZE (decide at plan time):
  single-line/trivial fix ⇒ this skill does not apply (description exclusion)
  simple feature ⇒ 2–3 slices; advisor pre-final consult only
  standard feature ⇒ 3–8 slices; full advisor cadence
  does NOT fit 8 slices or one session's context ⇒ PROGRAM, not feature: STOP, say so, decompose into feature-sized units and run this loop per unit (or hand to an orchestrator); never stretch one session over an epic

PLAN: vertical slices per SIZE, each shippable. Order: data model → first user-facing surface → each behavior → polish.

ISOLATION (decide at plan time): shared checkout + other agents/humans may touch it, OR build experimental/possibly-discarded ⇒ skyrift create <slug> from repo MAIN working tree (not a linked worktree) → work in printed path. Inside .skyrift-workspace: disposable detached clone — land committed work per workspace rules (promote/push from branch), NEVER git add -A (untracked .skyrift-workspace marker), skyrift discard when abandoned. Solo uncontested checkout ⇒ skip, work in place.

SLICE CYCLE (repeat per slice):
  generate/locate → edit(anchors) → diagnostics(batch) → test → format+commit
  ├─ generate: run with argv ARRAY, never shell string; slow ⇒ background:true → run_wait
  ├─ locate: grep|find → paste ¶path#TAG straight into edit; NEVER read file already holding anchor
  ├─ edit: multiple hunks one file ⇒ ONE edit, stacked ops; cross-file change (model+surface+test) ⇒ ONE multi-section edit + verify:true (atomic, whole rollback on reject)
  ├─ diagnostics: ONE call, paths:[all touched files]; never per-file calls
  ├─ test: failures return edit anchors ⇒ fix directly, no re-locating
  ├─ template/view edits: verify:true = reparse only; structural damage (root-element count, unbalanced tags) + runtime component/asset resolution invisible to reparse ⇒ re-read edited range IMMEDIATELY after edit (1 read ≪ red test run + file recreation), then pair with request-level render test same slice
  ├─ data queries owned by user/tenant ⇒ same slice adds test proving other user sees nothing
  ├─ checkpoint: formatter via run → git_commit green slice (rollback points)
  └─ ADVISOR GATE (if advisor/review tool active): slice just committed = model slice OR first user-facing surface ⇒ consult advisor NOW, findings = review input, before next slice starts. Part of cycle, not optional garnish. Never per-edit (billing + reviews half-states badly).
  CHECKPOINT LOG (live, not retrospective): the turn a checkpoint resolves (advisor consulted, skipped, or n/a) ⇒ write one line `CHECKPOINT: <post-model|post-first-surface|pre-final> = done|skipped(<reason>)|n/a(<tier>)` right there. Report path given (primer at SessionStart, or the loop gate) ⇒ append the line to that FINAL file by its OWN tool call, nothing in chat; file absent ⇒ create it with `# feature-loop FINAL` → `loop-report: v1` → the line, nothing else; a line written later or inside the FINAL write is not live (Stop gate: `checkpoint-not-live`). No path given ⇒ print the line in chat. Field-derived: end-gate attestation reconstructed from git log = backward-engineered compliance, omission-prone; forward-tracked lines make FINAL a copy job.
  red slice unresolvable ⇒ report exact failing test/diagnostic output, STOP; never continue on red

RULE SKIPS: cannot or will not follow a rule ⇒ SAY SO in chat before proceeding (human-facing: never only in the report file), never silently drop it. Skipped-but-undeclared rule discovered later = trust breach, worse than the skip itself.

FINAL (all fields MANDATORY, no omissions):
  full suite via test tool → report:
  ├─ SIZE tier chosen + why
  ├─ slices shipped + commit ids
  ├─ test counts (passed/assertions)
  ├─ advisor checkpoints: COPY the live CHECKPOINT lines emitted during build, one per [post-model / post-first-surface / pre-final]; checkpoint with no live line ⇒ write `CHECKPOINT: <name> = not-emitted` and list it under deviations by name ("None" then not allowed); never reconstruct a done/skipped line after the fact (reconstruction from git log is the failure mode, not the fix)
  └─ deviations from this skill — "None" permitted ONLY when every rule above was followed as written
  WHERE (report = file, chat = one line):
  ├─ path = the FINAL path the primer (SessionStart) or the loop gate (ADVISOR GATE reminder, Stop message) named ⇒ the file already holds the live CHECKPOINT lines; complete it: append the FINAL fields, or create(path, overwrite:true) keeping every CHECKPOINT line verbatim
  ├─ file, one per line: `# feature-loop FINAL` → `loop-report: v1` → (the live CHECKPOINT lines) → `repo: <abs root>` → `branch: <name>` → `date: <UTC ISO>` → the five fields above, labels verbatim (gate matches them) → `skylore: <nothing durable | marked <ids>>` at column 0, no tree glyph
  ├─ chat = ONLY `FINAL stored: <path>` + ≤2 short lines (what shipped + suite status; deviations count)
  ├─ create fails ⇒ print FINAL in chat (gate accepts either)
  ├─ no path given (primer and gate absent, `SKYLINE_LOOP_REPORT=chat`, another harness) ⇒ CHECKPOINT lines and FINAL in chat as before
  └─ dispatch brief names a destination (board comment, PR body) ⇒ post there as well; in file mode still append the CHECKPOINT lines to the FINAL file and write the FINAL there (the Stop gate reads it)

SKYLORE DEPOSIT (with FINAL, sparse): durable decision made during build (library/pattern choice with real alternative) ⇒ lore_mark(kind=decision, why= names beaten alternative); machine/tooling quirk that cost a retry ⇒ lore_mark(kind=fact, why= names expected-instead). NEVER mark manifest-derivable facts, routine milestones, code structure. Skyrift workspace used ⇒ state its path + land/discard status in report. Answer = the FINAL file's `skylore:` line (`nothing durable` or `marked <ids>`); no path ⇒ one chat line.
