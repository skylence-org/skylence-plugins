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

Stage 2 answers Read from skyline by building `result.file` from the daemon's
read tool and letting core render `text` from it.

## Test and typecheck

    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/skyline-mod-claude
    npx -p typescript tsc -p plugins/skyline-mod-claude/tsconfig.json

The typecheck needs `types/claude-code.d.ts`; see `types/README.md`.
