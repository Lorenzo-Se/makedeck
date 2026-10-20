#!/usr/bin/env bash
# Integration test for bin/devmux: starts a dummy project on a dedicated tmux socket.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
export DEVMUX_SOCKET="devmux-test-$$"
t() { tmux -L "$DEVMUX_SOCKET" "$@"; }

PROJ=$(mktemp -d /tmp/devmux-test.XXXXXX)
cleanup() { t kill-server 2>/dev/null || true; rm -rf "$PROJ"; }
trap cleanup EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

printf 'dev: setup server ## start everything\nsetup:\n\t@echo setup done\nserver:\n\t@sleep 60\n' > "$PROJ/Makefile"

(cd "$PROJ" && bash "$HERE/bin/devmux") || fail "devmux exit code != 0"
sleep 1

WINDOWS=$(t list-windows -a -F '#{session_name} #{window_name} #{pane_dead} #{pane_dead_status}')
echo "$WINDOWS"
# tmux does not allow '.' in session names; mktemp yields "devmux-test.XXXXXX"
SESSION=$(basename "$PROJ" | tr '.:' '__')
grep -q "^$SESSION setup 1 0$" <<<"$WINDOWS" || fail "setup should have exited with 0 and still be listed"
grep -q "^$SESSION server 0 $" <<<"$WINDOWS" || fail "server should be running"

if (cd "$PROJ" && bash "$HERE/bin/devmux" 2>/dev/null); then
  fail "a second start should fail while the session is running"
fi
echo "OK"
