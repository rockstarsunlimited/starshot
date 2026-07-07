#!/bin/zsh

starshot_state_dir() {
  printf '%s\n' "${STARSHOT_STATE_DIR:-$HOME/Library/Application Support/Starshot}"
}

starshot_queue_dir() {
  printf '%s\n' "$(starshot_state_dir)/queue"
}

starshot_blob_dir() {
  printf '%s\n' "$(starshot_state_dir)/blobs"
}

starshot_log_dir() {
  printf '%s\n' "$(starshot_state_dir)/logs"
}

starshot_notify() {
  local message="$1"
  local title="${2:-Starshot}"
  if [[ "${STARSHOT_NOTIFY:-1}" != "1" ]]; then
    return 0
  fi
  /usr/bin/osascript -e "display notification $(printf '%q' "$message") with title $(printf '%q' "$title")" >/dev/null 2>&1 || true
}

starshot_json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

starshot_enqueue_upload() {
  local file="$1"
  local content_type="$2"
  local scope="$3"
  local reason="$4"
  local queue_dir
  queue_dir="$(starshot_queue_dir)"
  local blob_dir
  blob_dir="$(starshot_blob_dir)"
  mkdir -p "$queue_dir" "$blob_dir"

  local id
  id="$(date -u '+%Y%m%dT%H%M%S')_$RANDOM"
  local ext="${file:e}"
  local blob="$blob_dir/$id.$ext"
  local item="$queue_dir/$id.json"
  local tmp_item="$queue_dir/$id.json.tmp"

  cp "$file" "$blob"
  xattr -c "$blob" 2>/dev/null || true

  cat > "$tmp_item" <<JSON
{
  "file": "$(starshot_json_escape "$blob")",
  "source_file": "$(starshot_json_escape "$file")",
  "content_type": "$(starshot_json_escape "$content_type")",
  "scope": "$(starshot_json_escape "$scope")",
  "queued_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "reason": "$(starshot_json_escape "$reason")"
}
JSON
  mv "$tmp_item" "$item"

  starshot_notify "Upload queued. Public URL will be available after sync." "Starshot offline"
  echo "Queued upload: $item" >&2
}
