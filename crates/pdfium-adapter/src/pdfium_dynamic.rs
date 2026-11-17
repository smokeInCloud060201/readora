//! Dynamic PDFium library loader and `PdfDocument` wrapper using `pdfium-render`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use app_domain::{
    DocumentMetadata, OutlineNode, PageDimensions, PageIndex, Rotation, SearchHit,
    sanitize_display_name,
};
use bytes::Bytes;
use pdf_engine::{
    EngineDocumentInfo, OpenDocumentOptions, PageGeometry, PdfDocument, PdfEngineError,
    RenderPageRequest, RenderedPage,
};
use pdfium_render::prelude::*;

use crate::fallback_engine::{
    extract_header_pdf_version, has_encrypt_dict_bytes, inspect_advanced_pdf_capabilities_bytes,
    search_page_text_hits,
};
use crate::png_encoder::{apply_render_mode_rgba, encode_rgba_to_png};

const MAX_OUTLINE_DEPTH: usize = 16;
const MAX_OUTLINE_NODES: usize = 4096;

#[derive(Debug, Clone)]
enum ResolvedPdfiumSource {
    LibraryFile(PathBuf),
    SystemLibrary,
}

static DEFAULT_PDFIUM_SOURCE: OnceLock<Option<ResolvedPdfiumSource>> = OnceLock::new();

fn probe_library_file_in_dir(dir: &Path) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }
    let lib_path = if dir.is_dir() {
        Pdfium::pdfium_platform_library_name_at_path(dir)
    } else {
        dir.to_path_buf()
    };
    if Pdfium::bind_to_library(&lib_path).is_ok() {
        Some(lib_path)
    } else {
        None
    }
}

fn bind_resolved_source(source: &ResolvedPdfiumSource) -> Option<Pdfium> {
    match source {
        ResolvedPdfiumSource::LibraryFile(path) => {
            Pdfium::bind_to_library(path).ok().map(Pdfium::new)
        }
        ResolvedPdfiumSource::SystemLibrary => {
            Pdfium::bind_to_system_library().ok().map(Pdfium::new)
        }
    }
}

fn resolve_default_pdfium_source() -> Option<ResolvedPdfiumSource> {
    DEFAULT_PDFIUM_SOURCE
        .get_or_init(|| {
            if let Ok(exe_path) = std::env::current_exe()
                && let Some(exe_dir) = exe_path.parent()
            {
                let bundle_candidates = [
                    exe_dir.join("../Resources/pdfium"),
                    exe_dir.join("../Frameworks"),
                    exe_dir.join("pdfium"),
                    exe_dir.to_path_buf(),
                    exe_dir.join("../share/readora/pdfium"),
                    exe_dir.join("../lib/readora"),
                    PathBuf::from("/usr/share/readora/pdfium"),
                ];
                for candidate in bundle_candidates {
                    if let Some(lib_path) = probe_library_file_in_dir(&candidate) {
                        return Some(ResolvedPdfiumSource::LibraryFile(lib_path));
                    }
                }
            }

            // Never dlopen relative to CWD in release builds (`HIGH-01`).
            #[cfg(debug_assertions)]
            {
                if let Some(lib_path) = probe_library_file_in_dir(Path::new("assets/pdfium")) {
                    return Some(ResolvedPdfiumSource::LibraryFile(lib_path));
                }
            }

            if Pdfium::bind_to_system_library().is_ok() {
                return Some(ResolvedPdfiumSource::SystemLibrary);
            }

            None
        })
        .clone()
}

fn resolve_pdfium_source(custom_dir: Option<&Path>) -> Option<ResolvedPdfiumSource> {
    if let Ok(env_dir) = std::env::var("READORA_PDFIUM_PATH") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty()
            && let Some(lib_path) = probe_library_file_in_dir(Path::new(trimmed))
        {
            return Some(ResolvedPdfiumSource::LibraryFile(lib_path));
        }
    }

    if let Some(dir) = custom_dir
        && let Some(lib_path) = probe_library_file_in_dir(dir)
    {
        return Some(ResolvedPdfiumSource::LibraryFile(lib_path));
    }

    resolve_default_pdfium_source()
}

/// Resolves the concrete `libpdfium` path if found in an explicit or bundled directory.
#[must_use]
pub fn resolve_pdfium_library_path(custom_dir: Option<&Path>) -> Option<PathBuf> {
    match resolve_pdfium_source(custom_dir)? {
        ResolvedPdfiumSource::LibraryFile(path) => Some(path),
        ResolvedPdfiumSource::SystemLibrary => None,
    }
}

/// Attempts to locate and bind to a native PDFium shared library across environment overrides,
/// application bundle resource directories, debug workspace assets, and system library paths.
#[must_use]
pub fn try_bind_pdfium(custom_dir: Option<&Path>) -> Option<Pdfium> {
    let source = resolve_pdfium_source(custom_dir)?;
    bind_resolved_source(&source)
}

/// Computes target `(width_px, height_px)` from PDFium's `page.width()` / `page.height()`.
///
/// PDFium's `FPDF_GetPageWidthF` / `FPDF_GetPageHeightF` already incorporate any intrinsic
/// `/Rotate` entry on the page dictionary, so only the user-requested `user_rotation` is
/// applied here (avoiding intrinsic `/Rotate` double-swaps).
pub(crate) fn compute_pdfium_target_pixel_size(
    pdfium_page_width_pt: f32,
    pdfium_page_height_pt: f32,
    scale: f32,
    user_rotation: Rotation,
    max_pixel_dimension: u32,
) -> Result<(u32, u32), PdfEngineError> {
    let dimensions = PageDimensions::new(pdfium_page_width_pt, pdfium_page_height_pt)
        .map_err(|e| PdfEngineError::InvalidPdfFormat(e.to_string()))?;
    match dimensions.target_pixel_size(scale, user_rotation, max_pixel_dimension) {
        Ok(pair) => Ok(pair),
        Err(app_domain::DomainError::RenderDimensionsExceedLimit {
            width_px,
            height_px,
            max_px,
        }) => Err(PdfEngineError::RenderDimensionsExceedLimit {
            width_px,
            height_px,
            max_px,
        }),
        Err(err) => Err(PdfEngineError::Internal(err.to_string())),
    }
}

fn format_pdfium_version(version: PdfDocumentVersion, header_bytes: &[u8]) -> String {
    match version {
        PdfDocumentVersion::Pdf1_0 => "1.0".to_owned(),
        PdfDocumentVersion::Pdf1_1 => "1.1".to_owned(),
        PdfDocumentVersion::Pdf1_2 => "1.2".to_owned(),
        PdfDocumentVersion::Pdf1_3 => "1.3".to_owned(),
        PdfDocumentVersion::Pdf1_4 => "1.4".to_owned(),
        PdfDocumentVersion::Pdf1_5 => "1.5".to_owned(),
        PdfDocumentVersion::Pdf1_6 => "1.6".to_owned(),
        PdfDocumentVersion::Pdf1_7 => "1.7".to_owned(),
        PdfDocumentVersion::Pdf2_0 => "2.0".to_owned(),
        PdfDocumentVersion::Other(raw) if raw >= 10 => format!("{}.{}", raw / 10, raw % 10),
        PdfDocumentVersion::Unset | PdfDocumentVersion::Other(_) => {
            extract_header_pdf_version(header_bytes).unwrap_or_else(|| "1.7".to_owned())
        }
    }
}

fn collect_outline_level<'a>(
    first: Option<PdfBookmark<'a>>,
    depth: usize,
    visited: &mut HashSet<PdfBookmark<'a>>,
    total_count: &mut usize,
) -> Vec<OutlineNode> {
    if depth >= MAX_OUTLINE_DEPTH || *total_count >= MAX_OUTLINE_NODES {
        return Vec::new();
    }

    let mut nodes = Vec::new();
    let mut cursor = first;
    while let Some(bookmark) = cursor {
        if *total_count >= MAX_OUTLINE_NODES || !visited.insert(bookmark.clone()) {
            break;
        }
        *total_count += 1;

        let children = if depth + 1 < MAX_OUTLINE_DEPTH {
            collect_outline_level(bookmark.first_child(), depth + 1, visited, total_count)
        } else {
            Vec::new()
        };

        if let Some(raw_title) = bookmark.title() {
            let title = sanitize_display_name(&raw_title);
            let page_index = bookmark
                .destination()
                .and_then(|d| d.page_index().ok())
                .map(|idx| PageIndex::new(u32::from(idx)));
            nodes.push(OutlineNode {
                title,
                page_index,
                children,
            });
        } else if !children.is_empty() {
            nodes.extend(children);
        }

        cursor = bookmark.next_sibling();
    }
    nodes
}

/// PDFium-backed document wrapper that serializes PDFium calls, caches its resolved library
/// source, stores shared `Bytes`, and zeroizes any password buffer on drop.
pub struct DynamicPdfiumDocument {
    info: EngineDocumentInfo,
    pdf_bytes: Bytes,
    password_utf8: Vec<u8>,
    resolved_source: ResolvedPdfiumSource,
    render_lock: Mutex<()>,
}

impl Drop for DynamicPdfiumDocument {
    fn drop(&mut self) {
        for byte in &mut self.password_utf8 {
            *byte = 0;
        }
        std::hint::black_box(&mut self.password_utf8);
        self.password_utf8.clear();
    }
}

impl DynamicPdfiumDocument {
    /// Opens and validates a PDF byte buffer using the dynamically loaded PDFium library.
    pub fn open(
        bytes: Bytes,
        options: &OpenDocumentOptions,
        library_dir: Option<PathBuf>,
    ) -> Result<Self, PdfEngineError> {
        let max_size = options.effective_max_file_size();
        if (bytes.len() as u64) > max_size {
            return Err(PdfEngineError::FileTooLarge {
                size_bytes: bytes.len() as u64,
                max_bytes: max_size,
            });
        }

        let resolved_source = resolve_pdfium_source(library_dir.as_deref()).ok_or_else(|| {
            PdfEngineError::EngineUnavailable("native PDFium library not found".to_owned())
        })?;
        let pdfium = bind_resolved_source(&resolved_source).ok_or_else(|| {
            PdfEngineError::EngineUnavailable("native PDFium library could not be bound".to_owned())
        })?;

        let effective_password = options.password.as_deref().filter(|pw| !pw.is_empty());

        let (page_count, metadata) = {
            let doc = pdfium
                .load_pdf_from_byte_slice(&bytes, effective_password)
                .map_err(|err| map_pdfium_error(err, effective_password.is_some()))?;

            let page_count = u32::from(doc.pages().len());
            if page_count == 0 {
                return Err(PdfEngineError::InvalidPdfFormat(
                    "PDF document contains 0 pages".to_owned(),
                ));
            }

            let (form_support, form_field_count, signature_status, signature_field_count) =
                inspect_advanced_pdf_capabilities_bytes(&bytes);

            let version_str = format_pdfium_version(doc.version(), &bytes);
            let is_encrypted = effective_password.is_some() || has_encrypt_dict_bytes(&bytes);
            let metadata = DocumentMetadata {
                title: doc
                    .metadata()
                    .get(PdfDocumentMetadataTagType::Title)
                    .map(|t| t.value().to_owned()),
                author: doc
                    .metadata()
                    .get(PdfDocumentMetadataTagType::Author)
                    .map(|t| t.value().to_owned()),
                subject: doc
                    .metadata()
                    .get(PdfDocumentMetadataTagType::Subject)
                    .map(|t| t.value().to_owned()),
                creator: doc
                    .metadata()
                    .get(PdfDocumentMetadataTagType::Creator)
                    .map(|t| t.value().to_owned()),
                pdf_version: version_str,
                is_encrypted,
                form_support,
                form_field_count,
                signature_status,
                signature_field_count,
            };
            (page_count, metadata)
        };

        let password_utf8 = effective_password.map_or_else(Vec::new, |pw| pw.as_bytes().to_vec());

        Ok(Self {
            info: EngineDocumentInfo {
                page_count,
                metadata,
            },
            pdf_bytes: bytes,
            password_utf8,
            resolved_source,
            render_lock: Mutex::new(()),
        })
    }

    fn bind(&self) -> Result<Pdfium, PdfEngineError> {
        bind_resolved_source(&self.resolved_source).ok_or_else(|| {
            PdfEngineError::EngineUnavailable("native PDFium library became unavailable".to_owned())
        })
    }

    fn password_str(&self) -> Option<&str> {
        if self.password_utf8.is_empty() {
            None
        } else {
            std::str::from_utf8(&self.password_utf8).ok()
        }
    }
}

impl PdfDocument for DynamicPdfiumDocument {
    fn info(&self) -> &EngineDocumentInfo {
        &self.info
    }

    fn page_geometry(&self, page_index: PageIndex) -> Result<PageGeometry, PdfEngineError> {
        let _guard = self
            .render_lock
            .lock()
            .map_err(|_| PdfEngineError::Internal("PDFium lock poisoned".to_owned()))?;
        let pdfium = self.bind()?;
        let pw = self.password_str();
        let doc = pdfium
            .load_pdf_from_byte_slice(&self.pdf_bytes, pw)
            .map_err(|e| map_pdfium_error(e, pw.is_some()))?;

        let idx_u16 = u16::try_from(page_index.zero_based()).map_err(|_| {
            PdfEngineError::PageOutOfBounds {
                page_index: page_index.zero_based(),
                page_count: self.info.page_count,
            }
        })?;
        let page = doc
            .pages()
            .get(idx_u16)
            .map_err(|_| PdfEngineError::PageOutOfBounds {
                page_index: page_index.zero_based(),
                page_count: self.info.page_count,
            })?;

        // `page.width()` and `page.height()` in PDFium already incorporate any page `/Rotate`,
        // so `intrinsic_rotation` is reported as `Rotation::Deg0` relative to `dimensions`.
        let dimensions = PageDimensions::new(page.width().value, page.height().value)
            .map_err(|e| PdfEngineError::InvalidPdfFormat(e.to_string()))?;

        Ok(PageGeometry {
            page_index,
            dimensions,
            intrinsic_rotation: Rotation::Deg0,
        })
    }

    fn outline(&self) -> Result<Vec<OutlineNode>, PdfEngineError> {
        let _guard = self
            .render_lock
            .lock()
            .map_err(|_| PdfEngineError::Internal("PDFium lock poisoned".to_owned()))?;
        let pdfium = self.bind()?;
        let pw = self.password_str();
        let doc = pdfium
            .load_pdf_from_byte_slice(&self.pdf_bytes, pw)
            .map_err(|e| map_pdfium_error(e, pw.is_some()))?;

        let mut visited = HashSet::new();
        let mut total_count = 0usize;
        Ok(collect_outline_level(
            doc.bookmarks().root(),
            0,
            &mut visited,
            &mut total_count,
        ))
    }

    fn extract_page_text(&self, page_index: PageIndex) -> Result<String, PdfEngineError> {
        let _guard = self
            .render_lock
            .lock()
            .map_err(|_| PdfEngineError::Internal("PDFium lock poisoned".to_owned()))?;
        let pdfium = self.bind()?;
        let pw = self.password_str();
        let doc = pdfium
            .load_pdf_from_byte_slice(&self.pdf_bytes, pw)
            .map_err(|e| map_pdfium_error(e, pw.is_some()))?;

        let idx_u16 = u16::try_from(page_index.zero_based()).map_err(|_| {
            PdfEngineError::PageOutOfBounds {
                page_index: page_index.zero_based(),
                page_count: self.info.page_count,
            }
        })?;
        let page = doc
            .pages()
            .get(idx_u16)
            .map_err(|_| PdfEngineError::PageOutOfBounds {
                page_index: page_index.zero_based(),
                page_count: self.info.page_count,
            })?;
        let text = page
            .text()
            .map_err(|e| PdfEngineError::Internal(format!("text extraction failed: {e}")))?;
        Ok(text.all())
    }

    fn search_text(
        &self,
        query: &str,
        case_sensitive: bool,
        max_hits: usize,
    ) -> Result<Vec<SearchHit>, PdfEngineError> {
        let trimmed = query.trim();
        if trimmed.is_empty() || max_hits == 0 {
            return Ok(Vec::new());
        }

        let _guard = self
            .render_lock
            .lock()
            .map_err(|_| PdfEngineError::Internal("PDFium lock poisoned".to_owned()))?;
        let pdfium = self.bind()?;
        let pw = self.password_str();
        let doc = pdfium
            .load_pdf_from_byte_slice(&self.pdf_bytes, pw)
            .map_err(|e| map_pdfium_error(e, pw.is_some()))?;

        let mut hits = Vec::new();
        for idx in 0..self.info.page_count {
            let remaining = max_hits.saturating_sub(hits.len());
            if remaining == 0 {
                break;
            }
            let Ok(idx_u16) = u16::try_from(idx) else {
                break;
            };
            let Ok(page) = doc.pages().get(idx_u16) else {
                continue;
            };
            let Ok(text_obj) = page.text() else {
                continue;
            };
            let page_text = text_obj.all();
            let page_idx = PageIndex::new(idx);
            let mut page_hits =
                search_page_text_hits(&page_text, page_idx, trimmed, case_sensitive, remaining);
            hits.append(&mut page_hits);
            if hits.len() >= max_hits {
                break;
            }
        }
        Ok(hits)
    }

    fn render_page(&self, request: &RenderPageRequest) -> Result<RenderedPage, PdfEngineError> {
        let _guard = self
            .render_lock
            .lock()
            .map_err(|_| PdfEngineError::Internal("PDFium lock poisoned".to_owned()))?;
        let pdfium = self.bind()?;
        let pw = self.password_str();
        let doc = pdfium
            .load_pdf_from_byte_slice(&self.pdf_bytes, pw)
            .map_err(|e| map_pdfium_error(e, pw.is_some()))?;

        let idx_u16 = u16::try_from(request.page_index.zero_based()).map_err(|_| {
            PdfEngineError::PageOutOfBounds {
                page_index: request.page_index.zero_based(),
                page_count: self.info.page_count,
            }
        })?;
        let page = doc
            .pages()
            .get(idx_u16)
            .map_err(|_| PdfEngineError::PageOutOfBounds {
                page_index: request.page_index.zero_based(),
                page_count: self.info.page_count,
            })?;

        let (width_px, height_px) = compute_pdfium_target_pixel_size(
            page.width().value,
            page.height().value,
            request.scale,
            request.rotation,
            request.max_pixel_dimension,
        )?;

        let pdfium_rotation = match request.rotation {
            Rotation::Deg0 => PdfPageRenderRotation::None,
            Rotation::Deg90 => PdfPageRenderRotation::Degrees90,
            Rotation::Deg180 => PdfPageRenderRotation::Degrees180,
            Rotation::Deg270 => PdfPageRenderRotation::Degrees270,
        };

        // `width_px` and `height_px` are already oriented for `request.rotation`, so pass
        // `do_rotate_constraints = false` to prevent PDFium from swapping width and height back!
        let config = PdfRenderConfig::new()
            .set_target_width(i32::try_from(width_px).unwrap_or(612))
            .set_target_height(i32::try_from(height_px).unwrap_or(792))
            .rotate(pdfium_rotation, false);

        let bitmap = page
            .render_with_config(&config)
            .map_err(|e| PdfEngineError::Internal(format!("PDFium page render failed: {e}")))?;

        let actual_w = u32::try_from(bitmap.width())
            .map_err(|_| PdfEngineError::Internal("negative PDFium bitmap width".to_owned()))?;
        let actual_h = u32::try_from(bitmap.height())
            .map_err(|_| PdfEngineError::Internal("negative PDFium bitmap height".to_owned()))?;

        let mut rgba = bitmap.as_rgba_bytes();
        apply_render_mode_rgba(&mut rgba, request.render_mode);
        let png_bytes = encode_rgba_to_png(actual_w, actual_h, &rgba)?;

        Ok(RenderedPage {
            page_index: request.page_index,
            width_px: actual_w,
            height_px: actual_h,
            png_bytes,
        })
    }
}

fn map_pdfium_error(err: PdfiumError, had_password: bool) -> PdfEngineError {
    let msg = err.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("password") {
        if had_password {
            PdfEngineError::IncorrectPassword
        } else {
            PdfEngineError::PasswordRequired
        }
    } else if lower.contains("format") || lower.contains("corrupt") || lower.contains("file") {
        PdfEngineError::InvalidPdfFormat(msg)
    } else {
        PdfEngineError::Internal(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdfium_rotation_geometry_never_double_swaps_and_formats_versions() {
        // Portrait 612 x 792 rotated 90 deg by user -> 792 x 612
        assert_eq!(
            compute_pdfium_target_pixel_size(612.0, 792.0, 1.0, Rotation::Deg90, 4096).unwrap(),
            (792, 612)
        );
        // Page with intrinsic /Rotate 90 already reports 792 x 612 from PDFium:
        // upright view (user Deg0) stays 792 x 612 (never double-swapped back to 612 x 792!),
        // and user Deg90 rotates it to 612 x 792!
        assert_eq!(
            compute_pdfium_target_pixel_size(792.0, 612.0, 1.0, Rotation::Deg0, 4096).unwrap(),
            (792, 612)
        );
        assert_eq!(
            compute_pdfium_target_pixel_size(792.0, 612.0, 1.0, Rotation::Deg90, 4096).unwrap(),
            (612, 792)
        );
        assert_eq!(
            compute_pdfium_target_pixel_size(612.0, 792.0, 1.0, Rotation::Deg270, 4096).unwrap(),
            (792, 612)
        );

        assert_eq!(
            format_pdfium_version(PdfDocumentVersion::Pdf1_7, b"%PDF-1.7\n"),
            "1.7"
        );
        assert_eq!(
            format_pdfium_version(PdfDocumentVersion::Pdf2_0, b"%PDF-2.0\n"),
            "2.0"
        );
        assert_eq!(
            format_pdfium_version(PdfDocumentVersion::Unset, b"%PDF-1.5\n"),
            "1.5"
        );
    }
}
