//! SQLite repository implementation for `SettingsRepository`.

use app_application::{ApplicationError, SettingsRepository};
use app_domain::AppSettings;
use rusqlite::params;

use crate::SqliteStorage;

impl SettingsRepository for SqliteStorage {
    fn load(&self) -> Result<AppSettings, ApplicationError> {
        let conn = self.lock_connection()?;
        let mut stmt = conn
            .prepare("SELECT settings_json FROM app_settings WHERE singleton_id = 1")
            .map_err(|e| ApplicationError::Storage(format!("prepare settings load failed: {e}")))?;

        let mut rows = stmt
            .query([])
            .map_err(|e| ApplicationError::Storage(format!("query settings failed: {e}")))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| ApplicationError::Storage(format!("fetch settings row failed: {e}")))?
        {
            let json_str: String = row
                .get(0)
                .map_err(|e| ApplicationError::Storage(e.to_string()))?;
            let parsed: AppSettings = serde_json::from_str(&json_str).map_err(|e| {
                ApplicationError::Storage(format!("corrupt settings JSON in storage: {e}"))
            })?;
            Ok(parsed)
        } else {
            Ok(AppSettings::default())
        }
    }

    fn save(&self, settings: &AppSettings) -> Result<(), ApplicationError> {
        settings.validate()?;
        let json_str = serde_json::to_string(settings)
            .map_err(|e| ApplicationError::Storage(format!("serialize settings failed: {e}")))?;
        let conn = self.lock_connection()?;
        conn.execute(
            "INSERT INTO app_settings (singleton_id, settings_json)
             VALUES (1, ?1)
             ON CONFLICT(singleton_id) DO UPDATE SET settings_json = excluded.settings_json",
            params![json_str],
        )
        .map_err(|e| ApplicationError::Storage(format!("save settings failed: {e}")))?;
        Ok(())
    }
}
