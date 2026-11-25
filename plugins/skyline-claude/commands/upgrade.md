---
description: Update Skyline, run skyline setup, restart the daemon, report what happened, and print plugin refresh steps.
---

Note the current UTC time, then run the skyline upgrade script:

```
run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"])
run(["bash", "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade.sh"])
```

Keep that time: it is how you tell this run's summary from a previous run's (see below).

The script runs three steps and keeps going when one fails:

1. Updates the skyline binary (`npm i -g @skylence-ai/skyline@latest` for an npm-managed install, `skyline update --yes` otherwise).
2. Runs `skyline setup`, which refreshes the daemon service, the marketplace plugins and the agent wiring. An upgrade from an agent shell never triggers the binary's own auto-setup, so this step is what applies them.
3. Restarts the daemon on port 7333 (or installs the service when there is nothing to restart), so it runs the new binary.

Its first line names the run's start time (UTC), its pid, and the summary and log files. It ends with a summary. The binary line reads one of:

- `updated X -> Y`
- `already current at X`
- `update failed: <step>; skyline is at X` (a `skyline update` that prints "no upgrade applied" counts as failed)
- `version unknown: skyline --version printed no version number` (counts as a failed step)
- `at X (the version before the upgrade is unknown)`

The setup and daemon lines follow. The last line is `Upgrade complete.` or `Upgrade did not complete cleanly: <failed steps>`.

The daemon restarts during the upgrade (in step 3, and inside `skyline update` on its GitHub update path), and the daemon is what serves the `run` call above. So the call can end early, with a transport or connection error or with output that stops partway. The script itself does not depend on its output being read, and it keeps going when nobody reads it. The restart can also stop the script: a Linux systemd user service stops every process of the service, and that includes this script. When the call ends early, do not run the upgrade again. Read the summary file instead, with the Read tool if the skyline tools are not back yet:

- If you saw the script's first line, read the summary file it names.
- Otherwise read both places it can be: `${XDG_CACHE_HOME:-$HOME/.cache}/skyline/upgrade-summary.txt` (that is `~/.cache/skyline/upgrade-summary.txt` unless `XDG_CACHE_HOME` is set), and `${TMPDIR:-/tmp}/skyline-upgrade-summary.txt` (used when the cache directory cannot be written). Trust only a summary whose first line, `skyline upgrade started <time> (pid N).`, has a time at or after the time you noted. An older time, or a file without that line, belongs to a previous run and proves nothing about this one. When neither file qualifies, the upgrade is NOT confirmed.
- The other files there, `upgrade-step.<pid>.out` and `upgrade-write.<pid>.tmp`, are a run's working files, never a summary.

When the run finishes, the summary holds the same closing text plus `exit code: N`. Until then it says the run "has not finished" and names the last step started and the last step finished. If it says that, wait a few seconds and read it again. `ps -p <pid>`, with the pid from its first line, tells a slow step from a stopped run: while the process is listed, the script is still running, so wait and read again. When the process is gone and the summary still says "has not finished", the script was stopped. Tell the user the upgrade is NOT confirmed, name those two steps and the `upgrade.log` next to the summary file (it has the output so far), and verify with `skyline --version` and `skyline daemon status`. Never report that as a successful upgrade, and do not run the upgrade again on your own.

Relay the summary to the user as printed, or as read from the summary file. When the exit code is non-zero, say which step failed, and never describe the upgrade as successful. Show the plugin-update steps from the summary, and remind the user to restart the session.
