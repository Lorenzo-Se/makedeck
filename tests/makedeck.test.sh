#!/usr/bin/env bash
# Integration test for bin/makedeck: starts a dummy project on a dedicated tmux socket.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
export MAKEDECK_SOCKET="makedeck-test-$$"
t() { tmux -L "$MAKEDECK_SOCKET" "$@"; }

PROJ=$(mktemp -d /tmp/makedeck-test.XXXXXX)
cleanup() { t kill-server 2>/dev/null || true; rm -rf "$PROJ"; }
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
echo "OK"
