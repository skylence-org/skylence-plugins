---
name: skylore-deposit-skill
description: How to put something into the skylore bank without making it worse — invoke when the Stop deposit check fires, or any time mid-session you are about to lore_mark. Recall before marking, supersede instead of re-marking, scope it, and know what does NOT belong. Not for reading the bank (lore_recall needs no skill).
---

Depositing into skylore. The bank is operator-wide and append-only: a bad mark is not neutral, it buries the good one next to it.

## IS IT DURABLE? (all four, or stop)

  would cost the NEXT session real time to re-derive
  NOT already stated by a file, manifest, lockfile, or parser — skybox/LSP re-derive code structure and never go stale, lore does
  still true after this branch merges
  you can name what it beat: an expectation it contradicted, or the alternative you rejected

Nothing clears all four ⇒ answer "nothing durable" and stop. An empty deposit is a correct outcome, not a failure.
Answer where the Stop check says: one `skylore: nothing durable` or `skylore: marked <ids>` line at column 0, appended to the session report file it names (never overwrite it); chat gets nothing or one line. No file named ⇒ answer in chat.

## RECALL BEFORE YOU MARK — always

  lore_recall(the words you would put in the body, unscoped) FIRST
  hit covers the same ground ⇒ lore_supersede(id, body=..., why=...) — do NOT deposit alongside it
  hit is adjacent but distinct ⇒ mark, and reference the neighbour in the body
  no hit ⇒ mark

Idempotency does NOT save you: lore_mark dedups on EXACT body text, so a paraphrase of an existing mark always inserts. Two marks in this bank say the same thing 28 characters apart.

## MARK SHAPE

  kind=fact       measured behavior, quirk, footgun
  kind=decision   a choice + why= naming the beaten alternative
  kind=preference operator instruction about how to work
  kind=episode    a specific event worth reconstructing later — rare
  why=            REQUIRED in practice: the expectation broken or the option rejected. A mark without one is a claim without provenance.
  repo=           set it unless the fact holds on any repo on this box. Unscoped marks surface on EVERY recall everywhere.
  anchors=        repo@commit / repo@commit#symbol when the fact is pinned to code

One or two marks per session. Ten means you are logging, not remembering.

## DOES NOT BELONG

  PR/branch/todo-scoped detail ("fixture has 8 cases not 9", "stub read budget for PR #74") ⇒ the PR or the todo
  status of work in flight ⇒ the board
  code structure, call graphs, signatures ⇒ skybox/LSP, never memorize a parse
  per-project notes and conventions ⇒ memory_* tiers
  restating a manifest ("app uses Laravel 13") ⇒ composer.json already knows

## GOOD vs BAD

  GOOD  "Path::starts_with is a LEXICAL prefix test and ignores `..`, so it is not a containment check: <base>/../../etc/passwd passes."
        why= "used as a sandbox guard in PR #48 R1; expected it to resolve the path"   repo= binary-lsp-rust-server
  BAD   "Fixed the pack mount bug in PR #48."          — dead on merge, no reusable fact
  BAD   "skyline_run does not inherit pane env."       — true, and already marked fourteen times

## WHY THIS SKILL EXISTS

Audit of the 171-mark bank, 2026-07-30: ~25% near-duplicate (14 marks for one env-inheritance fact, 9 for one composer quirk), 31 marks scoped to a single PR, and 1 mark ever superseded though six correct an earlier one in prose only — so both versions recall as equally live and a session can act on the corrected one. Every rule above is one of those findings.
