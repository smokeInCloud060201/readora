//! Native OS integration adapter implementing `PlatformPort`.
//!
//! Handles path resolution, file size validation, deterministic document ID hashing,
//! OS application data directory discovery, and atomic file writes.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use app_application::{
    AppCleanupReportDto, ApplicationError, PlatformPort, ReleaseManifestDto, ResolvedFileInfo,
};
use app_domain::{DocumentId, sanitize_display_name};
use sha2::{Digest, Sha256};

const ALLOWED_APP_DIR_NAMES: &[&str] = &[
    "com.readora.desktop",
    "Readora",
    "readora",
    "readora-data",
    "readora-cache",
    "readora-samples",
];

const KNOWN_SQLITE_FILES: &[&str] = &[
    "readora.sqlite",
    "readora.sqlite-wal",
    "readora.sqlite-shm",
    "readora.sqlite-journal",
];

const KNOWN_CACHE_EXTENSIONS: &[&str] = &["png", "cache", "tmp", "json", "bin"];

/// Default platform adapter for desktop operating systems (macOS, Windows, Linux).
#[derive(Debug, Clone, Default)]
pub struct NativePlatformAdapter;

impl NativePlatformAdapter {
    /// Creates a new `NativePlatformAdapter`.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Resolves the OS-appropriate application data directory for storing `readora.sqlite`.
    #[must_use]
    pub fn resolve_app_data_dir() -> PathBuf {
        if let Ok(override_dir) = std::env::var("READORA_DATA_DIR") {
            let trimmed = override_dir.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("com.readora.desktop");
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                return PathBuf::from(appdata).join("Readora");
            }
        }

        #[cfg(target_os = "linux")]
        {
            if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
                let trimmed = xdg.trim();
                if !trimmed.is_empty() {
                    return PathBuf::from(trimmed).join("readora");
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join("readora");
            }
        }

        std::env::temp_dir().join("readora-data")
    }

    /// Resolves the OS-appropriate application cache directory used exclusively by Readora.
    #[must_use]
    pub fn resolve_app_cache_dir() -> PathBuf {
        if let Ok(override_dir) = std::env::var("READORA_CACHE_DIR") {
            let trimmed = override_dir.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home)
                    .join("Library")
                    .join("Caches")
                    .join("com.readora.desktop");
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
                return PathBuf::from(local_appdata).join("Readora").join("Cache");
            }
        }

        #[cfg(target_os = "linux")]
        {
            if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
                let trimmed = xdg.trim();
                if !trimmed.is_empty() {
                    return PathBuf::from(trimmed).join("readora");
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home).join(".cache").join("readora");
            }
        }

        std::env::temp_dir().join("readora-cache")
    }

    /// Returns a privacy-safe representation of the OS application data directory
    /// without exposing the local username or absolute home path in support diagnostics.
    #[must_use]
    pub const fn redacted_data_dir_display() -> &'static str {
        #[cfg(target_os = "macos")]
        {
            "~/Library/Application Support/com.readora.desktop"
        }
        #[cfg(target_os = "windows")]
        {
            "%APPDATA%\\Readora"
        }
        #[cfg(target_os = "linux")]
        {
            "~/.local/share/readora"
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            "$TMPDIR/readora-data"
        }
    }

    /// Returns a privacy-safe representation of the OS application cache directory.
    #[must_use]
    pub const fn redacted_cache_dir_display() -> &'static str {
        #[cfg(target_os = "macos")]
        {
            "~/Library/Caches/com.readora.desktop"
        }
        #[cfg(target_os = "windows")]
        {
            "%LOCALAPPDATA%\\Readora\\Cache"
        }
        #[cfg(target_os = "linux")]
        {
            "~/.cache/readora"
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            "$TMPDIR/readora-cache"
        }
    }

    /// Verifies that a target directory path is a dedicated Readora application folder
    /// (and never a source repository, root, home, Desktop, or Documents directory) before any cleanup.
    #[must_use]
    pub fn is_safe_readora_directory(path: &Path) -> bool {
        let has_repo_markers = |dir: &Path| {
            dir.join("Cargo.toml").exists()
                || dir.join("package.json").exists()
                || dir.join(".git").exists()
        };

        if has_repo_markers(path) {
            return false;
        }

        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        if ALLOWED_APP_DIR_NAMES.contains(&name) || name.starts_with("readora-mem-") {
            return true;
        }
        if name.eq_ignore_ascii_case("cache")
            && let Some(parent) = path.parent()
            && !has_repo_markers(parent)
            && let Some(parent_name) = parent.file_name().and_then(|n| n.to_str())
        {
            return ALLOWED_APP_DIR_NAMES.contains(&parent_name)
                || parent_name.starts_with("readora-mem-");
        }
        false
    }

    /// Removes Readora's SQLite database files (`readora.sqlite`, `-wal`, `-shm`, `-journal`),
    /// temporary atomic-write files, and dedicated cache files from the given application
    /// directories for clean uninstall or local state reset.
    ///
    /// Strictly removes **only** artifacts created by Readora. Any unrelated user files or
    /// external PDF documents are never touched, and directories are removed only via
    /// non-recursive `fs::remove_dir` when completely empty.
    pub fn cleanup_all_app_artifacts(
        data_dir: &Path,
        cache_dir: &Path,
    ) -> Result<AppCleanupReportDto, ApplicationError> {
        Self::cleanup_app_artifacts_internal(data_dir, cache_dir, false, true)
    }

    /// Cleans live application directories after SQLite tables have been transactionally reset,
    /// tolerating OS file-sharing locks on open `readora.sqlite*` handles (e.g. Windows
    /// `ERROR_SHARING_VIOLATION`).
    pub fn cleanup_live_app_artifacts(
        data_dir: &Path,
        cache_dir: &Path,
        clean_shared_sample_dir: bool,
    ) -> Result<AppCleanupReportDto, ApplicationError> {
        Self::cleanup_app_artifacts_internal(data_dir, cache_dir, true, clean_shared_sample_dir)
    }

    fn cleanup_app_artifacts_internal(
        data_dir: &Path,
        cache_dir: &Path,
        tolerate_open_sqlite_lock: bool,
        clean_shared_sample_dir: bool,
    ) -> Result<AppCleanupReportDto, ApplicationError> {
        let mut report = AppCleanupReportDto {
            redacted_data_dir: Self::redacted_data_dir_display().to_owned(),
            redacted_cache_dir: Self::redacted_cache_dir_display().to_owned(),
            ..AppCleanupReportDto::default()
        };

        if data_dir.exists() {
            if !Self::is_safe_readora_directory(data_dir) {
                return Err(ApplicationError::Platform(
                    "refusing to clean directory that is not a dedicated Readora application folder"
                        .to_owned(),
                ));
            }

            // 1. Remove known SQLite database files created by Readora
            for file_name in KNOWN_SQLITE_FILES {
                let candidate = data_dir.join(file_name);
                if candidate.is_file() {
                    match fs::remove_file(&candidate) {
                        Ok(()) => {
                            report.removed_database_files += 1;
                        }
                        Err(_err) if tolerate_open_sqlite_lock => {
                            // On Windows, an open SQLite handle returns ERROR_SHARING_VIOLATION (32).
                            // All application tables were already transactionally cleared and checkpointed.
                        }
                        Err(e) => {
                            return Err(ApplicationError::Platform(format!(
                                "failed to remove application database file {file_name}: {e}"
                            )));
                        }
                    }
                }
            }

            // 2. Remove Readora atomic-write temp files (`.export.tmp-*`, `.readora*.tmp-*`) in data_dir
            if let Ok(entries) = fs::read_dir(data_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(fname) = path.file_name().and_then(|n| n.to_str())
                        && path.is_file()
                        && fname.starts_with('.')
                        && fname.contains(".tmp-")
                        && fs::remove_file(&path).is_ok()
                    {
                        report.removed_temp_entries += 1;
                    }
                }
            }

            // 3. Clean dedicated `cache`, `updates`, and internal `library` staging subdirectories inside data_dir if present
            for subdir in ["cache", "updates"] {
                let nested_dir = data_dir.join(subdir);
                if nested_dir.is_dir() {
                    report.removed_cache_entries +=
                        Self::clean_known_cache_files_in_dir(&nested_dir);
                    let _ = fs::remove_dir(&nested_dir);
                }
            }

            let library_dir = data_dir.join("library");
            if library_dir.is_dir() {
                report.removed_cache_entries += Self::clean_internal_library_dir(&library_dir);
                let _ = fs::remove_dir(&library_dir);
            }

            // Remove data_dir only if completely empty (never deletes unrelated files)
            if fs::remove_dir(data_dir).is_ok() {
                report.data_dir_removed = true;
            }
        }

        if cache_dir.exists() {
            if !Self::is_safe_readora_directory(cache_dir) {
                return Err(ApplicationError::Platform(
                    "refusing to clean cache path that is not a dedicated Readora cache folder"
                        .to_owned(),
                ));
            }
            report.removed_cache_entries += Self::clean_known_cache_files_in_dir(cache_dir);
            if fs::remove_dir(cache_dir).is_ok() {
                report.cache_dir_removed = true;
            }
        }

        if clean_shared_sample_dir {
            // Also clean Readora's temporary sample directory (`$TMPDIR/readora-samples`) if present
            let sample_dir = std::env::temp_dir().join("readora-samples");
            if sample_dir.is_dir() {
                let sample_file = sample_dir.join("Readora-Welcome-Guide.pdf");
                if sample_file.is_file() && fs::remove_file(&sample_file).is_ok() {
                    report.removed_temp_entries += 1;
                }
                let _ = fs::remove_dir(&sample_dir);
            }
        }

        Ok(report)
    }

    /// Cleans the default OS Readora data and cache directories (`resolve_app_data_dir()` and
    /// `resolve_app_cache_dir()`).
    pub fn cleanup_default_app_artifacts() -> Result<AppCleanupReportDto, ApplicationError> {
        let data_dir = Self::resolve_app_data_dir();
        let cache_dir = Self::resolve_app_cache_dir();
        Self::cleanup_all_app_artifacts(&data_dir, &cache_dir)
    }

    fn clean_internal_library_dir(library_dir: &Path) -> usize {
        let mut removed = 0;
        let Ok(entries) = fs::read_dir(library_dir) else {
            return 0;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let is_known_lib_file =
                    path.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|name| {
                            name == "state.json"
                                || name.starts_with("state.json.tmp")
                                || (name.starts_with('.') && name.contains(".tmp-"))
                        });
                if is_known_lib_file && fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            } else if path.is_dir()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| name == "pdfs")
            {
                if let Ok(pdf_entries) = fs::read_dir(&path) {
                    for pdf_entry in pdf_entries.flatten() {
                        let pdf_path = pdf_entry.path();
                        if pdf_path.is_dir() {
                            if let Ok(sub_entries) = fs::read_dir(&pdf_path) {
                                for sub_entry in sub_entries.flatten() {
                                    let sub_path = sub_entry.path();
                                    let is_staged_sub_pdf = sub_path.is_file()
                                        && sub_path
                                            .file_name()
                                            .and_then(|n| n.to_str())
                                            .is_some_and(|name| {
                                                name.ends_with(".pdf")
                                                    || name.ends_with(".pdf.tmp")
                                                    || (name.starts_with('.')
                                                        && name.contains(".tmp-"))
                                            });
                                    if is_staged_sub_pdf && fs::remove_file(&sub_path).is_ok() {
                                        removed += 1;
                                    }
                                }
                            }
                            let _ = fs::remove_dir(&pdf_path);
                            continue;
                        }
                        let is_staged_pdf = pdf_path.is_file()
                            && pdf_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .is_some_and(|name| {
                                    name.ends_with(".pdf")
                                        || name.ends_with(".pdf.tmp")
                                        || (name.starts_with('.') && name.contains(".tmp-"))
                                });
                        if is_staged_pdf && fs::remove_file(&pdf_path).is_ok() {
                            removed += 1;
                        }
                    }
                }
                let _ = fs::remove_dir(&path);
            }
        }
        removed
    }

    fn clean_known_cache_files_in_dir(dir: &Path) -> usize {
        let mut removed = 0;
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let is_known_cache_file = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        KNOWN_CACHE_EXTENSIONS
                            .iter()
                            .any(|allowed| ext.eq_ignore_ascii_case(allowed))
                    })
                    || path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|name| {
                            name.starts_with("readora-")
                                || name.starts_with("render-cache")
                                || (name.starts_with('.') && name.contains(".tmp-"))
                        });
                if is_known_cache_file && fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            } else if path.is_dir()
                && let Some(sub_name) = path.file_name().and_then(|n| n.to_str())
                && matches!(
                    sub_name,
                    "render-cache" | "thumbnails" | "pages" | "temp" | "updates"
                )
            {
                removed += Self::clean_known_cache_files_in_dir(&path);
                let _ = fs::remove_dir(&path);
            }
        }
        removed
    }

    /// Removes Readora's SQLite database files (`readora.sqlite`, `-wal`, `-shm`) from
    /// the given application data directory for clean uninstall or local state reset.
    pub fn cleanup_app_data_dir(data_dir: &Path) -> Result<bool, ApplicationError> {
        let cache_dir = data_dir.join("cache");
        let report = Self::cleanup_all_app_artifacts(data_dir, &cache_dir)?;
        Ok(report.removed_database_files > 0
            || report.removed_cache_entries > 0
            || report.removed_temp_entries > 0)
    }

    /// Resolves the path to the staged release manifest inside the given data directory.
    #[must_use]
    pub fn release_manifest_path_in(data_dir: &Path) -> PathBuf {
        if let Ok(custom_path) = std::env::var("READORA_UPDATE_MANIFEST") {
            let trimmed = custom_path.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
        data_dir.join("updates").join("release-manifest.json")
    }

    /// Reads and validates a staged release manifest from `data_dir/updates/release-manifest.json`
    /// if present. Returns `Ok(None)` when no update manifest exists on disk.
    pub fn read_release_manifest_in(
        data_dir: &Path,
    ) -> Result<Option<ReleaseManifestDto>, ApplicationError> {
        let manifest_path = Self::release_manifest_path_in(data_dir);
        if !manifest_path.is_file() {
            return Ok(None);
        }

        let raw_json = fs::read_to_string(&manifest_path).map_err(|e| {
            ApplicationError::Platform(format!("failed to read release manifest: {e}"))
        })?;
        let manifest: ReleaseManifestDto = serde_json::from_str(&raw_json).map_err(|e| {
            ApplicationError::Platform(format!("invalid release manifest JSON: {e}"))
        })?;
        if manifest.version.trim().is_empty() {
            return Err(ApplicationError::Platform(
                "release manifest is missing required version field".to_owned(),
            ));
        }
        Ok(Some(manifest))
    }

    /// Atomically stages a release manifest inside `data_dir/updates/release-manifest.json`.
    pub fn stage_release_manifest_in(
        &self,
        data_dir: &Path,
        manifest: &ReleaseManifestDto,
    ) -> Result<PathBuf, ApplicationError> {
        if manifest.version.trim().is_empty() {
            return Err(ApplicationError::Platform(
                "release manifest version must not be empty".to_owned(),
            ));
        }
        let manifest_path = Self::release_manifest_path_in(data_dir);
        let serialized = serde_json::to_vec_pretty(manifest).map_err(|e| {
            ApplicationError::Platform(format!("failed to serialize release manifest: {e}"))
        })?;
        self.atomic_write_file(&manifest_path.to_string_lossy(), &serialized)?;
        Ok(manifest_path)
    }

    /// Removes the staged release manifest from `data_dir/updates/release-manifest.json` after installation.
    pub fn clear_staged_release_manifest_in(data_dir: &Path) -> Result<bool, ApplicationError> {
        let manifest_path = Self::release_manifest_path_in(data_dir);
        if manifest_path.is_file() {
            fs::remove_file(&manifest_path).map_err(|e| {
                ApplicationError::Platform(format!("failed to remove staged manifest: {e}"))
            })?;
            if let Some(parent) = manifest_path.parent() {
                let _ = fs::remove_dir(parent);
            }
            return Ok(true);
        }
        Ok(false)
    }

    /// Returns `true` when `raw` is a syntactically valid 64-character hexadecimal SHA-256 digest.
    #[must_use]
    pub fn is_hex_sha256(raw: &str) -> bool {
        let trimmed = raw.trim().trim_start_matches("sha256:");
        trimmed.len() == 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit())
    }

    /// Computes the SHA-256 digest of `bytes` and compares it in constant time against `expected_hex`.
    #[must_use]
    pub fn verify_sha256_bytes(bytes: &[u8], expected_hex: &str) -> bool {
        let cleaned = expected_hex.trim().trim_start_matches("sha256:");
        if !Self::is_hex_sha256(cleaned) {
            return false;
        }
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let actual = format!("{:x}", hasher.finalize());
        let a = actual.as_bytes();
        let b = cleaned.to_ascii_lowercase();
        let b = b.as_bytes();
        if a.len() != b.len() {
            return false;
        }
        let mut diff = 0_u8;
        for (x, y) in a.iter().zip(b.iter()) {
            diff |= x ^ y;
        }
        diff == 0
    }

    /// Reads `file_path` and verifies its SHA-256 digest against `expected_hex`.
    pub fn verify_sha256_file(
        file_path: &Path,
        expected_hex: &str,
    ) -> Result<bool, ApplicationError> {
        let bytes = fs::read(file_path).map_err(|e| {
            ApplicationError::Platform(format!("failed to read file for SHA-256 check: {e}"))
        })?;
        Ok(Self::verify_sha256_bytes(&bytes, expected_hex))
    }

    /// Parses a GitHub Releases `/repos/{owner}/{repo}/releases/latest` JSON payload into a
    /// validated `ReleaseManifestDto`, selecting the best matching installer asset for `target_os`.
    pub fn parse_github_release_json(
        raw_json: &str,
        target_os: &str,
    ) -> Result<ReleaseManifestDto, ApplicationError> {
        Self::parse_github_release_json_for_target(raw_json, target_os, std::env::consts::ARCH)
    }

    /// Parses a GitHub Releases `/repos/{owner}/{repo}/releases/latest` JSON payload into a
    /// validated `ReleaseManifestDto`, preferring assets matching both `target_os` and `target_arch`.
    pub fn parse_github_release_json_for_target(
        raw_json: &str,
        target_os: &str,
        target_arch: &str,
    ) -> Result<ReleaseManifestDto, ApplicationError> {
        let value: serde_json::Value = serde_json::from_str(raw_json).map_err(|e| {
            ApplicationError::Platform(format!("invalid GitHub release JSON response: {e}"))
        })?;

        let is_draft = value
            .get("draft")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let is_prerelease = value
            .get("prerelease")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if is_draft || is_prerelease {
            return Err(ApplicationError::Platform(
                "latest release is a draft or prerelease".to_owned(),
            ));
        }

        let raw_tag = value
            .get("tag_name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim();
        let version = raw_tag.trim_start_matches(['v', 'V']).trim().to_owned();
        if version.is_empty() {
            return Err(ApplicationError::Platform(
                "GitHub release payload is missing tag_name".to_owned(),
            ));
        }

        let title = value
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(
                || format!("Focus Reader {version} is ready"),
                ToOwned::to_owned,
            );

        let notes = value
            .get("body")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(
                || format!("Release {version} published on GitHub Releases."),
                ToOwned::to_owned,
            );

        let published_at = value
            .get("published_at")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned();

        let html_url = value
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned);

        let os_extensions: &[&str] = match target_os {
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
        let mut selected_size: u64 = 0;
        let mut selected_url: Option<String> = None;
        let mut selected_sha256: Option<String> = None;

        if let Some(assets) = value.get("assets").and_then(serde_json::Value::as_array) {
            for asset in assets {
                let asset_name = asset
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let asset_size = asset
                    .get("size")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let asset_url = asset
                    .get("browser_download_url")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned);
                let asset_digest = asset
                    .get("digest")
                    .and_then(serde_json::Value::as_str)
                    .map(|d| d.trim_start_matches("sha256:").to_owned());

                let matches_os = os_extensions.iter().any(|ext| asset_name.contains(ext));
                if !matches_os {
                    continue;
                }
                let matches_arch = arch_tokens.is_empty()
                    || arch_tokens.iter().any(|tok| asset_name.contains(tok));
                let is_preferred_updater_bundle =
                    target_os == "macos" && asset_name.ends_with(".app.tar.gz");
                let score: u8 = match (matches_arch, is_preferred_updater_bundle) {
                    (true, true) => 4,
                    (true, false) => 3,
                    (false, _) => 2,
                };

                if score > best_score {
                    best_score = score;
                    selected_size = asset_size;
                    selected_url = asset_url;
                    selected_sha256 = asset_digest
                        .map(|d| d.trim().to_owned())
                        .filter(|d| !d.is_empty());
                    if score == 4 {
                        break;
                    }
                }
            }
        }

        let package_size_bytes = selected_size;
        let download_url = selected_url.or(html_url);
        let sha256 = selected_sha256.unwrap_or_default();

        Ok(ReleaseManifestDto {
            version,
            title,
            notes,
            package_size_bytes,
            sha256,
            published_at,
            download_url,
        })
    }
}

impl PlatformPort for NativePlatformAdapter {
    fn resolve_and_validate_pdf_path(
        &self,
        raw_path: &str,
        max_size_bytes: u64,
    ) -> Result<ResolvedFileInfo, ApplicationError> {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Err(ApplicationError::Platform(
                "file path must not be empty".to_owned(),
            ));
        }

        let input_path = Path::new(trimmed);
        let canonical = fs::canonicalize(input_path).map_err(|_| {
            ApplicationError::Platform("selected file does not exist or is inaccessible".to_owned())
        })?;

        let metadata = fs::metadata(&canonical)
            .map_err(|_| ApplicationError::Platform("unable to read file metadata".to_owned()))?;

        if !metadata.is_file() {
            return Err(ApplicationError::Platform(
                "selected path is not a regular file".to_owned(),
            ));
        }

        let file_size_bytes = metadata.len();
        if file_size_bytes == 0 {
            return Err(ApplicationError::Platform("PDF file is empty".to_owned()));
        }
        if max_size_bytes > 0 && file_size_bytes > max_size_bytes {
            return Err(ApplicationError::Platform(format!(
                "file size ({file_size_bytes} bytes) exceeds maximum allowed ({max_size_bytes} bytes)"
            )));
        }

        let canonical_str = canonical.to_string_lossy().into_owned();
        let display_name = canonical
            .file_name()
            .map(|n| sanitize_display_name(&n.to_string_lossy()))
            .unwrap_or_else(|| "Document.pdf".to_owned());

        let document_id = derive_document_id(&canonical_str)?;

        Ok(ResolvedFileInfo {
            document_id,
            canonical_path: canonical_str,
            display_name,
            file_size_bytes,
        })
    }

    fn current_unix_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(0))
            .unwrap_or(0)
    }

    fn atomic_write_file(&self, target_path: &str, bytes: &[u8]) -> Result<(), ApplicationError> {
        let target = Path::new(target_path.trim());
        if target.as_os_str().is_empty() {
            return Err(ApplicationError::Platform(
                "export target path must not be empty".to_owned(),
            ));
        }
        let parent = target.parent().ok_or_else(|| {
            ApplicationError::Platform("export target path has no parent directory".to_owned())
        })?;
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| {
                ApplicationError::Platform(format!("failed to create export directory: {e}"))
            })?;
        }

        let pid = std::process::id();
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let temp_name = format!(
            ".{}.tmp-{pid}-{now_nanos}",
            target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "export".to_owned())
        );
        let temp_path = parent.join(temp_name);

        let write_result = (|| -> Result<(), ApplicationError> {
            let mut file = File::create(&temp_path).map_err(|e| {
                ApplicationError::Platform(format!("failed to create temporary export file: {e}"))
            })?;
            file.write_all(bytes).map_err(|e| {
                ApplicationError::Platform(format!("failed to write export bytes: {e}"))
            })?;
            file.sync_all().map_err(|e| {
                ApplicationError::Platform(format!("failed to flush export file: {e}"))
            })?;
            fs::rename(&temp_path, target).map_err(|e| {
                ApplicationError::Platform(format!("failed to finalize atomic export write: {e}"))
            })?;
            Ok(())
        })();

        if write_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }

        write_result
    }

    fn remove_file_if_exists(&self, path: &str) -> Result<bool, ApplicationError> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(ApplicationError::Platform(
                "file path must not be empty".to_owned(),
            ));
        }
        match fs::remove_file(Path::new(trimmed)) {
            Ok(()) => Ok(true),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(ApplicationError::Platform(format!(
                "failed to remove file: {err}"
            ))),
        }
    }

    fn read_file_bytes(
        &self,
        path: &str,
        max_size_bytes: u64,
    ) -> Result<Vec<u8>, ApplicationError> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(ApplicationError::Platform(
                "file path must not be empty".to_owned(),
            ));
        }
        let target = Path::new(trimmed);
        let meta = fs::metadata(target).map_err(|_| {
            ApplicationError::Platform("target file does not exist or is unreadable".to_owned())
        })?;
        if !meta.is_file() {
            return Err(ApplicationError::Platform(
                "target path is not a regular file".to_owned(),
            ));
        }
        if max_size_bytes > 0 && meta.len() > max_size_bytes {
            return Err(ApplicationError::Platform(format!(
                "file size ({} bytes) exceeds maximum allowed ({max_size_bytes} bytes)",
                meta.len()
            )));
        }
        let file = File::open(target).map_err(|_| {
            ApplicationError::Platform("failed to open file for reading".to_owned())
        })?;
        let cap = usize::try_from(meta.len().min(16 * 1024 * 1024)).unwrap_or(64 * 1024);
        let mut buf = Vec::with_capacity(cap);
        if max_size_bytes > 0 {
            file.take(max_size_bytes.saturating_add(1))
                .read_to_end(&mut buf)
                .map_err(|_| ApplicationError::Platform("failed to read file bytes".to_owned()))?;
            if (buf.len() as u64) > max_size_bytes {
                return Err(ApplicationError::Platform(format!(
                    "file size exceeds maximum allowed ({max_size_bytes} bytes)"
                )));
            }
        } else {
            let mut f = file;
            f.read_to_end(&mut buf)
                .map_err(|_| ApplicationError::Platform("failed to read file bytes".to_owned()))?;
        }
        Ok(buf)
    }

    fn remove_empty_dir_if_exists(&self, path: &str) -> Result<bool, ApplicationError> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Ok(false);
        }
        match fs::remove_dir(Path::new(trimmed)) {
            Ok(()) => Ok(true),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Ok(false),
        }
    }

    fn is_path_within_dir(&self, candidate_path: &str, parent_dir: &Path) -> bool {
        let Ok(canon_parent) = fs::canonicalize(parent_dir) else {
            let candidate = Path::new(candidate_path);
            return candidate != parent_dir && candidate.starts_with(parent_dir);
        };
        let candidate = Path::new(candidate_path);
        let resolved_candidate = fs::canonicalize(candidate).or_else(|_| {
            let parent = candidate
                .parent()
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?;
            let name = candidate
                .file_name()
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
            fs::canonicalize(parent).map(|cp| cp.join(name))
        });
        match resolved_candidate {
            Ok(canon_cand) => canon_cand != canon_parent && canon_cand.starts_with(&canon_parent),
            Err(_) => false,
        }
    }
}

fn derive_document_id(canonical_path: &str) -> Result<DocumentId, ApplicationError> {
    let mut hasher = Sha256::new();
    hasher.update(canonical_path.as_bytes());
    let digest = hasher.finalize();
    let mut hex_id = String::with_capacity(36);
    hex_id.push_str("doc-");
    for byte in &digest[..16] {
        use std::fmt::Write as _;
        let _ = write!(&mut hex_id, "{byte:02x}");
    }
    Ok(DocumentId::new(hex_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_validates_files_and_performs_atomic_writes() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = NativePlatformAdapter::new();

        let file_path = dir.path().join("sample_doc.pdf");
        let file_str = file_path.to_string_lossy().into_owned();

        adapter
            .atomic_write_file(&file_str, b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF")
            .unwrap();

        let resolved = adapter
            .resolve_and_validate_pdf_path(&file_str, 1024 * 1024)
            .unwrap();
        assert_eq!(resolved.display_name, "sample_doc.pdf");
        assert!(resolved.document_id.as_str().starts_with("doc-"));

        // Size limit exceeded
        assert!(adapter.resolve_and_validate_pdf_path(&file_str, 5).is_err());
    }

    #[test]
    fn platform_uninstall_cleanup_removes_sqlite_artifacts_and_redacts_paths() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("com.readora.desktop");
        let cache_dir = dir.path().join("readora-cache");
        let adapter = NativePlatformAdapter::new();

        let db_file = data_dir.join("readora.sqlite");
        let wal_file = data_dir.join("readora.sqlite-wal");
        let cache_file = cache_dir.join("render-cache").join("page-0.png");
        adapter
            .atomic_write_file(&db_file.to_string_lossy(), b"sqlite-bytes")
            .unwrap();
        adapter
            .atomic_write_file(&wal_file.to_string_lossy(), b"wal-bytes")
            .unwrap();
        adapter
            .atomic_write_file(&cache_file.to_string_lossy(), b"png-cache-bytes")
            .unwrap();

        assert!(db_file.exists());
        assert!(cache_file.exists());
        let report =
            NativePlatformAdapter::cleanup_all_app_artifacts(&data_dir, &cache_dir).unwrap();
        assert_eq!(report.removed_database_files, 2);
        assert_eq!(report.removed_cache_entries, 1);
        assert!(report.data_dir_removed);
        assert!(report.cache_dir_removed);
        assert!(!db_file.exists());
        assert!(!wal_file.exists());
        assert!(!cache_file.exists());
        assert!(!NativePlatformAdapter::redacted_data_dir_display().is_empty());
        assert!(!NativePlatformAdapter::redacted_cache_dir_display().is_empty());
    }

    #[test]
    fn platform_uninstall_cleanup_never_deletes_unrelated_user_files_or_non_app_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("com.readora.desktop");
        let cache_dir = dir.path().join("readora-cache");
        let user_docs_dir = dir.path().join("Documents");
        let adapter = NativePlatformAdapter::new();

        let db_file = data_dir.join("readora.sqlite");
        let unrelated_file = data_dir.join("user-personal-notes.pdf");
        let external_pdf = user_docs_dir.join("contract.pdf");

        adapter
            .atomic_write_file(&db_file.to_string_lossy(), b"sqlite-bytes")
            .unwrap();
        adapter
            .atomic_write_file(&unrelated_file.to_string_lossy(), b"%PDF-1.7 user file")
            .unwrap();
        adapter
            .atomic_write_file(&external_pdf.to_string_lossy(), b"%PDF-1.7 external")
            .unwrap();

        // Refuses to clean a non-Readora directory like `Documents`
        assert!(
            NativePlatformAdapter::cleanup_all_app_artifacts(&user_docs_dir, &cache_dir).is_err()
        );
        assert!(external_pdf.exists());

        // Removes `readora.sqlite` but leaves `user-personal-notes.pdf` and `data_dir` untouched
        let report =
            NativePlatformAdapter::cleanup_all_app_artifacts(&data_dir, &cache_dir).unwrap();
        assert_eq!(report.removed_database_files, 1);
        assert!(!report.data_dir_removed);
        assert!(!db_file.exists());
        assert!(unrelated_file.exists());
        assert!(external_pdf.exists());
    }

    #[test]
    fn platform_parses_github_releases_latest_json_payload() {
        let sample_github_json = r#"{
            "tag_name": "v1.2.0",
            "name": "Focus Reader 1.2",
            "body": "Faster continuous scrolling and GitHub release verification.",
            "published_at": "2026-11-10T12:00:00Z",
            "html_url": "https://github.com/smokeInCloud060201/readora/releases/tag/v1.2.0",
            "assets": [
                {
                    "name": "Readora_1.2.0_x64-setup.exe",
                    "size": 38797312,
                    "browser_download_url": "https://github.com/smokeInCloud060201/readora/releases/download/v1.2.0/Readora_1.2.0_x64-setup.exe",
                    "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                },
                {
                    "name": "Readora_1.2.0_aarch64.dmg",
                    "size": 44040192,
                    "browser_download_url": "https://github.com/smokeInCloud060201/readora/releases/download/v1.2.0/Readora_1.2.0_aarch64.dmg",
                    "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                }
            ]
        }"#;

        let manifest =
            NativePlatformAdapter::parse_github_release_json(sample_github_json, "macos").unwrap();
        assert_eq!(manifest.version, "1.2.0");
        assert_eq!(manifest.title, "Focus Reader 1.2");
        assert_eq!(manifest.package_size_bytes, 44_040_192);
        assert_eq!(
            manifest.sha256,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            manifest.download_url.as_deref(),
            Some(
                "https://github.com/smokeInCloud060201/readora/releases/download/v1.2.0/Readora_1.2.0_aarch64.dmg"
            )
        );
    }

    #[test]
    fn platform_uninstall_cleanup_removes_internal_library_staging_dir_and_verifies_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("com.readora.desktop");
        let cache_dir = dir.path().join("readora-cache");
        let adapter = NativePlatformAdapter::new();

        let state_file = data_dir.join("library").join("state.json");
        let staged_pdf = data_dir.join("library").join("pdfs").join("doc-abc.pdf");
        adapter
            .atomic_write_file(&state_file.to_string_lossy(), br#"{"recents":[]}"#)
            .unwrap();
        adapter
            .atomic_write_file(&staged_pdf.to_string_lossy(), b"%PDF-1.7\n%%EOF")
            .unwrap();

        let empty_sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert!(NativePlatformAdapter::verify_sha256_bytes(
            b"",
            empty_sha256
        ));
        assert!(!NativePlatformAdapter::verify_sha256_bytes(
            b"tampered",
            empty_sha256
        ));

        let report =
            NativePlatformAdapter::cleanup_all_app_artifacts(&data_dir, &cache_dir).unwrap();
        assert_eq!(report.removed_cache_entries, 2);
        assert!(report.data_dir_removed);
        assert!(!data_dir.exists());
    }

    #[test]
    fn platform_rejects_repo_directories_draft_prereleases_and_cross_os_digest_mixing() {
        let dir = tempfile::tempdir().unwrap();
        let fake_repo = dir.path().join("readora");
        fs::create_dir_all(fake_repo.join("cache")).unwrap();
        fs::write(fake_repo.join("Cargo.toml"), b"[workspace]\n").unwrap();
        assert!(!NativePlatformAdapter::is_safe_readora_directory(
            &fake_repo
        ));
        assert!(!NativePlatformAdapter::is_safe_readora_directory(
            &fake_repo.join("cache")
        ));

        // Draft and prerelease GitHub payloads are rejected
        let draft_json = r#"{"tag_name":"v2.0.0","draft":true,"assets":[]}"#;
        assert!(NativePlatformAdapter::parse_github_release_json(draft_json, "macos").is_err());

        let prerelease_json = r#"{"tag_name":"v2.0.0-rc.1","prerelease":true,"assets":[]}"#;
        assert!(
            NativePlatformAdapter::parse_github_release_json(prerelease_json, "macos").is_err()
        );

        // Wrong-OS asset digest is never mixed onto an OS-matching asset without digest
        let mixed_assets_json = r#"{
            "tag_name": "v1.3.0",
            "assets": [
                {
                    "name": "Readora_1.3.0_x64-setup.exe",
                    "size": 38797312,
                    "browser_download_url": "https://example.com/win.exe",
                    "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                },
                {
                    "name": "Readora_1.3.0_aarch64.dmg",
                    "size": 44040192,
                    "browser_download_url": "https://example.com/mac.dmg"
                }
            ]
        }"#;
        let parsed = NativePlatformAdapter::parse_github_release_json_for_target(
            mixed_assets_json,
            "macos",
            "aarch64",
        )
        .unwrap();
        assert_eq!(
            parsed.download_url.as_deref(),
            Some("https://example.com/mac.dmg")
        );
        assert_eq!(parsed.sha256, "");
        assert!(!NativePlatformAdapter::is_hex_sha256(&parsed.sha256));

        // Linux sees no Linux asset -> does NOT select Windows .exe!
        let linux_parsed = NativePlatformAdapter::parse_github_release_json_for_target(
            mixed_assets_json,
            "linux",
            "x86_64",
        )
        .unwrap();
        assert!(linux_parsed.download_url.is_none());
        assert_eq!(linux_parsed.sha256, "");
    }
}
