//! Binary entry point for the Readora desktop shell.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use app_core::AppCore;
use readora_desktop_lib::{DesktopCommandHandler, init_tracing};

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

    match DesktopCommandHandler::try_new_default() {
        Ok(_handler) => {
            tracing::info!("Readora desktop core initialized successfully");
        }
        Err(err) => {
            tracing::error!(code = %err.code, "Readora initialization failed: {}", err.message);
            std::process::exit(1);
        }
    }
}
