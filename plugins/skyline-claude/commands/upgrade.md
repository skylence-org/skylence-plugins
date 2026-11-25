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

Relay the summary to the user as printed. When the exit code is non-zero, say which step failed. Never describe the upgrade as successful then. Show the plugin-update steps the script printed, and remind the user to restart the session.
