//! Binary entry point for the Readora desktop shell.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use app_core::AppCore;
use readora_desktop_lib::{DesktopCommandHandler, init_tracing};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

#[derive(Debug, Clone, Copy)]
enum DesktopUserEvent {
    Quit,
}

fn resolve_ui_dist_dir() -> Option<PathBuf> {
    if let Ok(exe_path) = std::env::current_exe()
        && let Some(exe_dir) = exe_path.parent()
    {
        let candidates = [
            // macOS .app bundle: Readora.app/Contents/MacOS/../Resources/ui
            exe_dir.join("../Resources/ui"),
            // Windows / portable bundle: ./ui next to executable
            exe_dir.join("ui"),
            // Linux .deb / .tar.gz bundle: /usr/bin/../share/readora/ui
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

fn sanitize_relative_path(raw_target: &str) -> PathBuf {
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

fn extract_query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut iter = pair.splitn(2, '=');
        let k = iter.next().unwrap_or("");
        let v = iter.next().unwrap_or("");
        if k == key {
            let decoded = v
                .replace("%2F", "/")
                .replace("%2f", "/")
                .replace("%3A", ":")
                .replace("%3a", ":");
            return Some(decoded);
        }
    }
    None
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
    version: &str,
    repo: &str,
    proxy: &EventLoopProxy<DesktopUserEvent>,
) -> &'static str {
    if !is_safe_semver(version) || !is_safe_github_repo(repo) {
        return r#"{"status":"invalid_parameters"}"#;
    }

    #[cfg(target_os = "macos")]
    {
        let tar_url = format!(
            "https://github.com/{repo}/releases/download/v{version}/Readora_{version}_macos-aarch64.app.tar.gz"
        );
        let dmg_url = format!(
            "https://github.com/{repo}/releases/download/v{version}/Readora_{version}_macos-aarch64.dmg"
        );
        let staging_dir = std::env::temp_dir().join(format!("readora-update-{version}"));
        let _ = std::fs::remove_dir_all(&staging_dir);
        if std::fs::create_dir_all(&staging_dir).is_ok() {
            let tar_path = staging_dir.join("Readora.app.tar.gz");
            let curl_ok = Command::new("/usr/bin/curl")
                .args(["-fSL", "--retry", "2", "-o"])
                .arg(&tar_path)
                .arg(&tar_url)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);

            if curl_ok {
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
                    let _ = Command::new("/usr/bin/codesign")
                        .args(["--force", "--deep", "--sign", "-"])
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

                    let _ = std::fs::remove_dir_all(&target_app);
                    let moved = Command::new("/bin/mv")
                        .arg(&extracted_app)
                        .arg(&target_app)
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);

                    if moved {
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

            // Fallback: download .dmg to Downloads and open it in Finder
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_owned());
            let dmg_dest = PathBuf::from(home)
                .join("Downloads")
                .join(format!("Readora_{version}_macos-aarch64.dmg"));
            let dmg_ok = Command::new("/usr/bin/curl")
                .args(["-fSL", "--retry", "2", "-o"])
                .arg(&dmg_dest)
                .arg(&dmg_url)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if dmg_ok {
                let _ = Command::new("/usr/bin/open").arg(&dmg_dest).spawn();
                return r#"{"status":"downloaded_installer"}"#;
            }
        }
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
            let _ = Command::new("msiexec.exe").arg("/i").arg(&msi_dest).spawn();
            let _ = proxy.send_event(DesktopUserEvent::Quit);
            return r#"{"status":"restarting"}"#;
        }
        let _ = Command::new("cmd")
            .args(["/C", "start", "", &msi_url])
            .spawn();
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

fn is_safe_doc_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn resolve_library_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("READORA_DATA_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("library");
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("com.readora.desktop")
                .join("library");
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("Readora").join("library");
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            let trimmed = xdg.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("readora").join("library");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("readora")
                .join("library");
        }
    }

    std::env::temp_dir().join("readora-data").join("library")
}

const MAX_HTTP_BODY_BYTES: usize = 128 * 1024 * 1024;

fn read_http_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut header_buf = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            if header_buf.is_empty() {
                return None;
            }
            break header_buf.len();
        }
        header_buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = header_buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if header_buf.len() >= 16_384 {
            return None;
        }
    };

    let header_str = String::from_utf8_lossy(&header_buf[..header_end]);
    let mut lines = header_str.lines();
    let request_line = lines.next().unwrap_or("GET / HTTP/1.1");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_ascii_uppercase();
    let raw_target = parts.next().unwrap_or("/").to_owned();

    let mut content_length = 0_usize;
    for line in lines {
        if let Some((k, v)) = line.split_once(':')
            && k.trim().eq_ignore_ascii_case("content-length")
            && let Ok(parsed) = v.trim().parse::<usize>()
        {
            content_length = parsed;
        }
    }

    if content_length > MAX_HTTP_BODY_BYTES {
        return None;
    }

    let mut body = Vec::with_capacity(content_length);
    if header_buf.len() > header_end {
        body.extend_from_slice(&header_buf[header_end..]);
    }
    while body.len() < content_length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);

    Some((method, raw_target, body))
}

fn write_json_response(stream: &mut TcpStream, status: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}

fn handle_http_connection(
    mut stream: TcpStream,
    ui_root: &Path,
    proxy: &EventLoopProxy<DesktopUserEvent>,
) {
    let Some((method, raw_target, req_body)) = read_http_request(&mut stream) else {
        return;
    };

    if raw_target.starts_with("/__readora_update") {
        let query = raw_target.split_once('?').map_or("", |(_, q)| q);
        let version = extract_query_param(query, "version").unwrap_or_default();
        let repo = extract_query_param(query, "repo")
            .unwrap_or_else(|| "smokeInCloud060201/readora".to_owned());
        let body = perform_native_self_update(&version, &repo, proxy);
        write_json_response(&mut stream, "200 OK", body.as_bytes());
        return;
    }

    if raw_target.starts_with("/__readora_state") {
        let lib_dir = resolve_library_dir();
        let state_file = lib_dir.join("state.json");
        match method.as_str() {
            "GET" => {
                if let Ok(bytes) = std::fs::read(&state_file) {
                    write_json_response(&mut stream, "200 OK", &bytes);
                } else {
                    write_json_response(&mut stream, "200 OK", b"{}");
                }
            }
            "POST" => {
                if std::fs::create_dir_all(&lib_dir).is_ok() {
                    let tmp_file = lib_dir.join("state.json.tmp");
                    if std::fs::write(&tmp_file, &req_body).is_ok()
                        && std::fs::rename(&tmp_file, &state_file).is_ok()
                    {
                        write_json_response(&mut stream, "200 OK", br#"{"ok":true}"#);
                        return;
                    }
                }
                write_json_response(&mut stream, "500 Internal Server Error", br#"{"ok":false}"#);
            }
            "DELETE" => {
                let _ = std::fs::remove_dir_all(&lib_dir);
                write_json_response(&mut stream, "200 OK", br#"{"ok":true}"#);
            }
            _ => {
                write_json_response(&mut stream, "405 Method Not Allowed", br#"{"ok":false}"#);
            }
        }
        return;
    }

    if raw_target.starts_with("/__readora_pdf") {
        let query = raw_target.split_once('?').map_or("", |(_, q)| q);
        let doc_id = extract_query_param(query, "id").unwrap_or_default();
        if !is_safe_doc_id(&doc_id) {
            write_json_response(&mut stream, "400 Bad Request", br#"{"ok":false}"#);
            return;
        }
        let pdf_dir = resolve_library_dir().join("pdfs");
        let pdf_file = pdf_dir.join(format!("{doc_id}.pdf"));
        match method.as_str() {
            "GET" => match std::fs::read(&pdf_file) {
                Ok(bytes) => {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    );
                    let _ = stream.write_all(header.as_bytes());
                    let _ = stream.write_all(&bytes);
                }
                Err(_) => {
                    write_json_response(&mut stream, "404 Not Found", br#"{"ok":false}"#);
                }
            },
            "POST" => {
                if std::fs::create_dir_all(&pdf_dir).is_ok() {
                    let tmp_file = pdf_dir.join(format!("{doc_id}.pdf.tmp"));
                    if std::fs::write(&tmp_file, &req_body).is_ok()
                        && std::fs::rename(&tmp_file, &pdf_file).is_ok()
                    {
                        write_json_response(&mut stream, "200 OK", br#"{"ok":true}"#);
                        return;
                    }
                }
                write_json_response(&mut stream, "500 Internal Server Error", br#"{"ok":false}"#);
            }
            "DELETE" => {
                let _ = std::fs::remove_file(&pdf_file);
                write_json_response(&mut stream, "200 OK", br#"{"ok":true}"#);
            }
            _ => {
                write_json_response(&mut stream, "405 Method Not Allowed", br#"{"ok":false}"#);
            }
        }
        return;
    }

    let rel_path = sanitize_relative_path(&raw_target);
    let full_path = ui_root.join(&rel_path);
    let resolved_path = if full_path.is_file() {
        full_path
    } else {
        ui_root.join("index.html")
    };

    match std::fs::read(&resolved_path) {
        Ok(body) => {
            let mime = content_type_for_path(&resolved_path);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&body);
        }
        Err(_) => {
            let not_found = b"404 Not Found";
            let header = format!(
                "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                not_found.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(not_found);
        }
    }
}

fn main() {
    init_tracing();

    // Support `--uninstall-cleanup` invoked by OS uninstallers (NSIS, MSI, deb/rpm postrm, macOS helper)
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

    if let Err(err) = DesktopCommandHandler::try_new_default() {
        tracing::error!(code = %err.code, "Readora initialization failed: {}", err.message);
        std::process::exit(1);
    }

    tracing::info!("Readora desktop core initialized successfully");

    if std::env::args().any(|arg| arg == "--headless-check") {
        return;
    }

    let Some(ui_root) = resolve_ui_dist_dir() else {
        tracing::info!("No bundled UI assets found; exiting after core initialization");
        return;
    };

    let listener = (41937..=41946)
        .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
        .or_else(|| TcpListener::bind("127.0.0.1:0").ok());
    let Some(listener) = listener else {
        tracing::error!("Failed to bind local loopback listener for Readora UI");
        std::process::exit(1);
    };

    let Ok(local_addr) = listener.local_addr() else {
        std::process::exit(1);
    };

    let url = format!("http://127.0.0.1:{}/", local_addr.port());
    tracing::info!("Serving Readora UI on {url}");

    let event_loop = EventLoopBuilder::<DesktopUserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let http_proxy = proxy.clone();

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let ui_dir = ui_root.clone();
            let stream_proxy = http_proxy.clone();
            std::thread::spawn(move || {
                handle_http_connection(stream, &ui_dir, &stream_proxy);
            });
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

    let init_script = r#"
      if (typeof globalThis.Iterator === 'undefined') {
        var IterProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
        function Iterator() {}
        Iterator.prototype = IterProto;
        globalThis.Iterator = Iterator;
      }
      if (typeof globalThis.Iterator.prototype.join !== 'function') {
        globalThis.Iterator.prototype.join = function(sep) {
          return Array.from(this).join(sep);
        };
      }
      if (typeof Promise.withResolvers !== 'function') {
        Promise.withResolvers = function() {
          var resolve, reject;
          var promise = new Promise(function(res, rej) { resolve = res; reject = rej; });
          return { promise: promise, resolve: resolve, reject: reject };
        };
      }
      if (typeof URL.parse !== 'function') {
        URL.parse = function(url, base) {
          try { return new URL(url, base); } catch (_) { return null; }
        };
      }
      window.close = function() {
        if (window.ipc && typeof window.ipc.postMessage === 'function') {
          window.ipc.postMessage('quit');
        }
      };
      window.addEventListener('keydown', function(e) {
        if ((e.metaKey || e.ctrlKey) && e.key && e.key.toLowerCase() === 'q') {
          e.preventDefault();
          if (window.ipc && typeof window.ipc.postMessage === 'function') {
            window.ipc.postMessage('quit');
          }
        }
      });
    "#;

    let webview = match WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(init_script)
        .with_ipc_handler(move |request| {
            if request.body() == "quit" {
                let _ = proxy.send_event(DesktopUserEvent::Quit);
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
