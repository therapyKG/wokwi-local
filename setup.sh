#!/usr/bin/env bash
# Sets up wokwi-local on macOS or Linux: installs whatever is missing, starts the server now and at
# every login, and walks you through loading the browser extension. Safe to run again.
#
#   ./setup.sh                          set up
#   ./setup.sh --preload uno,pico,esp32 also download those boards' cores now (ESP32 is a few GB)
#   ./setup.sh --yes                    don't stop to ask (accepts Apple's Rosetta license)
#   ./setup.sh --no-browser             don't open the browser's extensions page
#   ./setup.sh --uninstall              stop the server and remove it from login items
#
# Missing tools are downloaded into ~/.local/share/wokwi-local, never system-wide, so no sudo is
# needed. For testing, WOKWI_SETUP_FORCE_DOWNLOAD=1 downloads them even if they're installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${XDG_DATA_HOME:-$HOME/.local/share}/wokwi-local"
PORT=9420
NODE_MAJOR=22
LABEL=com.wokwi-local.server
OS="$(uname -s)"
ARCH="$(uname -m)"

YES=0
PRELOAD=""
BROWSER=1
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y | --yes) YES=1 ;;
    --preload) PRELOAD="${2:?--preload needs a list, e.g. uno,pico,esp32}"; shift ;;
    --no-browser) BROWSER=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[ -n "${CI:-}" ] && BROWSER=0

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

case "$OS" in
  Darwin | Linux) ;;
  *) die "this script is for macOS and Linux. On Windows, run setup.ps1." ;;
esac
for tool in curl tar; do
  command -v "$tool" >/dev/null || die "$tool is required but not installed"
done

if [ "$OS" = Darwin ]; then
  SERVICE_FILE="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG="$HOME/Library/Logs/wokwi-local.log"
else
  SERVICE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/wokwi-local.service"
  AUTOSTART_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/wokwi-local.desktop"
  LOG="${XDG_STATE_HOME:-$HOME/.local/state}/wokwi-local.log"
fi

# --- Downloads -------------------------------------------------------------------------------

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

download() { # url file
  curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"
}

# Finds "<sha256>  <name>" in a checksum list and checks the downloaded file against it.
verify() { # sums-file name file
  local expected
  expected="$(grep -E "[[:space:]]\*?$2\$" "$1" | cut -d' ' -f1)"
  [ -n "$expected" ] || die "no checksum listed for $2"
  [ "$(sha256 "$3")" = "$expected" ] || die "checksum mismatch for $2"
}

cpu() { # node | arduino: how each project names this CPU in its download file names
  case "$1:$ARCH" in
    node:x86_64 | node:amd64) echo x64 ;;
    node:arm64 | node:aarch64) echo arm64 ;;
    arduino:x86_64 | arduino:amd64) echo 64bit ;;
    arduino:arm64 | arduino:aarch64) echo ARM64 ;;
    arduino:armv7l) echo ARMv7 ;;
    *) return 1 ;;
  esac
}

# --- Node --------------------------------------------------------------------------------------

node_ok() {
  "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null
}

find_node() {
  local candidates=("$TOOLS/node/bin/node")
  if [ -z "${WOKWI_SETUP_FORCE_DOWNLOAD:-}" ]; then
    candidates+=("$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node)
    # nvm installs aren't on PATH outside an interactive shell; prefer the newest.
    while IFS= read -r c; do candidates+=("$c"); done < <(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r)
  fi
  for c in "${candidates[@]}"; do
    if [ -n "$c" ] && [ -x "$c" ] && node_ok "$c"; then echo "$c"; return 0; fi
  done
  return 1
}

install_node() {
  local os arch base file tmp
  os="$([ "$OS" = Darwin ] && echo darwin || echo linux)"
  arch="$(cpu node)" || die "there's no Node $NODE_MAJOR download for this CPU ($ARCH); install Node 18+ yourself"
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp="$(mktemp -d)"
  download "$base/SHASUMS256.txt" "$tmp/sums"
  file="$(grep -oE "node-v[0-9.]+-$os-$arch\.tar\.gz" "$tmp/sums" | head -1)"
  [ -n "$file" ] || die "couldn't find a Node $NODE_MAJOR download for $os-$arch"
  download "$base/$file" "$tmp/$file"
  verify "$tmp/sums" "$file" "$tmp/$file"
  rm -rf "$TOOLS/node"
  mkdir -p "$TOOLS/node"
  tar -xzf "$tmp/$file" -C "$TOOLS/node" --strip-components 1
  rm -rf "$tmp"
}

# --- arduino-cli -------------------------------------------------------------------------------

find_arduino_cli() {
  local candidates=("$TOOLS/bin/arduino-cli")
  if [ -z "${WOKWI_SETUP_FORCE_DOWNLOAD:-}" ]; then
    candidates+=("$(command -v arduino-cli || true)" /opt/homebrew/bin/arduino-cli /usr/local/bin/arduino-cli "$HOME/.local/bin/arduino-cli")
  fi
  for c in "${candidates[@]}"; do
    if [ -n "$c" ] && [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

install_arduino_cli() {
  local tag ver os arch file base tmp
  arch="$(cpu arduino)" || die "there's no arduino-cli download for this CPU ($ARCH)"
  # The "latest" release page redirects to the newest tag.
  tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/arduino/arduino-cli/releases/latest)"
  tag="${tag##*/}"
  ver="${tag#v}"
  [ -n "$ver" ] || die "couldn't find the latest arduino-cli release"
  os="$([ "$OS" = Darwin ] && echo macOS || echo Linux)"
  file="arduino-cli_${ver}_${os}_${arch}.tar.gz"
  base="https://github.com/arduino/arduino-cli/releases/download/$tag"
  tmp="$(mktemp -d)"
  download "$base/$ver-checksums.txt" "$tmp/sums"
  download "$base/$file" "$tmp/$file"
  verify "$tmp/sums" "$file" "$tmp/$file"
  mkdir -p "$TOOLS/bin"
  tar -xzf "$tmp/$file" -C "$TOOLS/bin" arduino-cli
  rm -rf "$tmp"
}

# --- Login service -----------------------------------------------------------------------------

server_up() {
  curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
}

wait_for_server() {
  for _ in $(seq 1 50); do
    server_up && return 0
    sleep 0.2
  done
  return 1
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

stop_service() {
  if [ "$OS" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  elif systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now wokwi-local.service 2>/dev/null || true
  fi
  # A server started by the autostart fallback (or by an earlier run of this script).
  pkill -f "$ROOT/server.js" 2>/dev/null || true
  sleep 0.5
}

start_in_background() {
  nohup "${CMD[@]}" >/dev/null 2>&1 &
}

install_service() {
  mkdir -p "$(dirname "$LOG")" "$(dirname "$SERVICE_FILE")"
  if [ "$OS" = Darwin ]; then
    {
      echo '<?xml version="1.0" encoding="UTF-8"?>'
      echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
      echo '<plist version="1.0"><dict>'
      echo "  <key>Label</key><string>$LABEL</string>"
      echo '  <key>ProgramArguments</key><array>'
      for arg in "${CMD[@]}"; do echo "    <string>$(xml_escape "$arg")</string>"; done
      echo '  </array>'
      echo "  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>"
      echo '  <key>RunAtLoad</key><true/>'
      echo '  <key>KeepAlive</key><true/>'
      echo "  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>"
      echo '</dict></plist>'
    } >"$SERVICE_FILE"
    launchctl bootstrap "gui/$(id -u)" "$SERVICE_FILE" || {
      warn "launchd refused the login item; starting the server just for this session"
      start_in_background
    }
  elif systemctl --user show-environment >/dev/null 2>&1; then
    local exec=""
    for arg in "${CMD[@]}"; do exec+=" \"${arg//\"/\\\"}\""; done
    cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=wokwi-local compile server for wokwi.com

[Service]
ExecStart=${exec# }
WorkingDirectory=$ROOT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now wokwi-local.service
  else
    # No systemd user session (e.g. WSL or some containers): use the desktop's autostart instead.
    SERVICE_FILE="$AUTOSTART_FILE"
    mkdir -p "$(dirname "$SERVICE_FILE")"
    local exec=""
    for arg in "${CMD[@]}"; do exec+=" \"${arg//\"/\\\"}\""; done
    cat >"$SERVICE_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=wokwi-local
Comment=Compile server for wokwi.com
Exec=${exec# }
Path=$ROOT
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
    start_in_background
  fi
}

# --- Main --------------------------------------------------------------------------------------

if [ "$UNINSTALL" = 1 ]; then
  say "Removing the wokwi-local login service"
  stop_service
  rm -f "$SERVICE_FILE" "${AUTOSTART_FILE:-}"
  [ "$OS" = Linux ] && systemctl --user daemon-reload 2>/dev/null || true
  echo "Done. The server is stopped and won't start at login."
  echo "Downloaded tools (if any) are in $TOOLS, and board cores in arduino-cli's data folder"
  echo "(arduino-cli config get directories.data). Delete them yourself if you no longer need them."
  exit 0
fi

say "Checking Node.js"
if NODE="$(find_node)"; then
  echo "Using $NODE ($("$NODE" --version))"
else
  echo "Node 18+ not found; downloading Node $NODE_MAJOR into $TOOLS/node"
  install_node
  NODE="$TOOLS/node/bin/node"
  echo "Installed $("$NODE" --version)"
fi

say "Checking arduino-cli"
if CLI="$(find_arduino_cli)"; then
  echo "Using $CLI"
else
  echo "arduino-cli not found; downloading it into $TOOLS/bin"
  install_arduino_cli
  CLI="$TOOLS/bin/arduino-cli"
fi
"$CLI" version

if [ "$OS" = Darwin ] && [ "$ARCH" = arm64 ]; then
  say "Checking Rosetta (needed for some Intel-only Arduino tools)"
  if arch -x86_64 /usr/bin/true 2>/dev/null; then
    echo "Rosetta is installed"
  elif [ "$YES" = 1 ]; then
    softwareupdate --install-rosetta --agree-to-license || die "Rosetta install failed; try: sudo softwareupdate --install-rosetta"
  else
    echo "Installing Rosetta. Apple will ask you to accept its license."
    softwareupdate --install-rosetta || die "Rosetta install failed; try: sudo softwareupdate --install-rosetta"
  fi
fi

if [ -n "$PRELOAD" ]; then
  say "Downloading board cores: $PRELOAD"
  CORES=""
  for board in ${PRELOAD//,/ }; do
    case "$board" in
      uno | mega | nano) CORES+=",arduino:avr" ;;
      pico | pipico) CORES+=",rp2040:rp2040" ;;
      esp32*) CORES+=",esp32:esp32" ;;
      attiny85) CORES+=",ATTinyCore:avr" ;;
      *) die "unknown board \"$board\" for --preload (use uno, mega, nano, pico, esp32 or attiny85)" ;;
    esac
  done
  "$NODE" "$ROOT/server.js" --arduino-cli "$CLI" --install-cores "${CORES#,}"
fi

say "Starting the server now and at every login"
CMD=("$NODE" "$ROOT/server.js" --arduino-cli "$CLI" --log "$LOG")
stop_service
PORT_TAKEN=0
server_up && PORT_TAKEN=1
install_service
if [ "$PORT_TAKEN" = 1 ]; then
  warn "another wokwi-local is already using port $PORT (maybe one you started by hand)."
  warn "Stop it, and the login service takes over within 10 seconds."
elif wait_for_server; then
  echo "Server is running on http://127.0.0.1:$PORT"
else
  warn "the server didn't answer yet. Its log is $LOG"
fi
echo "Login item: $SERVICE_FILE"

say "Load the browser extension (one time)"
EXT="$ROOT/extension"
PASTE_KEY="$([ "$OS" = Darwin ] && echo Cmd+Shift+G || echo Ctrl+L)"
cat <<EOF
Browsers only let you add an unpacked extension by hand:
  1. In Chrome (or Edge, Brave, Arc), open chrome://extensions
  2. Turn on "Developer mode" (top right)
  3. Click "Load unpacked" and choose this folder:
       $EXT
     In the folder picker, press $PASTE_KEY and paste the path.
  4. On wokwi.com, press play. If Chrome asks to access devices on your local network, click Allow.
EOF
if [ "$BROWSER" = 1 ]; then
  if command -v pbcopy >/dev/null; then printf '%s' "$EXT" | pbcopy && echo "(The folder path is on your clipboard.)"
  elif command -v wl-copy >/dev/null; then printf '%s' "$EXT" | wl-copy && echo "(The folder path is on your clipboard.)"
  elif command -v xclip >/dev/null; then printf '%s' "$EXT" | xclip -selection clipboard && echo "(The folder path is on your clipboard.)"
  fi
  if [ "$OS" = Darwin ]; then
    open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
  else
    for browser in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
      if command -v "$browser" >/dev/null; then
        "$browser" "chrome://extensions" >/dev/null 2>&1 &
        break
      fi
    done
  fi
fi

say "Done"
echo "Builds now compile locally whenever this computer is on. Each one is logged in:"
echo "  $LOG"
echo "If you move this folder, run ./setup.sh again so the login item points at the new place."
