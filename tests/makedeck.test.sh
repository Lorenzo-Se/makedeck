#!/usr/bin/env bash
# Integration test for bin/makedeck: starts a dummy project on a dedicated tmux socket.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
export MAKEDECK_SOCKET="makedeck-test-$$"
t() { tmux -L "$MAKEDECK_SOCKET" "$@"; }

PROJ=$(mktemp -d /tmp/makedeck-test.XXXXXX)
PROJ2=$(mktemp -d /tmp/makedeck-test.XXXXXX)
# Processes of the restart/stop fixture carry this marker so pgrep finds only them.
M="MK$$"
cleanup() {
  pkill -f "${M}_" 2>/dev/null || true
  t kill-server 2>/dev/null || true
  rm -rf "$PROJ" "$PROJ2"
}
trap cleanup EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

printf 'dev: setup server ## start everything\nsetup:\n\t@echo setup done\nserver:\n\t@sleep 60\n' > "$PROJ/Makefile"

(cd "$PROJ" && bash "$HERE/bin/makedeck") || fail "makedeck exit code != 0"
sleep 1

WINDOWS=$(t list-windows -a -F '#{session_name} #{window_name} #{pane_dead} #{pane_dead_status}')
echo "$WINDOWS"
# tmux does not allow '.' in session names; mktemp yields "makedeck-test.XXXXXX"
SESSION=$(basename "$PROJ" | tr '.:' '__')
grep -q "^$SESSION setup 1 0$" <<<"$WINDOWS" || fail "setup should have exited with 0 and still be listed"
grep -q "^$SESSION server 0 $" <<<"$WINDOWS" || fail "server should be running"

SETUP_LOG=$(t capture-pane -p -J -S -200 -t "$(t list-windows -t "=$SESSION" -F '#{window_id} #{window_name}' | awk '$2 == "setup" {print $1}')")
grep -q "setup done" <<<"$SETUP_LOG" || fail "setup log should contain its output"
if grep -q "Pane is dead" <<<"$SETUP_LOG"; then
  fail "exited windows should not get tmux's 'Pane is dead' line in their log"
fi

MK="$HERE/bin/makedeck"
OUT=$(cd "$PROJ" && bash "$MK") || fail "a second start should exit 0 while the session is running"
grep -q "is already running\." <<<"$OUT" || fail "a second start should say the session is already running"
grep -Eq "^server +running$" <<<"$OUT" || fail "a second start should print the status lines"

OUT=$(cd "$PROJ" && bash "$MK" status) || fail "status should exit 0"
grep -Eq '^setup +exited \(0\)$' <<<"$OUT" || fail "status should show setup as exited (0)"
grep -Eq '^server +running$' <<<"$OUT" || fail "status should show server as running"

mkdir "$PROJ/sub"
OUT_SUB=$(cd "$PROJ/sub" && bash "$MK" status) || fail "status in a subdirectory should exit 0"
[ "$OUT_SUB" = "$OUT" ] || fail "status in a subdirectory should find the session of a parent"

OUT=$(cd "$PROJ" && bash "$MK" logs setup) || fail "logs should exit 0"
grep -q "setup done" <<<"$OUT" || fail "logs setup should contain its output"
[ "$(cd "$PROJ" && bash "$MK" logs setup -n 1)" = "setup done" ] || fail "logs setup -n 1 should print exactly the last line"
[ "$(cd "$PROJ" && bash "$MK" logs -n 1 setup)" = "setup done" ] || fail "logs -n 1 setup should print exactly the last line"

if ERR=$(cd "$PROJ" && bash "$MK" logs nope 2>&1 >/dev/null); then
  fail "logs of an unknown service should fail"
fi
grep -q "Services: setup server" <<<"$ERR" || fail "an unknown service should list the services: $ERR"

EMPTY=$(mktemp -d /tmp/makedeck-empty.XXXXXX)
if ERR=$(cd "$EMPTY" && bash "$MK" status 2>&1 >/dev/null); then
  rm -rf "$EMPTY"
  fail "status without a session should fail"
fi
grep -q "No makedeck session" <<<"$ERR" || { rm -rf "$EMPTY"; fail "status without a session should say so: $ERR"; }
if ERR=$(cd "$EMPTY" && MAKEDECK_SOCKET="makedeck-test-none-$$" bash "$MK" status 2>&1 >/dev/null); then
  rm -rf "$EMPTY"
  fail "status without a tmux server should fail"
fi
rm -rf "$EMPTY"
grep -q "No makedeck session" <<<"$ERR" || fail "no tmux server should count as no session: $ERR"

# --- restart and stop -------------------------------------------------------
count() { pgrep -f "${M}_$1" | wc -l | tr -d ' '; }
printf 'dev: web worker\nweb:\n\t@exec -a %s_web sleep 300\nworker:\n\t@nohup bash -c '"'"'exec -a %s_nohup sleep 300'"'"' >/dev/null 2>&1 & exec -a %s_worker sleep 300\ndev-stop:\n\t@touch stopped\n' \
  "$M" "$M" "$M" > "$PROJ2/Makefile"
(cd "$PROJ2" && bash "$MK" >/dev/null) || fail "starting the restart/stop fixture failed"
SESSION2=$(basename "$PROJ2" | tr '.:' '__')
sleep 1
[ "$(count web)$(count worker)$(count nohup)" = "111" ] || fail "fixture processes should run once each"

web_pid() { t list-windows -t "=$SESSION2" -F '#{window_name} #{pane_pid}' | awk '$1 == "web" { print $2 }'; }
OLD_PID=$(web_pid)
OUT=$(cd "$PROJ2" && bash "$MK" restart web) || fail "restart web should exit 0"
[ "$OUT" = "restarted web" ] || fail "restart web should print 'restarted web', got: $OUT"
sleep 1
[ "$(count web)" = 1 ] || fail "after restart exactly one web process should run, got $(count web)"
[ "$(web_pid)" != "$OLD_PID" ] || fail "restart should start a new pane process"

OUT=$(cd "$PROJ2" && bash "$MK" restart) || fail "restart without a service should exit 0"
[ "$OUT" = "restarted web worker" ] || fail "restart should name all services, got: $OUT"
sleep 1
[ "$(count web)$(count worker)$(count nohup)" = "111" ] || fail "restart of all should leave each process running once"

(cd "$PROJ2" && bash "$MK" stop web >/dev/null) || fail "stop web should exit 0"
[ "$(count web)" = 0 ] || fail "stop web should end the web process"
OUT=$(cd "$PROJ2" && bash "$MK" status) || fail "status should exit 0"
grep -Eq '^web +stopped$' <<<"$OUT" || fail "a stopped service should stay listed as stopped, got: $OUT"

OUT=$(cd "$PROJ2" && bash "$MK" stop) || fail "stop should exit 0"
grep -qx "stopped $SESSION2" <<<"$OUT" || fail "stop should print 'stopped $SESSION2', got: $OUT"
grep -qx "ran make dev-stop" <<<"$OUT" || fail "stop should report that it ran make dev-stop, got: $OUT"
[ "$(count "")" = 0 ] || fail "stop should end every process, including nohup ones"
[ -f "$PROJ2/stopped" ] || fail "stop should run make dev-stop"
if t has-session -t "=$SESSION2" 2>/dev/null; then fail "stop should close the session"; fi

OUT=$(cd "$PROJ" && bash "$MK" stop) || fail "stop without dev-stop should exit 0"
if grep -q "ran make dev-stop" <<<"$OUT"; then fail "stop without dev-stop should not claim it ran"; fi
echo "OK"
