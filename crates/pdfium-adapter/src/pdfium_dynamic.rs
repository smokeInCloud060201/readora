//! Dynamic PDFium library loader and `PdfDocument` wrapper using `pdfium-render`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use app_domain::{DocumentMetadata, OutlineNode, PageDimensions, PageIndex, Rotation, SearchHit};
use bytes::Bytes;
use pdf_engine::{
    EngineDocumentInfo, OpenDocumentOptions, PageGeometry, PdfDocument, PdfEngineError,
    RenderPageRequest, RenderedPage,
};
use pdfium_render::prelude::*;

use crate::fallback_engine::inspect_advanced_pdf_capabilities_bytes;
use crate::png_encoder::{apply_render_mode_rgba, encode_rgba_to_png};

fn try_bind_in_dir(dir: &Path) -> Option<Pdfium> {
    if !dir.exists() {
        return None;
    }
    let lib_path = if dir.is_dir() {
        Pdfium::pdfium_platform_library_name_at_path(dir)
    } else {
        dir.to_path_buf()
    };
    Pdfium::bind_to_library(&lib_path).ok().map(Pdfium::new)
}

/// Attempts to locate and bind to a native PDFium shared library across environment overrides,
/// application bundle resource directories, workspace assets, and system library paths.
#[must_use]
pub fn try_bind_pdfium(custom_dir: Option<&Path>) -> Option<Pdfium> {
    if let Ok(env_dir) = std::env::var("READORA_PDFIUM_PATH") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty()
            && let Some(bound) = try_bind_in_dir(Path::new(trimmed))
        {
            return Some(bound);
        }
    }

    if let Some(dir) = custom_dir
        && let Some(bound) = try_bind_in_dir(dir)
    {
        return Some(bound);
    }

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
            if let Some(bound) = try_bind_in_dir(&candidate) {
                return Some(bound);
            }
        }
    }

    if let Some(bound) = try_bind_in_dir(Path::new("assets/pdfium")) {
        return Some(bound);
    }

    Pdfium::bind_to_system_library().ok().map(Pdfium::new)
}

/// PDFium-backed document wrapper that serializes PDFium calls, stores shared `Bytes`,
/// and zeroizes any password buffer on drop.
pub struct DynamicPdfiumDocument {
    info: EngineDocumentInfo,
    pdf_bytes: Bytes,
    password_utf8: Vec<u8>,
    library_dir: Option<PathBuf>,
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

        let pdfium = try_bind_pdfium(library_dir.as_deref()).ok_or_else(|| {
            PdfEngineError::EngineUnavailable("native PDFium library not found".to_owned())
        })?;

        let (page_count, metadata) = {
            let doc = pdfium
                .load_pdf_from_byte_slice(&bytes, options.password.as_deref())
                .map_err(|err| map_pdfium_error(err, options.password.is_some()))?;

            let page_count = u32::from(doc.pages().len());
            if page_count == 0 {
                return Err(PdfEngineError::InvalidPdfFormat(
                    "PDF document contains 0 pages".to_owned(),
                ));
            }

            let (form_support, form_field_count, signature_status, signature_field_count) =
                inspect_advanced_pdf_capabilities_bytes(&bytes);

            let version_str = format!("{:?}", doc.version());
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
                is_encrypted: options.password.is_some(),
                form_support,
                form_field_count,
                signature_status,
                signature_field_count,
            };
            (page_count, metadata)
        };

        let password_utf8 = options
            .password
            .as_deref()
            .map_or_else(Vec::new, |pw| pw.as_bytes().to_vec());

        Ok(Self {
            info: EngineDocumentInfo {
                page_count,
                metadata,
            },
            pdf_bytes: bytes,
            password_utf8,
            library_dir,
            render_lock: Mutex::new(()),
        })
    }

    fn bind(&self) -> Result<Pdfium, PdfEngineError> {
        try_bind_pdfium(self.library_dir.as_deref()).ok_or_else(|| {
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

        let dimensions = PageDimensions::new(page.width().value, page.height().value)
            .map_err(|e| PdfEngineError::InvalidPdfFormat(e.to_string()))?;

        let intrinsic_rotation = match page.rotation() {
            Ok(PdfPageRenderRotation::Degrees90) => Rotation::Deg90,
            Ok(PdfPageRenderRotation::Degrees180) => Rotation::Deg180,
            Ok(PdfPageRenderRotation::Degrees270) => Rotation::Deg270,
            _ => Rotation::Deg0,
        };

        Ok(PageGeometry {
            page_index,
            dimensions,
            intrinsic_rotation,
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

        let mut nodes = Vec::new();
        for bookmark in doc.bookmarks().iter() {
            if let Some(title) = bookmark.title() {
                let page_index = bookmark
                    .destination()
                    .and_then(|d| d.page_index().ok())
                    .map(|idx| PageIndex::new(u32::from(idx)));
                nodes.push(OutlineNode {
                    title,
                    page_index,
                    children: Vec::new(),
                });
            }
        }
        Ok(nodes)
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
        let needle = if case_sensitive {
            trimmed.to_owned()
        } else {
            trimmed.to_lowercase()
        };

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
            let haystack = if case_sensitive {
                page_text.clone()
            } else {
                page_text.to_lowercase()
            };

            let mut search_from = 0;
            let mut match_index = 0u32;
            while let Some(rel) = haystack[search_from..].find(&needle) {
                let abs = search_from + rel;
                let start = clamp_floor_char_boundary(&page_text, abs.saturating_sub(24));
                let end = clamp_ceil_char_boundary(&page_text, abs + needle.len() + 36);
                let snippet = page_text
                    .get(start..end)
                    .unwrap_or(page_text.as_str())
                    .trim()
                    .to_owned();
                hits.push(SearchHit {
                    page_index: page_idx,
                    match_index,
                    snippet,
                });
                if hits.len() >= max_hits {
                    return Ok(hits);
                }
                match_index = match_index.saturating_add(1);
                search_from = abs + needle.len().max(1);
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

        let dimensions = PageDimensions::new(page.width().value, page.height().value)
            .map_err(|e| PdfEngineError::InvalidPdfFormat(e.to_string()))?;
        let intrinsic_rotation = match page.rotation() {
            Ok(PdfPageRenderRotation::Degrees90) => Rotation::Deg90,
            Ok(PdfPageRenderRotation::Degrees180) => Rotation::Deg180,
            Ok(PdfPageRenderRotation::Degrees270) => Rotation::Deg270,
            _ => Rotation::Deg0,
        };
        let effective_rotation = intrinsic_rotation.combine(request.rotation);
        let (width_px, height_px) = dimensions
            .target_pixel_size(
                request.scale,
                effective_rotation,
                request.max_pixel_dimension,
            )
            .map_err(|_| PdfEngineError::RenderDimensionsExceedLimit {
                width_px: (dimensions.width_pt() * request.scale) as u32,
                height_px: (dimensions.height_pt() * request.scale) as u32,
                max_px: request.max_pixel_dimension,
            })?;

        let pdfium_rotation = match request.rotation {
            Rotation::Deg0 => PdfPageRenderRotation::None,
            Rotation::Deg90 => PdfPageRenderRotation::Degrees90,
            Rotation::Deg180 => PdfPageRenderRotation::Degrees180,
            Rotation::Deg270 => PdfPageRenderRotation::Degrees270,
        };

        let config = PdfRenderConfig::new()
            .set_target_width(i32::try_from(width_px).unwrap_or(612))
            .set_target_height(i32::try_from(height_px).unwrap_or(792))
            .rotate(pdfium_rotation, true);

        let bitmap = page
            .render_with_config(&config)
            .map_err(|e| PdfEngineError::Internal(format!("PDFium page render failed: {e}")))?;

        let mut rgba = bitmap.as_rgba_bytes();
        apply_render_mode_rgba(&mut rgba, request.render_mode);
        let png_bytes = encode_rgba_to_png(width_px, height_px, &rgba)?;

        Ok(RenderedPage {
            page_index: request.page_index,
            width_px,
            height_px,
            png_bytes,
        })
    }
}

fn clamp_floor_char_boundary(s: &str, index: usize) -> usize {
    let mut i = index.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn clamp_ceil_char_boundary(s: &str, index: usize) -> usize {
    let mut i = index.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
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
