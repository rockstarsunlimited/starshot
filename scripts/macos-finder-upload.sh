#!/bin/sh
set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SESSION_ENV="${STARSHOT_FINDER_SESSION_ENV:-${TMPDIR:-/tmp}/starshot-finder.env}"

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

resolve_profile_value() {
  key="$1"
  if [ ! -f .varlock/profiles/starshot.env ]; then
    return 1
  fi
  if [ -x node_modules/.bin/varlock ]; then
    node_modules/.bin/varlock printenv -p .env.schema -p .varlock/profiles/starshot.env "$key"
  elif command -v varlock >/dev/null 2>&1; then
    varlock printenv -p .env.schema -p .varlock/profiles/starshot.env "$key"
  elif command -v bunx >/dev/null 2>&1; then
    bunx varlock printenv -p .env.schema -p .varlock/profiles/starshot.env "$key"
  else
    return 1
  fi
}

notify() {
  message="$1"
  if ! osascript -e "display notification \"$message\" with title \"Starshot\"" >/dev/null 2>&1; then
    echo "Warning: macOS notification failed: $message" >&2
  fi
}

load_session_env() {
  if [ "${STARSHOT_FINDER_SESSION_CACHE:-0}" != "1" ]; then
    return 0
  fi
  if [ -f "$SESSION_ENV" ]; then
    # shellcheck disable=SC1090
    . "$SESSION_ENV"
  fi
}

save_session_env() {
  if [ "${STARSHOT_FINDER_SESSION_CACHE:-0}" != "1" ]; then
    return 0
  fi
  if [ -z "${STARSHOT_UPLOAD_URL:-}" ]; then
    return 0
  fi
  if [ -z "${AUTH_TOKEN:-}" ] && [ -z "${STARSHOT_AUTH_TOKEN:-}" ]; then
    return 0
  fi

  mkdir -p "$(dirname "$SESSION_ENV")"
  tmp_file="$SESSION_ENV.tmp.$$"
  {
    printf 'export STARSHOT_UPLOAD_URL=%s\n' "$(shell_quote "$STARSHOT_UPLOAD_URL")"
    if [ -n "${STARSHOT_AUTH_TOKEN:-}" ]; then
      printf 'export STARSHOT_AUTH_TOKEN=%s\n' "$(shell_quote "$STARSHOT_AUTH_TOKEN")"
    else
      printf 'export AUTH_TOKEN=%s\n' "$(shell_quote "$AUTH_TOKEN")"
    fi
  } > "$tmp_file"
  chmod 600 "$tmp_file"
  mv "$tmp_file" "$SESSION_ENV"
}

if [ "$#" -lt 1 ]; then
  notify "No file selected."
  exit 1
fi

load_session_env

if [ -z "${STARSHOT_UPLOAD_URL:-}" ]; then
  STARSHOT_UPLOAD_URL="$(resolve_profile_value STARSHOT_UPLOAD_URL || true)"
  export STARSHOT_UPLOAD_URL
fi

if [ -z "${AUTH_TOKEN:-}" ] && [ -z "${STARSHOT_AUTH_TOKEN:-}" ]; then
  AUTH_TOKEN="$(resolve_profile_value AUTH_TOKEN || true)"
  export AUTH_TOKEN
fi

if [ -z "${STARSHOT_UPLOAD_URL:-}" ]; then
  echo "STARSHOT_UPLOAD_URL is not configured." >&2
  notify "Upload failed: missing STARSHOT_UPLOAD_URL."
  exit 1
fi

if [ -z "${AUTH_TOKEN:-}" ] && [ -z "${STARSHOT_AUTH_TOKEN:-}" ]; then
  echo "AUTH_TOKEN or STARSHOT_AUTH_TOKEN is not configured." >&2
  notify "Upload failed: missing AUTH_TOKEN."
  exit 1
fi

save_session_env

last_url=""
for file in "$@"; do
  url="$(cargo run --quiet -- upload-file "$file" --scope humans)"
  last_url="$url"
done

if [ -n "$last_url" ]; then
  if printf '%s' "$last_url" | pbcopy; then
    notify "Copied screenshot URL to clipboard."
  else
    echo "Warning: pbcopy failed; URL was not copied." >&2
    notify "Upload complete, but clipboard copy failed."
  fi
  printf '%s\n' "$last_url"
fi
