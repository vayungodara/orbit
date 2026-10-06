# orbit

See your Amp orbs from inside Claude Code, and let Claude run them for you.

<p align="center">
  <img src="docs/orbit.svg" width="620" alt="Five orbs drawn as globes: two working, one waiting on you, one done and one failed">
</p>

orbit is a mod for Claude Code. Each Amp orb shows up as a small globe in a side pane, you get a toast when one finishes or opens a pull request, and Claude gets tools to start orbs, message them and wait for their results. It talks to Amp and GitHub through the public `amp` and `gh` command-line tools, so it needs no API keys of its own.

## Install

You need Claude Code 2.1.286 or later and the `amp` CLI, signed in. `gh` is optional. With it, pull requests show their CI status. Desktop notifications work on macOS only.

```sh
git clone https://github.com/vayungodara/orbit ~/.claude/mods/orbit
```

Then add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. If you load other mods the same way, separate the folders with `:`.

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/orbit" } }
```

Claude Code reads this variable when it starts, so restart it afterwards. In the desktop app that means quitting and reopening it.

The desktop app starts sessions with a bare `PATH`, so orbit looks for `amp` in `~/.local/bin` and `~/.amp/bin`, and for `gh` in the Homebrew folders, before it falls back to `PATH`.

## Using it

Type `/orbs` to open the pane, or `/orbs T-…` to jump straight to one orb.

The ring around each globe shows what the orb is doing. Orange means it's working, blue means it's waiting on you, green means it's done and red means it failed. A working globe slowly turns, and bigger orbs get bigger globes. Under each one you'll see its title and current step, or its pull request and CI result once it has one.

The pane keeps only what needs your attention: orbs that are working, waiting or failed, plus finished ones for an hour. In a terminal session the globes become coloured dots.

Click an orb's name to open its drawer. It lists the last six steps the orb took, the pull requests it linked, what it has cost so far, and small CPU and memory graphs. Once the orb stops, the drawer also shows the last line of its final message. From there you can send the orb a message, open it in Amp or archive it. Archiving asks for a second press.

You also get a toast when an orb finishes, needs you, fails or opens a pull request. On macOS, failures and new pull requests send a notification as well.

## Tools for Claude

| Tool | What it does |
| --- | --- |
| `orb_start` | Starts an orb on a project (`owner/name`) from a title and a prompt, in mode `ultra` at size `a1.small` unless told otherwise. Returns the thread ID and link. If `amp` exits without printing a link, it warns that the orb may have started anyway. |
| `orb_send` | Sends a follow-up message to an orb, whether it is running or finished. |
| `orb_status` | One line per orb with its state, mode, size, current step, pull requests with CI and CodeRabbit status, and the end of its last message. |
| `orb_wait` | Waits until orbs end their turn or open a pull request. The default timeout is 30 minutes and the maximum is 2 hours. |
| `orb_result` | Returns an orb's latest final message, up to its last 3,000 characters. |
| `orb_archive` | Archives an orb. |

A status line looks like this:

```
T-0f0e0d0c-0001-7000-8000-000000000001 fix flaky login test · working · ultra/small · running tests cargo · PR #28 CI✓ CR…
```

Claude reads these tool definitions on every turn, so all six together are kept to about 1,100 characters.

### Permissions

Tools that come from a mod skip Claude Code's own permission prompt, so orbit checks your permission rules itself. `orb_start`, `orb_send` and `orb_archive` change things, so they only run when a rule allows them. In default mode, add `mcp__orbit__*` to your allow rules. The read-only tools run unless a rule denies them.

## Staying light

Each `amp` call takes about a quarter of a second of CPU and over 200 MB of memory while it runs, so orbit calls it as rarely as it can.

- When no orb is being tracked, nothing runs. The only exception is one check when an interactive session starts.
- While an orb is working, orbit reads the thread list once a minute, or every 30 seconds for ten minutes after you open the pane or message an orb. When things go quiet it slows to every 5 minutes, and an hour after the last change it stops.
- An orb's full thread is read only after the list shows it changed. That happens at most every 5 minutes per orb, or every 30 seconds for the orb open in the drawer.
- Pull request status and usage are only fetched while the pane is open, at most once a minute.
- If `amp` keeps failing, orbit backs off to one read every 5 minutes and shows the error at the top of the pane.
- The globes are animated SVG, so there's no timer redrawing the pane.

## Limits

- There's no stop button, because Amp's CLI can't interrupt an orb.
- An orb keeps the mode it was started in, even if a later message asks for another.
- Each open Claude session polls Amp and shows toasts on its own. macOS notifications are only sent once.
- orbit sees your 30 most recent Amp threads. An orb that hasn't changed in 24 hours drops out of the pane.
- "Waiting on you" is a guess, based on whether the orb's last message ends with a question.
- Orb size is only known for orbs orbit started or whose drawer you opened. Other orbs are drawn at medium size.
- Without `gh`, pull requests show `–` instead of a CI result. Without `/usr/bin/jq`, threads larger than 4 MiB can't be read.

## Settings

You can change two settings in `/config`:

- `notify` turns macOS notifications for failures and new pull requests on or off. It's on by default.
- `notifyAfter` is how many minutes old an orb has to be before it can send a notification. The default is 5.

## Development

```sh
claude plugin validate ~/.claude/mods/orbit
claude plugin test ~/.claude/mods/orbit
```

`hooks/register.tsx` holds the state, the `/orbs` command, the tools and the pane. The mod engine only follows `$` inside the file where it is used, so the other modules receive a `Ports` object (`hooks/ports.ts`) that `register.tsx` builds for them.

| File | What's in it |
| --- | --- |
| `hooks/poller.ts` | The one timer that reads Amp, plus toasts and notifications |
| `hooks/scheduler.ts` | When to read the list and which threads to fetch |
| `hooks/cli.ts` | The `amp`, `gh` and `jq` calls |
| `hooks/model.ts`, `hooks/steps.ts` | Turning Amp's output into orbs and steps |
| `hooks/sphere.ts` | The globe and graph SVGs |
| `hooks/tools.ts`, `hooks/actions.ts` | Claude's tools and the pane's buttons |
| `types/index.d.ts` | The state other mods can read |

The step icons (`activities.ts`, `classify.ts`, `icons.ts` and `elapsed.tsx`) are copied from my status bar mod so the two look the same. Other mods can read orbit's `orbs` state too, so a status bar can show its own chip for each orb and open the drawer with `/orbs <id>`.

## License

MIT
