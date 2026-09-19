# skyline-mod-claude (early access)

Skyline as a Claude Code **mod**: a plugin whose behaviour is a hooks module
(`hooks/register.ts`) hooking the engine's events as functions `($, e, next)`,
instead of the classic shell hooks `skyline-claude` uses. Mods need function
hooks enabled:

    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir plugins/skyline-mod-claude

Written against Claude Code 2.1.278. The mod API is early access and may change
between releases; this plugin is not in the marketplace and runs from source.

## Why

`skyline-claude`'s enforce hook denies the model's native Read and prints the
skyline call to make instead, which costs one retry per redirect. A `tool.call`
mod can answer Read itself, from the skyline daemon, and hand the result back
in the shape the engine expects: no denial, no retry. To do that it must
produce exactly the record core produces, and that record is not declared in
the published types (`BuiltinToolResults` is empty). Stage 1 discovers it.

## Stage 1: wrap Read, record the shape

One hook on `tool.call` with a `{ tool: 'Read' }` matcher awaits `next(e)`,
measures the result and returns it untouched. It records keys and types only,
plus the length of the model-facing text; never a file's contents. Each new shape is announced once in the transcript (a system
notice, not sent to the model); every record goes to the debug log; with the
`shapeFile` option set, the deduplicated shapes are rewritten as JSON after
every Read.

Options come from `pluginConfigs` in user settings or `--settings`, never
project settings:

    claude --settings '{"pluginConfigs":{"skyline-mod-claude":{"options":{"shapeFile":"/tmp/read-shapes.json"}}}}'

### What a Read comes back as (observed on 2.1.278, 2026-09-19)

An answered Read resolves `{ ref, result, text }`. Types were observed; the
values below are illustrative:

```jsonc
{
  "ref": 7,                       // number: core's message index
  "result": {
    "type": "text",               // string
    "file": {
      "filePath": "…absolute path…",  // string
      "content": "…the file…",        // string: the whole file or the requested window
      "numLines": 3,                  // number
      "startLine": 1,                 // number
      "totalLines": 3                 // number
    }
  },
  "text": "1\talpha line one\n2\tbeta line two\n…"   // string: what the model reads, `N\t` per line
}
```

A Read that fails (file missing) resolves `{ isError: true, ref, result, text }`
where `result` is the error string and `text` is the same message the model
reads (`File does not exist. Note: your current working directory is …`).

A Read a hook refuses resolves `{ deny }` and never reaches the tool.

## Stage 2: answer Read from skyline

The same hook now answers an eligible Read itself. It asks the skyline daemon
for the file over MCP streamable HTTP (`$.http.fetch`, so the engine owns the
socket), translates skyline's block into the record above, and returns
`{ result: { type: 'text', file }, context: [anchor] }`. Core renders the
model-facing `text` from `result` exactly as it does for its own Read, so the
model sees the usual numbered lines; core's Read never runs, and the classic
enforce hook beneath never sees a call to deny. No retry, no redirect.

Eligible means: a text file (not pdf, image, notebook, or a `pages` request),
resolved against the session directory, not under `~/.claude`, inside a code
tree (a `.git` or `.skyrift-workspace` marker in its directory or above, the
classic hook's rule), and one the engine's permission decision allows. That
last check matters: a hook that answers without `next(e)` skips core's
permission path, and the first live run with a `Read(./sample.txt)` deny rule
read the file anyway. The mod now asks `$.tool.check` first and leaves
anything but `allow` to core, which then refuses as it always did. Everything
else, and every failure, goes on to core untouched:

- daemon unreachable: core reads, and the daemon is marked down for 5 s so a
  batch of Reads does not each wait out a connection timeout;
- daemon restarted (our session id is stale): one re-initialize, then the Read;
- skyline reports an error (file missing): core reads and produces the native
  error the model already knows;
- skyline's block is not a plain numbered read: core reads.

Skyline is asked with `full: true` (its delta shortcut would otherwise answer a
repeated read with only the changed lines) and `max_match_chars: 0` (no
500-character line cap). `offset` and `limit` pass through; both sides are
1-indexed.

Two differences from core's own Read, both minor:

- `content` is rebuilt from skyline's `N:` lines, so whether the file ended
  with a newline is lost; core counts that trailing empty segment as a line
  and the mod does not.
- `totalLines` is exact on a whole read (skyline's `total:` trailer) and a
  lower bound on a partial one (the last line returned).

With `anchorContext` on, the `¶path#TAG` anchor rides along as a context line
the model reads (`skyline anchor for edit (paste verbatim): ¶…#TAG`), so a
skyline `edit` can follow without a second read. It is off by default since
0.4.2: an interactive tester judged it noise whenever no edit followed, and it
only pays when skyline's edit tool is available to the model. With it off a
Read answered from skyline is fully transparent.

Options (`pluginConfigs` in user settings or `--settings`): `daemonUrl`,
`answerFromSkyline` (off makes the mod observe only, as stage 1 did),
`anchorContext`, `shapeFile`.

## Stage 3: answer Grep from skyline

A second hook, on Grep, does the same for searches. Observed on 2.1.278 (the
mod's stage-1 recorder, pointed at Grep), core's Grep record is one of:

```jsonc
// output_mode files_with_matches (the default)
{ "mode": "files_with_matches", "filenames": ["sub\\nested.txt", "sample.txt"], "numFiles": 2, "totalFiles": 2 }
// output_mode content
{ "mode": "content", "content": "code.rs-1-fn alpha() {}\ncode.rs:2:let beta = 2;\n--\nsample.txt:2:beta line two",
  "filenames": [], "numFiles": 2, "numLines": 3, "totalLines": 3 }
// output_mode count
{ "mode": "count", "content": "sample.txt:3", "filenames": [], "numFiles": 1, "numMatches": 3 }
```

Core renders the model-facing text from the record (`Found N files` + the
names; the content as is; `No files found` / `No matches found` when empty).
`content` is ripgrep's own rendering: paths relative to the working
directory in the host's separator (whatever `path` was), `path:N:line` for a
match and `path-N-line` for a context line when `-n` is set (no number
otherwise), `--` between context groups, and no path at all when the search
was one file.

The mod asks skyline's `grep` (`strict: true` so its zero-match fallback
ladder does not invent matches core would not find, `max_match_chars: 0`,
`limit` from `head_limit`, `files_with_matches` for files mode, `glob`,
`ignore_case`, `context`/`after_context`/`before_context`, `skip` from
`offset`) and renders the block as above. Skyline does not mark context lines,
so with `-A`/`-B`/`-C` the mod tells a match from a context line by testing
each line against the pattern as a JavaScript regex; a pattern JavaScript
cannot compile is left to core. Also left to core: `output_mode: count`
(skyline's count has no per-file figures), a `type` filter (no ripgrep type
table on the skyline side), `multiline`, an empty pattern, and everything the
Read path leaves (outside a code tree, `~/.claude`, permission not allow,
daemon down or erroring, a block that does not parse).

Known differences from core, both cosmetic: skyline counts a file's trailing
empty segment as a line, so a context window at the end of a file may show one
`path-N-` line core would not; and `totalLines`/`totalFiles` equal what was
returned (no truncation figure from skyline).

Measured in the live `-p` runs here (one Windows machine, timed from the
mod's own hook, so core's figure includes the worker hop): core's own Grep
took 3.2 to 3.7 s per call; skyline answered in 75 to 220 ms. The cause on
core's side was not profiled.

## Stage 4: answer Glob from skyline

A third hook, on Glob, uses skyline's `find`. Core's Glob record, observed
the same way:

```jsonc
{ "filenames": ["sample.txt", "sub\\nested.txt"], "numFiles": 2, "totalMatches": 2,
  "truncated": false, "countIsComplete": true, "durationMs": 7 }
```

Filenames are relative to the working directory in the host's separator,
oldest modification first; core renders them one per line, or `No files
found`. Both sides let `*.txt` match at any depth, so the pattern passes
through unchanged. Skyline's only sort is newest first, so the rows are
turned round. Skyline's headers carry the Windows extended-length prefix
(`\\?\C:\…`), which is stripped. `durationMs` is the mod's own timing of the
daemon call. The cap is 100 rows, as core's is before it reports truncation;
skyline's elision footer (`N match(es), M shown, K elided`) sets
`totalMatches` and `truncated`.

## Permissions, for every answered tool

A hook that answers without `next(e)` skips core's permission path, so each
answer path asks `$.tool.check` about the call first and leaves anything but
`allow` to core. That is not enough for Grep and Glob: core also applies Read
rules to every file its own Grep or Glob would name, so under
`permissions.deny: ["Read(./sample.txt)"]` core's Glob says `No files found`
and core's Grep `No matches found`, while a per-call check passes (the search
itself is allowed). The first 0.4.0 build leaked the file through both; the
other pane's A/B caught it. The mod now asks `$.tool.check({ tool: "Read",
input: { file_path } })` for every file skyline returns and drops the ones
not allowed, whole (a Grep block, a Glob row), before translating. One check
per result file, in parallel, capped by the result limits (250 Grep rows,
100 Glob rows).

### Writing a user-tier mod: what the loader enforces

Anthropic's built-in mods load natively; a plugin's module is checked
statically before it loads, and the check refused two things on the way here:

- `$` may only be spelled `$.noun.event(...)` at a call site, or passed to a
  function declared at the top of the module (a `function` declaration or a
  `const` bound to one). It cannot be passed to a nested function or a method,
  bound, spread, returned or read. So `ioOf($)` is a top-level function that
  returns closures (`fetch: (url, init) => $.http.fetch(url, init)`) and the
  rest of the module works with those.
- `$.env.get` takes a literal variable name, so the variables a module reads
  can be listed.
- `BuiltinToolInputs` is declared by merging: a tool the fetched
  `claude-code.d.ts` does not list (Grep, in the checkout used here) gets its
  own `types/<tool>.d.ts` beside it, committed.

The kit also hands a hook the path as the host spells it: a test's
`$.fs.exists('/repo/.git')` reaches the hook beneath as `C:\repo\.git` on
Windows, so a mock must compare separator-agnostically.

## Test and typecheck

    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/skyline-mod-claude
    npx -p typescript tsc -p plugins/skyline-mod-claude/tsconfig.json

The typecheck needs `types/claude-code.d.ts`; see `types/README.md`.
