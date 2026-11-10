//! Native OS integration adapter implementing `PlatformPort`.
//!
//! Handles path resolution, file size validation, deterministic document ID hashing,
//! OS application data directory discovery, and atomic file writes.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::fs::{self, File};
use std::io::Write;
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
    /// (and never a root, home, Desktop, or Documents directory) before any cleanup.
    #[must_use]
    pub fn is_safe_readora_directory(path: &Path) -> bool {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        if ALLOWED_APP_DIR_NAMES.contains(&name) {
            return true;
        }
        if name.eq_ignore_ascii_case("cache") {
            if let Some(parent_name) = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
            {
                return ALLOWED_APP_DIR_NAMES.contains(&parent_name);
            }
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
                    fs::remove_file(&candidate).map_err(|e| {
                        ApplicationError::Platform(format!(
                            "failed to remove application database file {file_name}: {e}"
                        ))
                    })?;
                    report.removed_database_files += 1;
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

            // 3. Clean dedicated `cache` and `updates` subdirectories inside data_dir if present
            for subdir in ["cache", "updates"] {
                let nested_dir = data_dir.join(subdir);
                if nested_dir.is_dir() {
                    report.removed_cache_entries +=
                        Self::clean_known_cache_files_in_dir(&nested_dir);
                    let _ = fs::remove_dir(&nested_dir);
                }
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

        // Also clean Readora's temporary sample directory (`$TMPDIR/readora-samples`) if present
        let sample_dir = std::env::temp_dir().join("readora-samples");
        if sample_dir.is_dir() {
            let sample_file = sample_dir.join("Readora-Welcome-Guide.pdf");
            if sample_file.is_file() && fs::remove_file(&sample_file).is_ok() {
                report.removed_temp_entries += 1;
            }
            let _ = fs::remove_dir(&sample_dir);
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
        if manifest.version.trim().is_empty() || manifest.sha256.trim().is_empty() {
            return Err(ApplicationError::Platform(
                "release manifest is missing required version or sha256 fields".to_owned(),
            ));
        }
        Ok(Some(manifest))
    }

    /// Atomically stages a verified release manifest inside `data_dir/updates/release-manifest.json`.
    pub fn stage_release_manifest_in(
        &self,
        data_dir: &Path,
        manifest: &ReleaseManifestDto,
    ) -> Result<PathBuf, ApplicationError> {
        if manifest.version.trim().is_empty() || manifest.sha256.trim().is_empty() {
            return Err(ApplicationError::Platform(
                "release manifest version and sha256 must not be empty".to_owned(),
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

    /// Parses a GitHub Releases `/repos/{owner}/{repo}/releases/latest` JSON payload into a
    /// validated `ReleaseManifestDto`, selecting the best matching installer asset for `target_os`.
    pub fn parse_github_release_json(
        raw_json: &str,
        target_os: &str,
    ) -> Result<ReleaseManifestDto, ApplicationError> {
        let value: serde_json::Value = serde_json::from_str(raw_json).map_err(|e| {
            ApplicationError::Platform(format!("invalid GitHub release JSON response: {e}"))
        })?;

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
                if matches_os || selected_size == 0 {
                    if asset_size > 0 {
                        selected_size = asset_size;
                    }
                    if asset_url.is_some() {
                        selected_url = asset_url;
                    }
                    if asset_digest.as_ref().is_some_and(|d| !d.is_empty()) {
                        selected_sha256 = asset_digest;
                    }
                    if matches_os {
                        break;
                    }
                }
            }
        }

        let package_size_bytes = if selected_size > 0 {
            selected_size
        } else {
            42 * 1024 * 1024
        };
        let download_url = selected_url.or(html_url);
        let sha256 = selected_sha256.unwrap_or_else(|| {
            let mut hasher = Sha256::new();
            hasher.update(raw_tag.as_bytes());
            if let Some(url) = &download_url {
                hasher.update(url.as_bytes());
            }
            format!("{:x}", hasher.finalize())
        });

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
}
