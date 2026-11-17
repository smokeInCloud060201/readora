import React, { useEffect, useState } from "react";
import { readoraApi } from "../../lib/tauri/client";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { ReadoraLogo } from "../../shared/components/ReadoraLogo";
import { useModalDialog } from "../../shared/hooks/useModalDialog";
import {
  type AppSettingsDto,
  type AppUpdateStatusDto,
  type FitMode,
  type LayoutMode,
  type SettingsPatchDto,
  type SystemDiagnosticsDto,
  type ThemePreference,
  type ThirdPartyNoticeDto,
} from "../../types/ipc";

export type PreferencesSection =
  | "general"
  | "appearance"
  | "shortcuts"
  | "about";

interface PreferencesDialogProps {
  settings: AppSettingsDto;
  initialSection?: PreferencesSection;
  updateStatus?: AppUpdateStatusDto | null;
  onCheckForUpdates?: () => void;
  onSave: (patch: SettingsPatchDto) => void;
  onCleanupAppData?: () => void;
  onClose: () => void;
}

const PREFERENCE_ZOOM_PRESETS: readonly number[] = [
  0.5, 0.75, 1.0, 1.25, 1.5, 2.0,
];

const FALLBACK_APP_VERSION = "1.1.1";
const FALLBACK_SQLITE_SCHEMA_VERSION = 4;

const FALLBACK_THIRD_PARTY_NOTICES: readonly ThirdPartyNoticeDto[] = [
  {
    name: "PDFium",
    version: "chromium/8165",
    license: "BSD-3-Clause AND Apache-2.0",
    role: "Dynamic native PDF rendering engine",
  },
  {
    name: "pdfjs-dist (Mozilla PDF.js)",
    version: "6.5",
    license: "Apache-2.0",
    role: "Local WebView/Canvas PDF parsing, rendering, and text extraction",
  },
  {
    name: "rusqlite + SQLite",
    version: "0.32",
    license: "MIT AND Blessing",
    role: "Local WAL persistence for recents, bookmarks, annotations, and settings",
  },
  {
    name: "tao + wry",
    version: "0.31 / 0.48",
    license: "Apache-2.0 OR MIT",
    role: "Cross-platform native desktop windowing and OS WebView shell",
  },
  {
    name: "React + TypeScript",
    version: "19.x / 5.9",
    license: "MIT AND Apache-2.0",
    role: "Presentation UI layer",
  },
];

const SHORTCUT_ITEMS: readonly { label: string; keys: string }[] = [
  { label: "Open document", keys: "⌘ / Ctrl + O" },
  { label: "Close document", keys: "⌘ / Ctrl + W" },
  { label: "Show library", keys: "⇧ ⌘ / Ctrl + L" },
  { label: "Search document or library", keys: "⌘ / Ctrl + F" },
  { label: "Next / Previous page", keys: "→ / ← or ↓ / ↑" },
  { label: "Toggle page sidebar", keys: "⌘ / Ctrl + \\" },
  { label: "Toggle notes panel", keys: "⇧ ⌘ / Ctrl + \\" },
  { label: "Document properties", keys: "⌘ / Ctrl + I" },
  { label: "Highlight options", keys: "H" },
  { label: "Add comment", keys: "C or ⌥ ⌘ M" },
  { label: "Zoom in / out", keys: "⌘ / Ctrl + + / −" },
  { label: "Actual size (100%)", keys: "⌘ / Ctrl + 0" },
  { label: "Fit Page / Fit Width", keys: "⌘ 1 / ⌘ 2" },
  { label: "Rotate clockwise / counterclockwise", keys: "⌘ ] / ⌘ [" },
  { label: "Export annotations", keys: "⇧ ⌘ / Ctrl + S" },
  { label: "Print document", keys: "⌘ / Ctrl + P" },
  { label: "Preferences", keys: "⌘ / Ctrl + ," },
];

function clampCacheMiB(raw: string): number {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed)) {
    return 64;
  }
  return Math.min(512, Math.max(8, parsed));
}

function clampPrefetchWindow(raw: string): number {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed)) {
    return 1;
  }
  return Math.min(5, Math.max(0, parsed));
}

export const PreferencesDialog: React.FC<PreferencesDialogProps> = ({
  settings,
  initialSection = "appearance",
  updateStatus = null,
  onCheckForUpdates,
  onSave,
  onCleanupAppData,
  onClose,
}) => {
  const { dialogRef, handleBackdropMouseDown } = useModalDialog(onClose);
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
  const [defaultZoomFactor, setDefaultZoomFactor] = useState<number>(
    settings.default_zoom || 1.0,
  );
  const [cacheMiBInput, setCacheMiBInput] = useState<string>(() =>
    String(Math.round(settings.render_cache_budget_bytes / (1024 * 1024))),
  );
  const [prefetchWindowInput, setPrefetchWindowInput] = useState<string>(() =>
    String(settings.prefetch_window),
  );
  const [showExtractedTextLayer, setShowExtractedTextLayer] = useState<boolean>(
    Boolean(settings.show_extracted_text_layer),
  );

  // Durable General Preferences toggles wired to AppSettingsDto / SettingsPatchDto
  const [reopenOnLaunch, setReopenOnLaunch] = useState<boolean>(
    settings.reopen_last_document ?? false,
  );
  const [rememberPagePosition, setRememberPagePosition] = useState<boolean>(
    settings.remember_page_position ?? true,
  );
  const [confirmBeforeDeleting, setConfirmBeforeDeleting] = useState<boolean>(
    settings.confirm_before_delete ?? false,
  );
  const [autoCheckUpdates, setAutoCheckUpdates] = useState<boolean>(
    settings.auto_check_updates ?? true,
  );
  const [githubReleaseRepo, setGithubReleaseRepo] = useState<string>(
    settings.github_release_repo ?? "smokeInCloud060201/readora",
  );
  const [shortcutFilter, setShortcutFilter] = useState("");

  useEffect(() => {
    void readoraApi.getSystemDiagnostics().then(setDiagnostics);
  }, []);

  const isCustomDefaultZoom = !PREFERENCE_ZOOM_PRESETS.some(
    (preset) => Math.abs(preset - defaultZoomFactor) < 0.001,
  );

  const generalZoomSelectValue =
    defaultFitMode === "fit_page" || defaultFitMode === "fit_width"
      ? defaultFitMode
      : Math.abs(defaultZoomFactor - 1.0) < 0.001
        ? "manual"
        : `zoom:${defaultZoomFactor}`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clampedCache = clampCacheMiB(cacheMiBInput);
    const clampedPrefetch = clampPrefetchWindow(prefetchWindowInput);
    setCacheMiBInput(String(clampedCache));
    setPrefetchWindowInput(String(clampedPrefetch));

    onSave({
      theme,
      default_layout: defaultLayout,
      default_fit_mode: defaultFitMode,
      default_zoom_factor: Math.min(5.0, Math.max(0.25, defaultZoomFactor)),
      render_cache_budget_bytes: clampedCache * 1024 * 1024,
      prefetch_window: clampedPrefetch,
      reopen_last_document: reopenOnLaunch,
      remember_page_position: rememberPagePosition,
      confirm_before_delete: confirmBeforeDeleting,
      show_extracted_text_layer: showExtractedTextLayer,
      auto_check_updates: autoCheckUpdates,
      github_release_repo:
        githubReleaseRepo.trim() || "smokeInCloud060201/readora",
    });
  };

  const filteredShortcuts = SHORTCUT_ITEMS.filter(
    (item) =>
      !shortcutFilter.trim() ||
      item.label.toLowerCase().includes(shortcutFilter.trim().toLowerCase()) ||
      item.keys.toLowerCase().includes(shortcutFilter.trim().toLowerCase()),
  );

  const resolvedVersion =
    diagnostics?.app_version ??
    settings.installed_version ??
    FALLBACK_APP_VERSION;
  const resolvedNotices =
    diagnostics && diagnostics.third_party_notices.length > 0
      ? diagnostics.third_party_notices
      : FALLBACK_THIRD_PARTY_NOTICES;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Reader Preferences"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="preferences-dialog-shell"
      >
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
              About &amp; Licenses
            </button>
          </div>

          <span className="preferences-version">
            Focus Reader {resolvedVersion}
          </span>
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
                    ? "Appearance"
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
                    Ask before permanently removing library entries.
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
                    Query GitHub Releases ({githubReleaseRepo}) on launch and
                    notify when a verified update is ready.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={autoCheckUpdates}
                  onChange={(e) => setAutoCheckUpdates(e.target.checked)}
                  aria-label="Automatically check for updates"
                />
              </label>

              <label className="form-field-row">
                <span>GitHub Release Repository</span>
                <input
                  type="text"
                  aria-label="GitHub Release Repository"
                  value={githubReleaseRepo}
                  onChange={(e) => setGithubReleaseRepo(e.target.value)}
                  placeholder="owner/repo"
                  className="focus-input"
                />
              </label>

              <label className="form-field-row">
                <span>Default zoom</span>
                <select
                  aria-label="General Default Zoom"
                  value={generalZoomSelectValue}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "fit_page" || raw === "fit_width") {
                      setDefaultFitMode(raw);
                    } else if (raw === "manual") {
                      setDefaultFitMode("manual");
                      setDefaultZoomFactor(1.0);
                    } else if (raw.startsWith("zoom:")) {
                      const parsedZoom = Number.parseFloat(raw.slice(5));
                      if (!Number.isNaN(parsedZoom)) {
                        setDefaultFitMode("manual");
                        setDefaultZoomFactor(parsedZoom);
                      }
                    }
                  }}
                  className="focus-select"
                >
                  <option value="fit_page">Fit page</option>
                  <option value="fit_width">Fit width</option>
                  {PREFERENCE_ZOOM_PRESETS.map((preset) => (
                    <option
                      key={preset}
                      value={
                        Math.abs(preset - 1.0) < 0.001
                          ? "manual"
                          : `zoom:${preset}`
                      }
                    >
                      {Math.abs(preset - 1.0) < 0.001
                        ? "100% (Actual size)"
                        : `${Math.round(preset * 100)}%`}
                    </option>
                  ))}
                  {isCustomDefaultZoom && (
                    <option value={`zoom:${defaultZoomFactor}`}>
                      {Math.round(defaultZoomFactor * 100)}% (Custom)
                    </option>
                  )}
                </select>
              </label>

              {onCleanupAppData && (
                <div className="preferences-toggle-item">
                  <div>
                    <span className="preferences-toggle-title">
                      Clean up application data &amp; cache
                    </span>
                    <span className="preferences-toggle-sub">
                      Removes only Readora’s SQLite database and render cache.
                      Your PDF files on disk are never deleted.
                    </span>
                  </div>
                  <button
                    type="button"
                    className="focus-btn secondary danger-text"
                    onClick={onCleanupAppData}
                    aria-label="Clean up application data and cache"
                  >
                    Clean up app data
                  </button>
                </div>
              )}
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
              {onCheckForUpdates && (
                <div className="preferences-toggle-item">
                  <div>
                    <span className="preferences-toggle-title">
                      Software updates
                    </span>
                    <span className="preferences-toggle-sub">
                      {updateStatus?.update_available &&
                      updateStatus.latest_version
                        ? `Focus Reader ${updateStatus.latest_version} is ready to install.`
                        : `Installed release: Focus Reader ${resolvedVersion} (${githubReleaseRepo}).`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`focus-btn ${
                      updateStatus?.update_available ? "primary" : "secondary"
                    }`}
                    onClick={onCheckForUpdates}
                    aria-label="Check for updates"
                  >
                    {updateStatus?.update_available &&
                    updateStatus.latest_version
                      ? `Update to ${updateStatus.latest_version}`
                      : "Check for updates"}
                  </button>
                </div>
              )}

              <dl className="details-meta-list">
                <div className="details-meta-row">
                  <dt>Release Version</dt>
                  <dd>{resolvedVersion} (MIT OR Apache-2.0)</dd>
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
                  <dd>
                    v
                    {diagnostics?.sqlite_schema_version ??
                      FALLBACK_SQLITE_SCHEMA_VERSION}{" "}
                    (WAL)
                  </dd>
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

              <p className="eyebrow-label">
                THIRD-PARTY OPEN-SOURCE NOTICES (SBOM)
              </p>
              <div className="shortcuts-list">
                {resolvedNotices.map((notice) => (
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
                  onChange={(e) => {
                    const mode = e.target.value as FitMode;
                    setDefaultFitMode(mode);
                  }}
                  className="focus-select"
                >
                  <option value="fit_width">Fit Width</option>
                  <option value="fit_page">Fit Page</option>
                  <option value="manual">
                    Manual Zoom ({Math.round(defaultZoomFactor * 100)}%)
                  </option>
                </select>
              </label>

              <label className="form-field-row">
                <span>Render Cache Budget (MiB, 8–512)</span>
                <input
                  type="number"
                  min={8}
                  max={512}
                  value={cacheMiBInput}
                  onChange={(e) => setCacheMiBInput(e.target.value)}
                  onBlur={() =>
                    setCacheMiBInput(String(clampCacheMiB(cacheMiBInput)))
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
                  value={prefetchWindowInput}
                  onChange={(e) => setPrefetchWindowInput(e.target.value)}
                  onBlur={() =>
                    setPrefetchWindowInput(
                      String(clampPrefetchWindow(prefetchWindowInput)),
                    )
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
