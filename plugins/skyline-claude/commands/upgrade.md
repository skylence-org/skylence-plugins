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

The daemon restarts during the upgrade (in step 3, and inside `skyline update` on its GitHub update path), and the daemon is what serves the `run` call above. So the call can end early, with a transport or connection error or with output that stops partway. The script itself does not depend on its output being read, and it keeps going when nobody reads it. The restart can also stop the script: a Linux systemd user service stops every process of the service, and that includes this script. When the call ends early, do not run the upgrade again. Read the summary file instead, with the Read tool if the skyline tools are not back yet:

- `${XDG_CACHE_HOME:-$HOME/.cache}/skyline/upgrade-summary.txt` (that is `~/.cache/skyline/upgrade-summary.txt` unless `XDG_CACHE_HOME` is set);
- `${TMPDIR:-/tmp}/skyline-upgrade-summary.txt` when the cache directory cannot be written.

The script prints the exact path on its first line. When the run finishes, the file holds the same closing text plus `exit code: N`. Until then it says the upgrade "has not finished" and names the last step started and the last step finished. If it says that, wait a few seconds and read it again. If it still says that, the script was stopped. Tell the user the upgrade is NOT confirmed, name those two steps and the `upgrade.log` next to the summary file (it has the output so far), and verify with `skyline --version` and `skyline daemon status`. Never report that as a successful upgrade, and do not run the upgrade again on your own.

Relay the summary to the user as printed, or as read from the summary file. When the exit code is non-zero, say which step failed, and never describe the upgrade as successful. Show the plugin-update steps from the summary, and remind the user to restart the session.
