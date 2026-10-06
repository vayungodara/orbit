# orbit

A Claude Code mod (function-hook plugin, Claude Code 2.1.286+) that shows your Amp orbs and lets Claude start and steer them. It draws a constellation pane, toasts when an orb changes, and gives Claude six orb tools.

![orbit globes: working, waiting, done and failed](docs/orbit-globes.png)

## Install

You need Claude Code 2.1.286 or later and the `amp` CLI, logged in. `gh` is optional and adds PR marks. Notifications are macOS only.

```sh
git clone https://github.com/vayungodara/orbit ~/.claude/mods/orbit
```

Then add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (separate several folders with `:`), and start a new session:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/orbit" } }
```

The variable is read when Claude Code starts, so quit and reopen the desktop app after changing it.

## How it finds the CLIs

It runs the `amp` and `gh` CLIs. The desktop app starts sessions with a bare PATH, so it looks for `amp` in `~/.local/bin` and `~/.amp/bin` and for `gh` in the Homebrew prefixes before it falls back to PATH.

## What it adds

- **`/orbs [thread id]`** opens the orbit pane. With a thread id (`T-…`) it opens that orb's drawer.
- **The constellation.** Each orb is a small globe, with lines in a colour taken from its thread id and a ring for its state: orange working, blue waiting on you, green done, red failed. A working globe turns: its meridians swing and a gap travels round the ring. A still globe shows its two meridians at different turns. The globe's size follows the orb's size. Under it are the title (the `project: ` prefix is dropped when two orbs share it) and one line: the current step, `waiting on you`, `failed`, or the PR number with its CI mark. The header counts orbs by state. The pane shows only what needs attention: working, waiting and failed orbs, and done ones for an hour after they finish. In the terminal the globes are coloured dots.
- **The drawer.** Click an orb's name to open its drawer. It shows the last six steps (icon, verb, target; the verb is red when the step failed, and only the running step's icon moves), the PRs the orb linked with their CI and CodeRabbit marks (five at most), the cost with CPU and memory in MiB (a sparkline for each on the desktop, and bars for the last twelve CPU samples in the terminal), and, once the orb has stopped, the last line of its final message. A working orb also shows how long it has run. Below are a message box, `open in Amp`, `archive` and `close`. Archive asks for a second press. Sending and archiving report by toast.
- **State for other mods.** The orbs live in plugin state (`orbit` / `orbs`, typed in `types/index.d.ts`), so a status-bar mod can draw its own chip per orb and open the drawer with `/orbs <id>`.
- **Toasts** when an orb finishes, waits on you, fails or opens a PR. A failure or a new PR also sends a macOS notification, if the orb was created at least `notifyAfter` minutes ago.
- **Tools for Claude:**

| Tool | What it does |
| --- | --- |
| `orb_start` | Starts an orb on a project (`owner/name`) from a title and a prompt. Mode `ultra` and size `a1.small` unless asked otherwise. Returns the thread id and URL (read from amp's stdout, else its stderr). If amp times out or ends without a thread URL, it says the orb may have started and to check `orb_status` before retrying. |
| `orb_send` | Sends a follow-up message to an orb, running or finished. |
| `orb_status` | One line per orb: thread id, title, state, mode and size, the current step while it works, PRs with CI and CodeRabbit marks (`#28 CI✓ CR…`; a PR gh has not checked yet shows its number alone), and the last 160 characters of its last message once it has stopped. For example `T-0f0e0d0c-0001-7000-8000-000000000001 Wave 1B cooldowns · working · ultra/small · running tests cargo · PR #28 CI✓ CR…`. It lists the orbs that are working, waiting or failed, or changed in the last hour; `ids` picks orbs and `all: true` lists every tracked one. A first line says so when `amp` is failing. |
| `orb_wait` | Waits until the given orbs are `idle` (the default: each turn ended) or each has a new `pr`, or, with `any`, until one of them ends a turn (including a turn that started during the wait) or opens a PR. Default 30 minutes, at most 120. Returns their `orb_status` lines, after a first line when it timed out or stopped early. Use it instead of a shell polling loop. |
| `orb_result` | An orb's latest final message, read from the thread itself: the last 3,000 characters, with a note when it is longer. |
| `orb_archive` | Archives an orb's thread. |

Claude reads the six definitions on every turn, so together they are kept to about 1,100 characters.

### Permissions

A tool answered by a plugin hook never reaches Claude Code's own permission prompt, so orbit asks the permission check itself. `orb_start`, `orb_send` and `orb_archive` change something, so they run only when the check says allow. Otherwise they refuse and name the rule to add. In a session in default mode, add `mcp__orbit__*` (or the individual tools) to your allow rules. `orb_status`, `orb_wait` and `orb_result` run unless a rule denies them.

## How it stays light

An `amp` call costs about 0.25 s of CPU and over 200 MB while it runs, so reads are rationed. No hook draws on a timer: the globes animate with SVG animation and the elapsed time counts on the surface's own clock.

- **The list** (`amp threads list`) is read every minute while an orb is working or changed in the last 10 minutes, then every 5 minutes until an hour after the last change, then not at all. While someone is watching it is read every 30 seconds. Watching is the 10 minutes after you open the pane, select an orb, send a message, or call `orb_start` or `orb_send`, and the length of an `orb_wait` plus a minute.
- **An orb's thread** (`amp threads export`) is read when the list shows it changed, at most every 5 minutes per orb (every 30 seconds for the orb open in the drawer while the pane is open), plus once when a working orb has been quiet for 90 seconds. That read is how the end of a turn is noticed: an orb stays working until a read taken after its last change shows the agent had the last word, and a message sent from orbit marks it working at once. A thread that fails to read keeps its last good reading and is tried again after 5 minutes. If it still cannot be read an hour after its last change, the orb shows as failed with the line `cannot read this thread`, without a toast or notification, and is not read again until it changes. At most two threads are read per pass, the selected orb's first and then the latest changes; the rest wait for the next pass. An orb that has been quiet for over an hour when orbit first sees it (at a session start, say) is not read until it changes or you select it, and shows as done, without details, until then.
- **PRs** are checked with `gh pr view` only while the pane is open (at most once a minute) and once after a turn ends. An orb's first read, at a session start say, is not the end of a turn. Merged and closed PRs are not checked again.
- **Usage** (`amp threads usage`) is read only for the orb open in the drawer, while the pane is open, at most once a minute.
- **Nothing at all** runs when no orb is tracked and nobody is watching, apart from one list read when an interactive session starts. Headless sessions read nothing until a tool asks. A failing `amp` with nothing tracked is not retried. With orbs tracked, a failing `amp` slows the reads, down to one every 5 minutes, and the error shows in the pane header.
- Opening the pane (unless a read just finished), selecting an orb and sending a message each read the list straight away; after a send, that read starts once any read already under way has finished, so it sees the message. `orb_status` answers from a read under 15 seconds old and makes one list read otherwise.
- `orb_wait` makes at most one read of its own, at the start and only if the last read is older than 30 seconds. After that it asks the poller to keep its 30 second cadence and checks the result every 5 seconds. It returns early, and says why, when `amp` is failing or an id is not tracked (every id, for `any`).
- Raw exports can pass the 4 MiB cap on a command's output (a 12-message thread was 5.1 MB), so they are shrunk with the system `/usr/bin/jq` when it is there: long tool output is dropped and long inputs are clipped. Besides `amp` and `gh`, the mod runs `jq` (the pipe runs under `/bin/bash`; dash, the `/bin/sh` on Debian and Ubuntu, has no `pipefail`), `osascript` for notifications and, during an `orb_wait`, a 5 second `sleep`.

## Limits

- No stop button: Amp's public CLI cannot interrupt an orb.
- Each open Claude session polls Amp on its own, so two sessions cost two sets of reads and both toast. A macOS notification goes out once between them: the plugin's store remembers what was notified for a day.
- An orb keeps the mode it was started with, whatever a follow-up asks for.
- Only the 30 most recent Amp threads, orbs or not, are listed. An orb that has not changed in 24 hours goes stale and leaves the pane.
- `waiting on you` is a guess: the orb's last message ends in a question. The PRs are the GitHub pull request links in the orb's own messages.
- Orb size is known for orbs orbit started and for an orb whose drawer has been opened (from the machine's core count). Other orbs are drawn at medium size.
- Without `gh`, PR marks stay at `–`. Without `/usr/bin/jq`, a thread whose export passes 4 MiB cannot be read.
- One message at a time per orb: a second send while one is under way is refused with a toast. A send can run for up to two minutes. Each orb has its own message box; a message sent from it leaves it empty, and a failed send keeps the text for another try.

## Settings (`/config`)

`notify` (macOS notifications for failures and new PRs; on) and `notifyAfter` (minutes since an orb was created before it may notify; 5).

## Files

- `hooks/register.tsx`: the module. Every atom and every `$` call lives here: tools, the `/orbs` command, the pane's drawing.
- `hooks/ports.ts`: the `Ports` type. The engine follows `$` only inside the file that holds it, so the other modules take a `Ports`, closures that `register.tsx` builds, instead of `$`.
- `hooks/poller.ts`: the one timer that reads Amp. It runs on the session start's ports whichever call asked for a read, any read re-arms it, and the session's measurement after each turn re-arms it after a reload. It writes the orbs and raises the toasts and notifications.
- `hooks/scheduler.ts`: when to read the list and which threads to export (pure).
- `hooks/cli.ts`: the `amp`, `gh` and `jq` calls (the jq pipe runs under `/bin/bash`), through a `Host` that `register.tsx` builds. `poller.ts` runs `osascript`, and `tools.ts` runs `sleep`.
- `hooks/model.ts`, `hooks/steps.ts`: parsing Amp's output, the rules for an orb's state, and turning a tool call into a step.
- `hooks/sphere.ts`: the globe and sparkline SVGs.
- `hooks/actions.ts`, `hooks/tools.ts`: what the pane's controls do, and Claude's tools with their permission checks and waits.
- `hooks/activities.ts`, `classify.ts`, `icons.ts`, `elapsed.tsx`: copies from skyline, my status-bar mod, so step icons look the same in both.
- `types/index.d.ts`: the state contract other mods read.
- `tests/`: 179 tests across 11 files.

## Check it

```sh
claude plugin validate ~/.claude/mods/orbit
claude plugin test ~/.claude/mods/orbit
```

In a new Claude desktop session: run `/orbs`, click an orb's name, and ask Claude to call `orb_status`. With nothing active, `pgrep -fl 'amp threads'` should print nothing.

## License

MIT. Built with Claude.
