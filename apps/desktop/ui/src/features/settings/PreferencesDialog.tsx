import React, { useEffect, useState } from "react";
import { readoraApi } from "../../lib/tauri/client";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { ReadoraLogo } from "../../shared/components/ReadoraLogo";
import {
  type AppSettingsDto,
  type FitMode,
  type LayoutMode,
  type SettingsPatchDto,
  type SystemDiagnosticsDto,
  type ThemePreference,
} from "../../types/ipc";

export type PreferencesSection =
  | "general"
  | "appearance"
  | "shortcuts"
  | "about";

interface PreferencesDialogProps {
  settings: AppSettingsDto;
  initialSection?: PreferencesSection;
  onSave: (patch: SettingsPatchDto) => void;
  onClose: () => void;
}

const SHORTCUT_ITEMS: readonly { label: string; keys: string }[] = [
  { label: "Open document", keys: "⌘  O" },
  { label: "Search document", keys: "⌘  F" },
  { label: "Toggle page sidebar", keys: "⌘  \\" },
  { label: "Toggle notes panel", keys: "⇧  ⌘  \\" },
  { label: "Zoom in / out", keys: "⌘  + / −" },
  { label: "Add comment", keys: "⌥  ⌘  M" },
  { label: "Fit Page / Fit Width", keys: "⌘  1 / ⌘  2" },
  { label: "Print document", keys: "⌘  P" },
];

export const PreferencesDialog: React.FC<PreferencesDialogProps> = ({
  settings,
  initialSection = "appearance",
  onSave,
  onClose,
}) => {
  const [activeSection, setActiveSection] =
    useState<PreferencesSection>(initialSection);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnosticsDto | null>(
    null,
  );
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
  const [showExtractedTextLayer, setShowExtractedTextLayer] = useState<boolean>(
    Boolean(settings.show_extracted_text_layer),
  );

  // Figma Frame 18: General Preferences local toggles
  const [reopenOnLaunch, setReopenOnLaunch] = useState(true);
  const [rememberPagePosition, setRememberPagePosition] = useState(true);
  const [confirmBeforeDeleting, setConfirmBeforeDeleting] = useState(false);
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [shortcutFilter, setShortcutFilter] = useState("");
  const [platformPreview, setPlatformPreview] = useState<
    "macos" | "windows" | "linux"
  >("macos");

  useEffect(() => {
    void readoraApi.getSystemDiagnostics().then(setDiagnostics);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      theme,
      default_layout: defaultLayout,
      default_fit_mode: defaultFitMode,
      render_cache_budget_bytes:
        Math.min(512, Math.max(8, cacheMiB)) * 1024 * 1024,
      prefetch_window: Math.min(5, Math.max(0, prefetchWindow)),
      show_extracted_text_layer: showExtractedTextLayer,
    });
  };

  const filteredShortcuts = SHORTCUT_ITEMS.filter(
    (item) =>
      !shortcutFilter.trim() ||
      item.label.toLowerCase().includes(shortcutFilter.trim().toLowerCase()) ||
      item.keys.toLowerCase().includes(shortcutFilter.trim().toLowerCase()),
  );

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Reader Preferences"
    >
      <div className="preferences-dialog-shell">
        {/* Left 190px Settings Navigation (Figma Frame 04 / 18 / 19) */}
        <nav className="preferences-nav" aria-label="Preferences Sections">
          <div className="preferences-brand">
            <div className="preferences-logo">
              <ReadoraLogo size={18} />
            </div>
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
            <button
              type="button"
              className={`preferences-nav-btn ${
                activeSection === "about" ? "active" : ""
              }`}
              onClick={() => setActiveSection("about")}
            >
              About & Licenses
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
                    : activeSection === "shortcuts"
                      ? "Keyboard shortcuts"
                      : "About, Diagnostics & Licenses"}
              </h2>
            </div>
            <button
              type="button"
              className="icon-close-btn"
              onClick={onClose}
              aria-label="Close preferences"
            >
              <FocusIcon name="close" size={16} />
            </button>
          </div>

          <div className="preferences-divider" />

          {activeSection === "general" ? (
            <div className="preferences-fields-grid">
              <label className="preferences-toggle-item">
                <div>
                  <span className="preferences-toggle-title">
                    Reopen documents on launch
                  </span>
                  <span className="preferences-toggle-sub">
                    Continue where you stopped reading.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={reopenOnLaunch}
                  onChange={(e) => setReopenOnLaunch(e.target.checked)}
                  aria-label="Reopen documents on launch"
                />
              </label>

              <label className="preferences-toggle-item">
                <div>
                  <span className="preferences-toggle-title">
                    Remember page position
                  </span>
                  <span className="preferences-toggle-sub">
                    Save reading progress for every document.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={rememberPagePosition}
                  onChange={(e) => setRememberPagePosition(e.target.checked)}
                  aria-label="Remember page position"
                />
              </label>

              <label className="preferences-toggle-item">
                <div>
                  <span className="preferences-toggle-title">
                    Confirm before deleting
                  </span>
                  <span className="preferences-toggle-sub">
                    Ask before moving files to the archive.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={confirmBeforeDeleting}
                  onChange={(e) => setConfirmBeforeDeleting(e.target.checked)}
                  aria-label="Confirm before deleting"
                />
              </label>

              <label className="preferences-toggle-item">
                <div>
                  <span className="preferences-toggle-title">
                    Automatically check for updates
                  </span>
                  <span className="preferences-toggle-sub">
                    Keep Focus Reader current.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={autoCheckUpdates}
                  onChange={(e) => setAutoCheckUpdates(e.target.checked)}
                  aria-label="Automatically check for updates"
                />
              </label>

              <label className="preferences-toggle-item">
                <div>
                  <span className="preferences-toggle-title">
                    Show extracted text below page
                  </span>
                  <span className="preferences-toggle-sub">
                    Display the embedded digital text stream beneath the
                    rendered PDF page.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={showExtractedTextLayer}
                  onChange={(e) => setShowExtractedTextLayer(e.target.checked)}
                  aria-label="Show extracted text below page"
                />
              </label>

              <label className="form-field-row">
                <span>Default zoom</span>
                <select
                  aria-label="General Default Zoom"
                  value={defaultFitMode}
                  onChange={(e) => setDefaultFitMode(e.target.value as FitMode)}
                  className="focus-select"
                >
                  <option value="fit_page">Fit page</option>
                  <option value="fit_width">Fit width</option>
                  <option value="manual">100% (Actual size)</option>
                </select>
              </label>
            </div>
          ) : activeSection === "shortcuts" ? (
            <div className="shortcuts-pane">
              <div className="shortcuts-search-box">
                <FocusIcon name="search" size={14} />
                <input
                  type="text"
                  value={shortcutFilter}
                  onChange={(e) => setShortcutFilter(e.target.value)}
                  placeholder="Search shortcuts…"
                  aria-label="Search shortcuts"
                  className="shortcuts-search-input"
                />
              </div>
              <p className="eyebrow-label">GENERAL</p>
              <div className="shortcuts-list">
                {filteredShortcuts.map((item) => (
                  <div key={item.label} className="shortcut-row">
                    <span>{item.label}</span>
                    <kbd>{item.keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ) : activeSection === "about" ? (
            <div
              className="preferences-fields-grid"
              aria-label="System Diagnostics and Licenses"
            >
              <dl className="details-meta-list">
                <div className="details-meta-row">
                  <dt>Release Version</dt>
                  <dd>
                    {diagnostics?.app_version ?? "0.1.0"} (MIT OR Apache-2.0)
                  </dd>
                </div>
                <div className="details-meta-row">
                  <dt>Platform Target</dt>
                  <dd>
                    {diagnostics
                      ? `${diagnostics.target_os} · ${diagnostics.target_arch}`
                      : "Desktop"}
                  </dd>
                </div>
                <div className="details-meta-row">
                  <dt>SQLite Schema</dt>
                  <dd>v{diagnostics?.sqlite_schema_version ?? 3} (WAL)</dd>
                </div>
                <div className="details-meta-row">
                  <dt>Local Data Location</dt>
                  <dd>
                    <code>
                      {diagnostics?.redacted_data_dir ??
                        "~/Library/Application Support/com.readora.desktop"}
                    </code>
                  </dd>
                </div>
              </dl>

              <p className="eyebrow-label">THIRD-PARTY OPEN-SOURCE NOTICES (SBOM)</p>
              <div className="shortcuts-list">
                {(diagnostics?.third_party_notices ?? []).map((notice) => (
                  <div key={notice.name} className="shortcut-row">
                    <span>
                      <strong>{notice.name}</strong> ({notice.version})
                    </span>
                    <span>{notice.license}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="preferences-fields-grid" data-node-id="3:177">
              <p className="eyebrow-label" data-node-id="3:182">
                COLOR THEME
              </p>
              <div className="theme-preview-cards" data-node-id="3:183">
                <button
                  type="button"
                  className={`theme-preview-card light ${
                    theme === "light" ? "selected" : ""
                  }`}
                  onClick={() => setTheme("light")}
                  data-node-id="3:184"
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
                  data-node-id="3:189"
                >
                  <div className="theme-preview-swatch dark-swatch" />
                  <span className="theme-preview-title">Dark</span>
                  <span className="theme-preview-sub">
                    Low-glare charcoal surface for night study
                  </span>
                </button>
              </div>

              <p className="eyebrow-label" data-node-id="3:207">
                PLATFORM PREVIEW
              </p>
              <div
                className="platform-preview-tabs"
                role="radiogroup"
                aria-label="Platform preview"
                data-node-id="3:208"
              >
                {(
                  [
                    { id: "macos", label: "macOS" },
                    { id: "windows", label: "Windows" },
                    { id: "linux", label: "Linux" },
                  ] as const
                ).map((plat) => (
                  <button
                    key={plat.id}
                    type="button"
                    role="radio"
                    aria-checked={platformPreview === plat.id}
                    className={`platform-tab-btn ${
                      platformPreview === plat.id ? "active" : ""
                    }`}
                    onClick={() => setPlatformPreview(plat.id)}
                  >
                    {plat.label}
                  </button>
                ))}
              </div>
              <p className="platform-preview-note" data-node-id="3:217">
                Window controls and keyboard shortcuts adapt automatically to
                your operating system.
              </p>

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

              <label className="preferences-toggle-item">
                <div>
                  <span className="preferences-toggle-title">
                    Show extracted text below page
                  </span>
                  <span className="preferences-toggle-sub">
                    Display the embedded digital text stream beneath the
                    rendered PDF page.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={showExtractedTextLayer}
                  onChange={(e) => setShowExtractedTextLayer(e.target.checked)}
                  aria-label="Show extracted text below page"
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
