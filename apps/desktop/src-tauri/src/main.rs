//! Binary entry point for the Readora desktop shell.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use app_core::AppCore;
use readora_desktop_lib::{DesktopCommandHandler, init_tracing};

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

fn handle_http_connection(mut stream: TcpStream, ui_root: &Path) {
    let mut buffer = [0_u8; 4096];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let request_line = request.lines().next().unwrap_or("GET / HTTP/1.1");
    let raw_target = request_line.split_whitespace().nth(1).unwrap_or("/");

    let rel_path = sanitize_relative_path(raw_target);
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

fn launch_desktop_window(url: &str) {
    #[cfg(target_os = "macos")]
    {
        let app_browsers = [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ];
        for browser in app_browsers {
            if Path::new(browser).is_file()
                && Command::new(browser)
                    .arg(format!("--app={url}"))
                    .arg("--window-size=1380,880")
                    .spawn()
                    .is_ok()
            {
                return;
            }
        }
        let _ = Command::new("open").arg(url).spawn();
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
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

    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        tracing::error!("Failed to bind local loopback listener for Readora UI");
        std::process::exit(1);
    };

    let Ok(local_addr) = listener.local_addr() else {
        std::process::exit(1);
    };

    let url = format!("http://127.0.0.1:{}/", local_addr.port());
    tracing::info!("Serving Readora UI on {url}");
    launch_desktop_window(&url);

    for stream in listener.incoming().flatten() {
        let ui_dir = ui_root.clone();
        std::thread::spawn(move || {
            handle_http_connection(stream, &ui_dir);
        });
    }
}
