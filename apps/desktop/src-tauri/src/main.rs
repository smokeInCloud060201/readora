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
use platform::NativePlatformAdapter;
use readora_desktop_lib::server::{
    generate_session_token, read_and_authorize_http_request, route_http_request,
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

fn verify_downloaded_asset_if_staged(
    file_path: &Path,
    asset_url: &str,
    staged_version: Option<&str>,
    staged_url: Option<&str>,
    staged_sha256: Option<&str>,
    requested_version: &str,
) -> bool {
    let (Some(sv), Some(sha)) = (staged_version, staged_sha256) else {
        return true;
    };
    if sv.trim() != requested_version || !NativePlatformAdapter::is_hex_sha256(sha) {
        return true;
    }
    if let Some(su) = staged_url
        && su != asset_url
    {
        return true;
    }
    NativePlatformAdapter::verify_sha256_file(file_path, sha).unwrap_or(false)
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

    let staged = handler.read_staged_update_manifest().ok().flatten();
    let staged_version = staged.as_ref().map(|m| m.version.as_str());
    let staged_url = staged.as_ref().and_then(|m| m.download_url.as_deref());
    let staged_sha256 = staged.as_ref().map(|m| m.sha256.as_str());

    #[cfg(target_os = "macos")]
    {
        let arch_labels: &[&str] = if cfg!(target_arch = "x86_64") {
            &["macos-x86_64", "macos-aarch64"]
        } else {
            &["macos-aarch64"]
        };
        let primary_arch = arch_labels[0];
        let dmg_url = format!(
            "https://github.com/{repo}/releases/download/v{version}/Readora_{version}_{primary_arch}.dmg"
        );
        let staging_dir = std::env::temp_dir().join(format!("readora-update-{version}"));
        let _ = std::fs::remove_dir_all(&staging_dir);

        if std::fs::create_dir_all(&staging_dir).is_ok() {
            let tar_path = staging_dir.join("Readora.app.tar.gz");
            let mut downloaded_tar_url: Option<String> = None;

            for arch in arch_labels {
                let candidate_url = format!(
                    "https://github.com/{repo}/releases/download/v{version}/Readora_{version}_{arch}.app.tar.gz"
                );
                let ok = Command::new("/usr/bin/curl")
                    .args(["-fSL", "--retry", "2", "-o"])
                    .arg(&tar_path)
                    .arg(&candidate_url)
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if ok {
                    downloaded_tar_url = Some(candidate_url);
                    break;
                }
            }

            if let Some(tar_url) = downloaded_tar_url {
                if !verify_downloaded_asset_if_staged(
                    &tar_path,
                    &tar_url,
                    staged_version,
                    staged_url,
                    staged_sha256,
                    version,
                ) {
                    let _ = std::fs::remove_dir_all(&staging_dir);
                    return r#"{"status":"checksum_verification_failed"}"#;
                }

                let untar_ok = Command::new("/usr/bin/tar")
                    .args(["-xzf"])
                    .arg(&tar_path)
                    .arg("-C")
                    .arg(&staging_dir)
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);

                let extracted_app = staging_dir.join("Readora.app");
                if untar_ok && extracted_app.is_dir() {
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
                        let _ = std::fs::remove_dir_all(&staging_dir);
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

                    let _ = std::fs::remove_dir_all(&target_app);
                    let moved = Command::new("/bin/mv")
                        .arg(&extracted_app)
                        .arg(&target_app)
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);
                    let _ = std::fs::remove_dir_all(&staging_dir);

                    if moved {
                        let _ = handler.app_install_update(version);
                        let target_str = target_app.to_string_lossy().into_owned();
                        let _ = Command::new("/bin/sh")
                            .args([
                                "-c",
                                &format!("sleep 0.6 && /usr/bin/open -n \"{target_str}\""),
                            ])
                            .spawn();
                        let _ = proxy.send_event(DesktopUserEvent::Quit);
                        return r#"{"status":"restarting"}"#;
                    }
                }
            }

            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_owned());
            let dmg_dest = PathBuf::from(home)
                .join("Downloads")
                .join(format!("Readora_{version}_{primary_arch}.dmg"));
            let dmg_ok = Command::new("/usr/bin/curl")
                .args(["-fSL", "--retry", "2", "-o"])
                .arg(&dmg_dest)
                .arg(&dmg_url)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            let _ = std::fs::remove_dir_all(&staging_dir);
            if dmg_ok {
                if !verify_downloaded_asset_if_staged(
                    &dmg_dest,
                    &dmg_url,
                    staged_version,
                    staged_url,
                    staged_sha256,
                    version,
                ) {
                    let _ = std::fs::remove_file(&dmg_dest);
                    return r#"{"status":"checksum_verification_failed"}"#;
                }
                let _ = handler.app_install_update(version);
                let _ = Command::new("/usr/bin/open").arg(&dmg_dest).spawn();
                return r#"{"status":"downloaded_installer"}"#;
            }
        }
        let _ = handler.app_install_update(version);
        let _ = Command::new("/usr/bin/open").arg(&dmg_url).spawn();
        r#"{"status":"opened_release"}"#
    }

    #[cfg(target_os = "windows")]
    {
        let msi_url = format!(
            "https://github.com/{repo}/releases/download/v{version}/Readora_{version}_windows-x86_64.msi"
        );
        let msi_dest = std::env::temp_dir().join(format!("Readora_{version}_windows-x86_64.msi"));
        let curl_ok = Command::new("curl.exe")
            .args(["-fSL", "--retry", "2", "-o"])
            .arg(&msi_dest)
            .arg(&msi_url)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if curl_ok {
            if !verify_downloaded_asset_if_staged(
                &msi_dest,
                &msi_url,
                staged_version,
                staged_url,
                staged_sha256,
                version,
            ) {
                let _ = std::fs::remove_file(&msi_dest);
                return r#"{"status":"checksum_verification_failed"}"#;
            }
            let _ = handler.app_install_update(version);
            let _ = Command::new("msiexec.exe").arg("/i").arg(&msi_dest).spawn();
            let _ = proxy.send_event(DesktopUserEvent::Quit);
            return r#"{"status":"restarting"}"#;
        }
        let _ = handler.app_install_update(version);
        let _ = Command::new("cmd")
            .args(["/C", "start", "", &msi_url])
            .spawn();
        r#"{"status":"opened_release"}"#
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (
            proxy,
            staged_version,
            staged_url,
            staged_sha256,
            verify_downloaded_asset_if_staged,
        );
        let _ = handler.app_install_update(version);
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

fn build_init_script(session_token: &str) -> String {
    format!(
        r#"
      (function() {{
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
          const resp = await fetch('/__readora_rpc', {{
            method: 'POST',
            headers: {{
              'Content-Type': 'application/json',
              'X-Readora-Token': TOKEN
            }},
            body: JSON.stringify({{ cmd: cmd, args: args || {{}} }})
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
                'X-Readora-Filename': encodeURIComponent(fileName || 'Document.pdf')
              }};
              if (password) {{
                headers['X-Readora-Password'] = encodeURIComponent(password);
              }}
              const bodyBuffer = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
              );
              const resp = await fetch('/__readora_import', {{
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
              const resp = await fetch('/__readora_pdf_read', {{
                method: 'POST',
                headers: {{
                  'Content-Type': 'application/json',
                  'X-Readora-Token': TOKEN
                }},
                body: JSON.stringify({{ documentId: documentId }})
              }});
              if (!resp.ok) {{
                return null;
              }}
              const buf = await resp.arrayBuffer();
              return buf.byteLength > 0 ? new Uint8Array(buf) : null;
            }},
            triggerSelfUpdate: async function(version) {{
              const resp = await fetch('/__readora_update', {{
                method: 'POST',
                headers: {{
                  'Content-Type': 'application/json',
                  'X-Readora-Token': TOKEN
                }},
                body: JSON.stringify({{ version: version }})
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
    let allowed_origin_prefix = format!("http://127.0.0.1:{bound_port}");
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
        for stream in listener.incoming().flatten() {
            if conn_tx.send(stream).is_err() {
                break;
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

    let init_script = build_init_script(&session_token);
    let ipc_proxy = proxy;

    let webview = match WebViewBuilder::new()
        .with_url(&base_url)
        .with_initialization_script(&init_script)
        .with_navigation_handler(move |target_url| {
            target_url.starts_with(&allowed_origin_prefix) || target_url == "about:blank"
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
