import React, { useState } from "react";
import {
  type AppSettingsDto,
  type FitMode,
  type LayoutMode,
  type SettingsPatchDto,
  type ThemePreference,
} from "../../types/ipc";

interface PreferencesDialogProps {
  settings: AppSettingsDto;
  onSave: (patch: SettingsPatchDto) => void;
  onClose: () => void;
}

export const PreferencesDialog: React.FC<PreferencesDialogProps> = ({
  settings,
  onSave,
  onClose,
}) => {
  const [activeSection, setActiveSection] = useState<
    "general" | "appearance" | "shortcuts"
  >("appearance");
  const [theme, setTheme] = useState<ThemePreference>(settings.theme);
  const [defaultLayout, setDefaultLayout] = useState<LayoutMode>(
    settings.default_layout,
  );
  const [defaultFitMode, setDefaultFitMode] = useState<FitMode>(
    settings.default_fit_mode,
  );
  const [cacheMiB, setCacheMiB] = useState<number>(
    Math.round(settings.render_cache_budget_bytes / (1024 * 1024)),
  );
  const [prefetchWindow, setPrefetchWindow] = useState<number>(
    settings.prefetch_window,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      theme,
      default_layout: defaultLayout,
      default_fit_mode: defaultFitMode,
      render_cache_budget_bytes:
        Math.min(512, Math.max(8, cacheMiB)) * 1024 * 1024,
      prefetch_window: Math.min(5, Math.max(0, prefetchWindow)),
    });
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Reader Preferences"
    >
      <div className="preferences-dialog-shell">
        {/* Left 190px Settings Navigation (Figma Frame 04 / 18) */}
        <nav
          className="preferences-nav"
          aria-label="Preferences Sections"
        >
          <div className="preferences-brand">
            <div className="preferences-logo">F</div>
            <span className="preferences-brand-title">Preferences</span>
          </div>

          <div className="preferences-nav-items">
            <button
              type="button"
              className={`preferences-nav-btn ${
                activeSection === "general" ? "active" : ""
              }`}
              onClick={() => setActiveSection("general")}
            >
              General
            </button>
            <button
              type="button"
              className={`preferences-nav-btn ${
                activeSection === "appearance" ? "active" : ""
              }`}
              onClick={() => setActiveSection("appearance")}
            >
              Appearance
            </button>
            <button
              type="button"
              className={`preferences-nav-btn ${
                activeSection === "shortcuts" ? "active" : ""
              }`}
              onClick={() => setActiveSection("shortcuts")}
            >
              Shortcuts
            </button>
          </div>

          <span className="preferences-version">Focus Reader 1.0.0</span>
        </nav>

        {/* Right 530px Content Pane */}
        <form onSubmit={handleSubmit} className="preferences-content">
          <div className="preferences-content-header">
            <div>
              <p className="eyebrow-label">PREFERENCES</p>
              <h2 className="preferences-heading">
                {activeSection === "general"
                  ? "General"
                  : activeSection === "appearance"
                    ? "Platform & Appearance"
                    : "Keyboard Shortcuts"}
              </h2>
            </div>
            <button
              type="button"
              className="icon-close-btn"
              onClick={onClose}
              aria-label="Close preferences"
            >
              ×
            </button>
          </div>

          <div className="preferences-divider" />

          {activeSection === "shortcuts" ? (
            <div className="shortcuts-list">
              <div className="shortcut-row">
                <span>Next / Previous Page</span>
                <kbd>→ / ←</kbd>
              </div>
              <div className="shortcut-row">
                <span>Zoom In / Out</span>
                <kbd>⌘+ / ⌘−</kbd>
              </div>
              <div className="shortcut-row">
                <span>Fit Page / Fit Width</span>
                <kbd>⌘1 / ⌘2</kbd>
              </div>
              <div className="shortcut-row">
                <span>Find in Document</span>
                <kbd>⌘F</kbd>
              </div>
            </div>
          ) : (
            <div className="preferences-fields-grid">
              <div className="theme-preview-cards">
                <button
                  type="button"
                  className={`theme-preview-card light ${
                    theme === "light" ? "selected" : ""
                  }`}
                  onClick={() => setTheme("light")}
                >
                  <div className="theme-preview-swatch light-swatch" />
                  <span className="theme-preview-title">Light</span>
                  <span className="theme-preview-sub">
                    Warm paper surface for daytime reading
                  </span>
                </button>
                <button
                  type="button"
                  className={`theme-preview-card dark ${
                    theme === "dark" ? "selected" : ""
                  }`}
                  onClick={() => setTheme("dark")}
                >
                  <div className="theme-preview-swatch dark-swatch" />
                  <span className="theme-preview-title">Dark</span>
                  <span className="theme-preview-sub">
                    Low-glare charcoal surface for night study
                  </span>
                </button>
              </div>

              <label className="form-field-row">
                <span>Theme</span>
                <select
                  aria-label="Preference Theme"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as ThemePreference)}
                  className="focus-select"
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>

              <label className="form-field-row">
                <span>Default Layout</span>
                <select
                  aria-label="Preference Default Layout"
                  value={defaultLayout}
                  onChange={(e) =>
                    setDefaultLayout(e.target.value as LayoutMode)
                  }
                  className="focus-select"
                >
                  <option value="single_page">Single Page</option>
                  <option value="continuous">Continuous Scroll</option>
                </select>
              </label>

              <label className="form-field-row">
                <span>Default Fit Mode</span>
                <select
                  aria-label="Preference Default Fit Mode"
                  value={defaultFitMode}
                  onChange={(e) => setDefaultFitMode(e.target.value as FitMode)}
                  className="focus-select"
                >
                  <option value="fit_width">Fit Width</option>
                  <option value="fit_page">Fit Page</option>
                  <option value="manual">Manual Zoom</option>
                </select>
              </label>

              <label className="form-field-row">
                <span>Render Cache Budget (MiB, 8–512)</span>
                <input
                  type="number"
                  min={8}
                  max={512}
                  value={cacheMiB}
                  onChange={(e) =>
                    setCacheMiB(Number.parseInt(e.target.value, 10) || 64)
                  }
                  className="focus-input compact"
                />
              </label>

              <label className="form-field-row">
                <span>Prefetch Window (Pages, 0–5)</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={prefetchWindow}
                  onChange={(e) =>
                    setPrefetchWindow(Number.parseInt(e.target.value, 10) || 0)
                  }
                  className="focus-input compact"
                />
              </label>
            </div>
          )}

          <div className="preferences-footer">
            <button
              type="button"
              className="focus-btn secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button type="submit" className="focus-btn primary">
              Save Preferences
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
