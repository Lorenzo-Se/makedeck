---
name: structuring-dev-makefiles
description: Use when creating or editing a project's Makefile `dev` target, adding or removing a local dev service (server, worker, Flutter app, Docker), or when services started with devmux (Zed task, cmd-shift-r) or shown in Raycast "Dev Services" fail to start, start in the wrong order, show no logs, or keep running after "Stop Project".
---

# Dev Makefiles for devmux + Raycast "Dev Services"

## How services are started and stopped

`devmux` (repo: `bin/devmux`) runs in the project root, usually from a Zed task:

1. It reads **only the first line** `dev: a b c ## comment` as text. The **recipe of `dev` never runs.**
2. Every prerequisite starts as `make <name>` in its own tmux window, **all at once**. Each window has its own TTY, so interactive keys such as `r` in `flutter run` work.
3. Raycast shows each window's stdout/stderr as its log. Exited targets stay visible with their exit code.
4. **Stop, Restart and Stop Project** send `SIGTERM` to each window's process group, then `SIGKILL` after 5 s. Stop Project then runs `make dev-stop` if that target exists.

## Rules

| Rule | Why |
|---|---|
| `dev:` is a single line of literal target names, no `$(VAR)`, no `\` continuation | devmux expands nothing and reads one line |
| Every target is listed in `.PHONY` | If a folder has the same name (`web/`, `app/`), make reports "up to date" and the window exits at once with no log |
| One target per service, its process runs in the foreground (`exec cmd`) | It then belongs to the window's process group and is reached when stopping |
| No `&`, `nohup`, `setsid`, `docker … up -d` or daemons **in service targets** | A detached process survives stopping and keeps its port |
| Logs go to stdout/stderr, not to files | Raycast and the terminal only show the window |
| Setup (install, migrations, infra) is a prerequisite of **exactly one** service target. Split setup that serves several parts per service (`web-setup`, `api-setup`) | Windows run in parallel; a shared prerequisite would run twice at the same time |
| Setup waits until its result is really ready: `docker compose up -d --wait` (needs a `healthcheck` in the compose file), the simulator via `until xcrun simctl list devices booted \| grep -q Booted; do sleep 1; done` | Otherwise the next step starts too early |
| Other services wait for that service in their recipe (`until nc -z localhost PORT; do sleep 1; done`) | make has no ordering across windows |
| Containers always run via `up -d` as setup and are stopped by `dev-stop`. To see container logs in Raycast, add a service `db-logs: infra` with `exec docker compose logs -f db` | A foreground container survives the `SIGKILL` after 5 s |
| Whatever runs outside the process groups (Docker containers) is stopped by `dev-stop` | It is the only hook after the processes are gone |
| `dev-stop` is non-interactive, idempotent, takes under 120 s and **deletes no data** (`stop`, not `down -v`) | Raycast runs it without a TTY. PATH holds only `/opt/homebrew/bin`, `/usr/local/bin` and system paths; nvm/asdf are missing |
| Processes exit on `SIGTERM` | `SIGKILL` follows after 5 s |

Target names become window names in Raycast, so keep them short: `api`, `worker`, `app`. The session name is the project folder.

## Example

Rails API, Sidekiq, Postgres/Redis in Docker and a Flutter app:

```make
.PHONY: dev api worker app backend-setup infra simulator dev-stop

# devmux starts every prerequisite in parallel as `make <name>` in its own
# tmux window (Raycast "Dev Services"). The recipe of `dev` never runs.
dev: api worker app ## Start local development

# api owns the shared setup; the others wait for it.
api: backend-setup
	cd backend && exec bin/rails server

worker:
	until nc -z localhost 3000; do sleep 1; done
	cd backend && exec bundle exec sidekiq

app: simulator
	cd app && exec flutter run -d ios

backend-setup: infra
	cd backend && { bundle check >/dev/null || bundle install; }
	cd backend && bin/rails db:prepare

# -d is fine here: infra is setup, not a service; dev-stop cleans up.
infra:
	docker compose up -d --wait

simulator:
	open -a Simulator
	until xcrun simctl list devices booted | grep -q Booted; do sleep 1; done

# Raycast "Stop Project" runs this after all windows have ended.
dev-stop:
	docker compose stop
```

## Common mistakes

- **Services in the recipe of `dev`** (`rails s & flutter run`): they never start. Make them prerequisites.
- **`setup` listed in `dev:` and also as a prerequisite**: setup runs twice in parallel.
- **Own PID files, `stop` targets or `trap` cleanup**: not needed, Raycast handles stopping. Only what runs outside belongs in `dev-stop`.
- **Changing the Zed task or `devmux` per project**: both are global. Change only the Makefile.
- **Deleting existing targets other than `dev`/`dev-stop`** (e.g. a manual `stop`): ask first. A `down -v` must never end up in `dev-stop`.
- **Stopping with `tmux kill-session` or running `make dev` in a terminal**: kill-session leaves the processes running under PID 1, and `make dev` works through the prerequisites one by one and hangs at the first service. Start with devmux and stop from Raycast.

## Verify

```sh
devmux                                 # in the project root
tmux -L devmux list-windows -a -F '#{session_name} #{window_name} dead=#{pane_dead} exit=#{pane_dead_status}'
tmux -L devmux capture-pane -p -t '=<project>:<target>'   # log of one window
```
Then use "Stop Project" in Raycast and check with `lsof -i :PORT` or `docker compose ps` that nothing keeps running.
