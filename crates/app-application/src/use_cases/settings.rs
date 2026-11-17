//! Use cases for reading and updating application settings and cache budgets.

use app_domain::{AppSettings, DomainError, ZoomLevel, is_valid_github_repo_slug};

use crate::dto::SettingsPatchDto;
use crate::error::ApplicationError;
use crate::ports::render_cache::RenderCachePort;
use crate::ports::storage::SettingsRepository;

/// Loads current application settings.
pub fn execute_get_settings(
    settings_repo: &dyn SettingsRepository,
) -> Result<AppSettings, ApplicationError> {
    settings_repo.load()
}

/// Applies a partial settings update, validates domain invariants, updates the live render
/// cache budget, and persists the updated settings.
pub fn execute_update_settings(
    patch: SettingsPatchDto,
    settings_repo: &dyn SettingsRepository,
    render_cache: &dyn RenderCachePort,
) -> Result<AppSettings, ApplicationError> {
    let mut settings = settings_repo.load()?;

    if let Some(theme) = patch.theme {
        settings.theme = theme;
    }
    if let Some(default_layout) = patch.default_layout {
        settings.default_layout = default_layout;
    }
    if let Some(default_fit_mode) = patch.default_fit_mode {
        settings.default_fit_mode = default_fit_mode;
    }
    if let Some(zoom_factor) = patch.default_zoom_factor {
        settings.default_zoom = ZoomLevel::new(zoom_factor)?;
    }
    if let Some(budget_bytes) = patch.render_cache_budget_bytes {
        settings.render_cache_budget_bytes = budget_bytes;
    }
    if let Some(prefetch_window) = patch.prefetch_window {
        settings.prefetch_window = prefetch_window;
    }
    if let Some(show_extracted_text_layer) = patch.show_extracted_text_layer {
        settings.show_extracted_text_layer = show_extracted_text_layer;
    }
    if let Some(auto_check_updates) = patch.auto_check_updates {
        settings.auto_check_updates = auto_check_updates;
    }
    if let Some(reopen_last_document) = patch.reopen_last_document {
        settings.reopen_last_document = reopen_last_document;
    }
    if let Some(remember_page_position) = patch.remember_page_position {
        settings.remember_page_position = remember_page_position;
    }
    if let Some(confirm_before_delete) = patch.confirm_before_delete {
        settings.confirm_before_delete = confirm_before_delete;
    }
    if let Some(github_repo) = patch.github_release_repo {
        let trimmed = github_repo.trim();
        if !is_valid_github_repo_slug(trimmed) {
            return Err(ApplicationError::Domain(DomainError::InvalidSettings(
                format!("invalid GitHub repository slug '{trimmed}'"),
            )));
        }
        settings.github_release_repo = trimmed.to_owned();
    }

    settings.validate()?;
    settings_repo.save(&settings)?;
    render_cache.set_budget_bytes(settings.render_cache_budget_bytes);

    Ok(settings)
}
