//! Authenticated loopback HTTP + RPC transport for the native Readora desktop shell.
//!
//! Security properties:
//! - Binds strictly to `127.0.0.1:0` (ephemeral OS-assigned port).
//! - Validates `Host: 127.0.0.1:<port>` on every request to defeat DNS rebinding.
//! - Rejects duplicate security-critical headers, `Transfer-Encoding`, unparseable
//!   `Content-Length`, incomplete headers, truncated bodies, and Slowloris trickles.
//! - Enforces `POST` + matching `Origin` + `Sec-Fetch-Site` + constant-time `X-Readora-Token`
//!   validation before reading request bodies or executing any RPC/import/update operation.
//! - Attaches strict `Content-Security-Policy` (without `script-src 'unsafe-inline'`),
//!   `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY` headers to static HTML and JS/Worker responses.

use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use app_application::{ExportAnnotationsBundleDto, ReleaseManifestDto};
use platform::NativePlatformAdapter;
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
/// Maximum fallback release manifest JSON size (`64 KiB`).
pub const MAX_RELEASE_MANIFEST_BYTES: usize = 64 * 1024;
/// Maximum GitHub Releases `/releases/latest` API JSON size (`512 KiB`).
pub const MAX_GITHUB_RELEASE_API_BYTES: usize = 512 * 1024;
/// Maximum duration allowed to finish receiving HTTP request headers (`3s`).
pub const MAX_HEADER_DURATION: Duration = Duration::from_secs(3);
/// Maximum total wall-clock duration allowed to read an HTTP request (`20s`).
pub const MAX_REQUEST_DURATION: Duration = Duration::from_secs(20);

/// Strict Content-Security-Policy served on UI HTML and JavaScript/Web Worker responses.
pub const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self' blob:; ",
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

/// Validates whether `raw_url` is an allowed WebView navigation target.
///
/// Must start with `"http://"` (rejecting `about:blank`, `javascript:`, `data:`, `https://`, etc.),
/// must not contain `@` in the authority (blocking `http://127.0.0.1:port@attacker.example/`),
/// and must match `127.0.0.1:<bound_port>` exactly (blocking port-prefix collisions such as `5432` vs `54321`).
#[must_use]
pub fn is_allowed_navigation_url(raw_url: &str, bound_port: u16) -> bool {
    let Some(rest) = raw_url.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    authority == format!("127.0.0.1:{bound_port}")
}

/// Verifies a downloaded release artifact fail-closed against a previously staged manifest.
#[must_use]
pub fn verify_downloaded_asset_staged(
    file_path: &Path,
    asset_url: &str,
    staged_manifest: Option<&ReleaseManifestDto>,
    requested_version: &str,
) -> bool {
    let Some(staged) = staged_manifest else {
        return false;
    };
    if staged.version.trim() != requested_version {
        return false;
    }
    if staged.download_url.as_deref() != Some(asset_url) {
        return false;
    }
    if !NativePlatformAdapter::is_hex_sha256(&staged.sha256) {
        return false;
    }
    NativePlatformAdapter::verify_sha256_file(file_path, &staged.sha256).unwrap_or(false)
}

/// Resolves bundled UI static assets strictly from trusted paths anchored to `exe_path`
/// or explicit FHS system roots (`fhs_roots`), never consulting `current_dir()` or relative paths.
#[must_use]
pub fn resolve_trusted_ui_dist_dir_with_fhs(
    exe_path: Option<&Path>,
    fhs_roots: &[&Path],
) -> Option<PathBuf> {
    if let Some(exe) = exe_path
        && let Some(exe_dir) = exe.parent()
    {
        let candidates = [
            exe_dir.join("../Resources/ui"),
            exe_dir.join("ui"),
            exe_dir.join("../lib/readora/ui"),
            exe_dir.join("../share/readora/ui"),
        ];
        for candidate in candidates {
            if !candidate.is_symlink() && candidate.join("index.html").is_file() {
                return Some(candidate);
            }
        }
    }

    for fhs_root in fhs_roots {
        if !fhs_root.is_symlink() && fhs_root.join("index.html").is_file() {
            return Some((*fhs_root).to_path_buf());
        }
    }

    None
}

/// Resolves bundled UI static assets from trusted bundle paths anchored to `exe_path`
/// (and FHS `/usr/lib/readora/ui` / `/usr/share/readora/ui` on Linux).
///
/// Never consults `current_dir()` or relative workspace paths (`[R2-HIGH-06]`).
#[must_use]
pub fn resolve_trusted_ui_dist_dir(exe_path: Option<&Path>) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    let fhs_roots: &[&Path] = &[
        Path::new("/usr/lib/readora/ui"),
        Path::new("/usr/share/readora/ui"),
    ];
    #[cfg(not(target_os = "linux"))]
    let fhs_roots: &[&Path] = &[];

    resolve_trusted_ui_dist_dir_with_fhs(exe_path, fhs_roots)
}

/// Returns `true` when `raw` is a strict 64-character ASCII hexadecimal SHA-256 digest.
#[must_use]
pub fn is_strict_hex_sha256(raw: &str) -> bool {
    raw.len() == 64 && raw.chars().all(|c| c.is_ascii_hexdigit())
}

/// Validates that `raw_url` is an `https://` URL targeting an allowlisted GitHub Releases host
/// with no `@` userinfo or custom port.
#[must_use]
pub fn is_allowed_github_https_url(raw_url: &str) -> bool {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let Some(rest) = trimmed.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let host = authority
        .strip_suffix(":443")
        .unwrap_or(authority)
        .to_ascii_lowercase();
    if host.contains(':') {
        return false;
    }
    matches!(
        host.as_str(),
        "github.com"
            | "api.github.com"
            | "objects.githubusercontent.com"
            | "release-assets.githubusercontent.com"
            | "codeload.github.com"
    )
}

/// Maps `(target_os, target_arch)` to the canonical `release-manifest-<platform>.json` asset name.
#[must_use]
pub fn platform_release_manifest_asset_name(
    target_os: &str,
    target_arch: &str,
) -> Option<&'static str> {
    match (target_os, target_arch) {
        ("macos", "aarch64" | "arm64") => Some("release-manifest-macos-aarch64.json"),
        ("macos", "x86_64" | "x64") => Some("release-manifest-macos-x86_64.json"),
        ("windows", "x86_64" | "x64" | "amd64") => Some("release-manifest-windows-x86_64.json"),
        ("windows", "aarch64" | "arm64") => Some("release-manifest-windows-aarch64.json"),
        ("linux", "x86_64" | "x64" | "amd64") => Some("release-manifest-linux-x86_64.json"),
        ("linux", "aarch64" | "arm64") => Some("release-manifest-linux-aarch64.json"),
        _ => None,
    }
}

/// Resolves the verified 64-character hex `sha256` for a selected GitHub Release asset:
/// 1. Prefers `selected_asset_digest` (`sha256:<64-hex>`) directly when present.
/// 2. When `selected_asset_digest` is `None`, falls back to a matching
///    `release-manifest-<platform>.json` asset in `release_assets` (fetched over HTTPS from
///    allowed GitHub hosts, bounded `<= 64 KiB`, verifying its `"asset"` matches
///    `selected_asset_name` exactly and its `"sha256"` is a valid 64-char hex digest).
pub fn resolve_selected_asset_sha256<F>(
    selected_asset_name: &str,
    selected_asset_digest: Option<&str>,
    release_assets: &[Value],
    target_os: &str,
    target_arch: &str,
    fetch_https_manifest: F,
) -> Option<String>
where
    F: FnOnce(&str) -> Result<Vec<u8>, String>,
{
    if let Some(raw_digest) = selected_asset_digest {
        let trimmed = raw_digest.trim();
        if !trimmed.is_empty() {
            let hex_part = trimmed.strip_prefix("sha256:")?;
            if is_strict_hex_sha256(hex_part) {
                return Some(hex_part.to_ascii_lowercase());
            }
            return None;
        }
    }

    let expected_manifest_name = platform_release_manifest_asset_name(target_os, target_arch)?;
    let manifest_entry = release_assets.iter().find(|entry| {
        entry
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.eq_ignore_ascii_case(expected_manifest_name))
    })?;

    let declared_size = manifest_entry
        .get("size")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if declared_size > MAX_RELEASE_MANIFEST_BYTES as u64 {
        return None;
    }

    let manifest_url = manifest_entry
        .get("browser_download_url")
        .and_then(Value::as_str)?;
    if !is_allowed_github_https_url(manifest_url) {
        return None;
    }

    let raw_bytes = fetch_https_manifest(manifest_url).ok()?;
    if raw_bytes.is_empty() || raw_bytes.len() > MAX_RELEASE_MANIFEST_BYTES {
        return None;
    }

    let parsed_manifest: Value = serde_json::from_slice(&raw_bytes).ok()?;
    let manifest_asset_name = parsed_manifest
        .get("asset")
        .and_then(Value::as_str)
        .map(str::trim)?;
    if manifest_asset_name != selected_asset_name {
        return None;
    }

    let manifest_sha = parsed_manifest
        .get("sha256")
        .and_then(Value::as_str)
        .map(str::trim)?;
    if !is_strict_hex_sha256(manifest_sha) {
        return None;
    }

    Some(manifest_sha.to_ascii_lowercase())
}

struct SelectedReleaseAsset {
    name: String,
    download_url: String,
    size_bytes: u64,
    digest: Option<String>,
}

fn select_platform_installer_asset(
    assets: &[Value],
    target_os: &str,
    target_arch: &str,
) -> Option<SelectedReleaseAsset> {
    let os_tokens: &[&str] = match target_os {
        "macos" => &[".dmg", ".app.tar.gz", "macos", "darwin"],
        "windows" => &[".msi", ".exe", "windows", "win64"],
        "linux" => &[".appimage", ".deb", ".rpm", "linux"],
        _ => &[".dmg", ".msi", ".appimage"],
    };
    let arch_tokens: &[&str] = match target_arch {
        "aarch64" | "arm64" => &["aarch64", "arm64", "universal"],
        "x86_64" | "x64" | "amd64" => &["x86_64", "x64", "amd64", "win64", "universal"],
        _ => &[],
    };

    let mut best_score: u8 = 0;
    let mut selected: Option<SelectedReleaseAsset> = None;

    for asset in assets {
        let Some(exact_name) = asset.get("name").and_then(Value::as_str) else {
            continue;
        };
        let lower_name = exact_name.to_ascii_lowercase();
        if lower_name.ends_with(".json")
            || lower_name.ends_with(".sha256")
            || lower_name.starts_with("release-manifest")
        {
            continue;
        }
        if !os_tokens.iter().any(|tok| lower_name.contains(tok)) {
            continue;
        }
        let Some(download_url) = asset
            .get("browser_download_url")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let size_bytes = asset.get("size").and_then(Value::as_u64).unwrap_or(0);
        let digest = asset
            .get("digest")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        let matches_arch =
            arch_tokens.is_empty() || arch_tokens.iter().any(|tok| lower_name.contains(tok));
        let is_preferred_updater_bundle = (target_os == "macos"
            && lower_name.ends_with(".app.tar.gz"))
            || (target_os == "linux" && lower_name.ends_with(".deb"));
        let score: u8 = match (matches_arch, is_preferred_updater_bundle) {
            (true, true) => 4,
            (true, false) => 3,
            (false, _) => 2,
        };

        if score > best_score {
            best_score = score;
            selected = Some(SelectedReleaseAsset {
                name: exact_name.to_owned(),
                download_url,
                size_bytes,
                digest,
            });
            if score == 4 {
                break;
            }
        }
    }

    selected
}

/// Parses a GitHub Releases `/releases/latest` JSON payload and resolves the platform asset's
/// SHA-256 digest (preferring `asset.digest` and falling back to `release-manifest-<platform>.json`).
pub fn parse_and_resolve_github_release_manifest<F>(
    raw_release_json: &str,
    target_os: &str,
    target_arch: &str,
    fetch_https_manifest: F,
) -> Result<ReleaseManifestDto, CommandErrorDto>
where
    F: FnOnce(&str) -> Result<Vec<u8>, String>,
{
    let mut manifest = NativePlatformAdapter::parse_github_release_json_for_target(
        raw_release_json,
        target_os,
        target_arch,
    )?;

    let parsed: Value = serde_json::from_str(raw_release_json).map_err(|err| CommandErrorDto {
        code: "platform_error".to_owned(),
        message: format!("invalid GitHub release JSON response: {err}"),
    })?;

    if let Some(assets) = parsed.get("assets").and_then(Value::as_array)
        && let Some(selected) = select_platform_installer_asset(assets, target_os, target_arch)
    {
        if is_allowed_github_https_url(&selected.download_url) {
            manifest.package_size_bytes = selected.size_bytes;
            manifest.download_url = Some(selected.download_url);
            manifest.sha256 = resolve_selected_asset_sha256(
                &selected.name,
                selected.digest.as_deref(),
                assets,
                target_os,
                target_arch,
                fetch_https_manifest,
            )
            .unwrap_or_default();
        } else {
            manifest.package_size_bytes = 0;
            manifest.download_url = None;
            manifest.sha256.clear();
        }
    }

    Ok(manifest)
}

fn fetch_github_https_bounded(
    url: &str,
    accept_header: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if !is_allowed_github_https_url(url) {
        return Err("URL is not an allowed GitHub HTTPS endpoint".to_owned());
    }

    let temp_out = tempfile::NamedTempFile::new()
        .map_err(|err| format!("failed to allocate temporary download buffer: {err}"))?;
    let curl_bin = if cfg!(target_os = "macos") {
        PathBuf::from("/usr/bin/curl")
    } else if cfg!(target_os = "windows") {
        let sys_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(sys_root).join("System32").join("curl.exe")
    } else {
        PathBuf::from("curl")
    };

    let max_size_str = max_bytes.to_string();
    let output = Command::new(curl_bin)
        .args([
            "--proto",
            "=https",
            "--tlsv1.2",
            "-fsSL",
            "--max-redirs",
            "5",
            "--connect-timeout",
            "10",
            "--max-time",
            "10",
            "--max-filesize",
            &max_size_str,
            "-H",
            accept_header,
            "-w",
            "%{url_effective}",
            "-o",
        ])
        .arg(temp_out.path())
        .arg(url)
        .output()
        .map_err(|err| format!("failed to execute HTTPS client: {err}"))?;

    if !output.status.success() {
        return Err("GitHub HTTPS request failed".to_owned());
    }

    let effective_url = String::from_utf8_lossy(&output.stdout);
    if !effective_url.trim().is_empty() && !is_allowed_github_https_url(effective_url.trim()) {
        return Err("redirected URL left allowed GitHub HTTPS hosts".to_owned());
    }

    let meta = std::fs::metadata(temp_out.path())
        .map_err(|err| format!("failed to inspect downloaded response size: {err}"))?;
    if meta.len() > max_bytes as u64 {
        return Err("downloaded GitHub response exceeded size cap".to_owned());
    }

    let bytes = std::fs::read(temp_out.path())
        .map_err(|err| format!("failed to read downloaded response bytes: {err}"))?;
    if bytes.len() > max_bytes {
        return Err("downloaded GitHub response exceeded size cap".to_owned());
    }
    Ok(bytes)
}

/// Fetches a bounded (`<= 64 KiB`) release manifest JSON over HTTPS from an allowed GitHub host.
pub fn fetch_allowed_github_manifest_bytes(url: &str) -> Result<Vec<u8>, String> {
    fetch_github_https_bounded(
        url,
        "Accept: application/octet-stream",
        MAX_RELEASE_MANIFEST_BYTES,
    )
}

fn is_valid_github_repo_slug(repo: &str) -> bool {
    app_domain::is_valid_github_repo_slug(repo)
}

/// Fetches `/repos/{owner}/{repo}/releases/latest` over HTTPS and resolves a verified
/// `ReleaseManifestDto` (falling back to `release-manifest-<platform>.json` when `asset.digest` is absent).
pub fn fetch_github_release_manifest(repo: &str) -> Result<ReleaseManifestDto, CommandErrorDto> {
    let trimmed_repo = repo.trim();
    if !is_valid_github_repo_slug(trimmed_repo) {
        return Err(CommandErrorDto {
            code: "validation_error".to_owned(),
            message: "Invalid GitHub owner/repo slug".to_owned(),
        });
    }
    let api_url = format!("https://api.github.com/repos/{trimmed_repo}/releases/latest");
    let raw_bytes = fetch_github_https_bounded(
        &api_url,
        "Accept: application/vnd.github+json",
        MAX_GITHUB_RELEASE_API_BYTES,
    )
    .map_err(|msg| CommandErrorDto {
        code: "platform_error".to_owned(),
        message: msg,
    })?;
    let raw_json = std::str::from_utf8(&raw_bytes).map_err(|_| CommandErrorDto {
        code: "platform_error".to_owned(),
        message: "GitHub release API response was not valid UTF-8".to_owned(),
    })?;
    parse_and_resolve_github_release_manifest(
        raw_json,
        std::env::consts::OS,
        std::env::consts::ARCH,
        fetch_allowed_github_manifest_bytes,
    )
}

/// Resolves the user's `Downloads` directory (verifying it exists and is not a symlink),
/// falling back to `<app_data_dir>/exports` when `Downloads` is missing.
pub fn resolve_export_target_dir(override_dir: Option<&Path>) -> Result<PathBuf, CommandErrorDto> {
    if let Some(custom) = override_dir {
        if let Ok(meta) = std::fs::symlink_metadata(custom)
            && meta.file_type().is_symlink()
        {
            return Err(CommandErrorDto {
                code: "platform_error".to_owned(),
                message: "Refusing to export into a symlinked directory".to_owned(),
            });
        }
        if !custom.exists() {
            std::fs::create_dir_all(custom).map_err(|err| CommandErrorDto {
                code: "platform_error".to_owned(),
                message: format!("Failed to create export directory: {err}"),
            })?;
        }
        return std::fs::canonicalize(custom).map_err(|err| CommandErrorDto {
            code: "platform_error".to_owned(),
            message: format!("Failed to resolve export directory: {err}"),
        });
    }

    #[cfg(target_os = "windows")]
    let downloads_candidate = std::env::var("USERPROFILE")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .map(|profile| PathBuf::from(profile).join("Downloads"));

    #[cfg(not(target_os = "windows"))]
    let downloads_candidate = std::env::var("HOME")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .map(|home| PathBuf::from(home).join("Downloads"));

    if let Some(downloads) = downloads_candidate
        && let Ok(meta) = std::fs::symlink_metadata(&downloads)
        && meta.is_dir()
        && !meta.file_type().is_symlink()
        && let Ok(canon) = std::fs::canonicalize(&downloads)
    {
        return Ok(canon);
    }

    let fallback = NativePlatformAdapter::resolve_app_data_dir().join("exports");
    if let Ok(meta) = std::fs::symlink_metadata(&fallback)
        && meta.file_type().is_symlink()
    {
        return Err(CommandErrorDto {
            code: "platform_error".to_owned(),
            message: "Refusing to export into symlinked exports directory".to_owned(),
        });
    }
    std::fs::create_dir_all(&fallback).map_err(|err| CommandErrorDto {
        code: "platform_error".to_owned(),
        message: format!("Failed to create fallback exports directory: {err}"),
    })?;
    Ok(std::fs::canonicalize(&fallback).unwrap_or(fallback))
}

/// Picks a non-clobbering `.md` file path inside `export_dir` (`<stem>.md`, `<stem>-2.md` .. `<stem>-999.md`)
/// so existing user files are never overwritten (`[R2-MED-01]`).
pub fn select_non_clobbering_markdown_path(
    export_dir: &Path,
    sanitized_file_name: &str,
) -> Result<PathBuf, CommandErrorDto> {
    let clean_name = Path::new(sanitized_file_name)
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::trim)
        .filter(|n| !n.is_empty() && !n.starts_with('.'))
        .unwrap_or("annotations.md");
    let stem = clean_name
        .strip_suffix(".md")
        .or_else(|| clean_name.strip_suffix(".MD"))
        .filter(|s| !s.is_empty())
        .unwrap_or("annotations");

    let primary = export_dir.join(format!("{stem}.md"));
    if std::fs::symlink_metadata(&primary).is_err() {
        return Ok(primary);
    }

    for suffix in 2..=999_u16 {
        let candidate = export_dir.join(format!("{stem}-{suffix}.md"));
        if std::fs::symlink_metadata(&candidate).is_err() {
            return Ok(candidate);
        }
    }

    Err(CommandErrorDto {
        code: "platform_error".to_owned(),
        message: "Unable to allocate non-clobbering Markdown export filename".to_owned(),
    })
}

/// Executes the `"annotation_export"` RPC command, supporting optional `"saveToDownloads": bool`
/// with atomic non-clobbering file creation (`[R2-MED-01]`).
pub fn execute_annotation_export_rpc(
    handler: &DesktopCommandHandler,
    args: &Value,
    downloads_dir_override: Option<&Path>,
) -> Result<ExportAnnotationsBundleDto, CommandErrorDto> {
    let document_id: String = serde_json::from_value(
        args.get("documentId").cloned().unwrap_or(Value::Null),
    )
    .map_err(|err| CommandErrorDto {
        code: "validation_error".to_owned(),
        message: format!("invalid IPC argument 'documentId': {err}"),
    })?;
    let include_annotations: bool = serde_json::from_value(
        args.get("includeAnnotations")
            .cloned()
            .unwrap_or(Value::Null),
    )
    .map_err(|err| CommandErrorDto {
        code: "validation_error".to_owned(),
        message: format!("invalid IPC argument 'includeAnnotations': {err}"),
    })?;
    let save_to_downloads = args
        .get("saveToDownloads")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // Security invariant (`[HIGH-04]`): untrusted HTTP RPC callers may never pick arbitrary
    // filesystem destination paths. When saving to disk is requested, always allocate a
    // non-clobbering path inside the resolved user Downloads / fallback exports directory.
    if save_to_downloads {
        let preview = handler.annotation_export(&document_id, include_annotations, None)?;
        let export_dir = resolve_export_target_dir(downloads_dir_override)?;
        let target_path = select_non_clobbering_markdown_path(&export_dir, &preview.file_name)?;
        let target_str = target_path.to_string_lossy().into_owned();
        let mut exported =
            handler.annotation_export(&document_id, include_annotations, Some(&target_str))?;
        if let Some(actual_name) = target_path.file_name().and_then(|n| n.to_str()) {
            exported.file_name = actual_name.to_owned();
        }
        return Ok(exported);
    }

    handler.annotation_export(&document_id, include_annotations, None)
}

/// Builds the WebView document-creation initialization script with subframe and origin guards
/// and captured intrinsics (`fetch`, `encodeURIComponent`, `JSON.stringify`, `Uint8Array`).
#[must_use]
pub fn build_init_script(bound_port: u16, session_token: &str) -> String {
    format!(
        r#"
      (function() {{
        if (window.top !== window.self) {{ return; }}
        if (window.location.origin !== "http://127.0.0.1:{bound_port}") {{ return; }}
        const nativeFetch = window.fetch.bind(window);
        const nativeEncodeURIComponent = globalThis.encodeURIComponent;
        const nativeJsonStringify = globalThis.JSON.stringify;
        const NativeUint8Array = globalThis.Uint8Array;
        const sliceArrayBuffer = Function.prototype.call.bind(ArrayBuffer.prototype.slice);
        const TOKEN = "{session_token}";

        if (typeof globalThis.Iterator === 'undefined') {{
          var IterProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
          function Iterator() {{}}
          Iterator.prototype = IterProto;
          globalThis.Iterator = Iterator;
        }}
        if (typeof globalThis.Iterator.prototype.join !== 'function') {{
          globalThis.Iterator.prototype.join = function(sep) {{
            return Array.from(this).join(sep);
          }};
        }}
        if (typeof Promise.withResolvers !== 'function') {{
          Promise.withResolvers = function() {{
            var resolve, reject;
            var promise = new Promise(function(res, rej) {{ resolve = res; reject = rej; }});
            return {{ promise: promise, resolve: resolve, reject: reject }};
          }};
        }}
        if (typeof URL.parse !== 'function') {{
          URL.parse = function(url, base) {{
            try {{ return new URL(url, base); }} catch (_) {{ return null; }}
          }};
        }}

        async function invokeRpc(cmd, args) {{
          const resp = await nativeFetch('/__readora_rpc', {{
            method: 'POST',
            headers: {{
              'Content-Type': 'application/json',
              'X-Readora-Token': TOKEN
            }},
            body: nativeJsonStringify({{ cmd: cmd, args: args || {{}} }})
          }});
          const payload = await resp.json();
          if (!resp.ok || !payload || payload.ok !== true) {{
            const err = (payload && payload.error) || {{
              code: 'ipc_error',
              message: 'Desktop command failed'
            }};
            throw err;
          }}
          return payload.data;
        }}

        Object.defineProperty(window, '__TAURI_INTERNALS__', {{
          configurable: false,
          enumerable: false,
          writable: false,
          value: Object.freeze({{
            invoke: invokeRpc
          }})
        }});

        Object.defineProperty(window, '__READORA_NATIVE__', {{
          configurable: false,
          enumerable: false,
          writable: false,
          value: Object.freeze({{
            importPdfBytes: async function(fileName, bytes, password) {{
              const headers = {{
                'Content-Type': 'application/pdf',
                'X-Readora-Token': TOKEN,
                'X-Readora-Filename': nativeEncodeURIComponent(fileName || 'Document.pdf')
              }};
              if (password) {{
                headers['X-Readora-Password'] = nativeEncodeURIComponent(password);
              }}
              const bodyBuffer = sliceArrayBuffer(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
              );
              const resp = await nativeFetch('/__readora_import', {{
                method: 'POST',
                headers: headers,
                body: bodyBuffer
              }});
              const payload = await resp.json();
              if (!resp.ok || !payload || payload.ok !== true) {{
                throw (payload && payload.error) || {{
                  code: 'invalid_pdf',
                  message: 'Failed to import PDF document'
                }};
              }}
              return payload.data;
            }},
            readPdfBytes: async function(documentId) {{
              const resp = await nativeFetch('/__readora_pdf_read', {{
                method: 'POST',
                headers: {{
                  'Content-Type': 'application/json',
                  'X-Readora-Token': TOKEN
                }},
                body: nativeJsonStringify({{ documentId: documentId }})
              }});
              if (!resp.ok) {{
                return null;
              }}
              const buf = await resp.arrayBuffer();
              return buf.byteLength > 0 ? new NativeUint8Array(buf) : null;
            }},
            triggerSelfUpdate: async function(version) {{
              const resp = await nativeFetch('/__readora_update', {{
                method: 'POST',
                headers: {{
                  'Content-Type': 'application/json',
                  'X-Readora-Token': TOKEN
                }},
                body: nativeJsonStringify({{ version: version }})
              }});
              if (!resp.ok) {{
                return {{ status: 'failed' }};
              }}
              return resp.json();
            }}
          }})
        }});

        window.close = function() {{
          if (window.ipc && typeof window.ipc.postMessage === 'function') {{
            window.ipc.postMessage('quit');
          }}
        }};
        window.addEventListener('keydown', function(e) {{
          if ((e.metaKey || e.ctrlKey) && e.key && e.key.toLowerCase() === 'q') {{
            e.preventDefault();
            if (window.ipc && typeof window.ipc.postMessage === 'function') {{
              window.ipc.postMessage('quit');
            }}
          }}
        }});
      }})();
    "#
    )
}

fn wipe_string(secret: &mut String) {
    if secret.is_empty() && secret.capacity() == 0 {
        return;
    }
    let taken = std::mem::take(secret);
    let mut bytes = taken.into_bytes();
    let cap = bytes.capacity();
    if cap > 0 {
        bytes.resize(cap, 0_u8);
        bytes.fill(0_u8);
        let _ = std::hint::black_box(bytes.as_mut_slice());
        bytes.clear();
    }
}

/// Parsed HTTP request metadata and body.
#[derive(Clone)]
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

impl std::fmt::Debug for ParsedHttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedHttpRequest")
            .field("method", &self.method)
            .field("target", &self.target)
            .field("header_count", &self.headers.len())
            .field("body_len", &self.body.len())
            .finish()
    }
}

impl Drop for ParsedHttpRequest {
    fn drop(&mut self) {
        for (k, v) in &mut self.headers {
            if k == "x-readora-token" || k == "x-readora-password" {
                wipe_string(v);
            }
        }
    }
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

fn duplicate_header_error() -> HttpResponse {
    HttpResponse::json(
        "400 Bad Request",
        &json!({ "ok": false, "error": { "code": "duplicate_header", "message": "Duplicate security-critical HTTP header" } }),
    )
}

fn timeout_error() -> HttpResponse {
    HttpResponse::json(
        "408 Request Timeout",
        &json!({ "ok": false, "error": { "code": "request_timeout", "message": "Request read deadline exceeded" } }),
    )
}

/// Reads and validates an HTTP/1.1 request from `reader`, checking `Host` and API authentication
/// headers **before** allocating or reading multi-megabyte request bodies.
pub fn read_and_authorize_http_request<R: Read>(
    reader: &mut R,
    bound_port: u16,
    expected_token: &str,
) -> Result<Option<ParsedHttpRequest>, HttpResponse> {
    let started_at = Instant::now();
    let mut header_buf = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 4096];
    let (header_end, body_offset) = loop {
        if started_at.elapsed() > MAX_HEADER_DURATION {
            header_buf.fill(0_u8);
            return Err(timeout_error());
        }
        match reader.read(&mut chunk) {
            Ok(0) => {
                if header_buf.is_empty() {
                    return Ok(None);
                }
                header_buf.fill(0_u8);
                return Err(HttpResponse::json(
                    "400 Bad Request",
                    &json!({ "ok": false, "error": { "code": "incomplete_headers", "message": "Incomplete HTTP request headers" } }),
                ));
            }
            Ok(n) => {
                if started_at.elapsed() > MAX_HEADER_DURATION {
                    header_buf.fill(0_u8);
                    return Err(timeout_error());
                }
                header_buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = header_buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break (pos, pos + 4);
                }
                if header_buf.len() > MAX_HEADER_BYTES {
                    header_buf.fill(0_u8);
                    return Err(HttpResponse::json(
                        "431 Request Header Fields Too Large",
                        &json!({ "ok": false, "error": { "code": "headers_too_large", "message": "Request headers exceed limit" } }),
                    ));
                }
            }
            Err(err) => {
                if started_at.elapsed() > MAX_HEADER_DURATION
                    || matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock)
                {
                    if header_buf.is_empty() && started_at.elapsed() <= MAX_HEADER_DURATION {
                        return Ok(None);
                    }
                    header_buf.fill(0_u8);
                    return Err(timeout_error());
                }
                if header_buf.is_empty() {
                    return Ok(None);
                }
                header_buf.fill(0_u8);
                return Err(HttpResponse::json(
                    "400 Bad Request",
                    &json!({ "ok": false, "error": { "code": "bad_request", "message": "Failed reading HTTP headers" } }),
                ));
            }
        }
    };

    let header_owned = match std::str::from_utf8(&header_buf[..header_end]) {
        Ok(s) => s.to_owned(),
        Err(_) => {
            header_buf.fill(0_u8);
            return Err(HttpResponse::json(
                "400 Bad Request",
                &json!({ "ok": false, "error": { "code": "bad_request", "message": "Invalid UTF-8 in HTTP headers" } }),
            ));
        }
    };
    let mut lines = header_owned.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let (Some(raw_method), Some(raw_target), Some(_http_version)) =
        (parts.next(), parts.next(), parts.next())
    else {
        return Err(HttpResponse::json(
            "400 Bad Request",
            &json!({ "ok": false, "error": { "code": "bad_request", "message": "Malformed HTTP request line" } }),
        ));
    };
    if parts.next().is_some() {
        return Err(HttpResponse::json(
            "400 Bad Request",
            &json!({ "ok": false, "error": { "code": "bad_request", "message": "Malformed HTTP request line" } }),
        ));
    }
    let method = raw_method.to_ascii_uppercase();
    let target = raw_target.to_owned();

    let mut headers = Vec::new();
    let mut content_length = 0_usize;
    let mut seen_host = false;
    let mut seen_origin = false;
    let mut seen_sec_fetch_site = false;
    let mut seen_token = false;
    let mut seen_filename = false;
    let mut seen_password = false;
    let mut seen_content_length = false;

    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            header_buf.fill(0_u8);
            return Err(HttpResponse::json(
                "400 Bad Request",
                &json!({ "ok": false, "error": { "code": "bad_request", "message": "Malformed HTTP header line" } }),
            ));
        };
        let key = k.trim().to_ascii_lowercase();
        let val = v.trim().to_owned();

        match key.as_str() {
            "transfer-encoding" => {
                header_buf.fill(0_u8);
                return Err(HttpResponse::json(
                    "501 Not Implemented",
                    &json!({ "ok": false, "error": { "code": "unsupported_transfer_encoding", "message": "Transfer-Encoding is not supported" } }),
                ));
            }
            "host" => {
                if seen_host {
                    header_buf.fill(0_u8);
                    return Err(duplicate_header_error());
                }
                seen_host = true;
            }
            "origin" => {
                if seen_origin {
                    header_buf.fill(0_u8);
                    return Err(duplicate_header_error());
                }
                seen_origin = true;
            }
            "sec-fetch-site" => {
                if seen_sec_fetch_site {
                    header_buf.fill(0_u8);
                    return Err(duplicate_header_error());
                }
                seen_sec_fetch_site = true;
            }
            "x-readora-token" => {
                if seen_token {
                    header_buf.fill(0_u8);
                    return Err(duplicate_header_error());
                }
                seen_token = true;
            }
            "x-readora-filename" => {
                if seen_filename {
                    header_buf.fill(0_u8);
                    return Err(duplicate_header_error());
                }
                seen_filename = true;
            }
            "x-readora-password" => {
                if seen_password {
                    header_buf.fill(0_u8);
                    return Err(duplicate_header_error());
                }
                seen_password = true;
            }
            "content-length" => {
                if seen_content_length {
                    header_buf.fill(0_u8);
                    return Err(duplicate_header_error());
                }
                seen_content_length = true;
                if val.is_empty() || !val.bytes().all(|b| b.is_ascii_digit()) {
                    header_buf.fill(0_u8);
                    return Err(HttpResponse::json(
                        "400 Bad Request",
                        &json!({ "ok": false, "error": { "code": "invalid_content_length", "message": "Malformed Content-Length header" } }),
                    ));
                }
                let Ok(parsed) = val.parse::<usize>() else {
                    header_buf.fill(0_u8);
                    return Err(HttpResponse::json(
                        "400 Bad Request",
                        &json!({ "ok": false, "error": { "code": "invalid_content_length", "message": "Malformed Content-Length header" } }),
                    ));
                };
                content_length = parsed;
            }
            _ => {}
        }

        headers.push((key, val));
    }

    let path_only = target.split('?').next().unwrap_or("/");
    let is_api_route = path_only.starts_with("/__readora_");
    if is_api_route {
        if let Err(err_resp) = validate_api_headers(&method, &headers, bound_port, expected_token) {
            header_buf.fill(0_u8);
            return Err(err_resp);
        }
    } else if !is_allowed_host(&headers, bound_port) {
        header_buf.fill(0_u8);
        return Err(HttpResponse::json(
            "403 Forbidden",
            &json!({ "ok": false, "error": { "code": "forbidden_host", "message": "Invalid Host header" } }),
        ));
    }

    let max_body = if path_only == "/__readora_import" {
        MAX_IMPORT_PDF_BYTES
    } else if is_api_route {
        MAX_RPC_BODY_BYTES
    } else {
        0
    };

    if content_length > max_body {
        header_buf.fill(0_u8);
        return Err(HttpResponse::json(
            "413 Payload Too Large",
            &json!({ "ok": false, "error": { "code": "payload_too_large", "message": "Request payload exceeds maximum allowed size" } }),
        ));
    }

    let mut body = Vec::with_capacity(content_length.min(64 * 1024));
    if header_buf.len() > body_offset {
        let already = &header_buf[body_offset..];
        let to_copy = already.len().min(content_length);
        body.extend_from_slice(&already[..to_copy]);
    }
    header_buf.fill(0_u8);
    let _ = std::hint::black_box(header_buf.as_mut_slice());
    while body.len() < content_length {
        if started_at.elapsed() > MAX_REQUEST_DURATION {
            return Err(timeout_error());
        }
        let remaining = content_length - body.len();
        let read_limit = remaining.min(chunk.len());
        match reader.read(&mut chunk[..read_limit]) {
            Ok(0) => break,
            Ok(n) => {
                if started_at.elapsed() > MAX_REQUEST_DURATION {
                    return Err(timeout_error());
                }
                body.extend_from_slice(&chunk[..n]);
            }
            Err(err) => {
                if started_at.elapsed() > MAX_REQUEST_DURATION
                    || matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock)
                {
                    return Err(timeout_error());
                }
                break;
            }
        }
    }

    if body.len() < content_length {
        return Err(HttpResponse::json(
            "400 Bad Request",
            &json!({ "ok": false, "error": { "code": "truncated_body", "message": "Request body truncated before Content-Length bytes" } }),
        ));
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
    route_http_request_with_export_dir(req, ui_root, handler, None, update_runner)
}

/// Routes a validated `ParsedHttpRequest` with an optional `Downloads` directory override (used by
/// unit tests to verify atomic non-clobbering exports without touching the user's real `~/Downloads`).
pub fn route_http_request_with_export_dir<F>(
    req: ParsedHttpRequest,
    ui_root: &Path,
    handler: &DesktopCommandHandler,
    downloads_dir_override: Option<&Path>,
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
            let rpc_result = if envelope.cmd == "annotation_export" {
                execute_annotation_export_rpc(handler, &envelope.args, downloads_dir_override)
                    .and_then(|bundle| {
                        serde_json::to_value(bundle).map_err(|err| CommandErrorDto {
                            code: "serialization_error".to_owned(),
                            message: format!("failed to serialize IPC response: {err}"),
                        })
                    })
            } else {
                handler.dispatch_rpc(&envelope.cmd, envelope.args)
            };
            match rpc_result {
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
    let candidate = if std::fs::symlink_metadata(&full_path)
        .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
    {
        full_path
    } else {
        ui_root.join("index.html")
    };

    let verified_path = (|| -> Option<PathBuf> {
        let meta = std::fs::symlink_metadata(&candidate).ok()?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return None;
        }
        let canon_root = std::fs::canonicalize(ui_root).ok()?;
        let canon_file = std::fs::canonicalize(&candidate).ok()?;
        if canon_file.starts_with(&canon_root) {
            Some(canon_file)
        } else {
            None
        }
    })();

    let Some(resolved_path) = verified_path else {
        return HttpResponse {
            status: "404 Not Found",
            content_type: "text/plain; charset=utf-8",
            include_csp: true,
            body: if head_only {
                Vec::new()
            } else {
                b"404 Not Found".to_vec()
            },
        };
    };

    match std::fs::read(&resolved_path) {
        Ok(body) => {
            let mime = content_type_for_path(&resolved_path);
            // Attach strict CSP on HTML documents AND JavaScript/module scripts so Web Workers
            // (`pdf.worker.mjs`, etc.) inherit the same strict policy (`[R2-LOW-04]`).
            let include_csp =
                mime.starts_with("text/html") || mime.starts_with("application/javascript");
            HttpResponse {
                status: "200 OK",
                content_type: mime,
                include_csp,
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
