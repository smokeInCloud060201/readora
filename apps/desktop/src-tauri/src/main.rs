//! Binary entry point for the Readora desktop shell.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_core::AppCore;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use platform::NativePlatformAdapter;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use readora_desktop_lib::server::verify_downloaded_asset_staged;
use readora_desktop_lib::server::{
    build_init_script, generate_session_token, is_allowed_navigation_url,
    read_and_authorize_http_request, route_http_request,
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

#[derive(Debug, Clone, Copy)]
enum DesktopUserEvent {
    Quit,
}

fn resolve_ui_dist_dir() -> Option<PathBuf> {
    if let Ok(exe_path) = std::env::current_exe()
        && let Some(exe_dir) = exe_path.parent()
    {
        let candidates = [
            exe_dir.join("../Resources/ui"),
            exe_dir.join("ui"),
            exe_dir.join("../share/readora/ui"),
            PathBuf::from("/usr/share/readora/ui"),
        ];
        for candidate in candidates {
            if candidate.join("index.html").is_file() {
                return Some(candidate);
            }
        }
    }

    let workspace_candidates = [
        PathBuf::from("apps/desktop/ui/dist"),
        PathBuf::from("../ui/dist"),
    ];
    workspace_candidates
        .into_iter()
        .find(|candidate| candidate.join("index.html").is_file())
}

fn is_safe_semver(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 32
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

fn is_safe_github_repo(repo: &str) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 64
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        })
}

fn perform_native_self_update(
    handler: &DesktopCommandHandler,
    raw_version: &str,
    proxy: &EventLoopProxy<DesktopUserEvent>,
) -> &'static str {
    let version = raw_version.trim().trim_start_matches(['v', 'V']);
    if !is_safe_semver(version) {
        return r#"{"status":"invalid_parameters"}"#;
    }

    let repo = handler
        .settings_get()
        .map(|s| s.github_release_repo)
        .unwrap_or_else(|_| "smokeInCloud060201/readora".to_owned());
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
                    let curl_ok = Command::new("/usr/bin/curl")
                        .args(["-fSL", "--retry", "2", "-o"])
                        .arg(&tar_path)
                        .arg(&tar_url)
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);

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
                        if untar_ok && extracted_app.is_dir() && !extracted_app.is_symlink() {
                            let _ = Command::new("/usr/bin/xattr")
                                .args(["-cr"])
                                .arg(&extracted_app)
                                .status();
                            let verified_sig = Command::new("/usr/bin/codesign")
                                .args(["--verify", "--deep", "--strict"])
                                .arg(&extracted_app)
                                .status()
                                .map(|s| s.success())
                                .unwrap_or(false);
                            if !verified_sig {
                                return r#"{"status":"signature_verification_failed"}"#;
                            }

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
                            let target_app = current_bundle
                                .unwrap_or_else(|| PathBuf::from("/Applications/Readora.app"));
                            let target_parent = target_app
                                .parent()
                                .map_or_else(|| PathBuf::from("/Applications"), Path::to_path_buf);
                            let backup_app = target_parent
                                .join(format!(".Readora.app.backup-{}", std::process::id()));
                            if backup_app.exists() {
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
                                    if had_existing {
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
                    let dmg_ok = Command::new("/usr/bin/curl")
                        .args(["-fSL", "--retry", "2", "-o"])
                        .arg(&staged_dmg)
                        .arg(&dmg_url)
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);
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
                            if std::fs::create_dir_all(&downloads_dir).is_ok() {
                                let dmg_dest = downloads_dir
                                    .join(format!("Readora_{version}_{arch_label}.dmg"));
                                let placed = std::fs::rename(&staged_dmg, &dmg_dest).is_ok()
                                    || std::fs::copy(&staged_dmg, &dmg_dest).is_ok();
                                if placed {
                                    drop(stage_temp);
                                    let _ = Command::new("/usr/bin/open").arg(&dmg_dest).spawn();
                                    return r#"{"status":"downloaded_installer"}"#;
                                }
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

        let updates_dir = NativePlatformAdapter::resolve_app_data_dir().join("updates");
        if std::fs::create_dir_all(&updates_dir).is_ok()
            && let Ok(stage_temp) = tempfile::Builder::new()
                .prefix(".stage-")
                .tempdir_in(&updates_dir)
        {
            let temp_zip = stage_temp.path().join(&zip_name);
            let curl_ok = Command::new("curl.exe")
                .args(["-fSL", "--retry", "2", "-o"])
                .arg(&temp_zip)
                .arg(&zip_url)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if curl_ok {
                if !verify_downloaded_asset_staged(&temp_zip, &zip_url, staged.as_ref(), version) {
                    return r#"{"status":"checksum_verification_failed"}"#;
                }
                if let Ok(user_profile) = std::env::var("USERPROFILE") {
                    let downloads_dir = PathBuf::from(user_profile).join("Downloads");
                    if std::fs::create_dir_all(&downloads_dir).is_ok() {
                        let dest_zip = downloads_dir.join(&zip_name);
                        let placed = std::fs::rename(&temp_zip, &dest_zip).is_ok()
                            || std::fs::copy(&temp_zip, &dest_zip).is_ok();
                        if placed {
                            drop(stage_temp);
                            let _ = Command::new("explorer.exe")
                                .arg(format!("/select,{}", dest_zip.display()))
                                .spawn();
                            return r#"{"status":"downloaded_installer"}"#;
                        }
                    }
                }
            }
        }

        let _ = Command::new("explorer.exe").arg(&release_url).spawn();
        r#"{"status":"opened_release"}"#
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = proxy;
        let release_url = format!("https://github.com/{repo}/releases/tag/v{version}");
        let _ = Command::new("xdg-open").arg(&release_url).spawn();
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
    let _ = stream.set_read_timeout(Some(SOCKET_IO_TIMEOUT));
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
                std::process::exit(0);
            }
            _ => {}
        }
    });
}
