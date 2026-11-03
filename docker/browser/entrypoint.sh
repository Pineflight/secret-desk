#!/bin/bash
# Starts the virtual display, the VNC server, noVNC, the DevTools forward and Chromium. If any of them exits, the container
# exits (the restart policy brings it back), so a half-working sidecar never lingers.
set -euo pipefail

PASSWORD_FILE="${VNC_PASSWORD_FILE:-/run/secrets/vnc-password}"
RESOLUTION="${RESOLUTION:-1440x900}"
PROFILE_DIR="${PROFILE_DIR:-/profile}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
# Chromium listens on loopback only (127.0.0.1:CDP_LOCAL_PORT); socat forwards CDP_PORT on all interfaces for the compose network.
CDP_PORT="${CDP_PORT:-9222}"
CDP_LOCAL_PORT="${CDP_LOCAL_PORT:-9223}"

fail() {
  echo "secret-desk-browser: $*" >&2
  exit 1
}

# A VNC password is mandatory. The VNC protocol only uses the first 8 characters, so shorter ones are refused.
[ -f "$PASSWORD_FILE" ] || fail "no VNC password: $PASSWORD_FILE does not exist (mount a secret there or set VNC_PASSWORD_FILE)."
[ -r "$PASSWORD_FILE" ] || fail "no VNC password: $PASSWORD_FILE is not readable by user $(id -un)."
password="$(head -n 1 "$PASSWORD_FILE" | tr -d '\r\n')"
[ "${#password}" -ge 8 ] || fail "the VNC password in $PASSWORD_FILE must have at least 8 characters."
# Only the first line, in a private copy: x11vnc would treat a second line as a view-only password.
vnc_file="$(mktemp)"
printf '%s\n' "$password" >"$vnc_file"
unset password

[ -w "$PROFILE_DIR" ] || fail "$PROFILE_DIR is not writable by user $(id -un) (uid $(id -u)); chown the volume to this user."

# Locks of a previous container (the hostname changes with every container) would make Chromium refuse the profile.
rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonCookie "$PROFILE_DIR"/SingletonSocket

pids=()
# shellcheck disable=SC2329  # invoked through the trap
cleanup() {
  trap - TERM INT EXIT
  rm -f "$vnc_file"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 "${RESOLUTION}x24" -nolisten tcp &
pids+=($!)
for _ in $(seq 1 50); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done
[ -S /tmp/.X11-unix/X99 ] || fail "the virtual display did not start."

# VNC on loopback only; noVNC (websockify) is the only way in.
# A window manager gives the browser window the keyboard focus. Without one, X sends keys only to the window under the
# pointer, and after a container restart typing in the noVNC window can stop working altogether.
DISPLAY=:99 openbox >/dev/null 2>&1 &
pids+=($!)

x11vnc -display :99 -localhost -rfbport 5900 -passwdfile "$vnc_file" -forever -shared -noxdamage -quiet >/dev/null 2>&1 &
pids+=($!)

websockify --web /usr/share/novnc "$NOVNC_PORT" 127.0.0.1:5900 >/dev/null 2>&1 &
pids+=($!)

socat "TCP-LISTEN:${CDP_PORT},fork,reuseaddr" "TCP:127.0.0.1:${CDP_LOCAL_PORT}" &
pids+=($!)

# The container is the sandbox by default; Chromium's own sandbox needs user namespaces (set BROWSER_SANDBOX=1 and allow them).
sandbox_flag="--no-sandbox"
[ "${BROWSER_SANDBOX:-0}" = "1" ] && sandbox_flag=""

width="${RESOLUTION%x*}"
height="${RESOLUTION#*x}"
# shellcheck disable=SC2086
chromium $sandbox_flag \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-port="$CDP_LOCAL_PORT" --remote-debugging-address=127.0.0.1 \
  --window-position=0,0 --window-size="${width},${height}" \
  --no-first-run --no-default-browser-check --password-store=basic \
  --disable-dev-shm-usage --disable-gpu --disable-background-networking --disable-sync \
  --disable-features=Translate,MediaRouter \
  about:blank &
chromium_pid=$!
pids+=("$chromium_pid")

# Any process ending ends the container.
wait -n || true
echo "secret-desk-browser: a component exited; stopping." >&2
exit 1
