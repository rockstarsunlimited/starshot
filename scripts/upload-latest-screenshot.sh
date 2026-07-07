#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/starshot-lib.sh"

: "${STARSHOT_UPLOAD_URL:?Set STARSHOT_UPLOAD_URL, for example https://your-domain.example/upload}"
STARSHOT_AUTH_TOKEN="${STARSHOT_AUTH_TOKEN:-${AUTH_TOKEN:-}}"
: "${STARSHOT_AUTH_TOKEN:?Set STARSHOT_AUTH_TOKEN or AUTH_TOKEN to the Worker bearer token}"

SCREENSHOT_DIR="${SCREENSHOT_DIR:-$HOME/Desktop}"
STARSHOT_UPLOAD_FORMAT="${STARSHOT_UPLOAD_FORMAT:-jpeg}"
STARSHOT_JPEG_QUALITY="${STARSHOT_JPEG_QUALITY:-75}"
STARSHOT_CLEANUP_DAYS="${STARSHOT_CLEANUP_DAYS:-7}"
STARSHOT_WORK_DIR="${STARSHOT_WORK_DIR:-$SCREENSHOT_DIR/.starshot-upload}"
LATEST_FILE="$(find "$SCREENSHOT_DIR" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.heic' -o -iname '*.heif' \) -print0 | xargs -0 ls -t 2>/dev/null | head -n 1)"

if [ -z "${LATEST_FILE}" ]; then
  echo "No screenshot image found in $SCREENSHOT_DIR" >&2
  exit 1
fi

mkdir -p "$STARSHOT_WORK_DIR"

UPLOAD_FILE="$LATEST_FILE"

UPLOAD_FORMAT="$(printf '%s' "$STARSHOT_UPLOAD_FORMAT" | tr '[:upper:]' '[:lower:]')"

case "$UPLOAD_FORMAT" in
  jpeg|jpg)
    STARSHOT_JPEG_QUALITY="$(printf '%s' "$STARSHOT_JPEG_QUALITY" | tr -cd '0-9')"
    if [ -z "$STARSHOT_JPEG_QUALITY" ] || [ "$STARSHOT_JPEG_QUALITY" -lt 1 ] || [ "$STARSHOT_JPEG_QUALITY" -gt 100 ]; then
      echo "STARSHOT_JPEG_QUALITY must be between 1 and 100" >&2
      exit 1
    fi
    base_name="$(basename "$LATEST_FILE")"
    UPLOAD_FILE="$STARSHOT_WORK_DIR/${base_name%.*}.jpg"
    sips -s format jpeg -s formatOptions "$STARSHOT_JPEG_QUALITY" "$LATEST_FILE" --out "$UPLOAD_FILE" >/dev/null
    xattr -c "$UPLOAD_FILE" 2>/dev/null || true
    ;;
  png)
    base_name="$(basename "$LATEST_FILE")"
    UPLOAD_FILE="$STARSHOT_WORK_DIR/${base_name%.*}.png"
    sips -s format png "$LATEST_FILE" --out "$UPLOAD_FILE" >/dev/null
    xattr -c "$UPLOAD_FILE" 2>/dev/null || true
    ;;
  original)
    ;;
  *)
    echo "STARSHOT_UPLOAD_FORMAT must be jpeg, png, or original" >&2
    exit 1
    ;;
esac

UPLOAD_FILE_LOWER="$(printf '%s' "$UPLOAD_FILE" | tr '[:upper:]' '[:lower:]')"
case "$UPLOAD_FILE_LOWER" in
  *.png) CONTENT_TYPE="image/png" ;;
  *.jpg|*.jpeg) CONTENT_TYPE="image/jpeg" ;;
  *.heic) CONTENT_TYPE="image/heic" ;;
  *.heif) CONTENT_TYPE="image/heif" ;;
  *) echo "Unsupported screenshot type: $LATEST_FILE" >&2; exit 1 ;;
esac

if [ "${STARSHOT_UPLOAD_DRY_RUN:-}" = "1" ]; then
  echo "Would upload: $UPLOAD_FILE"
  echo "Content-Type: $CONTENT_TYPE"
else
  if ! curl --fail --silent --show-error \
    --request POST "$STARSHOT_UPLOAD_URL" \
    --header "Authorization: Bearer $STARSHOT_AUTH_TOKEN" \
    --header "Content-Type: $CONTENT_TYPE" \
    --header "X-Starshot-Scope: humans" \
    --data-binary @"$UPLOAD_FILE"; then
    starshot_enqueue_upload "$UPLOAD_FILE" "$CONTENT_TYPE" "humans" "upload failed"
  fi
fi

if [ -n "$STARSHOT_CLEANUP_DAYS" ]; then
  STARSHOT_CLEANUP_DAYS="$(printf '%s' "$STARSHOT_CLEANUP_DAYS" | tr -cd '0-9')"
  if [ -n "$STARSHOT_CLEANUP_DAYS" ]; then
    find "$SCREENSHOT_DIR" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.heic' -o -iname '*.heif' \) -mtime +"$STARSHOT_CLEANUP_DAYS" -delete
    find "$STARSHOT_WORK_DIR" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) -mtime +"$STARSHOT_CLEANUP_DAYS" -delete
  fi
fi
