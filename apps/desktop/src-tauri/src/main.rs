//! Binary entry point for the Readora desktop shell.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::fs::{File, OpenOptions};
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_core::AppCore;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use platform::NativePlatformAdapter;
use readora_desktop_lib::commands::OFFICIAL_RELEASE_REPO;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use readora_desktop_lib::server::verify_downloaded_asset_staged;
use readora_desktop_lib::server::{
    MAX_HEADER_DURATION, build_init_script, generate_session_token, is_allowed_navigation_url,
    read_and_authorize_http_request, resolve_trusted_ui_dist_dir, route_http_request,
};
use readora_desktop_lib::{DesktopCommandHandler, init_tracing};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

const HTTP_WORKER_COUNT: usize = 8;
const HTTP_QUEUE_CAPACITY: usize = 64;
const SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const MAX_SELF_UPDATE_BYTES: &str = "268435456"; // 256 MiB
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static BACKUP_SEQ: AtomicU64 = AtomicU64::new(1);

struct UpdateInProgressGuard;

impl Drop for UpdateInProgressGuard {
    fn drop(&mut self) {
        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn copy_staged_installer_exclusively(
    src_path: &Path,
    downloads_dir: &Path,
    file_name: &str,
) -> Option<PathBuf> {
    let dl_meta = std::fs::symlink_metadata(downloads_dir).ok()?;
    if !dl_meta.is_dir() || dl_meta.file_type().is_symlink() {
        return None;
    }
    let clean_name = Path::new(file_name).file_name()?.to_str()?;
    let mut src_file = File::open(src_path).ok()?;

    let (stem, ext) = match clean_name.rsplit_once('.') {
        Some((s, e)) => (s, Some(e)),
        None => (clean_name, None),
    };

    for attempt in 1..=99_u16 {
        let candidate_name = if attempt == 1 {
            clean_name.to_owned()
        } else if let Some(ext) = ext {
            format!("{stem}-{attempt}.{ext}")
        } else {
            format!("{stem}-{attempt}")
        };
        let dest_path = downloads_dir.join(candidate_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest_path)
        {
            Ok(mut dest_file) => {
                if std::io::copy(&mut src_file, &mut dest_file).is_ok()
                    && dest_file.sync_all().is_ok()
                {
                    return Some(dest_path);
                }
                drop(dest_file);
                let _ = std::fs::remove_file(&dest_path);
                return None;
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn verify_bundle_no_escaping_symlinks(bundle_root: &Path) -> bool {
    let Ok(canon_bundle) = std::fs::canonicalize(bundle_root) else {
        return false;
    };
    fn walk(dir: &Path, canon_bundle: &Path, depth: usize) -> bool {
        if depth > 16 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                return false;
            };
            if meta.file_type().is_symlink() {
                let Ok(target_canon) = std::fs::canonicalize(&path) else {
                    return false;
                };
                if !target_canon.starts_with(canon_bundle) {
                    return false;
                }
            } else if meta.is_dir() && !walk(&path, canon_bundle, depth + 1) {
                return false;
            }
        }
        true
    }
    walk(bundle_root, &canon_bundle, 0)
}

#[cfg(target_os = "windows")]
fn resolve_windows_tool(tool_name: &str, in_system32: bool) -> PathBuf {
    let sys_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let base = PathBuf::from(sys_root);
    if in_system32 {
        base.join("System32").join(tool_name)
    } else {
        base.join(tool_name)
    }
}

#[cfg(target_os = "macos")]
fn inspect_current_bundle_team_id() -> Option<String> {
    let current_app = std::env::current_exe().ok().and_then(|exe| {
        let contents_dir = exe.parent()?.parent()?;
        let app_dir = contents_dir.parent()?;
        if app_dir.extension().and_then(|e| e.to_str()) == Some("app") {
            Some(app_dir.to_path_buf())
        } else {
            None
        }
    })?;
    let output = Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=4"])
        .arg(&current_app)
        .output()
        .ok()?;
    let info = String::from_utf8_lossy(&output.stderr);
    for line in info.lines() {
        if let Some(raw_team) = line.strip_prefix("TeamIdentifier=") {
            let trimmed = raw_team.trim();
            if trimmed.len() == 10 && trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy)]
enum DesktopUserEvent {
    Quit,
}

fn resolve_ui_dist_dir_for_exe(exe_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(trusted) = resolve_trusted_ui_dist_dir(exe_path) {
        return Some(trusted);
    }

    // Strictly gate workspace / CWD fallbacks to debug builds only (`[R2-HIGH-06]`).
    // Release binaries (`#[cfg(not(debug_assertions))]`) NEVER probe `current_dir()` or relative paths.
    #[cfg(debug_assertions)]
    {
        let manifest_dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/dist");
        let dev_candidates = [
            manifest_dist,
            PathBuf::from("apps/desktop/ui/dist"),
            PathBuf::from("../ui/dist"),
        ];
        for candidate in dev_candidates {
            if !candidate.is_symlink() && candidate.join("index.html").is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn resolve_ui_dist_dir() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok();
    resolve_ui_dist_dir_for_exe(exe_path.as_deref())
}

fn is_safe_semver(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 32
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

fn is_safe_github_repo(repo: &str) -> bool {
    app_domain::is_valid_github_repo_slug(repo)
}

fn perform_native_self_update(
    handler: &DesktopCommandHandler,
    raw_version: &str,
    proxy: &EventLoopProxy<DesktopUserEvent>,
) -> &'static str {
    if UPDATE_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return r#"{"status":"already_in_progress"}"#;
    }
    let _in_progress_guard = UpdateInProgressGuard;

    let version = raw_version.trim().trim_start_matches(['v', 'V']);
    if !is_safe_semver(version) {
        return r#"{"status":"invalid_parameters"}"#;
    }

    // Release binaries always pin binary self-update downloads to the official upstream repository
    // so settings tampering cannot steer executable updates to an untrusted repository (`[CRIT-03]`).
    let repo = if cfg!(not(debug_assertions)) {
        OFFICIAL_RELEASE_REPO.to_owned()
    } else {
        handler
            .settings_get()
            .map(|s| s.github_release_repo)
            .unwrap_or_else(|_| OFFICIAL_RELEASE_REPO.to_owned())
    };
    if !is_safe_github_repo(&repo) {
        return r#"{"status":"invalid_parameters"}"#;
    }

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;

        let staged = handler.read_staged_update_manifest().ok().flatten();
        let staged_url = staged.as_ref().and_then(|m| m.download_url.as_deref());
        let arch_label = if cfg!(target_arch = "x86_64") {
            "macos-x86_64"
        } else {
            "macos-aarch64"
        };
        let tar_url = format!(
            "https://github.com/{repo}/releases/download/v{version}/Readora_{version}_{arch_label}.app.tar.gz"
        );
        let dmg_url = format!(
            "https://github.com/{repo}/releases/download/v{version}/Readora_{version}_{arch_label}.dmg"
        );
        let release_url = format!("https://github.com/{repo}/releases/tag/v{version}");

        let updates_dir = NativePlatformAdapter::resolve_app_data_dir().join("updates");
        if std::fs::create_dir_all(&updates_dir).is_ok() {
            let _ = std::fs::set_permissions(&updates_dir, std::fs::Permissions::from_mode(0o700));
            if let Ok(stage_temp) = tempfile::Builder::new()
                .prefix(".stage-")
                .tempdir_in(&updates_dir)
            {
                let staging_dir = stage_temp.path();

                if staged_url != Some(dmg_url.as_str()) {
                    let tar_path = staging_dir.join("Readora.app.tar.gz");
                    let curl_output = Command::new("/usr/bin/curl")
                        .args([
                            "--proto",
                            "=https",
                            "--tlsv1.2",
                            "-fSL",
                            "--retry",
                            "2",
                            "--max-redirs",
                            "5",
                            "--connect-timeout",
                            "10",
                            "--max-time",
                            "120",
                            "--max-filesize",
                            MAX_SELF_UPDATE_BYTES,
                            "-w",
                            "%{url_effective}",
                            "-o",
                        ])
                        .arg(&tar_path)
                        .arg(&tar_url)
                        .output()
                        .ok();

                    let curl_ok = curl_output.as_ref().is_some_and(|out| {
                        let eff = String::from_utf8_lossy(&out.stdout);
                        out.status.success()
                            && (eff.trim().is_empty()
                                || readora_desktop_lib::server::is_allowed_github_https_url(
                                    eff.trim(),
                                ))
                    });

                    if curl_ok {
                        if !verify_downloaded_asset_staged(
                            &tar_path,
                            &tar_url,
                            staged.as_ref(),
                            version,
                        ) {
                            return r#"{"status":"checksum_verification_failed"}"#;
                        }

                        let untar_ok = Command::new("/usr/bin/tar")
                            .args(["-xzf"])
                            .arg(&tar_path)
                            .arg("-C")
                            .arg(staging_dir)
                            .status()
                            .map(|s| s.success())
                            .unwrap_or(false);

                        let extracted_app = staging_dir.join("Readora.app");
                        if untar_ok
                            && extracted_app.is_dir()
                            && !extracted_app.is_symlink()
                            && verify_bundle_no_escaping_symlinks(&extracted_app)
                        {
                            // Fail closed: require BOTH an active installed `.app` bundle (never overwrite
                            // `/Applications/Readora.app` from debug/standalone binaries) AND a verified Apple Team ID.
                            let current_bundle = std::env::current_exe().ok().and_then(|exe| {
                                let contents_dir = exe.parent()?.parent()?;
                                let app_dir = contents_dir.parent()?;
                                if app_dir.extension().and_then(|e| e.to_str()) == Some("app")
                                    && !app_dir.to_string_lossy().starts_with("/Volumes/")
                                {
                                    Some(app_dir.to_path_buf())
                                } else {
                                    None
                                }
                            });
                            let (Some(target_app), Some(team_id)) =
                                (current_bundle, inspect_current_bundle_team_id())
                            else {
                                return r#"{"status":"signature_verification_failed"}"#;
                            };

                            // Verify code signature BEFORE clearing quarantine (`[CRIT-03]`)
                            let req = format!(
                                "identifier \"com.readora.desktop\" and anchor apple generic and certificate leaf[subject.OU] = \"{team_id}\""
                            );
                            let verified_sig = Command::new("/usr/bin/codesign")
                                .args(["--verify", "--deep", "--strict", "-R"])
                                .arg(&req)
                                .arg(&extracted_app)
                                .status()
                                .map(|s| s.success())
                                .unwrap_or(false);
                            if !verified_sig {
                                return r#"{"status":"signature_verification_failed"}"#;
                            }
                            let _ = Command::new("/usr/bin/xattr")
                                .args(["-crs"])
                                .arg(&extracted_app)
                                .status();

                            let target_parent = target_app
                                .parent()
                                .map_or_else(|| PathBuf::from("/Applications"), Path::to_path_buf);
                            let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
                            let backup_app = target_parent
                                .join(format!(".Readora.app.backup-{}-{seq}", std::process::id()));
                            if let Ok(m) = std::fs::symlink_metadata(&backup_app)
                                && !m.file_type().is_symlink()
                            {
                                let _ = std::fs::remove_dir_all(&backup_app);
                            }

                            let had_existing = target_app.exists();
                            let backup_ok = if had_existing {
                                std::fs::rename(&target_app, &backup_app).is_ok()
                                    || Command::new("/bin/mv")
                                        .arg("--")
                                        .arg(&target_app)
                                        .arg(&backup_app)
                                        .status()
                                        .map(|s| s.success())
                                        .unwrap_or(false)
                            } else {
                                true
                            };

                            if backup_ok {
                                let moved = std::fs::rename(&extracted_app, &target_app).is_ok()
                                    || Command::new("/bin/mv")
                                        .arg("--")
                                        .arg(&extracted_app)
                                        .arg(&target_app)
                                        .status()
                                        .map(|s| s.success())
                                        .unwrap_or(false);

                                if moved {
                                    if had_existing
                                        && std::fs::symlink_metadata(&backup_app)
                                            .is_ok_and(|m| !m.file_type().is_symlink())
                                    {
                                        let _ = std::fs::remove_dir_all(&backup_app);
                                    }
                                    drop(stage_temp);
                                    let _ = handler.app_install_update(version);
                                    let _ = Command::new("/bin/sh")
                                        .args([
                                            "-c",
                                            "sleep 0.6 && exec /usr/bin/open -n -- \"$1\"",
                                            "--",
                                        ])
                                        .arg(&target_app)
                                        .spawn();
                                    let _ = proxy.send_event(DesktopUserEvent::Quit);
                                    return r#"{"status":"restarting"}"#;
                                }

                                if had_existing
                                    && std::fs::rename(&backup_app, &target_app).is_err()
                                {
                                    let _ = Command::new("/bin/mv")
                                        .arg("--")
                                        .arg(&backup_app)
                                        .arg(&target_app)
                                        .status();
                                }
                            }
                        }
                    }
                }

                if staged_url == Some(dmg_url.as_str()) {
                    let staged_dmg =
                        staging_dir.join(format!("Readora_{version}_{arch_label}.dmg"));
                    let dmg_output = Command::new("/usr/bin/curl")
                        .args([
                            "--proto",
                            "=https",
                            "--tlsv1.2",
                            "-fSL",
                            "--retry",
                            "2",
                            "--max-redirs",
                            "5",
                            "--connect-timeout",
                            "10",
                            "--max-time",
                            "120",
                            "--max-filesize",
                            MAX_SELF_UPDATE_BYTES,
                            "-w",
                            "%{url_effective}",
                            "-o",
                        ])
                        .arg(&staged_dmg)
                        .arg(&dmg_url)
                        .output()
                        .ok();
                    let dmg_ok = dmg_output.as_ref().is_some_and(|out| {
                        let eff = String::from_utf8_lossy(&out.stdout);
                        out.status.success()
                            && (eff.trim().is_empty()
                                || readora_desktop_lib::server::is_allowed_github_https_url(
                                    eff.trim(),
                                ))
                    });
                    if dmg_ok {
                        if !verify_downloaded_asset_staged(
                            &staged_dmg,
                            &dmg_url,
                            staged.as_ref(),
                            version,
                        ) {
                            return r#"{"status":"checksum_verification_failed"}"#;
                        }
                        if let Ok(home) = std::env::var("HOME") {
                            let downloads_dir = PathBuf::from(home).join("Downloads");
                            let dmg_name = format!("Readora_{version}_{arch_label}.dmg");
                            if let Some(dmg_dest) = copy_staged_installer_exclusively(
                                &staged_dmg,
                                &downloads_dir,
                                &dmg_name,
                            ) {
                                drop(stage_temp);
                                let _ = Command::new("/usr/bin/open").arg(&dmg_dest).spawn();
                                return r#"{"status":"downloaded_installer"}"#;
                            }
                        }
                    }
                }
            }
        }

        let _ = Command::new("/usr/bin/open").arg(&release_url).spawn();
        r#"{"status":"opened_release"}"#
    }

    #[cfg(target_os = "windows")]
    {
        let _ = proxy;
        let staged = handler.read_staged_update_manifest().ok().flatten();
        let zip_name = format!("Readora_{version}_windows-x86_64-setup.zip");
        let zip_url = format!("https://github.com/{repo}/releases/download/v{version}/{zip_name}");
        let release_url = format!("https://github.com/{repo}/releases/tag/v{version}");

        let curl_exe = resolve_windows_tool("curl.exe", true);
        let explorer_exe = resolve_windows_tool("explorer.exe", false);

        let updates_dir = NativePlatformAdapter::resolve_app_data_dir().join("updates");
        if std::fs::create_dir_all(&updates_dir).is_ok()
            && let Ok(stage_temp) = tempfile::Builder::new()
                .prefix(".stage-")
                .tempdir_in(&updates_dir)
        {
            let temp_zip = stage_temp.path().join(&zip_name);
            let curl_output = Command::new(&curl_exe)
                .args([
                    "--proto",
                    "=https",
                    "--tlsv1.2",
                    "-fSL",
                    "--retry",
                    "2",
                    "--max-redirs",
                    "5",
                    "--connect-timeout",
                    "10",
                    "--max-time",
                    "120",
                    "--max-filesize",
                    MAX_SELF_UPDATE_BYTES,
                    "-w",
                    "%{url_effective}",
                    "-o",
                ])
                .arg(&temp_zip)
                .arg(&zip_url)
                .output()
                .ok();
            let curl_ok = curl_output.as_ref().is_some_and(|out| {
                let eff = String::from_utf8_lossy(&out.stdout);
                out.status.success()
                    && (eff.trim().is_empty()
                        || readora_desktop_lib::server::is_allowed_github_https_url(eff.trim()))
            });
            if curl_ok {
                if !verify_downloaded_asset_staged(&temp_zip, &zip_url, staged.as_ref(), version) {
                    return r#"{"status":"checksum_verification_failed"}"#;
                }
                if let Ok(user_profile) = std::env::var("USERPROFILE") {
                    let downloads_dir = PathBuf::from(user_profile).join("Downloads");
                    if let Some(dest_zip) =
                        copy_staged_installer_exclusively(&temp_zip, &downloads_dir, &zip_name)
                    {
                        drop(stage_temp);
                        let dest_str = dest_zip.to_string_lossy();
                        if !dest_str.contains('"') && !dest_str.chars().any(char::is_control) {
                            let _ = Command::new(&explorer_exe)
                                .raw_arg(format!("/select,\"{dest_str}\""))
                                .spawn();
                        }
                        return r#"{"status":"downloaded_installer"}"#;
                    }
                }
            }
        }

        let _ = Command::new(&explorer_exe).arg(&release_url).spawn();
        r#"{"status":"opened_release"}"#
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = proxy;
        let release_url = format!("https://github.com/{repo}/releases/tag/v{version}");
        let _ = Command::new("/usr/bin/xdg-open").arg(&release_url).spawn();
        r#"{"status":"opened_release"}"#
    }
}

fn handle_http_connection(
    mut stream: TcpStream,
    bound_port: u16,
    expected_token: &str,
    ui_root: &Path,
    handler: &DesktopCommandHandler,
    proxy: &EventLoopProxy<DesktopUserEvent>,
) {
    let _ = stream.set_read_timeout(Some(MAX_HEADER_DURATION));
    let _ = stream.set_write_timeout(Some(SOCKET_IO_TIMEOUT));

    match read_and_authorize_http_request(&mut stream, bound_port, expected_token) {
        Ok(Some(req)) => {
            let resp = route_http_request(req, ui_root, handler, |cmd_handler, ver| {
                perform_native_self_update(cmd_handler, ver, proxy)
            });
            resp.write_to(&mut stream);
        }
        Ok(None) => {}
        Err(err_resp) => {
            err_resp.write_to(&mut stream);
        }
    }
}

fn main() {
    init_tracing();

    if std::env::args().any(|arg| arg == "--uninstall-cleanup") {
        match AppCore::cleanup_default_app_artifacts() {
            Ok(report) => {
                tracing::info!(
                    removed_db = report.removed_database_files,
                    removed_cache = report.removed_cache_entries,
                    removed_temp = report.removed_temp_entries,
                    "Readora uninstall cleanup completed"
                );
                return;
            }
            Err(err) => {
                tracing::error!("Readora uninstall cleanup failed: {err}");
                std::process::exit(1);
            }
        }
    }

    let handler = match DesktopCommandHandler::try_new_default() {
        Ok(h) => Arc::new(h),
        Err(err) => {
            tracing::error!(
                code = %err.code,
                "Readora initialization failed: {}",
                err.message
            );
            std::process::exit(1);
        }
    };

    tracing::info!("Readora desktop core initialized successfully");

    if std::env::args().any(|arg| arg == "--headless-check") {
        return;
    }

    let Some(ui_root) = resolve_ui_dist_dir() else {
        tracing::info!("No bundled UI assets found; exiting after core initialization");
        return;
    };

    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        tracing::error!("Failed to bind ephemeral loopback listener for Readora UI");
        std::process::exit(1);
    };
    let Ok(local_addr) = listener.local_addr() else {
        std::process::exit(1);
    };
    let bound_port = local_addr.port();
    let base_url = format!("http://127.0.0.1:{bound_port}/");
    let session_token = Arc::new(generate_session_token());

    tracing::info!("Serving Readora UI on authenticated loopback port {bound_port}");

    let event_loop = EventLoopBuilder::<DesktopUserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Bounded worker pool for loopback HTTP/RPC connections (never unbounded thread spawning)
    let (conn_tx, conn_rx) = sync_channel::<TcpStream>(HTTP_QUEUE_CAPACITY);
    let shared_rx = Arc::new(Mutex::new(conn_rx));
    let ui_root = Arc::new(ui_root);

    for _ in 0..HTTP_WORKER_COUNT {
        let rx = Arc::clone(&shared_rx);
        let worker_ui = Arc::clone(&ui_root);
        let worker_handler = Arc::clone(&handler);
        let worker_token = Arc::clone(&session_token);
        let worker_proxy = proxy.clone();
        std::thread::spawn(move || {
            loop {
                let next_stream = {
                    let Ok(guard) = rx.lock() else {
                        break;
                    };
                    guard.recv()
                };
                let Ok(stream) = next_stream else {
                    break;
                };
                handle_http_connection(
                    stream,
                    bound_port,
                    &worker_token,
                    &worker_ui,
                    &worker_handler,
                    &worker_proxy,
                );
            }
        });
    }

    std::thread::spawn(move || {
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    if conn_tx.send(stream).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    tracing::warn!("Loopback listener accept error: {err}");
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    });

    let window = match WindowBuilder::new()
        .with_title("Readora — PDF Reader")
        .with_inner_size(LogicalSize::new(1380.0, 880.0))
        .with_min_inner_size(LogicalSize::new(860.0, 580.0))
        .build(&event_loop)
    {
        Ok(win) => win,
        Err(err) => {
            tracing::error!("Failed to create native Readora window: {err}");
            std::process::exit(1);
        }
    };

    let init_script = build_init_script(bound_port, &session_token);
    let ipc_proxy = proxy;

    let webview = match WebViewBuilder::new()
        .with_url(&base_url)
        // Security note (`wry 0.48`): the boolean parameter is `for_main_only: false`, which forces
        // WebView2 on Windows to register via `AddScriptToExecuteOnDocumentCreated` rather than the
        // racy `add_ContentLoading` path. Main-frame + exact-origin isolation is strictly enforced
        // inside `build_init_script` via `window.top === window.self` and
        // `window.location.origin === "http://127.0.0.1:<bound_port>"`.
        .with_initialization_script_for_main_only(&init_script, false)
        .with_new_window_req_handler(|_| false)
        .with_navigation_handler(move |target_url| {
            is_allowed_navigation_url(&target_url, bound_port)
        })
        .with_ipc_handler(move |request| {
            if request.body() == "quit" {
                let _ = ipc_proxy.send_event(DesktopUserEvent::Quit);
            }
        })
        .build(&window)
    {
        Ok(wv) => wv,
        Err(err) => {
            tracing::error!("Failed to initialize native OS WebView: {err}");
            std::process::exit(1);
        }
    };

    let mut webview = Some(webview);
    let mut window = Some(window);

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested | WindowEvent::Destroyed,
                ..
            }
            | Event::UserEvent(DesktopUserEvent::Quit)
            | Event::LoopDestroyed => {
                drop(webview.take());
                drop(window.take());
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
