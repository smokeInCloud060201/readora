/**
 * Typed IPC contracts matching the Rust `app-application` and `src-tauri` DTOs.
 */

export type FitMode = "manual" | "fit_width" | "fit_page";
export type Rotation = "deg0" | "deg90" | "deg180" | "deg270";
export type LayoutMode = "single_page" | "continuous";
export type RenderMode = "standard" | "grayscale" | "dark_inversion";
export type ThemePreference = "system" | "light" | "dark";

export interface DocumentMetadataDto {
  title: string | null;
  author: string | null;
  subject: string | null;
  creator: string | null;
  pdf_version: string;
  is_encrypted: boolean;
}

export interface DocumentDescriptorDto {
  id: string;
  file_name: string;
  file_size_bytes: number;
  page_count: number;
  metadata: DocumentMetadataDto;
}

export interface ViewStateDto {
  document_id: string;
  current_page: number;
  page_count: number;
  zoom: number;
  fit_mode: FitMode;
  rotation: Rotation;
  layout_mode: LayoutMode;
  render_mode: RenderMode;
}

export interface OutlineNodeDto {
  title: string;
  page_index: number | null;
  children: OutlineNodeDto[];
}

export interface BookmarkDto {
  id: string;
  document_id: string;
  page_index: number;
  label: string;
  created_at_unix_ms: number;
}

export interface DocumentSessionDto {
  descriptor: DocumentDescriptorDto;
  view_state: ViewStateDto;
  outline: OutlineNodeDto[];
  bookmarks: BookmarkDto[];
}

export interface OpenDocumentRequestDto {
  path: string;
  password: string | null;
}

export interface RenderPageCommandDto {
  document_id: string;
  page_index: number;
  scale: number;
  rotation_degrees: number;
  render_mode: RenderMode;
  generation: number | null;
}

export interface RenderedPageResultDto {
  document_id: string;
  page_index: number;
  width_px: number;
  height_px: number;
  data_url: string;
  cache_hit: boolean;
  generation: number;
}

export type NavigationActionDto =
  | { kind: "go_to_page"; value: number }
  | { kind: "next_page" }
  | { kind: "previous_page" }
  | { kind: "set_zoom"; value: number }
  | { kind: "step_zoom_in" }
  | { kind: "step_zoom_out" }
  | { kind: "set_fit_mode"; value: FitMode }
  | { kind: "rotate_clockwise" }
  | { kind: "rotate_counter_clockwise" }
  | { kind: "set_layout_mode"; value: LayoutMode }
  | { kind: "set_render_mode"; value: RenderMode };

export interface SearchRequestDto {
  document_id: string;
  query: string;
  case_sensitive: boolean;
  max_hits: number;
}

export interface SearchHitDto {
  page_index: number;
  match_index: number;
  snippet: string;
}

export interface RecentDocumentDto {
  document_id: string;
  file_path: string;
  display_name: string;
  last_page: number;
  page_count: number;
  last_zoom: number;
  last_rotation: Rotation;
  last_opened_unix_ms: number;
  is_favorite?: boolean;
  is_archived?: boolean;
}

export interface UpsertBookmarkCommandDto {
  document_id: string;
  page_index: number;
  label: string;
}

export interface AppSettingsDto {
  theme: ThemePreference;
  default_layout: LayoutMode;
  default_fit_mode: FitMode;
  default_zoom: number;
  render_cache_budget_bytes: number;
  prefetch_window: number;
}

export interface SettingsPatchDto {
  theme?: ThemePreference;
  default_layout?: LayoutMode;
  default_fit_mode?: FitMode;
  default_zoom_factor?: number;
  render_cache_budget_bytes?: number;
  prefetch_window?: number;
}

export interface CommandErrorDto {
  code: string;
  message: string;
}

export function rotationToDegrees(rotation: Rotation): number {
  switch (rotation) {
    case "deg90":
      return 90;
    case "deg180":
      return 180;
    case "deg270":
      return 270;
    case "deg0":
    default:
      return 0;
  }
}
