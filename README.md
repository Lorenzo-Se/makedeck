# makedeck

Start all dev services of a project in the background with one keystroke, and control them from Raycast: live logs, restart, stop, and a real terminal when you need one (e.g. `r` for Flutter hot reload).

```
Zed ⇧⌘R ──► makedeck ──► tmux session "<project>" (socket "makedeck")
                         ├─ window api      make api
                         ├─ window worker   make worker
                         └─ window app      make app        ◄── ⏎ in Raycast: Terminal.app attaches
                                ▲
Raycast "Dev Services" ─────────┘  logs · restart · stop · stop project
```

**The idea:** your `Makefile` already knows which services a project needs. They are the prerequisites of `dev`. makedeck runs each of them in its own tmux window. You get no terminal window cluttering your screen, yet every service still has a real TTY.

## Requirements

macOS, [tmux](https://github.com/tmux/tmux), [Raycast](https://raycast.com) and make.

## Installation

```sh
git clone https://github.com/Lorenzo-Se/makedeck.git
cd makedeck
brew install tmux

# put makedeck on your PATH
ln -s "$PWD/bin/makedeck" "$(brew --prefix)/bin/makedeck"
```

Then install the [makedeck extension from the Raycast Store](https://www.raycast.com/SemL/makedeck).

**Zed** (optional): start makedeck from a task. Add this to `~/.config/zed/tasks.json`:

```jsonc
{
  "label": "makedeck",
  "command": "makedeck",
  "cwd": "$ZED_WORKTREE_ROOT",
  "use_new_terminal": true,
  "allow_concurrent_runs": false,
  "reveal": "never",    // don't show a terminal
  "hide": "on_success"  // keep the tab only on errors
}
```

Errors and messages such as "already running" show up as a macOS notification. Without Zed, just run `makedeck` in the project root.

## Makefile

makedeck reads the **first line** of the target (default `dev`, or `makedeck <target>`) and starts every prerequisite **in parallel** as `make <name>`:

```make
.PHONY: dev api worker app backend-setup infra dev-stop

dev: api worker app ## local development

api: backend-setup                 # setup belongs to exactly one service
	cd backend && exec bin/rails server

worker:                            # waits for api instead of relying on make order
	until nc -z localhost 3000; do sleep 1; done
	cd backend && exec bundle exec sidekiq

app:
	cd app && exec flutter run -d ios

backend-setup: infra
	cd backend && bin/rails db:prepare

infra:
	docker compose up -d --wait

dev-stop:                          # optional, runs after "Stop Project"
	docker compose stop
```

The key rules:
- Every service runs in the foreground and writes to stdout.
- No `&`, `nohup` or `-d` in services.
- Every target is listed in `.PHONY`.
- Whatever keeps running outside the processes, such as containers, is stopped by `dev-stop`.

The full rules with reasons are in [`skills/structuring-dev-makefiles/SKILL.md`](skills/structuring-dev-makefiles/SKILL.md).

## Commands

| Command | Effect |
|---|---|
| `makedeck [target]` | Start every prerequisite of `target` (default `dev`). If the session already runs, print its status and exit 0 |
| `makedeck status` | One line per service: `running`, `stopped` (killed by a signal), `exited (0)` or `failed (N)` |
| `makedeck logs <service> [-n N]` | Last N lines (default 100) of a service |
| `makedeck restart [service]` | Stop and start one service again, or all of them |
| `makedeck stop [service]` | Stop one service (it stays listed as stopped), or all: close the session and run `make dev-stop` if make knows it |
| `makedeck hook` | Claude Code `PreToolUse` hook, see [For coding agents](#for-coding-agents) |
| `makedeck help` | Usage |

`status`, `logs`, `restart` and `stop` work from any subdirectory: they use the session whose project folder contains the current directory. Stopping works like in Raycast (SIGTERM to the process groups, SIGKILL after 5 s).

The command names are reserved: a Makefile target called `status`, `logs`, `restart`, `stop`, `hook` or `help` cannot be started with `makedeck <target>`.

## Raycast "Dev Services"

The list is grouped by project. The detail view shows the live log, refreshed every 2 s, with the newest output at the bottom.

| Action | Shortcut | Effect |
|---|---|---|
| Open in Terminal | ⏎ | Terminal.app attaches to exactly this window. Detach with `Ctrl-B d`; the service keeps running |
| Stop | ⌃C | SIGTERM to the process group, SIGKILL after 5 s |
| Restart | ⌘R | stop, then start again in the same window |
| Copy Logs | ⇧⌘C | last 200 lines |
| Restart Project | ⇧⌘R | all services at once |
| Stop Project | ⇧⌘⌫ | stop all, close the session, run `make dev-stop` |

Exited services stay visible with their exit code (`exited (0)`, `failed (2)`), so you can still read their output.

> **Stop from Raycast or with `makedeck stop` only.** `tmux kill-session` and `respawn-window -k` do not end the processes; they keep running under PID 1 and block ports. That is why makedeck signals the process groups itself.

## For coding agents

The skill in [`skills/structuring-dev-makefiles`](skills/structuring-dev-makefiles/SKILL.md) teaches agents to write makedeck-ready Makefiles and to fix broken ones. To use it with Claude Code:

```sh
ln -s "$PWD/skills/structuring-dev-makefiles" ~/.claude/skills/
```

Agents tend to start `make dev` or a single service in the background themselves, where neither you nor Raycast can see or stop it. The hook prevents that. Add it to `~/.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "makedeck hook" } ] } ] } }
```

In a project whose Makefile has a `dev:` target, it blocks `make dev` and, in the background, every prerequisite of `dev`, and tells the agent to use `makedeck`, `makedeck status`, `makedeck logs` and `makedeck restart` instead. It needs `jq` (`/usr/bin/jq` on macOS 15+).

## Layout

```
bin/makedeck                  launcher (bash): starts the tmux session; status, logs, restart, stop, hook
raycast/src/tmux.ts           tmux access: list, logs, stop, restart, open in Terminal
raycast/src/services.tsx      Raycast UI
skills/                       agent skill for Makefiles
tests/makedeck.test.sh        integration test for bin/makedeck
tests/tmux*.test.ts           tests for raycast/src/tmux.ts (kept out of the extension)
```

## Development

Requires Node.js ≥ 22.18.

```sh
bash tests/makedeck.test.sh
node --test tests/*.test.ts
cd raycast && npm run lint && npm run build
```

The tests start real tmux servers on their own sockets (`MAKEDECK_SOCKET`) and don't touch your running sessions. The Raycast integration tests use `bin/makedeck` from this repository.

## Limitations

- Raycast's detail view cannot scroll, so makedeck shows only as many of the newest lines as fit. The size is estimated for the default Raycast window (`LOG_ROWS` and `LOG_COLS` in `services.tsx`).
- Two terminal windows on the same project share the active window.
- Processes left behind in the background by a target that has already exited can no longer be reached. Hence the "no `&`" rule.

## License

[MIT](LICENSE)
