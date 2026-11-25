---
description: Update Skyline, run skyline setup, restart the daemon, report what happened, and print plugin refresh steps.
---

Run the skyline upgrade script:

```
run(["bash", "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade.sh"])
```

The script runs three steps and keeps going when one fails:

1. Updates the skyline binary (`npm i -g @skylence-ai/skyline@latest` for an npm-managed install, `skyline update --yes` otherwise).
2. Runs `skyline setup`, which refreshes the daemon service, the marketplace plugins and the agent wiring. An upgrade from an agent shell never triggers the binary's own auto-setup, so this step is what applies them.
3. Restarts the daemon on port 7333 (or installs the service when there is nothing to restart), so it runs the new binary.

It ends with a summary: the binary line says `updated X -> Y`, `already current at X`, or `update failed: <step>`, followed by the setup and daemon results. The last line is `Upgrade complete.` or `Upgrade did not complete cleanly: <failed steps>`.

The daemon restarts during the upgrade (in step 3, and inside `skyline update` on its GitHub update path), and the daemon is what serves the `run` call above. So the call can end early, with a transport or connection error or with output that stops partway, while the script keeps running to the end. When that happens, do not run the upgrade again. Read the summary file instead, with the Read tool if the skyline tools are not back yet:

- `${XDG_CACHE_HOME:-$HOME/.cache}/skyline/upgrade-summary.txt` (that is `~/.cache/skyline/upgrade-summary.txt` unless `XDG_CACHE_HOME` is set);
- `${TMPDIR:-/tmp}/skyline-upgrade-summary.txt` when the cache directory cannot be written.

The script prints the exact path on its first line. The file holds the same closing text plus `exit code: N`. If it still says the upgrade "has not finished", wait a few seconds and read it again. The full step output is in the `upgrade.log` next to it.

Relay the summary to the user as printed, or as read from the summary file. When the exit code is non-zero, say which step failed, and never describe the upgrade as successful. Show the plugin-update steps from the summary, and remind the user to restart the session.
