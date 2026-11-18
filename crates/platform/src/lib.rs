//! Native OS integration adapter implementing `PlatformPort`.
//!
//! Handles path resolution, file size validation, deterministic document ID hashing,
//! OS application data directory discovery, and atomic file writes.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use app_application::{
    AppCleanupReportDto, ApplicationError, PlatformPort, ReleaseManifestDto, ResolvedFileInfo,
};
use app_domain::{DocumentId, SemVer, has_unsafe_os_path_or_ads, sanitize_display_name};
use sha2::{Digest, Sha256};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
#[inline]
fn is_reparse_or_symlink(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    meta.file_type().is_symlink() || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

#[cfg(not(windows))]
#[inline]
fn is_reparse_or_symlink(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

#[inline]
fn is_regular_non_symlink_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !is_reparse_or_symlink(&m))
}

#[inline]
fn is_non_symlink_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !is_reparse_or_symlink(&m))
}

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
        if !path.is_absolute() {
            return false;
        }
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
    /// leaving open `readora.sqlite*` files and the live `data_dir` intact so POSIX/Windows file
    /// descriptors remain valid for the running process.
    pub fn cleanup_live_app_artifacts(
        data_dir: &Path,
        cache_dir: &Path,
        clean_shared_sample_dir: bool,
    ) -> Result<AppCleanupReportDto, ApplicationError> {
        Self::cleanup_app_artifacts_internal(data_dir, cache_dir, true, clean_shared_sample_dir)
    }

    /// Cleans ephemeral isolated test directories during `AppCore::drop` when SQLite is in-memory
    /// and removing empty `data_dir` allows the ephemeral parent directory to be cleaned up.
    pub fn cleanup_ephemeral_app_artifacts(
        data_dir: &Path,
        cache_dir: &Path,
    ) -> Result<AppCleanupReportDto, ApplicationError> {
        Self::cleanup_app_artifacts_internal(data_dir, cache_dir, false, false)
    }

    fn cleanup_app_artifacts_internal(
        data_dir: &Path,
        cache_dir: &Path,
        is_live_cleanup: bool,
        clean_shared_sample_dir: bool,
    ) -> Result<AppCleanupReportDto, ApplicationError> {
        let mut report = AppCleanupReportDto {
            redacted_data_dir: Self::redacted_data_dir_display().to_owned(),
            redacted_cache_dir: Self::redacted_cache_dir_display().to_owned(),
            ..AppCleanupReportDto::default()
        };

        if fs::symlink_metadata(data_dir).is_ok() {
            if !is_non_symlink_dir(data_dir) || !Self::is_safe_readora_directory(data_dir) {
                return Err(ApplicationError::Platform(
                    "refusing to clean directory that is not a dedicated Readora application folder"
                        .to_owned(),
                ));
            }

            // 1. Remove known SQLite database files created by Readora ONLY when no live
            //    SqliteStorage connection is open (unlinking on POSIX orphans the live DB inode).
            if !is_live_cleanup {
                for file_name in KNOWN_SQLITE_FILES {
                    let candidate = data_dir.join(file_name);
                    if is_regular_non_symlink_file(&candidate) {
                        fs::remove_file(&candidate).map_err(|e| {
                            ApplicationError::Platform(format!(
                                "failed to remove application database file {file_name}: {e}"
                            ))
                        })?;
                        report.removed_database_files += 1;
                    }
                }
            }

            // 2. Remove Readora atomic-write temp files (`.export.tmp-*`, `.readora*.tmp-*`) in data_dir
            if let Ok(entries) = fs::read_dir(data_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(fname) = path.file_name().and_then(|n| n.to_str())
                        && is_regular_non_symlink_file(&path)
                        && fname.starts_with('.')
                        && fname.contains(".tmp-")
                        && fs::remove_file(&path).is_ok()
                    {
                        report.removed_temp_entries += 1;
                    }
                }
            }

            // 3. Clean dedicated `cache`, `updates`, `samples`, and internal `library` subdirectories inside data_dir
            for subdir in ["cache", "updates"] {
                let nested_dir = data_dir.join(subdir);
                if is_non_symlink_dir(&nested_dir) {
                    report.removed_cache_entries +=
                        Self::clean_known_cache_files_in_dir(&nested_dir);
                    let _ = fs::remove_dir(&nested_dir);
                }
            }

            let samples_dir = data_dir.join("samples");
            if is_non_symlink_dir(&samples_dir) {
                let sample_file = samples_dir.join("Readora-Welcome-Guide.pdf");
                if is_regular_non_symlink_file(&sample_file)
                    && fs::remove_file(&sample_file).is_ok()
                {
                    report.removed_temp_entries += 1;
                }
                let _ = fs::remove_dir(&samples_dir);
            }

            let library_dir = data_dir.join("library");
            if is_non_symlink_dir(&library_dir) {
                report.removed_cache_entries += Self::clean_internal_library_dir(&library_dir);
                let _ = fs::remove_dir(&library_dir);
            }

            // Remove data_dir only when not in live mode and completely empty
            if !is_live_cleanup && fs::remove_dir(data_dir).is_ok() {
                report.data_dir_removed = true;
            }
        }

        if fs::symlink_metadata(cache_dir).is_ok() {
            if !is_non_symlink_dir(cache_dir) || !Self::is_safe_readora_directory(cache_dir) {
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
            // Also clean legacy shared temporary sample directory (`$TMPDIR/readora-samples`) if present
            let sample_dir = std::env::temp_dir().join("readora-samples");
            if is_non_symlink_dir(&sample_dir) {
                let sample_file = sample_dir.join("Readora-Welcome-Guide.pdf");
                if is_regular_non_symlink_file(&sample_file)
                    && fs::remove_file(&sample_file).is_ok()
                {
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
            if is_regular_non_symlink_file(&path) {
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
            } else if is_non_symlink_dir(&path)
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| name == "pdfs")
            {
                if let Ok(pdf_entries) = fs::read_dir(&path) {
                    for pdf_entry in pdf_entries.flatten() {
                        let pdf_path = pdf_entry.path();
                        if is_non_symlink_dir(&pdf_path) {
                            if let Ok(sub_entries) = fs::read_dir(&pdf_path) {
                                for sub_entry in sub_entries.flatten() {
                                    let sub_path = sub_entry.path();
                                    let is_staged_sub_pdf = is_regular_non_symlink_file(&sub_path)
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
                        let is_staged_pdf = is_regular_non_symlink_file(&pdf_path)
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
            if is_regular_non_symlink_file(&path) {
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
            } else if is_non_symlink_dir(&path)
                && let Some(sub_name) = path.file_name().and_then(|n| n.to_str())
                && (matches!(
                    sub_name,
                    "render-cache" | "thumbnails" | "pages" | "temp" | "updates"
                ) || sub_name.starts_with(".stage-"))
            {
                if sub_name.starts_with(".stage-") {
                    removed += Self::clean_stage_subdir_safely(&path, 0);
                } else {
                    removed += Self::clean_known_cache_files_in_dir(&path);
                }
                let _ = fs::remove_dir(&path);
            }
        }
        removed
    }

    fn clean_stage_subdir_safely(dir: &Path, depth: usize) -> usize {
        if depth > 8 {
            return 0;
        }
        let mut removed = 0;
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if is_reparse_or_symlink(&meta) {
                let removed_link = if cfg!(windows) && meta.is_dir() {
                    fs::remove_dir(&path).is_ok()
                } else {
                    fs::remove_file(&path).is_ok() || fs::remove_dir(&path).is_ok()
                };
                if removed_link {
                    removed += 1;
                }
            } else if meta.is_dir() {
                removed += Self::clean_stage_subdir_safely(&path, depth + 1);
                let _ = fs::remove_dir(&path);
            } else if meta.is_file() && fs::remove_file(&path).is_ok() {
                removed += 1;
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
        #[cfg(any(test, debug_assertions))]
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
        const MAX_RELEASE_MANIFEST_BYTES: u64 = 1024 * 1024;

        let manifest_path = Self::release_manifest_path_in(data_dir);
        match fs::symlink_metadata(&manifest_path) {
            Ok(meta) => {
                if is_reparse_or_symlink(&meta) || !meta.is_file() {
                    return Err(ApplicationError::Platform(
                        "refusing to read symlinked or non-regular release manifest".to_owned(),
                    ));
                }
                if meta.len() > MAX_RELEASE_MANIFEST_BYTES {
                    return Err(ApplicationError::Platform(
                        "staged release manifest exceeds maximum allowed size".to_owned(),
                    ));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(ApplicationError::Platform(format!(
                    "failed to inspect release manifest: {err}"
                )));
            }
        }

        let file = File::open(&manifest_path).map_err(|e| {
            ApplicationError::Platform(format!("failed to open release manifest: {e}"))
        })?;
        let mut raw_bytes = Vec::new();
        file.take(MAX_RELEASE_MANIFEST_BYTES.saturating_add(1))
            .read_to_end(&mut raw_bytes)
            .map_err(|e| {
                ApplicationError::Platform(format!("failed to read release manifest: {e}"))
            })?;
        if (raw_bytes.len() as u64) > MAX_RELEASE_MANIFEST_BYTES {
            return Err(ApplicationError::Platform(
                "staged release manifest exceeds maximum allowed size".to_owned(),
            ));
        }

        let manifest: ReleaseManifestDto = serde_json::from_slice(&raw_bytes).map_err(|e| {
            ApplicationError::Platform(format!("invalid release manifest JSON: {e}"))
        })?;
        let normalized_ver = manifest
            .version
            .trim()
            .trim_start_matches(['v', 'V'])
            .trim();
        if normalized_ver.is_empty() {
            return Err(ApplicationError::Platform(
                "release manifest is missing required version field".to_owned(),
            ));
        }
        let _ = SemVer::parse(normalized_ver)?;
        if let Some(ref url) = manifest.download_url
            && !app_application::is_allowed_github_download_url(url)
        {
            return Err(ApplicationError::Platform(
                "release manifest download_url is not an allowlisted https:// GitHub URL"
                    .to_owned(),
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

    /// Streams `file_path` in bounded chunks and verifies its SHA-256 digest against `expected_hex`.
    pub fn verify_sha256_file(
        file_path: &Path,
        expected_hex: &str,
    ) -> Result<bool, ApplicationError> {
        let cleaned = expected_hex.trim().trim_start_matches("sha256:");
        if !Self::is_hex_sha256(cleaned) {
            return Ok(false);
        }
        if !is_regular_non_symlink_file(file_path) {
            return Err(ApplicationError::Platform(
                "refusing to verify SHA-256 of symlink or non-regular file".to_owned(),
            ));
        }
        let mut file = File::open(file_path).map_err(|e| {
            ApplicationError::Platform(format!("failed to open file for SHA-256 check: {e}"))
        })?;
        let mut hasher = Sha256::new();
        let mut buf = [0_u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|e| {
                ApplicationError::Platform(format!("failed to read file for SHA-256 check: {e}"))
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let actual = format!("{:x}", hasher.finalize());
        let expected_lower = cleaned.to_ascii_lowercase();
        let a = actual.as_bytes();
        let b = expected_lower.as_bytes();
        if a.len() != b.len() {
            return Ok(false);
        }
        let mut diff = 0_u8;
        for (x, y) in a.iter().zip(b.iter()) {
            diff |= x ^ y;
        }
        Ok(diff == 0)
    }

    /// Parses a GitHub Releases `/repos/{owner}/{repo}/releases/latest` JSON payload into a
    /// validated `ReleaseManifestDto`, selecting the best matching installer asset for `target_os`.
    pub fn parse_github_release_json(
        raw_json: &str,
        target_os: &str,
    ) -> Result<ReleaseManifestDto, ApplicationError> {
        let default_arch = if target_os == std::env::consts::OS {
            std::env::consts::ARCH
        } else if target_os == "macos" {
            "aarch64"
        } else {
            "x86_64"
        };
        Self::parse_github_release_json_for_target(raw_json, target_os, default_arch)
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
        let _ = SemVer::parse(&version)?;

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
            .filter(|u| {
                u.starts_with("https://")
                    && !u
                        .chars()
                        .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
            })
            .map(ToOwned::to_owned);

        let os_extensions: &[&str] = match target_os {
            "macos" => &[".app.tar.gz", ".dmg", ".pkg"],
            "windows" => &[".msi", ".exe"],
            "linux" => &[".deb", ".appimage", ".rpm"],
            _ => &[".dmg", ".msi", ".appimage"],
        };

        let arch_tokens: &[&str] = match target_arch {
            "aarch64" | "arm64" => &["aarch64", "arm64", "universal"],
            "x86_64" | "x64" | "amd64" => &["x86_64", "x64", "amd64", "win64", "universal"],
            _ => &[],
        };
        let foreign_arch_tokens: &[&str] = match target_arch {
            "aarch64" | "arm64" => &["x86_64", "x64", "amd64", "win64", "win32", "i386", "i686"],
            "x86_64" | "x64" | "amd64" => &["aarch64", "arm64", "armv7", "armhf"],
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
                    .trim()
                    .to_ascii_lowercase();
                let is_sidecar = asset_name.is_empty()
                    || asset_name.starts_with("release-manifest")
                    || asset_name.ends_with(".json")
                    || asset_name.ends_with(".sig")
                    || asset_name.ends_with(".sha256")
                    || asset_name.ends_with(".sha512")
                    || asset_name.ends_with(".asc")
                    || asset_name.ends_with(".blockmap")
                    || asset_name.ends_with(".txt")
                    || asset_name.ends_with(".yml")
                    || asset_name.ends_with(".yaml")
                    || asset_name.ends_with(".md");
                if is_sidecar {
                    continue;
                }

                let matches_os = os_extensions.iter().any(|ext| asset_name.ends_with(ext));
                if !matches_os {
                    continue;
                }
                if !asset_name.contains("universal")
                    && foreign_arch_tokens
                        .iter()
                        .any(|tok| asset_name.contains(tok))
                {
                    continue;
                }

                let asset_size = asset
                    .get("size")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let asset_url = asset
                    .get("browser_download_url")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned);
                if let Some(ref url) = asset_url
                    && (!url.starts_with("https://")
                        || url
                            .chars()
                            .any(|c| c.is_control() || c.is_whitespace() || c == '\\'))
                {
                    continue;
                }
                let asset_digest = asset
                    .get("digest")
                    .and_then(serde_json::Value::as_str)
                    .map(|d| d.trim_start_matches("sha256:").to_owned());

                let matches_arch = arch_tokens.is_empty()
                    || arch_tokens.iter().any(|tok| asset_name.contains(tok));
                let is_preferred_updater_bundle = (target_os == "macos"
                    && asset_name.ends_with(".app.tar.gz"))
                    || (target_os == "linux" && asset_name.ends_with(".deb"));
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
        if has_unsafe_os_path_or_ads(trimmed) {
            return Err(ApplicationError::Platform(
                "unsafe or unsupported file path syntax".to_owned(),
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
            return Err(ApplicationError::FileTooLarge {
                size_bytes: file_size_bytes,
                max_bytes: max_size_bytes,
            });
        }

        let canonical_str = normalize_canonical_path_string(&canonical)?;
        if has_unsafe_os_path_or_ads(&canonical_str) {
            return Err(ApplicationError::Platform(
                "resolved file path uses an unsafe Windows device or UNC location".to_owned(),
            ));
        }
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

        if let Ok(meta) = fs::symlink_metadata(target)
            && meta.file_type().is_symlink()
        {
            return Err(ApplicationError::Platform(
                "refusing to write atomically over a symbolic link".to_owned(),
            ));
        }

        let pid = std::process::id();
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let safe_base = target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "export".to_owned());

        let (mut file, temp_path) = {
            let mut opened = None;
            let mut last_err = None;
            for _attempt in 0..8 {
                let seq = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
                let temp_name = format!(".{safe_base}.tmp-{pid}-{now_nanos}-{seq}");
                let candidate = parent.join(temp_name);
                let mut opts = OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                opts.mode(0o600);
                match opts.open(&candidate) {
                    Ok(f) => {
                        opened = Some((f, candidate));
                        break;
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                        last_err = Some(err);
                    }
                    Err(err) => {
                        return Err(ApplicationError::Platform(format!(
                            "failed to create temporary export file: {err}"
                        )));
                    }
                }
            }
            match opened {
                Some(pair) => pair,
                None => {
                    return Err(ApplicationError::Platform(format!(
                        "failed to allocate unique temporary file: {}",
                        last_err
                            .map(|e| e.to_string())
                            .unwrap_or_else(|| "file exists".to_owned())
                    )));
                }
            }
        };

        let write_result = (|| -> Result<(), ApplicationError> {
            file.write_all(bytes).map_err(|e| {
                ApplicationError::Platform(format!("failed to write export bytes: {e}"))
            })?;
            file.sync_all().map_err(|e| {
                ApplicationError::Platform(format!("failed to flush export file: {e}"))
            })?;
            drop(file);
            if let Ok(meta) = fs::symlink_metadata(target)
                && meta.file_type().is_symlink()
            {
                return Err(ApplicationError::Platform(
                    "refusing to replace symbolic link target".to_owned(),
                ));
            }
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
            return Err(ApplicationError::FileTooLarge {
                size_bytes: meta.len(),
                max_bytes: max_size_bytes,
            });
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
                return Err(ApplicationError::FileTooLarge {
                    size_bytes: buf.len() as u64,
                    max_bytes: max_size_bytes,
                });
            }
        } else {
            let mut f = file;
            f.read_to_end(&mut buf)
                .map_err(|_| ApplicationError::Platform("failed to read file bytes".to_owned()))?;
        }
        Ok(buf)
    }

    fn read_verified_pdf_bytes(
        &self,
        raw_path: &str,
        expected_doc_id: &DocumentId,
        max_size_bytes: u64,
    ) -> Result<Vec<u8>, ApplicationError> {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() || has_unsafe_os_path_or_ads(trimmed) {
            return Err(ApplicationError::Platform(
                "unsafe or empty PDF file path".to_owned(),
            ));
        }

        let input_path = Path::new(trimmed);
        let pre_meta = fs::symlink_metadata(input_path).map_err(|_| {
            ApplicationError::Platform("target PDF file does not exist or is unreadable".to_owned())
        })?;
        if is_reparse_or_symlink(&pre_meta) || !pre_meta.is_file() {
            return Err(ApplicationError::Platform(
                "refusing to read symlinked or non-regular PDF path".to_owned(),
            ));
        }

        let resolved = self.resolve_and_validate_pdf_path(trimmed, max_size_bytes)?;
        if &resolved.document_id != expected_doc_id {
            return Err(ApplicationError::Platform(
                "document identity does not match persisted path".to_owned(),
            ));
        }

        let canon_meta =
            fs::symlink_metadata(Path::new(&resolved.canonical_path)).map_err(|_| {
                ApplicationError::Platform("unable to inspect resolved PDF file".to_owned())
            })?;
        if is_reparse_or_symlink(&canon_meta) || !canon_meta.is_file() {
            return Err(ApplicationError::Platform(
                "refusing to read symlinked or non-regular PDF target".to_owned(),
            ));
        }

        let file = File::open(Path::new(&resolved.canonical_path)).map_err(|_| {
            ApplicationError::Platform("failed to open PDF file for reading".to_owned())
        })?;
        let opened_meta = file.metadata().map_err(|_| {
            ApplicationError::Platform("unable to inspect opened PDF handle".to_owned())
        })?;
        if !opened_meta.is_file() {
            return Err(ApplicationError::Platform(
                "opened handle is not a regular file".to_owned(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if pre_meta.dev() != opened_meta.dev() || pre_meta.ino() != opened_meta.ino() {
                return Err(ApplicationError::Platform(
                    "target PDF file changed concurrently during open".to_owned(),
                ));
            }
        }
        let file_len = opened_meta.len();
        if file_len == 0 {
            return Err(ApplicationError::Platform("PDF file is empty".to_owned()));
        }
        if max_size_bytes > 0 && file_len > max_size_bytes {
            return Err(ApplicationError::FileTooLarge {
                size_bytes: file_len,
                max_bytes: max_size_bytes,
            });
        }

        let cap = usize::try_from(file_len.min(16 * 1024 * 1024)).unwrap_or(64 * 1024);
        let mut buf = Vec::with_capacity(cap);
        if max_size_bytes > 0 {
            file.take(max_size_bytes.saturating_add(1))
                .read_to_end(&mut buf)
                .map_err(|_| ApplicationError::Platform("failed to read PDF bytes".to_owned()))?;
            if (buf.len() as u64) > max_size_bytes {
                return Err(ApplicationError::FileTooLarge {
                    size_bytes: buf.len() as u64,
                    max_bytes: max_size_bytes,
                });
            }
        } else {
            let mut f = file;
            f.read_to_end(&mut buf)
                .map_err(|_| ApplicationError::Platform("failed to read PDF bytes".to_owned()))?;
        }

        let header_slice = &buf[..buf.len().min(1024)];
        if !header_slice.windows(5).any(|w| w == b"%PDF-") {
            return Err(ApplicationError::Platform(
                "target file does not begin with a valid %PDF- header".to_owned(),
            ));
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
        use std::path::Component;

        let trimmed = candidate_path.trim();
        if trimmed.is_empty() || has_unsafe_os_path_or_ads(trimmed) {
            return false;
        }
        let Ok(canon_parent) = fs::canonicalize(parent_dir) else {
            return false;
        };
        let candidate = Path::new(trimmed);
        if candidate
            .components()
            .any(|c| matches!(c, Component::ParentDir))
            || trimmed.split(['/', '\\']).any(|seg| seg == "..")
        {
            return false;
        }

        if let Ok(canon_cand) = fs::canonicalize(candidate) {
            return canon_cand != canon_parent && canon_cand.starts_with(&canon_parent);
        }

        // Only allow resolving `candidate.parent()` when `candidate` itself does not exist at all
        // (even as a broken symlink), has a valid file_name, and contains zero `..` or `.` segments.
        if fs::symlink_metadata(candidate).is_ok() {
            return false;
        }
        if candidate
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
            || trimmed
                .split(['/', '\\'])
                .any(|seg| seg == ".." || seg == ".")
        {
            return false;
        }
        let (Some(cand_parent), Some(name)) = (candidate.parent(), candidate.file_name()) else {
            return false;
        };
        let Ok(canon_cand_parent) = fs::canonicalize(cand_parent) else {
            return false;
        };
        let canon_cand = canon_cand_parent.join(name);
        canon_cand != canon_parent && canon_cand.starts_with(&canon_parent)
    }
}

fn normalize_canonical_path_string(canonical: &Path) -> Result<String, ApplicationError> {
    #[cfg(windows)]
    {
        use std::path::Component;
        use std::path::Prefix;
        if let Some(Component::Prefix(prefix)) = canonical.components().next() {
            match prefix.kind() {
                Prefix::VerbatimUNC(_, _) | Prefix::UNC(_, _) | Prefix::DeviceNS(_) => {
                    return Err(ApplicationError::Platform(
                        "refusing UNC or Windows DOS device path".to_owned(),
                    ));
                }
                Prefix::VerbatimDisk(_) => {
                    let s = canonical.to_string_lossy();
                    if let Some(stripped) = s.strip_prefix(r"\\?\") {
                        return Ok(stripped.to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(canonical.to_string_lossy().into_owned())
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

    #[test]
    fn is_path_within_dir_blocks_dotdot_traversal_even_when_parent_dir_missing() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = NativePlatformAdapter::new();
        let outside_file = dir.path().join("outside.pdf");
        fs::write(&outside_file, b"%PDF-1.7\n%%EOF").unwrap();

        let library_pdfs = dir
            .path()
            .join("com.readora.desktop")
            .join("library")
            .join("pdfs");
        assert!(!library_pdfs.exists());

        let traversal = format!("{}/../../../outside.pdf", library_pdfs.to_string_lossy());
        assert!(!adapter.is_path_within_dir(&traversal, &library_pdfs));

        let nonexistent_inside = format!("{}/abc/staged.pdf", library_pdfs.to_string_lossy());
        assert!(!adapter.is_path_within_dir(&nonexistent_inside, &library_pdfs));

        // Now create `library/pdfs/abc` and verify traversal is still rejected while legitimate child succeeds
        let sub_dir = library_pdfs.join("abc");
        fs::create_dir_all(&sub_dir).unwrap();
        let staged_file = sub_dir.join("staged.pdf");
        fs::write(&staged_file, b"%PDF-1.7\n%%EOF").unwrap();

        assert!(!adapter.is_path_within_dir(&traversal, &library_pdfs));
        assert!(!adapter.is_path_within_dir(&library_pdfs.to_string_lossy(), &library_pdfs));
        assert!(adapter.is_path_within_dir(&staged_file.to_string_lossy(), &library_pdfs));
        assert!(adapter.is_path_within_dir(&sub_dir.to_string_lossy(), &library_pdfs));

        // After staged_file is removed, checking its already-removed path or its parent subdir still works safely
        fs::remove_file(&staged_file).unwrap();
        assert!(adapter.is_path_within_dir(&staged_file.to_string_lossy(), &library_pdfs));
        assert!(!adapter.is_path_within_dir(
            &format!("{}/./staged.pdf", sub_dir.to_string_lossy()),
            &library_pdfs
        ));
    }

    #[test]
    fn round2_platform_sidecar_arch_filtering_live_cleanup_and_verified_pdf_read() {
        let valid_sha = "b".repeat(64);
        let release_json = serde_json::json!({
            "tag_name": "v1.1.3",
            "html_url": "https://github.com/smokeInCloud060201/readora/releases/tag/v1.1.3",
            "assets": [
                {
                    "name": "Readora_1.1.3_macos-aarch64.app.tar.gz.sha256",
                    "size": 128,
                    "browser_download_url": "https://github.com/smokeInCloud060201/readora/releases/download/v1.1.3/Readora_1.1.3_macos-aarch64.app.tar.gz.sha256"
                },
                {
                    "name": "Readora_1.1.3_macos-aarch64.app.tar.gz.sig",
                    "size": 128,
                    "browser_download_url": "https://github.com/smokeInCloud060201/readora/releases/download/v1.1.3/Readora_1.1.3_macos-aarch64.app.tar.gz.sig"
                },
                {
                    "name": "Readora_1.1.3_macos-x86_64.dmg",
                    "size": 12_000_000,
                    "digest": format!("sha256:{}", "c".repeat(64)),
                    "browser_download_url": "https://github.com/smokeInCloud060201/readora/releases/download/v1.1.3/Readora_1.1.3_macos-x86_64.dmg"
                },
                {
                    "name": "Readora_1.1.3_macos-aarch64.dmg",
                    "size": 11_000_000,
                    "digest": format!("sha256:{valid_sha}"),
                    "browser_download_url": "https://github.com/smokeInCloud060201/readora/releases/download/v1.1.3/Readora_1.1.3_macos-aarch64.dmg"
                }
            ]
        })
        .to_string();

        let parsed = NativePlatformAdapter::parse_github_release_json_for_target(
            &release_json,
            "macos",
            "aarch64",
        )
        .unwrap();
        assert_eq!(
            parsed.download_url.as_deref(),
            Some(
                "https://github.com/smokeInCloud060201/readora/releases/download/v1.1.3/Readora_1.1.3_macos-aarch64.dmg"
            )
        );
        assert_eq!(parsed.sha256, valid_sha);

        assert!(app_application::is_allowed_github_download_url_for_repo(
            "https://github.com/smokeInCloud060201/readora/releases/download/v1.1.2/Readora.dmg",
            "smokeInCloud060201/readora",
        ));
        assert!(!app_application::is_allowed_github_download_url_for_repo(
            "https://github.com/other/repo/releases/download/v1.1.2/Readora.dmg",
            "smokeInCloud060201/readora",
        ));
        assert!(!app_application::is_allowed_github_download_url_for_repo(
            "https://github.com:8443/smokeInCloud060201/readora/releases/download/v1.1.2/Readora.dmg",
            "smokeInCloud060201/readora",
        ));

        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("com.readora.desktop");
        let cache_dir = temp.path().join("readora-cache");
        fs::create_dir_all(data_dir.join("cache")).unwrap();
        fs::create_dir_all(&cache_dir).unwrap();
        let sqlite_path = data_dir.join("readora.sqlite");
        let tile_path = data_dir.join("cache").join("tile.png");
        fs::write(&sqlite_path, b"SQLite format 3\0").unwrap();
        fs::write(&tile_path, b"pngdata").unwrap();

        NativePlatformAdapter::cleanup_live_app_artifacts(&data_dir, &cache_dir, false).unwrap();
        assert!(data_dir.exists());
        assert!(sqlite_path.exists());
        assert!(!tile_path.exists());

        let pdf_path = temp.path().join("verified.pdf");
        let pdf_bytes = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF";
        fs::write(&pdf_path, pdf_bytes).unwrap();
        let pdf_path_str = pdf_path.to_string_lossy().into_owned();
        let adapter = NativePlatformAdapter::new();
        let resolved = adapter
            .resolve_and_validate_pdf_path(&pdf_path_str, 1024 * 1024)
            .unwrap();
        let read_back = adapter
            .read_verified_pdf_bytes(&pdf_path_str, &resolved.document_id, 1024 * 1024)
            .unwrap();
        assert_eq!(read_back, pdf_bytes);
        let wrong_id = DocumentId::new("wrong-doc-id").unwrap();
        assert!(
            adapter
                .read_verified_pdf_bytes(&pdf_path_str, &wrong_id, 1024 * 1024)
                .is_err()
        );
    }
}
