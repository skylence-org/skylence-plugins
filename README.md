# Skyline Plugins

Marketplace repo for the Skyline binary plugins. Exposes the Skyline, skybox,
skycastle, and skyway MCP daemons to Grok, Claude Code, Codex, and Antigravity
with agent-side hooks that steer native file work toward the richer MCP tools.

## Prerequisite

Install and bootstrap Skyline first:

```bash
npm install -g @skylence-ai/skyline
skyline setup
```

`skyline setup` installs the shared HTTP daemon on port 7333 and installs the
optional marketplace plugins when supported agent CLIs are available.

## Claude Code

```bash
claude plugin marketplace add skylence-be/skylence-plugins --scope user
claude plugin install skyline-claude --scope user
```

Restart Claude Code after installing the plugin.

## Codex

```bash
codex plugin marketplace add skylence-be/skylence-plugins
codex plugin add skyline-codex@skylence-plugins
```

Restart Codex after installing the plugin.

## Grok

```bash
grok plugin marketplace add skylence-be/skylence-plugins
grok plugin marketplace update skylence-plugins
grok plugin install skyline-grok@skylence-be/skylence-plugins --trust
grok plugin install skybox-grok@skylence-be/skylence-plugins --trust
grok plugin install skycastle-grok@skylence-be/skylence-plugins --trust
grok plugin install skyway-grok@skylence-be/skylence-plugins --trust
```

**Important:** 
- After adding, run `grok plugin marketplace update skylence-plugins`.
- Use the full qualifier `@skylence-be/skylence-plugins` when installing.

Use the same daemons as the other variants (ports 7333/7070/8210/3090).

- `skyline-grok`: full native tool shadowing when the daemon is reachable.
- `skybox-grok` / `skycastle-grok`: additive + steering of relevant CLI commands.
- `skyway-grok`: additive (no file-tool shadowing).

Skills appear as `/<plugin>:operate`, `/<plugin>:upgrade`, etc. Hooks follow Grok's decision contract and use `GROK_PLUGIN_ROOT`.

## skybox-claude (Claude Code)

Separate, optional plugin that wires the **skybox** code-knowledge-graph MCP
daemon (HTTP, port 7070) into Claude Code. skybox is read-only graph navigation
(`query` / `context` / `impact` / `route_map` + indexing) — it complements
Skyline's editing tools and does not replace native file tools, so it ships a
daemon watchdog monitor and a CLI→MCP enforcement hook (which redirects
`skybox index` / `query` / `search` / `status` in the shell to the richer MCP
tools), but no native-file-tool enforcement.

```bash
# ensure the skybox MCP daemon is serving on port 7070 (or via its launchd agent)
skybox mcp serve --transport http --bind 127.0.0.1 --port 7070

claude plugin marketplace add skylence-be/skylence-plugins --scope user
claude plugin install skybox-claude --scope user
```

Index a repo with `skybox index <path>`; then the `skybox` MCP tools are
available in a fresh Claude Code session.

## Included plugins

**Grok** (`.grok-plugin/marketplace.json`):

- `skyline-grok` — Full enforcement (shadows `read_file`, `search_replace`,
  `grep`, `list_dir`, `run_terminal_command` with skyline_* tools when daemon
  is up). Grok-native hooks.
- `skybox-grok` — skybox code-knowledge-graph MCP (port 7070) + CLI steering
  for `skybox` subcommands.
- `skycastle-grok` — skycastle secrets MCP (port 8210) + steering for secrets/export.
- `skyway-grok` — skyway workflow MCP (port 3090). Purely additive.

**Claude Code** (`.claude-plugin/marketplace.json`):

- `skyline-claude` — HTTP MCP + PreToolUse enforcement, daemon watchdog,
  friction-nudge monitors, upgrade/uninstall commands.
- `skybox-claude` — skybox graph MCP + CLI→MCP hook + operate skill + commands.
  Read-only (does not replace native file tools).
- `skyway-claude` — skyway workflow MCP + monitor + `/skyway-status` + operate.
  Additive.
- `skycastle-claude` — skycastle secrets MCP + CLI steering + status command +
  operate skill.
- `skyline-mod-claude` — EARLY ACCESS, not in the marketplace yet. Skyline as a
  Claude Code mod (function hooks, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).
  Stage 1 wraps Read and records the result shape; run from source with
  `claude --plugin-dir plugins/skyline-mod-claude`, test with
  `claude plugin test plugins/skyline-mod-claude`.

**Codex and Antigravity** (`.agents/plugins/marketplace.json`):

- `skyline-codex` / `skyline-antigravity` — enforcement hooks + upgrade/uninstall.
- `skybox-codex` / `skybox-antigravity` — graph MCP + CLI steering + operate/uninstall.
- `skyway-codex` / `skyway-antigravity` — workflow MCP + operate/upgrade/uninstall.
- `skycastle-codex` / `skycastle-antigravity` — secrets MCP + steering + skills.

## Verify

```bash
skyline daemon status
```

The port 7333 row should show `running`. In a fresh agent session, the Skyline
MCP tools should include `skyline_read`, `skyline_grep`, `skyline_edit`,
`skyline_git`, and `skyline_run`.

## Upgrade and removal

- **Grok**: use `/skyline-grok:upgrade`, `/skyline-grok:uninstall` (or the
  equivalent for skybox/skycastle/skyway).
- **Claude**: run `/upgrade` or `/uninstall` from the installed plugin.
- **Codex**: ask for the upgrade or uninstall skill.

Manual removal commands are printed by the uninstall flow. Package removal uses
the package manager you installed with, for example
`npm uninstall -g @skylence-ai/skyline`.

See the per-plugin `plugins/*-grok/README.md` for Grok-specific notes.
