//! PDFium adapter implementing `pdf_engine::PdfEngine` and `pdf_engine::PdfDocument`.
//!
//! Attempts dynamic native library binding via `pdfium-render` and transparently falls back
//! to a pure-Rust PDF parser/renderer when `libpdfium` is not installed on the system.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::fs;
use std::path::{Path, PathBuf};

use pdf_engine::{OpenDocumentOptions, PdfDocument, PdfEngine, PdfEngineError, PdfEngineKind};

pub mod fallback_engine;
pub mod pdfium_dynamic;
pub mod png_encoder;

use fallback_engine::FallbackPdfDocument;
use pdfium_dynamic::{DynamicPdfiumDocument, try_bind_pdfium};

/// Adapter implementing `PdfEngine` using PDFium dynamic loading with a pure-Rust fallback.
#[derive(Debug, Clone, Default)]
pub struct PdfiumEngineAdapter {
    library_dir: Option<PathBuf>,
    allow_fallback: bool,
}

impl PdfiumEngineAdapter {
    /// Creates an adapter that probes for native PDFium and falls back to the pure-Rust engine
    /// if `libpdfium` is not present.
    #[must_use]
    pub const fn new_with_fallback(library_dir: Option<PathBuf>) -> Self {
        Self {
            library_dir,
            allow_fallback: true,
        }
    }

    /// Creates a strict adapter that requires the native PDFium library to be present.
    #[must_use]
    pub const fn new_strict(library_dir: Option<PathBuf>) -> Self {
        Self {
            library_dir,
            allow_fallback: false,
        }
    }

    fn has_native_pdfium(&self) -> bool {
        try_bind_pdfium(self.library_dir.as_deref()).is_some()
    }
}

impl PdfEngine for PdfiumEngineAdapter {
    fn kind(&self) -> PdfEngineKind {
        if self.has_native_pdfium() {
            PdfEngineKind::PdfiumDynamic
        } else {
            PdfEngineKind::PureRustFallback
        }
    }

    fn open_path(
        &self,
        path: &Path,
        options: &OpenDocumentOptions,
    ) -> Result<Box<dyn PdfDocument>, PdfEngineError> {
        let meta = fs::metadata(path).map_err(|_| {
            PdfEngineError::IoError("target PDF file does not exist or is unreadable".to_owned())
        })?;
        let max_size = options.effective_max_file_size();
        if meta.len() > max_size {
            return Err(PdfEngineError::FileTooLarge {
                size_bytes: meta.len(),
                max_bytes: max_size,
            });
        }
        let bytes = fs::read(path)
            .map_err(|_| PdfEngineError::IoError("failed to read PDF file bytes".to_owned()))?;
        self.open_bytes(&bytes, options)
    }

    fn open_bytes(
        &self,
        bytes: &[u8],
        options: &OpenDocumentOptions,
    ) -> Result<Box<dyn PdfDocument>, PdfEngineError> {
        if self.has_native_pdfium() {
            let doc =
                DynamicPdfiumDocument::open(bytes.to_vec(), options, self.library_dir.clone())?;
            return Ok(Box::new(doc));
        }

        if !self.allow_fallback {
            return Err(PdfEngineError::EngineUnavailable(
                "native PDFium library not found and fallback is disabled".to_owned(),
            ));
        }

        let fallback = FallbackPdfDocument::from_bytes(bytes, options)?;
        Ok(Box::new(fallback))
    }
}

/// Generates a minimal, structurally valid synthetic PDF byte buffer for testing and demos
/// without committing binary `.pdf` files to source control.
#[must_use]
pub fn build_synthetic_pdf_bytes(
    title: &str,
    page_texts: &[&str],
    user_password: Option<&str>,
) -> Vec<u8> {
    let page_count = page_texts.len().max(1);
    let mut out = String::from("%PDF-1.7\n");
    out.push_str(&format!(
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Title ({title}) /Author (Readora) >>\nendobj\n"
    ));
    out.push_str(&format!(
        "2 0 obj\n<< /Type /Pages /Count {page_count} /MediaBox [0 0 612 792] >>\nendobj\n"
    ));
    if let Some(pw) = user_password {
        out.push_str(&format!(
            "3 0 obj\n<< /Filter /Standard /Encrypt true /UserPassword ({pw}) >>\nendobj\n"
        ));
    }
    for (idx, text) in page_texts.iter().enumerate() {
        let obj_id = 10 + idx;
        out.push_str(&format!(
            "{obj_id} 0 obj\n<< /Type /Page /OutlineTitle (Section {}) >>\nstream\nBT ({text}) Tj ET\nendstream\nendobj\n",
            idx + 1
        ));
    }
    out.push_str("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use app_domain::{PageIndex, RenderMode, Rotation};
    use pdf_engine::RenderPageRequest;

    use super::*;

    #[test]
    fn adapter_opens_renders_and_searches_valid_pdf_bytes() {
        let adapter = PdfiumEngineAdapter::new_with_fallback(None);
        let bytes = build_synthetic_pdf_bytes(
            "Readora Specification",
            &[
                "Welcome to Readora Chapter One",
                "Hexagonal Architecture and Ports",
                "Memory Bounded LRU Render Cache",
            ],
            None,
        );

        let doc = adapter
            .open_bytes(&bytes, &OpenDocumentOptions::default())
            .unwrap();
        assert_eq!(doc.info().page_count, 3);
        assert_eq!(
            doc.info().metadata.title.as_deref(),
            Some("Readora Specification")
        );

        let geom = doc.page_geometry(PageIndex::FIRST).unwrap();
        assert_eq!(geom.dimensions.width_pt(), 612.0);
        assert_eq!(geom.dimensions.height_pt(), 792.0);

        let hits = doc.search_text("Hexagonal", false, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].page_index.zero_based(), 1);

        let rendered = doc
            .render_page(&RenderPageRequest {
                page_index: PageIndex::new(1),
                scale: 1.0,
                rotation: Rotation::Deg90,
                render_mode: RenderMode::DarkInversion,
                max_pixel_dimension: 4096,
            })
            .unwrap();
        assert_eq!((rendered.width_px, rendered.height_px), (792, 612));
        assert!(rendered.png_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn adapter_rejects_malformed_and_enforces_passwords() {
        let adapter = PdfiumEngineAdapter::new_with_fallback(None);

        assert!(matches!(
            adapter.open_bytes(b"not a pdf at all", &OpenDocumentOptions::default()),
            Err(PdfEngineError::InvalidPdfFormat(_))
        ));

        assert!(matches!(
            adapter.open_bytes(
                b"%PDF-1.7\ntruncated without eof",
                &OpenDocumentOptions::default()
            ),
            Err(PdfEngineError::InvalidPdfFormat(_))
        ));

        let encrypted =
            build_synthetic_pdf_bytes("Secret Doc", &["Confidential page"], Some("topsecret"));
        assert_eq!(
            adapter
                .open_bytes(&encrypted, &OpenDocumentOptions::default())
                .err(),
            Some(PdfEngineError::PasswordRequired)
        );

        assert_eq!(
            adapter
                .open_bytes(
                    &encrypted,
                    &OpenDocumentOptions {
                        password: Some("wrong-pass".to_owned()),
                        max_file_size_bytes: 0,
                    }
                )
                .err(),
            Some(PdfEngineError::IncorrectPassword)
        );

        let unlocked = adapter
            .open_bytes(
                &encrypted,
                &OpenDocumentOptions {
                    password: Some("topsecret".to_owned()),
                    max_file_size_bytes: 0,
                },
            )
            .unwrap();
        assert_eq!(unlocked.info().page_count, 1);
        assert!(unlocked.info().metadata.is_encrypted);
    }

    #[test]
    fn adapter_inspects_forms_and_signatures_explicitly() {
        use app_domain::{FormSupportStatus, SignaturePresenceStatus};

        let adapter = PdfiumEngineAdapter::new_with_fallback(None);
        let mut signed_acroform_pdf = String::from(
            "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R] >> /Title (Signed Form) >>\nendobj\n",
        );
        signed_acroform_pdf
            .push_str("2 0 obj\n<< /Type /Pages /Count 1 /MediaBox [0 0 612 792] >>\nendobj\n");
        signed_acroform_pdf
            .push_str("4 0 obj\n<< /FT /Tx /T (FullName) /V (Ada Lovelace) >>\nendobj\n");
        signed_acroform_pdf.push_str("5 0 obj\n<< /FT /Sig /Type /Sig >>\nendobj\n");
        signed_acroform_pdf.push_str(
            "10 0 obj\n<< /Type /Page >>\nstream\nBT (Form Page) Tj ET\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
        );

        let doc = adapter
            .open_bytes(
                signed_acroform_pdf.as_bytes(),
                &OpenDocumentOptions::default(),
            )
            .unwrap();
        assert_eq!(
            doc.info().metadata.form_support,
            FormSupportStatus::AcroFormReadOnly
        );
        assert_eq!(doc.info().metadata.form_field_count, 1);
        assert_eq!(
            doc.info().metadata.signature_status,
            SignaturePresenceStatus::SignaturePresentUnverified
        );
        assert!(
            doc.info()
                .metadata
                .signature_status_summary()
                .contains("cryptographic certificate trust not verified")
        );

        let xfa_pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /XFA (stream) >> >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
        let xfa_doc = adapter
            .open_bytes(xfa_pdf, &OpenDocumentOptions::default())
            .unwrap();
        assert_eq!(
            xfa_doc.info().metadata.form_support,
            FormSupportStatus::UnsupportedXfa
        );
    }
}
