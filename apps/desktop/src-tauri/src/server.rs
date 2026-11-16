//! Authenticated loopback HTTP + RPC transport for the native Readora desktop shell.
//!
//! Security properties:
//! - Binds strictly to `127.0.0.1:0` (ephemeral OS-assigned port).
//! - Validates `Host: 127.0.0.1:<port>` on every request to defeat DNS rebinding.
//! - Enforces `POST` + matching `Origin` + `Sec-Fetch-Site` + constant-time `X-Readora-Token`
//!   validation before reading request bodies or executing any RPC/import/update operation.
//! - Attaches strict `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and
//!   `X-Frame-Options: DENY` headers to static UI responses.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::commands::{CommandErrorDto, DesktopCommandHandler};

/// Maximum HTTP request header size (`16 KiB`).
pub const MAX_HEADER_BYTES: usize = 16 * 1024;
/// Maximum JSON RPC body size (`2 MiB`).
pub const MAX_RPC_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Maximum authenticated PDF import body size (`512 MiB`).
pub const MAX_IMPORT_PDF_BYTES: usize = 512 * 1024 * 1024;

/// Strict Content-Security-Policy served on UI HTML documents.
pub const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self' 'unsafe-inline' blob:; ",
    "worker-src 'self' blob:; ",
    "connect-src 'self' https://api.github.com https://github.com; ",
    "img-src 'self' data: blob:; ",
    "style-src 'self' 'unsafe-inline'; ",
    "font-src 'self' data:; ",
    "object-src 'none'; ",
    "base-uri 'self'; ",
    "frame-ancestors 'none'"
);

/// Generates a 256-bit OS CSPRNG hexadecimal session token.
#[must_use]
pub fn generate_session_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Compares two ASCII token strings in constant time with respect to their contents.
#[must_use]
pub fn constant_time_eq(left: &str, right: &str) -> bool {
    let a = left.as_bytes();
    let b = right.as_bytes();
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0_u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Parsed HTTP request metadata and body.
#[derive(Debug, Clone)]
pub struct ParsedHttpRequest {
    /// Uppercase HTTP method (`GET`, `POST`, etc.).
    pub method: String,
    /// Raw request path/query target.
    pub target: String,
    /// Lowercased header key-value pairs.
    pub headers: Vec<(String, String)>,
    /// Validated request body bytes.
    pub body: Vec<u8>,
}

impl ParsedHttpRequest {
    /// Looks up a lowercased HTTP header value.
    #[must_use]
    pub fn header(&self, lower_name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == lower_name)
            .map(|(_, v)| v.as_str())
    }
}

/// Serialized HTTP response ready to write to a client stream.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    /// HTTP status code and reason phrase (e.g. `"200 OK"`, `"403 Forbidden"`).
    pub status: &'static str,
    /// MIME `Content-Type` value.
    pub content_type: &'static str,
    /// Include `Content-Security-Policy` header on this response.
    pub include_csp: bool,
    /// Response body payload.
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// Builds a JSON response with `no-store` cache control.
    #[must_use]
    pub fn json(status: &'static str, payload: &Value) -> Self {
        let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            include_csp: false,
            body,
        }
    }

    /// Builds a JSON response from a pre-serialized JSON string.
    #[must_use]
    pub fn raw_json(status: &'static str, raw: &str) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            include_csp: false,
            body: raw.as_bytes().to_vec(),
        }
    }

    /// Writes the complete HTTP/1.1 response to `writer`.
    pub fn write_to<W: Write>(&self, writer: &mut W) {
        let csp_line = if self.include_csp {
            format!("Content-Security-Policy: {CONTENT_SECURITY_POLICY}\r\n")
        } else {
            String::new()
        };
        let header = format!(
            "HTTP/1.1 {status}\r\n\
             Content-Type: {ct}\r\n\
             Content-Length: {len}\r\n\
             Cache-Control: no-store\r\n\
             X-Content-Type-Options: nosniff\r\n\
             X-Frame-Options: DENY\r\n\
             {csp_line}\
             Connection: close\r\n\r\n",
            status = self.status,
            ct = self.content_type,
            len = self.body.len(),
        );
        let _ = writer.write_all(header.as_bytes());
        let _ = writer.write_all(&self.body);
    }
}

/// Checks whether the `Host` header strictly matches `127.0.0.1:<bound_port>` (preventing DNS rebinding).
#[must_use]
pub fn is_allowed_host(headers: &[(String, String)], bound_port: u16) -> bool {
    let expected = format!("127.0.0.1:{bound_port}");
    headers
        .iter()
        .find(|(k, _)| k == "host")
        .is_some_and(|(_, v)| v.trim() == expected)
}

/// Validates that an incoming API request carries the expected `Host`, `POST` method,
/// same-origin `Origin` / `Sec-Fetch-Site` headers, and per-launch `X-Readora-Token`.
pub fn validate_api_headers(
    method: &str,
    headers: &[(String, String)],
    bound_port: u16,
    expected_token: &str,
) -> Result<(), HttpResponse> {
    if !is_allowed_host(headers, bound_port) {
        return Err(HttpResponse::json(
            "403 Forbidden",
            &json!({ "ok": false, "error": { "code": "forbidden_host", "message": "Invalid Host header" } }),
        ));
    }

    if method != "POST" {
        return Err(HttpResponse::json(
            "405 Method Not Allowed",
            &json!({ "ok": false, "error": { "code": "method_not_allowed", "message": "POST required" } }),
        ));
    }

    let expected_origin = format!("http://127.0.0.1:{bound_port}");
    let origin_ok = headers
        .iter()
        .find(|(k, _)| k == "origin")
        .is_some_and(|(_, v)| v.trim() == expected_origin);
    if !origin_ok {
        return Err(HttpResponse::json(
            "403 Forbidden",
            &json!({ "ok": false, "error": { "code": "forbidden_origin", "message": "Cross-origin request denied" } }),
        ));
    }

    if let Some((_, fetch_site)) = headers.iter().find(|(k, _)| k == "sec-fetch-site")
        && fetch_site.trim() != "same-origin"
    {
        return Err(HttpResponse::json(
            "403 Forbidden",
            &json!({ "ok": false, "error": { "code": "forbidden_fetch_site", "message": "Cross-site fetch denied" } }),
        ));
    }

    let supplied_token = headers
        .iter()
        .find(|(k, _)| k == "x-readora-token")
        .map_or("", |(_, v)| v.trim());
    if !constant_time_eq(supplied_token, expected_token) {
        return Err(HttpResponse::json(
            "403 Forbidden",
            &json!({ "ok": false, "error": { "code": "unauthorized", "message": "Invalid session token" } }),
        ));
    }

    Ok(())
}

/// Reads and validates an HTTP/1.1 request from `reader`, checking `Host` and API authentication
/// headers **before** allocating or reading multi-megabyte request bodies.
pub fn read_and_authorize_http_request<R: Read>(
    reader: &mut R,
    bound_port: u16,
    expected_token: &str,
) -> Result<Option<ParsedHttpRequest>, HttpResponse> {
    let mut header_buf = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let Ok(n) = reader.read(&mut chunk) else {
            return Ok(None);
        };
        if n == 0 {
            if header_buf.is_empty() {
                return Ok(None);
            }
            break header_buf.len();
        }
        header_buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = header_buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if header_buf.len() > MAX_HEADER_BYTES {
            return Err(HttpResponse::json(
                "431 Request Header Fields Too Large",
                &json!({ "ok": false, "error": { "code": "headers_too_large", "message": "Request headers exceed limit" } }),
            ));
        }
    };

    let header_str = String::from_utf8_lossy(&header_buf[..header_end]);
    let mut lines = header_str.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let Some(raw_method) = parts.next() else {
        return Ok(None);
    };
    let method = raw_method.to_ascii_uppercase();
    let target = parts.next().unwrap_or("/").to_owned();

    let mut headers = Vec::new();
    let mut content_length = 0_usize;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_owned();
            if key == "content-length"
                && let Ok(parsed) = val.parse::<usize>()
            {
                content_length = parsed;
            }
            headers.push((key, val));
        }
    }

    let is_api_route = target.starts_with("/__readora_");
    if is_api_route {
        validate_api_headers(&method, &headers, bound_port, expected_token)?;
    } else if !is_allowed_host(&headers, bound_port) {
        return Err(HttpResponse::json(
            "403 Forbidden",
            &json!({ "ok": false, "error": { "code": "forbidden_host", "message": "Invalid Host header" } }),
        ));
    }

    let max_body = if target == "/__readora_import" {
        MAX_IMPORT_PDF_BYTES
    } else if is_api_route {
        MAX_RPC_BODY_BYTES
    } else {
        0
    };

    if content_length > max_body {
        return Err(HttpResponse::json(
            "413 Payload Too Large",
            &json!({ "ok": false, "error": { "code": "payload_too_large", "message": "Request payload exceeds maximum allowed size" } }),
        ));
    }

    let mut body = Vec::with_capacity(content_length.min(64 * 1024));
    if header_buf.len() > header_end {
        let already = &header_buf[header_end..];
        let to_copy = already.len().min(content_length);
        body.extend_from_slice(&already[..to_copy]);
    }
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let read_limit = remaining.min(chunk.len());
        let Ok(n) = reader.read(&mut chunk[..read_limit]) else {
            break;
        };
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    Ok(Some(ParsedHttpRequest {
        method,
        target,
        headers,
        body,
    }))
}

#[derive(Deserialize)]
struct RpcRequestEnvelope {
    cmd: String,
    #[serde(default)]
    args: Value,
}

#[derive(Deserialize)]
struct ReadPdfPayload {
    #[serde(rename = "documentId")]
    document_id: String,
}

#[derive(Deserialize)]
struct UpdatePayload {
    version: String,
}

/// Routes a validated `ParsedHttpRequest` to `DesktopCommandHandler` or static UI asset resolution.
pub fn route_http_request<F>(
    req: ParsedHttpRequest,
    ui_root: &Path,
    handler: &DesktopCommandHandler,
    update_runner: F,
) -> HttpResponse
where
    F: FnOnce(&DesktopCommandHandler, &str) -> &'static str,
{
    let path_only = req.target.split('?').next().unwrap_or("/");

    match path_only {
        "/__readora_rpc" => {
            let parsed: Result<RpcRequestEnvelope, _> = serde_json::from_slice(&req.body);
            let Ok(envelope) = parsed else {
                return error_response(
                    "400 Bad Request",
                    CommandErrorDto {
                        code: "validation_error".to_owned(),
                        message: "Malformed JSON RPC envelope".to_owned(),
                    },
                );
            };
            match handler.dispatch_rpc(&envelope.cmd, envelope.args) {
                Ok(data) => HttpResponse::json("200 OK", &json!({ "ok": true, "data": data })),
                Err(err) => error_response("400 Bad Request", err),
            }
        }
        "/__readora_import" => {
            let raw_name = req.header("x-readora-filename").unwrap_or("Document.pdf");
            let file_name = percent_decode_utf8(raw_name);
            let password = req
                .header("x-readora-password")
                .map(percent_decode_utf8)
                .filter(|pw| !pw.is_empty());

            match handler.document_import_bytes(&file_name, &req.body, password) {
                Ok(session) => {
                    HttpResponse::json("200 OK", &json!({ "ok": true, "data": session }))
                }
                Err(err) => error_response("400 Bad Request", err),
            }
        }
        "/__readora_pdf_read" => {
            let Ok(payload) = serde_json::from_slice::<ReadPdfPayload>(&req.body) else {
                return error_response(
                    "400 Bad Request",
                    CommandErrorDto {
                        code: "validation_error".to_owned(),
                        message: "Missing documentId".to_owned(),
                    },
                );
            };
            match handler.document_read_bytes(&payload.document_id) {
                Ok(bytes) => HttpResponse {
                    status: "200 OK",
                    content_type: "application/pdf",
                    include_csp: false,
                    body: bytes,
                },
                Err(err) => error_response("404 Not Found", err),
            }
        }
        "/__readora_update" => {
            let Ok(payload) = serde_json::from_slice::<UpdatePayload>(&req.body) else {
                return HttpResponse::raw_json(
                    "400 Bad Request",
                    r#"{"status":"invalid_parameters"}"#,
                );
            };
            let result_json = update_runner(handler, payload.version.trim());
            HttpResponse::raw_json("200 OK", result_json)
        }
        _ if path_only.starts_with("/__readora_") => HttpResponse::json(
            "404 Not Found",
            &json!({ "ok": false, "error": { "code": "not_found", "message": "Unknown endpoint" } }),
        ),
        _ => {
            if req.method != "GET" && req.method != "HEAD" {
                return HttpResponse::json(
                    "405 Method Not Allowed",
                    &json!({ "ok": false, "error": { "code": "method_not_allowed", "message": "Static assets only support GET/HEAD" } }),
                );
            }
            serve_static_ui_asset(ui_root, path_only, req.method == "HEAD")
        }
    }
}

fn error_response(status: &'static str, err: CommandErrorDto) -> HttpResponse {
    HttpResponse::json(status, &json!({ "ok": false, "error": err }))
}

fn serve_static_ui_asset(ui_root: &Path, raw_path: &str, head_only: bool) -> HttpResponse {
    let rel_path = sanitize_relative_path(raw_path);
    let full_path = ui_root.join(&rel_path);
    let resolved_path = if full_path.is_file() {
        full_path
    } else {
        ui_root.join("index.html")
    };

    match std::fs::read(&resolved_path) {
        Ok(body) => {
            let mime = content_type_for_path(&resolved_path);
            let is_html = mime.starts_with("text/html");
            HttpResponse {
                status: "200 OK",
                content_type: mime,
                include_csp: is_html,
                body: if head_only { Vec::new() } else { body },
            }
        }
        Err(_) => HttpResponse {
            status: "404 Not Found",
            content_type: "text/plain; charset=utf-8",
            include_csp: true,
            body: if head_only {
                Vec::new()
            } else {
                b"404 Not Found".to_vec()
            },
        },
    }
}

/// Sanitizes a URL path into normal relative path segments without traversal (`..`).
#[must_use]
pub fn sanitize_relative_path(raw_target: &str) -> PathBuf {
    let without_query = raw_target.split('?').next().unwrap_or("/");
    let trimmed = without_query.trim_start_matches('/');
    if trimmed.is_empty() {
        return PathBuf::from("index.html");
    }

    let mut clean = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        if let Component::Normal(segment) = comp {
            clean.push(segment);
        }
    }
    if clean.as_os_str().is_empty() {
        PathBuf::from("index.html")
    } else {
        clean
    }
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "json" => "application/json; charset=utf-8",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Percent-decodes an ASCII URI component into a UTF-8 string.
#[must_use]
pub fn percent_decode_utf8(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

const fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
