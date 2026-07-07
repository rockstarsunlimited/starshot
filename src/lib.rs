#![forbid(unsafe_code)]
#![deny(clippy::panic, clippy::unwrap_used, clippy::expect_used)]

use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use worker::*;

const DEFAULT_MAX_UPLOAD_BYTES: u64 = 26_214_400;
const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

#[derive(Serialize)]
struct UploadResponse {
    url: String,
    key: String,
}

#[derive(Serialize)]
struct ListItem {
    key: String,
    url: String,
    timestamp: String,
}

#[derive(Serialize)]
struct ListResponse {
    items: Vec<ListItem>,
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    match (req.method(), req.path().as_str()) {
        (Method::Post, "/upload") => handle_upload(&mut req, env).await,
        (Method::Get, "/api/list") => handle_list(&req, env).await,
        (Method::Get, "/upload") => method_not_allowed("POST"),
        (Method::Get, path) if path != "/" => handle_get(path.trim_start_matches('/'), env).await,
        (Method::Get, _) => not_found(),
        (Method::Post, _) => not_found(),
        _ => method_not_allowed("GET, POST"),
    }
}

async fn handle_list(req: &Request, env: Env) -> Result<Response> {
    let auth_token = env.secret("AUTH_TOKEN")?.to_string();
    if !authorized(req, &auth_token)? {
        return text_response("unauthorized", 401);
    }

    let url = req.url()?;
    let scope = match url
        .query_pairs()
        .find(|(key, _)| key == "scope")
        .map(|(_, value)| value.to_string())
        .unwrap_or_else(|| "humans".to_string())
        .as_str()
    {
        "agents" => "agents",
        "humans" => "humans",
        _ => return text_response("invalid scope", 400),
    };
    let limit = url
        .query_pairs()
        .find(|(key, _)| key == "limit")
        .and_then(|(_, value)| value.parse::<u32>().ok())
        .unwrap_or(50)
        .clamp(1, 1000);
    let since = url
        .query_pairs()
        .find(|(key, _)| key == "since")
        .map(|(_, value)| value.to_string());
    let public_base_url = public_base_url(&env);
    let bucket = env.bucket("SCREENSHOTS")?;
    let objects = bucket
        .list()
        .prefix(format!("{scope}/"))
        .limit(1000)
        .execute()
        .await?;

    let mut items = objects
        .objects()
        .into_iter()
        .filter_map(|object| {
            let key = object.key();
            let timestamp = timestamp_from_key(&key)?;
            Some(ListItem {
                url: format!("{public_base_url}/{key}"),
                key,
                timestamp,
            })
        })
        .filter(|item| {
            since
                .as_deref()
                .is_none_or(|since| item.timestamp.as_str() >= since)
        })
        .collect::<Vec<_>>();

    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    items.truncate(limit as usize);

    Response::from_json(&ListResponse { items })
}

async fn handle_upload(req: &mut Request, env: Env) -> Result<Response> {
    let auth_token = env.secret("AUTH_TOKEN")?.to_string();
    if !authorized(req, &auth_token)? {
        return text_response("unauthorized", 401);
    }

    let content_length = match content_length(req) {
        Ok(Some(length)) => length,
        Ok(None) => return text_response("content-length required", 413),
        Err(_) => return text_response("invalid content-length", 413),
    };

    let max_upload_bytes = match max_upload_bytes(&env) {
        Ok(bytes) => bytes,
        Err(_) => return text_response("invalid max upload size", 500),
    };

    if content_length > max_upload_bytes {
        return text_response("upload too large", 413);
    }

    let content_type = match upload_content_type(req)? {
        Some(value) => value,
        None => return text_response("content-type required", 415),
    };

    let ext = match extension_for_content_type(content_type.as_str()) {
        Some(ext) => ext,
        None => return text_response("unsupported media type", 415),
    };

    let bytes = req.bytes().await?;
    if bytes.len() as u64 > max_upload_bytes {
        return text_response("upload too large", 413);
    }

    let scope = match upload_scope(req)? {
        Some(scope) => scope,
        None => return text_response("invalid upload scope", 400),
    };
    let key = object_key(&bytes, ext, scope);
    let bucket = env.bucket("SCREENSHOTS")?;
    let http_metadata = HttpMetadata {
        content_type: Some(content_type),
        cache_control: Some(CACHE_CONTROL.to_string()),
        ..Default::default()
    };

    bucket
        .put(key.clone(), bytes)
        .http_metadata(http_metadata)
        .execute()
        .await?;

    let public_base_url = public_base_url(&env);

    let body = UploadResponse {
        url: format!("{public_base_url}/{key}"),
        key,
    };

    Response::from_json(&body)
}

async fn handle_get(key: &str, env: Env) -> Result<Response> {
    if !valid_public_key(key) {
        return not_found();
    }

    let bucket = env.bucket("SCREENSHOTS")?;
    let Some(object) = bucket.get(key).execute().await? else {
        return not_found();
    };

    let Some(body) = object.body() else {
        return not_found();
    };

    let mut response = Response::from_body(body.response_body()?)?;
    let headers = response.headers_mut();
    object.write_http_metadata(headers.clone())?;
    headers.set("Cache-Control", CACHE_CONTROL)?;
    headers.set("ETag", &object.http_etag())?;
    headers.set("Content-Length", &object.size().to_string())?;
    Ok(response)
}

fn authorized(req: &Request, expected_token: &str) -> Result<bool> {
    let Some(header) = req.headers().get("Authorization")? else {
        return Ok(false);
    };

    let Some(token) = header.strip_prefix("Bearer ") else {
        return Ok(false);
    };

    if token.len() != expected_token.len() {
        return Ok(false);
    }

    Ok(token.as_bytes().ct_eq(expected_token.as_bytes()).into())
}

fn content_length(req: &Request) -> Result<Option<u64>> {
    req.headers()
        .get("Content-Length")?
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| Error::RustError("invalid content-length".to_string()))
        })
        .transpose()
}

fn upload_content_type(req: &Request) -> Result<Option<String>> {
    Ok(req.headers().get("Content-Type")?.and_then(|value| {
        value
            .split(';')
            .next()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
    }))
}

fn upload_scope(req: &Request) -> Result<Option<&'static str>> {
    match req.headers().get("X-Starshot-Scope")?.as_deref() {
        Some("agents") => Ok(Some("agents")),
        Some("humans") | None => Ok(Some("humans")),
        Some(_) => Ok(None),
    }
}

fn extension_for_content_type(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        _ => None,
    }
}

fn max_upload_bytes(env: &Env) -> std::result::Result<u64, std::num::ParseIntError> {
    match env.var("MAX_UPLOAD_BYTES") {
        Ok(value) => value.to_string().parse(),
        Err(_) => Ok(DEFAULT_MAX_UPLOAD_BYTES),
    }
}

fn public_base_url(env: &Env) -> String {
    env.var("PUBLIC_BASE_URL")
        .map(|value| value.to_string())
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string()
}

fn hash_suffix(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn object_key(bytes: &[u8], ext: &str, scope: &str) -> String {
    object_key_at(&js_sys::Date::new_0(), bytes, ext, scope)
}

fn object_key_at(now: &js_sys::Date, bytes: &[u8], ext: &str, scope: &str) -> String {
    let year = now.get_utc_full_year();
    let month = now.get_utc_month() + 1;
    let day = now.get_utc_date();
    let hour = now.get_utc_hours();
    let minute = now.get_utc_minutes();
    let second = now.get_utc_seconds();
    let millisecond = now.get_utc_milliseconds();
    let suffix = hash_suffix(bytes);

    format!(
        "{scope}/{year:04}/{month:02}/{day:02}/{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}-{millisecond:03}_{suffix}.{ext}"
    )
}

fn valid_public_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with('/')
        && !key.contains("..")
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
}

fn timestamp_from_key(key: &str) -> Option<String> {
    let filename = key.rsplit('/').next()?;
    let timestamp = filename.split('_').next()?;
    if timestamp.len() < 23 {
        return None;
    }

    let date = &timestamp[..10];
    let time = &timestamp[11..23];
    let formatted_time = time.replacen('-', ":", 2).replacen('-', ".", 1);
    Some(format!("{date} {formatted_time}"))
}

fn not_found() -> Result<Response> {
    text_response("not found", 404)
}

fn method_not_allowed(allow: &str) -> Result<Response> {
    let mut response = text_response("method not allowed", 405)?;
    response.headers_mut().set("Allow", allow)?;
    Ok(response)
}

fn text_response(message: &str, status: u16) -> Result<Response> {
    Response::error(message, status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_allowed_content_types_to_extensions() {
        assert_eq!(extension_for_content_type("image/png"), Some("png"));
        assert_eq!(extension_for_content_type("image/jpeg"), Some("jpg"));
        assert_eq!(extension_for_content_type("image/heic"), Some("heic"));
        assert_eq!(extension_for_content_type("image/heif"), Some("heif"));
        assert_eq!(extension_for_content_type("image/webp"), None);
    }

    #[test]
    fn validates_public_keys() {
        assert!(valid_public_key(
            "humans/2026/07/07/2026-07-07T12-00-00-000_abcdef123456.png"
        ));
        assert!(!valid_public_key(""));
        assert!(!valid_public_key("../secret"));
        assert!(!valid_public_key("2026/07/07/bad key.png"));
    }

    #[test]
    fn extracts_timestamp_from_scoped_key() {
        assert_eq!(
            timestamp_from_key("agents/2026/07/07/2026-07-07T12-34-56-789_abcdef123456.jpg"),
            Some("2026-07-07 12:34:56.789".to_string())
        );
    }
}
