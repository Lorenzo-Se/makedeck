# devmux

Start all dev services of a project in the background with one keystroke, and control them from Raycast: live logs, restart, stop, and a real terminal when you need one (e.g. `r` for Flutter hot reload).

```
Zed ⇧⌘R ──► devmux ──► tmux session "<project>" (socket "devmux")
                         ├─ window api      make api
                         ├─ window worker   make worker
                         └─ window app      make app        ◄── ⏎ in Raycast: Terminal.app attaches
                                ▲
Raycast "Dev Services" ─────────┘  logs · restart · stop · stop project
```

**The idea:** your `Makefile` already knows which services a project needs. They are the prerequisites of `dev`. devmux runs each of them in its own tmux window. You get no terminal window cluttering your screen, yet every service still has a real TTY.

## Requirements

macOS, [tmux](https://github.com/tmux/tmux), [Raycast](https://raycast.com), Node.js ≥ 22.18 and make.

## Installation

```sh
git clone https://github.com/Lorenzo-Se/devmux.git
cd devmux
brew install tmux

# put devmux on your PATH
ln -s "$PWD/bin/devmux" /opt/homebrew/bin/devmux

# register the Raycast extension (once; stop it with Ctrl-C afterwards, the extension stays)
cd raycast && npm install && npm run dev
```

**Zed** (optional): start devmux from a task. Add this to `~/.config/zed/tasks.json`:

```jsonc
{
  "label": "devmux",
  "command": "devmux",
  "cwd": "$ZED_WORKTREE_ROOT",
  "use_new_terminal": true,
  "allow_concurrent_runs": false,
  "reveal": "never",    // don't show a terminal
  "hide": "on_success"  // keep the tab only on errors
}
```

Errors such as "already running" show up as a macOS notification. Without Zed, just run `devmux` in the project root.

## Makefile

devmux reads the **first line** of the target (default `dev`, or `devmux <target>`) and starts every prerequisite **in parallel** as `make <name>`:

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

> **Stop from Raycast only.** `tmux kill-session` and `respawn-window -k` do not end the processes; they keep running under PID 1 and block ports. That is why devmux signals the process groups itself.

## For coding agents

The skill in [`skills/structuring-dev-makefiles`](skills/structuring-dev-makefiles/SKILL.md) teaches agents to write devmux-ready Makefiles and to fix broken ones. To use it with Claude Code:

```sh
ln -s "$PWD/skills/structuring-dev-makefiles" ~/.claude/skills/
```

## Layout

```
bin/devmux                    launcher (bash): reads the Makefile, creates the tmux session
raycast/src/tmux.ts           tmux access: list, logs, stop, restart, open in Terminal
raycast/src/services.tsx      Raycast UI
skills/                       agent skill for Makefiles
tests/devmux.test.sh          integration test for bin/devmux
```

## Development

```sh
bash tests/devmux.test.sh
cd raycast && npm test && npm run lint && npm run build
```

The tests start real tmux servers on their own sockets (`DEVMUX_SOCKET`) and don't touch your running sessions.

## Limitations

- Raycast's detail view cannot scroll, so devmux shows only as many of the newest lines as fit. The size is estimated for the default Raycast window (`LOG_ROWS` and `LOG_COLS` in `services.tsx`).
- Two terminal windows on the same project share the active window.
- Processes left behind in the background by a target that has already exited can no longer be reached. Hence the "no `&`" rule.

## License

[MIT](LICENSE)
