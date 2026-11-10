//! Binary entry point for the Readora desktop shell.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use readora_desktop_lib::{DesktopCommandHandler, init_tracing};

fn main() {
    init_tracing();
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
