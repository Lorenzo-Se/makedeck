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

if (cd "$PROJ" && bash "$HERE/bin/makedeck" 2>/dev/null); then
  fail "a second start should fail while the session is running"
fi
echo "OK"
