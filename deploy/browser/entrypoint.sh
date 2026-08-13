#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR=/data/profile
VNC_DIR=/data/.vnc
VNC_SECRET_FILE="$VNC_DIR/password.txt"
VNC_AUTH_FILE="$VNC_DIR/passwd"
declare -a critical_pids=()
declare -a critical_names=()
shutting_down=0

stop_children() {
  shutting_down=1
  trap - TERM INT EXIT
  for pid in "${critical_pids[@]:-}"; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done
  deadline=$((SECONDS + 20))
  while (( SECONDS < deadline )); do
    alive=0
    for pid in "${critical_pids[@]:-}"; do
      [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=1
    done
    [[ "$alive" -eq 0 ]] && break
    sleep 0.1
  done
  for pid in "${critical_pids[@]:-}"; do
    [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}

trap stop_children TERM INT EXIT

mkdir -p "$PROFILE_DIR" "$VNC_DIR"
chown -R pwuser:pwuser /data

# Remove only Chromium's crash leftovers. Profile content and login state stay intact.
rm -f "$PROFILE_DIR/SingletonCookie" "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket"
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

if [[ -n "${XSIGNAL_VNC_PASSWORD:-}" ]]; then
  vnc_password="$XSIGNAL_VNC_PASSWORD"
elif [[ -f "$VNC_SECRET_FILE" && "$(wc -c < "$VNC_SECRET_FILE")" -ge 16 ]] && ! grep -Eq '^[0-9a-f]{32}$' "$VNC_SECRET_FILE"; then
  vnc_password="$(<"$VNC_SECRET_FILE")"
else
  # Classic VNC authentication uses the first eight bytes, so make those bytes
  # full-alphabet random characters instead of a low-entropy hex prefix.
  vnc_password="$(openssl rand -base64 24 | tr -d '\n')"
  printf '%s' "$vnc_password" > "$VNC_SECRET_FILE"
  chmod 0600 "$VNC_SECRET_FILE"
fi

x11vnc -storepasswd "$vnc_password" "$VNC_AUTH_FILE" >/dev/null
chown -R pwuser:pwuser "$VNC_DIR"
unset vnc_password XSIGNAL_VNC_PASSWORD

runuser -u pwuser -- Xvfb :99 -screen 0 1440x960x24 -nolisten tcp -ac >/data/xvfb.log 2>&1 &
xvfb_pid=$!
for _ in $(seq 1 100); do
  [[ -S /tmp/.X11-unix/X99 ]] && break
  sleep 0.1
done
if [[ ! -S /tmp/.X11-unix/X99 ]]; then
  printf '%s\n' '{"level":"error","event":"xvfb_start_timeout"}' >&2
  exit 1
fi
runuser -u pwuser -- fluxbox -display :99 >/data/fluxbox.log 2>&1 &
runuser -u pwuser -- x11vnc -display :99 -localhost -forever -shared -rfbauth "$VNC_AUTH_FILE" -rfbport 5900 -o /data/x11vnc.log >/dev/null 2>&1 &
x11vnc_pid=$!
runuser -u pwuser -- websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/data/novnc.log 2>&1 &
novnc_pid=$!
runuser -u pwuser -- node /opt/x-signal-browser/launcher.mjs &
launcher_pid=$!

critical_pids=("$xvfb_pid" "$x11vnc_pid" "$novnc_pid" "$launcher_pid")
critical_names=("Xvfb" "x11vnc" "websockify" "Chromium launcher")

while true; do
  set +e
  wait -n "${critical_pids[@]}"
  status=$?
  set -e
  [[ "$shutting_down" -eq 1 ]] && exit 0
  dead_name="critical child"
  for index in "${!critical_pids[@]}"; do
    if ! kill -0 "${critical_pids[$index]}" 2>/dev/null; then
      dead_name="${critical_names[$index]}"
      break
    fi
  done
  printf '{"level":"error","event":"browser_child_exited","child":"%s","status":%d}\n' "$dead_name" "$status" >&2
  exit 1
done
