#!/bin/zsh
set -euo pipefail

LABEL="co.rockstarsunlimited.starshot"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_PATH="${BUN_PATH:-$(command -v bun)}"
SCREENSHOT_DIR="${SCREENSHOT_DIR:-$HOME/Desktop}"
UID_VALUE="$(id -u)"

if [[ -z "$BUN_PATH" ]]; then
  echo "bun was not found in PATH. Install Bun or set BUN_PATH=/absolute/path/to/bun." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

COMMAND='cd "'$REPO_DIR'" && "'$BUN_PATH'" run upload'
ESCAPED_COMMAND="$(xml_escape "$COMMAND")"
ESCAPED_SCREENSHOT_DIR="$(xml_escape "$SCREENSHOT_DIR")"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>$ESCAPED_COMMAND</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>$ESCAPED_SCREENSHOT_DIR</string>
  </array>
  <key>StandardOutPath</key>
  <string>/tmp/$LABEL.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/$LABEL.err</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST_PATH" >/dev/null

if [[ "${STARSHOT_INSTALL_DRY_RUN:-}" == "1" ]]; then
  echo "Dry run wrote $PLIST_PATH"
  exit 0
fi

launchctl bootout "gui/$UID_VALUE/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_VALUE" "$PLIST_PATH"
launchctl enable "gui/$UID_VALUE/$LABEL"

echo "Installed and loaded $LABEL"
echo "$PLIST_PATH"
