#!/bin/sh

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
  message="$1"
  title="${2:-Starshot}"
  if [ "${STARSHOT_NOTIFY:-1}" != "1" ]; then
    return 0
  fi
  /usr/bin/osascript -e "display notification \"$message\" with title \"$title\"" >/dev/null 2>&1 || true
}

starshot_json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

starshot_enqueue_upload() {
  file="$1"
  content_type="$2"
  scope="$3"
  reason="$4"
  queue_dir="$(starshot_queue_dir)"
  blob_dir="$(starshot_blob_dir)"
  mkdir -p "$queue_dir" "$blob_dir"

  id="$(date -u '+%Y%m%dT%H%M%S')_$RANDOM"
  ext="${file##*.}"
  blob="$blob_dir/$id.$ext"
  item="$queue_dir/$id.json"
  tmp_item="$queue_dir/$id.json.tmp"

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
