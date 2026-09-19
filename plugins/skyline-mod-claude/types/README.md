# Mod API declarations

`hooks/` and `tests/` are typed against `claude-code.d.ts`, the declaration
file Claude Code writes for function hooks. It is Anthropic's (all rights
reserved), so it is not committed here; `.gitignore` keeps it out.

To typecheck, put a copy in this folder first, by either route:

- In Claude Code, run `/plugin-types`, which writes the declarations for the
  version you are running.
- Or copy `mods/types/claude-code.d.ts` from a checkout of
  https://github.com/anthropics/claude-code.

Then, from the repository root:

    npx -p typescript tsc -p plugins/skyline-mod-claude/tsconfig.json
