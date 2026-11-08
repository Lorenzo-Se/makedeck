# Agent-Safe Dev Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coding agents start and inspect dev services through makedeck instead of their own background processes, and Raycast shows whatever still runs outside makedeck.

**Architecture:** Three layers. (1) `bin/makedeck` gets agent subcommands (`status`, `logs`, `restart`, `stop`) and a Claude Code `PreToolUse` hook (`makedeck hook`) that blocks `make dev` / background service targets. (2) The skill, README and the user's global `~/.claude/CLAUDE.md` + `~/.claude/settings.json` teach and wire this. (3) The Raycast extension scans processes (`ps`, `lsof`) and lists dev services that run outside the makedeck tmux server in the matching project section, with log, stop and "Move to makedeck".

**Tech Stack:** bash + tmux + jq (`/usr/bin/jq`, ships with macOS 15+), TypeScript (Raycast API, `node --test`).

**Spec:** Section "Design" below (agreed in conversation on 2026-11-08).

## Design

**CLI** (`makedeck [target]` keeps working unchanged for the Zed task):

| Command | Behavior |
|---|---|
| `makedeck [target]` | Start as today. If the session already exists: print `<session> is already running.` plus the status lines, notify, **exit 0** (was exit 1). |
| `makedeck status` | One line per window: `printf '%-16s %s\n' name status`, status ∈ `running`, `stopped` (killed by signal), `exited (0)`, `failed (N)` — same wording as Raycast `statusText`. |
| `makedeck logs <service> [-n N]` | Last N (default 100) lines of the window, `capture-pane -p -J`, trailing blank lines removed. `-n` may come before or after the service. |
| `makedeck restart [service]` | Terminate the window's process group(s), then `respawn-window -k`. Without service: every window of the session. Prints `restarted <names>`. |
| `makedeck stop [service]` | With service: terminate that window (it stays listed as stopped). Without: terminate all, `kill-session`, run `make dev-stop` in the session path if make knows it. Prints `stopped <session>` and `ran make dev-stop` when it ran. |
| `makedeck hook` | Claude Code PreToolUse hook, see below. |
| `makedeck help` / `-h` / `--help` | Usage text. |

Session lookup for `status/logs/restart/stop`: walk up from `$PWD` and pick the first directory equal to a session's `#{session_path}`. None found → stderr `No makedeck session for <PWD>. Start it with: makedeck`, exit 1. Unknown service → stderr `No service '<name>' in <session>. Services: <names>`, exit 1. Subcommand names are reserved; a Makefile target called `status`, `logs`, `restart`, `stop`, `hook` or `help` can no longer be started via `makedeck <target>` (document it).

Termination mirrors `terminate()` in `raycast/src/tmux.ts`: SIGTERM to each live pane's process group (`kill -TERM -- -PID`, never for PID ≤ 1), wait until groups are gone and panes dead (poll 0.1 s, 5 s), then SIGKILL, wait 2 s, else stderr `Processes are still running after SIGKILL`, exit 1.

**Hook** (`makedeck hook`, reads the PreToolUse JSON from stdin):
- No `jq` → stderr `makedeck hook needs jq`, exit 1 (non-blocking error, shown to the user).
- `tool_name != "Bash"` → exit 0.
- Split `tool_input.command` into segments at `;`, `&&`, `||`, `|`, `&`, `(`, `)`, newline. Track the effective directory, starting at `.cwd`: a segment `cd <dir>` changes it (relative to the current one). In each segment, skip leading `VAR=value` words and the prefixes `nohup`, `exec`, `command`, `time`, `env`, `setsid`, `rtk`, `rtk proxy`. If the first remaining word's basename is `make` or `gmake`, collect its targets: skip `-C <dir>` (changes the directory for this make), `-f/-I/-o/-W <arg>`, other `-…` flags, numeric words (`-j 4`) and `VAR=value`.
- That directory's `Makefile` must have a `dev:` line (same awk as the launcher), else allow.
- Background = `tool_input.run_in_background == true`, or the command contains an `&` that is not part of `&&`, `>&` or `&>`.
- Block (exit 2) if a make has target `dev`, or has a target among dev's prerequisites while background. Everything else exits 0.
- Block message on stderr (exact copy):
  `This project runs its dev services with makedeck (services: <prereqs>). Do not start them yourself. Start them with: makedeck (returns immediately, safe if already running). Check: makedeck status. Logs: makedeck logs <service>. After code changes: makedeck restart <service>.`

**Raycast detection**, per refresh, independent of tmux sessions:
1. `ps -x -ww -o pid=,ppid=,pgid=,args=` (own processes), `lsof -nP -iTCP -sTCP:LISTEN -a -u <uid> -Fpn` (listeners → ports). `lsof` exit 1 with empty output means "none".
2. Exclude every process that is, or descends from, a makedeck pane PID.
3. Candidates: (a) `make`/`gmake` processes; (b) TCP listeners that are not daemons. **Daemon = `ppid == 1 && pid == pgid`** (real examples: `adb fork-server`, `caveman-proxy`). An orphaned child of a dead shell or a failed stop keeps `pgid != pid` and stays visible.
4. `lsof -a -d cwd,1 -p <candidates> -Fpftn` → cwd and stdout (type + name) per candidate. Candidates missing here (exited meanwhile) are dropped.
5. Project path: nearest ancestor-or-self of cwd that is a makedeck session path; else for (a) the make cwd; else the nearest ancestor-or-self containing `.git`, which must lie strictly below `$HOME` (a dotfiles repo at `~` does not count). No project path → dropped.
6. A make candidate is kept if a target is `dev` or a prerequisite of `dev` in its cwd's Makefile, or if a listener lies in its subtree. A listener candidate is kept if it has a project path.
7. Keep only top-most kept candidates (drop those with a kept ancestor). Ports = all listener ports in the subtree, sorted, unique.
8. Name: make → its targets joined by space, or `make` if none; otherwise the args with each path-like word reduced to its basename, cut to 40 chars (`node expo start --port 8081`).
9. Log: if stdout type is `REG`, its path; read only the last 64 KiB, strip ANSI escapes, keep the text after the last `\r` of each line.

UI: external items appear in the project's section (keyed by project name = `basename(projectPath)` with `.`/`:` → `_`, same as session names), after the tmux windows, orange dot, accessories `outside makedeck` tag + `:port` list. Detail: the log, or `No log: output goes to <stdout name>.` followed by the command. Actions: **Move to makedeck** (only if the project path has a Makefile with `dev:` and no makedeck session exists for it; stops all externals of that project, then runs `makedeck` through the user's login shell so nvm/rbenv are on PATH), **Stop** (⌃C, confirm alert `Stop <name> (PID <pid>)?` / `Sends SIGTERM to its process group, SIGKILL after 5 s.`), **Copy Logs** (⇧⌘C). A failed process scan does not hide tmux services; it shows one item `Process scan failed` with the error message.

## Global Constraints

- Code, comments, README, skill and CHANGELOG in English.
- `makedeck` with no arguments and `makedeck <target>` keep their current start behavior (apart from exit 0 when already running).
- Socket name stays `${MAKEDECK_SOCKET:-makedeck}`; all tests use their own sockets and never touch the user's sessions.
- Never signal PID/PGID ≤ 1 or the extension's own process group.
- The extension must keep working without the makedeck CLI installed; only "Move to makedeck" needs it and fails with `makedeck not found. Install it and put it on PATH.`
- Use `/bin/ps` and `/usr/sbin/lsof` by absolute path (Raycast's PATH is minimal).
- Node ≥ 22.18 for tests (`node --test tests/*.test.ts`), existing `npm run lint && npm run build` in `raycast/` must pass.

## Review Focus

1. Log files full of ANSI colors and `\r` progress bars (expo, vite, webpack) must read as plain text → `cleanLog` tests in Task 6.
2. Multi-GB log files must not be read fully or stall the 2 s refresh → `readLogFile` tail test with a >64 KiB file in Task 7.
3. A process that exits between `ps` and `lsof` must silently disappear, not throw → `detectExternal` test with a candidate missing from `files` in Task 6.
4. Hook false positives: `git commit -m "make dev"`, `make test` in background, `make api 2>&1`, `make -C other dev` where `other` has no makedeck Makefile must all pass → hook table in Task 3.
5. Stopping an external service whose group already ended must succeed quietly → `stopExternal` test in Task 7.

---

### Task 1: CLI dispatch, session lookup, `status`, `logs`, idempotent start

**Files:**
- Modify: `bin/makedeck`
- Test: `tests/makedeck.test.sh`

**Interfaces:**
- Produces (bash functions inside `bin/makedeck`, reused by Tasks 2–3): `prereqs <makefile> <target>` (prints prerequisites, space-separated), `find_session` (prints session name for `$PWD` or fails), `window_id <session> <name>` (prints `@N` or fails with the service list), `print_status <session>`.

- [ ] **Step 1: Write failing tests** — extend `tests/makedeck.test.sh` after the existing start checks (fixture: `dev: setup server`, `setup` echoes `setup done`, `server` sleeps):
  - Second `makedeck` run: exit 0, stdout contains `is already running.` and a line matching `^server +running$`.
  - `makedeck status` in `$PROJ`: lines `^setup +exited \(0\)$` and `^server +running$`.
  - `makedeck status` in `$PROJ/sub` (mkdir it): same output (walk-up lookup).
  - `makedeck logs setup` → contains `setup done`; `makedeck logs setup -n 1` and `makedeck logs -n 1 setup` → exactly one line, `setup done`.
  - `makedeck logs nope` → exit 1, stderr contains `Services: setup server`.
  - `makedeck status` in a fresh empty temp dir → exit 1, stderr contains `No makedeck session`.
  - Replace the old "second start should fail" check.

- [ ] **Step 2: Run** `bash tests/makedeck.test.sh` — Expected: FAIL at the second-start check.

- [ ] **Step 3: Implement** dispatch (`case "${1:-}" in status|logs|restart|stop|hook|help|-h|--help)`; anything else is a start target, default `dev`), the functions above, `status`, `logs`, `help`, and exit 0 + status for an existing session. Move the awk into `prereqs`. Session paths come from `list-sessions -F '#{session_name}\t#{session_path}'`; no server running counts as no session.

- [ ] **Step 4: Run** `bash tests/makedeck.test.sh` — Expected: `OK`.

- [ ] **Step 5: Commit** `git add bin/makedeck tests/makedeck.test.sh && git commit -m "Add status and logs commands to makedeck"`

### Task 2: CLI `restart` and `stop`

**Files:**
- Modify: `bin/makedeck`
- Test: `tests/makedeck.test.sh`

**Interfaces:**
- Consumes: `find_session`, `window_id`, `prereqs` from Task 1.
- Produces: `terminate <tmux-target-args…>` bash function (same semantics as `terminate()` in `raycast/src/tmux.ts`; comment that they must stay in sync).

- [ ] **Step 1: Write failing tests** — new fixture project (own temp dir) with markers like the TS integration test: `dev: web worker`, `web:` `@exec -a MK$$_web sleep 300`, `worker:` starts a `nohup … exec -a MK$$_nohup sleep 300 &` plus `exec -a MK$$_worker sleep 300`, `dev-stop:` `@touch stopped`.
  - `makedeck restart web` → exit 0, prints `restarted web`; afterwards `pgrep -f MK$$_web | wc -l` is 1 and the window's `#{pane_pid}` changed.
  - `makedeck stop web` → `pgrep -f MK$$_web` finds nothing, `makedeck status` shows `web` as `stopped`.
  - `makedeck stop` → exit 0, prints `stopped <session>` and `ran make dev-stop`; no `MK$$_` process left (including nohup); file `stopped` exists; `tmux has-session` fails.
  - `makedeck stop` in a project without `dev-stop` → exit 0, no `ran make dev-stop` line.

- [ ] **Step 2: Run** `bash tests/makedeck.test.sh` — Expected: FAIL at `restart`.

- [ ] **Step 3: Implement** `terminate`, `restart [service]`, `stop [service]`. `make dev-stop` runs with `LC_ALL=C`, `MAKELEVEL` unset, in the session path; a top-level `make: *** No rule to make target [`']dev-stop'` on stderr means "missing" (same rule as `isMissingTarget`); any other failure prints make's output and exits with its code.

- [ ] **Step 4: Run** `bash tests/makedeck.test.sh` — Expected: `OK`.

- [ ] **Step 5: Commit** `git commit -am "Add restart and stop commands to makedeck"`

### Task 3: `makedeck hook`

**Files:**
- Modify: `bin/makedeck`
- Test: `tests/makedeck.test.sh`

**Interfaces:**
- Consumes: `prereqs` from Task 1.
- Produces: `makedeck hook` — stdin PreToolUse JSON, exit 0 (allow) / 2 (block, message on stderr) / 1 (jq missing).

- [ ] **Step 1: Write failing tests** — a table driven by a helper `hook_case <expected-exit> <cwd> <command> [background]` that builds `{"tool_name":"Bash","cwd":…,"tool_input":{"command":…,"run_in_background":…}}` with `jq -n` and pipes it into `bin/makedeck hook`. Fixture `H` with Makefile `dev: api worker`, `api:`, `worker:`, `test:`; plus `H/other` with a Makefile without `dev:`; plus a dir without Makefile.
  - Block (2): `make dev`; `make -j4 dev`; `make api` background; `make api &`; `echo hi; make dev`; `cd <basename H> && make dev` with cwd = parent of `H`; `nohup make worker &`; `FOO=1 make dev`; `rtk proxy make dev`; `make -C H dev` from an unrelated dir.
  - Allow (0): `make api` foreground; `make test` background; `make api 2>&1`; `make api &> log` foreground; `git commit -m "make dev"`; `make dev` in `H/other`; `make dev` in the dir without Makefile; tool_name `Read`.
  - A blocked case's stderr contains `makedeck logs <service>` and `services: api worker`.

- [ ] **Step 2: Run** `bash tests/makedeck.test.sh` — Expected: FAIL at the first hook case.

- [ ] **Step 3: Implement** `hook` per the Design section. `jq -r` extracts `.tool_name`, `.cwd`, `.tool_input.command`, `.tool_input.run_in_background // false`. Segment splitting and word handling in bash/awk; quoting inside a word does not need to be honored beyond what the allow cases require.

- [ ] **Step 4: Run** `bash tests/makedeck.test.sh` — Expected: `OK`.

- [ ] **Step 5: Commit** `git commit -am "Add Claude Code hook that routes dev services through makedeck"`

### Task 4: Teach agents, wire the hook (repo docs + user's global config)

**Files:**
- Modify: `skills/structuring-dev-makefiles/SKILL.md`, `README.md`
- Modify (outside repo, approved by the user): `~/.claude/CLAUDE.md`, `~/.claude/settings.json`

- [ ] **Step 1: Skill** — add section `## For agents: running the services` before `## Verify` with: start with `makedeck` (never `make dev` or service targets yourself, in particular not in the background); `makedeck status`, `makedeck logs <service> [-n N]`, `makedeck restart <service>`, `makedeck stop`; `makedeck` is safe to call when already running. Replace the raw tmux lines in `## Verify` with `makedeck status` / `makedeck logs <target>`; reword the "running `make dev` in a terminal" common mistake to point at the hook.

- [ ] **Step 2: README** — new section `## Commands` (table from the Design section, note on reserved target names); under "For coding agents" add the hook snippet:
  ```json
  { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "makedeck hook" } ] } ] } }
  ```
  with one sentence on what it blocks and that it needs `jq` (`/usr/bin/jq` on macOS 15+). Update the Layout block if paths changed.

- [ ] **Step 3: Global CLAUDE.md** — append:
  ```markdown
  ## Dev services (makedeck)

  If the project's Makefile has a `dev:` target, its services run in makedeck. Never start `make dev` or a service target yourself, in particular not in the background. Start with `makedeck` (safe if already running), then use `makedeck status`, `makedeck logs <service>`, `makedeck restart <service>` and `makedeck stop`.
  ```

- [ ] **Step 4: settings.json** — add `{"matcher":"Bash","hooks":[{"type":"command","command":"makedeck hook"}]}` to the existing `hooks.PreToolUse` array, keeping all other entries; edit with `jq` into a temp file and move it over the original after `jq . <tmp>` succeeds.

- [ ] **Step 5: Verify** — `jq -e '.hooks.PreToolUse | map(.hooks[].command) | index("makedeck hook")' ~/.claude/settings.json` prints a number; `echo '{"tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"make dev"}}' | makedeck hook` exits 0 in this repo (no Makefile) — and exits 2 in a temp project with `dev: a`.

- [ ] **Step 6: Commit** (repo files only) `git commit -am "Document agent commands and the makedeck hook"`

### Task 5: tmux.ts — pane PID per service, shared group termination

**Files:**
- Modify: `raycast/src/tmux.ts`
- Test: `tests/tmux.test.ts`, `tests/tmux.integration.test.ts`

**Interfaces:**
- Produces:
  - `Service.pid: number | null` (pane PID, null for exited panes); `LIST_FORMAT` gains `#{pane_pid}` as 8th field, `parseWindows` checks 8 fields.
  - `export const SEARCH_PATH: string[]`
  - `export function findBinary(name: string): string | undefined` (first `${dir}/${name}` in `SEARCH_PATH` that exists; `tmuxBinary` uses it).
  - `export async function terminateGroups(pgids: number[], stillRunning: () => Promise<boolean> = async () => false): Promise<void>` — SIGTERM, wait ≤ `STOP_TIMEOUT_MS` until no group exists and `stillRunning()` is false, SIGKILL, wait ≤ `KILL_TIMEOUT_MS`, else throw `Processes are still running after SIGKILL`. `terminate(target)` becomes `terminateGroups(pids, async () => (await panes(target)).some((p) => !p.dead))`.
  - `signalGroup` additionally refuses the extension's own process group (look it up once via `ps -o pgid= -p <process.pid>`) with `Error("refusing to signal own process group")`.

- [ ] **Step 1: Update tests** — `parseWindows` fixtures get the pane PID field (running: `"4242"` → `pid: 4242`; exited: `""` → `pid: null`); 7-field line now throws. Add integration test: `terminateGroups([pgid])` on a detached `sleep` started with `spawn(..., { detached: true })` ends it; `terminateGroups` on a PGID that no longer exists resolves.

- [ ] **Step 2: Run** `node --test tests/tmux*.test.ts` — Expected: FAIL (pid field, missing export).

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run** `node --test tests/tmux*.test.ts` — Expected: all pass.

- [ ] **Step 5: Commit** `git commit -am "Expose pane PIDs and shared group termination in tmux.ts"`

### Task 6: processes.ts — parsers and pure detection

**Files:**
- Create: `raycast/src/processes.ts`
- Test: `tests/processes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Proc = { pid: number; ppid: number; pgid: number; args: string };
  export type OpenFiles = { cwd?: string; stdout?: { type: string; name: string } };
  export type ExternalService = {
    id: string;            // `ext:${pid}`
    pid: number; pgid: number;
    project: string; projectPath: string;
    name: string; command: string;
    ports: number[];
    logPath: string | null;
    stdout: string | null; // stdout name, for the "No log" message
    makedeckReady: boolean; // projectPath has a Makefile with a dev: line
  };
  export type DetectInput = {
    procs: Proc[];
    listeners: Map<number, number[]>;
    files: Map<number, OpenFiles>;
    panePids: Set<number>;
    sessionPaths: string[];
    home: string;
    readMakefile: (dir: string) => string | null; // file content or null
    isRepoRoot: (dir: string) => boolean;          // dir contains .git
  };
  export function parsePs(out: string): Proc[];
  export function parseListeners(out: string): Map<number, number[]>;
  export function parseFiles(out: string): Map<number, OpenFiles>;
  export function makeTargets(args: string): string[] | null; // null = not make/gmake
  export function devPrereqs(makefile: string): string[];
  export function candidatePids(procs: Proc[], listeners: Map<number, number[]>, panePids: Set<number>): number[];
  export function detectExternal(input: DetectInput): ExternalService[];
  export function cleanLog(raw: string): string;
  ```

- [ ] **Step 1: Write failing tests** with fixtures modeled on the real machine survey:
  - `parsePs` on `"51094 51091 51062 node /x/node_modules/.bin/expo start --port 8081\n"` → one Proc with that args.
  - `parseListeners` on `p11\nn*:3000\nn127.0.0.1:5173\np12\nn[::1]:8080\n` → `{11: [3000, 5173], 12: [8080]}`.
  - `parseFiles` on `p5\nfcwd\ntDIR\nn/p\nf1\ntREG\nn/tmp/x.log\n` → `{5: {cwd: "/p", stdout: {type: "REG", name: "/tmp/x.log"}}}`.
  - `makeTargets`: `/Applications/Xcode.app/…/usr/bin/make app` → `["app"]`; `make -j 4 -C dir FOO=1 dev api` → `["dev", "api"]`; `make` → `[]`; `node make.js` → `null`.
  - `devPrereqs("x: y\ndev: api worker ## c\n")` → `["api", "worker"]`; no dev line → `[]`.
  - `detectExternal` scenario (home `/Users/u`):
    - orphaned `make app` (ppid 1, pgid ≠ pid, cwd `/Users/u/three`, Makefile `dev: app`, stdout REG `/tmp/metro.log`) with child `node …expo start` listening on 8081 → exactly one service `name: "app"`, `ports: [8081]`, `logPath: "/tmp/metro.log"`, `project: "three"`, `makedeckReady: true`.
    - process tree below pane PID 55048 listening on 8082 → absent.
    - `adb` daemon (ppid 1, pid == pgid, cwd in repo, listening) → absent.
    - `make android` (not a dev prereq) with listening child `qemu` and grandchild `netsimd` listening → one service `android`, ports from both.
    - `make test` without listener, not a prereq → absent; `make worker` (prereq) without listener → present, `ports: []`.
    - sub-make `make[1]` under a kept make → absent (top-most only).
    - plain `node server.js` with ppid ≠ 1, cwd `/Users/u/web/src`, repo root `/Users/u/web`, stdout CHR `/dev/ttys005` → `project: "web"`, `logPath: null`, `stdout: "/dev/ttys005"`, name `node server.js`.
    - listener with cwd `/Users/u/notes` where only `/Users/u` is a repo → absent; listener with cwd `/tmp/x` → absent.
    - cwd inside a session path `/Users/u/mono/app` that lies in repo `/Users/u/mono` → `projectPath: "/Users/u/mono/app"`.
    - project folder `my.app` → `project: "my_app"`.
    - candidate PID missing from `files` → absent, no throw.
  - `candidatePids` returns the make, listener and expo PIDs of the scenario but not the pane descendants or the daemon.
  - `cleanLog("\x1b[32mready\x1b[0m\nload 10%\rload 100%\n")` → `"ready\nload 100%\n"`.

- [ ] **Step 2: Run** `node --test tests/processes.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** per Design steps 2–9. Ancestry via a `pid → Proc` map walking `ppid` (stop at 1 or unknown). Name reduction for non-make: each word containing `/` → its basename, join, cut to 40 chars with `…`.

- [ ] **Step 4: Run** `node --test tests/processes.test.ts` — Expected: all pass.

- [ ] **Step 5: Commit** `git add raycast/src/processes.ts tests/processes.test.ts && git commit -m "Detect dev services running outside makedeck"`

### Task 7: processes.ts — scanning, logs, stop, move to makedeck

**Files:**
- Modify: `raycast/src/processes.ts`
- Test: `tests/processes.integration.test.ts`

**Interfaces:**
- Consumes: `Service` (with `pid`), `SEARCH_PATH`, `findBinary`, `terminateGroups` from Task 5; everything from Task 6.
- Produces:
  ```ts
  export async function listExternalServices(services: Service[], home?: string): Promise<ExternalService[]>; // home defaults to homedir()
  export async function readLogFile(path: string, maxLines?: number): Promise<string>; // default 200, reads last 64 KiB, cleanLog + tailLog
  export async function stopExternal(service: ExternalService): Promise<void>;          // terminateGroups([service.pgid])
  export async function moveToMakedeck(projectPath: string, externals: ExternalService[]): Promise<void>;
  ```
  `moveToMakedeck` stops every external whose `projectPath` matches, then runs `${process.env.SHELL || "/bin/zsh"} -l -i -c "exec <quoted makedeck path>"` with `cwd: projectPath`, stdin ignored, timeout 30 s. Missing binary → `Error("makedeck not found. Install it and put it on PATH.")`.

- [ ] **Step 1: Write failing tests** — temp root as `home` (`mkdtempSync`), project `proj` with `.git/` dir and Makefile `dev: api\napi:\n\t@exec -a MARK_api node -e "require('net').createServer().listen(0)"`; start `make api > out.log 2>&1` with `spawn("bash", ["-c", …], { cwd, detached: true, stdio: "ignore" })`:
  - `listExternalServices([], root)` finds `name: "api"`, one port > 0, `logPath` ending in `out.log`.
  - Passing a fake `Service` whose `pid` is the spawned bash PID → the service is absent.
  - `stopExternal` ends it (`pgrep -f MARK_api` empty); calling it again resolves.
  - `readLogFile` on a 1 MiB file whose last line is `LAST` → result ends with `LAST`, and at most `maxLines` lines.
  - `moveToMakedeck` with `MAKEDECK_SOCKET` set to a test socket and `PATH` pointing at `bin/` of this repo: the external is gone and `tmux -L <socket> has-session -t =proj` succeeds. Clean up the socket in `after`.

- [ ] **Step 2: Run** `node --test tests/processes.integration.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** using `/bin/ps` and `/usr/sbin/lsof` via `execFile` (lsof exit 1 + empty stdout → empty result), `fs.promises.open` + `read` at `max(0, size - 65536)` for logs (drop the first partial line when not reading from 0).

- [ ] **Step 4: Run** `node --test tests/*.test.ts` — Expected: all pass.

- [ ] **Step 5: Commit** `git commit -am "Scan, stop and adopt external dev services"`

### Task 8: Raycast UI, changelog, README

**Files:**
- Modify: `raycast/src/services.tsx`, `raycast/CHANGELOG.md`, `raycast/package.json` (description only), `README.md`

**Interfaces:**
- Consumes: `listServices`, `Service` (tmux.ts); `listExternalServices`, `readLogFile`, `stopExternal`, `moveToMakedeck`, `ExternalService` (processes.ts).

- [ ] **Step 1: Implement** one loader `loadAll(): Promise<{ services: Service[]; externals: ExternalService[]; scanError: Error | null }>` (scan errors caught into `scanError`, tmux errors still propagate to the existing empty views). Sections keyed by project name hold both lists; `isShowingDetail` and the empty view consider both. Selected id `ext:…` loads `readLogFile(logPath)` when `logPath` is set. New `ExternalItem` per Design "UI" (orange `Icon.CircleFilled`, tag `outside makedeck`, ports text, detail text for no log, actions Move to makedeck → Stop → Copy Logs, success toasts `Moved <project> to makedeck` / `<name> stopped`). `scanError` renders one item `Process scan failed` with `Icon.Warning` and the message as subtitle.

- [ ] **Step 2: CHANGELOG** — prepend `## [Services outside makedeck] - {PR_MERGE_DATE}` with bullets: shows dev services started outside makedeck (e.g. by a coding agent) in their project, with log, stop and "Move to makedeck". `package.json` description: `See your makedeck services with live logs, open them in Terminal, restart or stop them, and spot dev servers started outside makedeck.`

- [ ] **Step 3: README** — in "Raycast Dev Services" a short subsection on external services: the detection rule in two sentences (make targets of `dev` and non-daemon TCP listeners inside a Git repo under `~`), what works (log if stdout is a file, stop, move) and what does not (restart, terminal). Add the limitation: workers without a port that are not started via make are not detected.

- [ ] **Step 4: Verify** — `cd raycast && npm run lint && npm run build`; `node --test tests/*.test.ts`; `bash tests/makedeck.test.sh`. Manual: `npm run dev` in `raycast/`, start `make app > /tmp/x.log 2>&1 &` in a real project, check it appears with log, stop it, start it again, use Move to makedeck.

- [ ] **Step 5: Commit** `git commit -am "Show dev services running outside makedeck in Raycast"`
