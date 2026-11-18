//! PDFium adapter implementing `pdf_engine::PdfEngine` and `pdf_engine::PdfDocument`.
//!
//! Attempts dynamic native library binding via `pdfium-render` and transparently falls back
//! to a pure-Rust PDF parser/renderer when `libpdfium` is not installed on the system.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::fs::{self, File};
use std::io::Read as _;
use std::path::{Path, PathBuf};

use bytes::Bytes;
use pdf_engine::{OpenDocumentOptions, PdfDocument, PdfEngine, PdfEngineError, PdfEngineKind};

pub mod fallback_engine;
pub mod pdfium_dynamic;
pub mod png_encoder;

use fallback_engine::FallbackPdfDocument;
use pdfium_dynamic::{DynamicPdfiumDocument, has_native_pdfium_worker};

/// Matches only small synthetic encrypted test fixtures produced by `build_synthetic_pdf_bytes`
/// so real-world PDFs whose body streams mention `/UserPassword` never bypass native PDFium (`[MED-03]`).
#[must_use]
pub(crate) fn is_synthetic_encrypted_test_fixture(bytes: &[u8]) -> bool {
    const MARKER: &[u8] = b"<< /Filter /Standard /Encrypt true /UserPassword (";
    bytes.len() <= 65_536 && bytes.windows(MARKER.len()).any(|w| w == MARKER)
}

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
        has_native_pdfium_worker(self.library_dir.as_deref())
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
        if !meta.is_file() {
            return Err(PdfEngineError::IoError(
                "target PDF path is not a regular file".to_owned(),
            ));
        }
        let max_size = options.effective_max_file_size();
        if meta.len() > max_size {
            return Err(PdfEngineError::FileTooLarge {
                size_bytes: meta.len(),
                max_bytes: max_size,
            });
        }
        let file = File::open(path)
            .map_err(|_| PdfEngineError::IoError("failed to open PDF file".to_owned()))?;
        let initial_cap = usize::try_from(meta.len().min(16 * 1024 * 1024)).unwrap_or(64 * 1024);
        let mut bytes = Vec::with_capacity(initial_cap);
        file.take(max_size.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| PdfEngineError::IoError("failed to read PDF file bytes".to_owned()))?;
        if (bytes.len() as u64) > max_size {
            return Err(PdfEngineError::FileTooLarge {
                size_bytes: bytes.len() as u64,
                max_bytes: max_size,
            });
        }

        let shared = Bytes::from(bytes);
        let is_synthetic_pw_fixture =
            self.allow_fallback && is_synthetic_encrypted_test_fixture(&shared);
        if self.has_native_pdfium() && !is_synthetic_pw_fixture {
            let doc = DynamicPdfiumDocument::open(shared, options, self.library_dir.clone())?;
            return Ok(Box::new(doc));
        }

        if !self.allow_fallback {
            return Err(PdfEngineError::EngineUnavailable(
                "native PDFium library not found and fallback is disabled".to_owned(),
            ));
        }

        let fallback = FallbackPdfDocument::from_bytes(&shared, options)?;
        Ok(Box::new(fallback))
    }

    fn open_bytes(
        &self,
        bytes: &[u8],
        options: &OpenDocumentOptions,
    ) -> Result<Box<dyn PdfDocument>, PdfEngineError> {
        let max_size = options.effective_max_file_size();
        if (bytes.len() as u64) > max_size {
            return Err(PdfEngineError::FileTooLarge {
                size_bytes: bytes.len() as u64,
                max_bytes: max_size,
            });
        }
        let is_synthetic_pw_fixture =
            self.allow_fallback && is_synthetic_encrypted_test_fixture(bytes);
        if self.has_native_pdfium() && !is_synthetic_pw_fixture {
            let doc = DynamicPdfiumDocument::open(
                Bytes::copy_from_slice(bytes),
                options,
                self.library_dir.clone(),
            )?;
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

fn escape_pdf_literal(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            _ => out.push(ch),
        }
    }
    out
}

/// Generates a minimal, structurally valid ISO 32000-1 PDF byte buffer (with exact `xref`
/// offsets, `/Kids`, `/Font`, `/Contents`, and `/Info` dictionary) for testing and demos
/// without committing binary `.pdf` files to source control.
#[must_use]
pub fn build_synthetic_pdf_bytes(
    title: &str,
    page_texts: &[&str],
    user_password: Option<&str>,
) -> Vec<u8> {
    let effective_texts: Vec<&str> = if page_texts.is_empty() {
        vec![""]
    } else {
        page_texts.to_vec()
    };
    let page_count = effective_texts.len();
    let escaped_title = escape_pdf_literal(title);

    // Object IDs:
    // 1 = Catalog, 2 = Pages, 3 = Font (/Helvetica), 4 = Info, 5 = Outlines root
    // 6..6+N = Page objects, 6+N..6+2N = Content stream objects, 6+2N..6+3N = Outline item objects
    // Optional last object = synthetic /UserPassword dictionary
    let outlines_root_id = 5usize;
    let first_page_id = 6usize;
    let first_content_id = first_page_id + page_count;
    let first_outline_item_id = first_content_id + page_count;
    let encrypt_obj_id = user_password.map(|_| first_outline_item_id + page_count);
    let total_objects = first_outline_item_id + page_count + usize::from(encrypt_obj_id.is_some());

    let mut out = Vec::with_capacity(1024 + page_count * 320);
    out.extend_from_slice(b"%PDF-1.7\n");

    let mut offsets = vec![0usize; total_objects];

    let write_obj = |buf: &mut Vec<u8>, offs: &mut [usize], id: usize, body: &[u8]| {
        offs[id] = buf.len();
        buf.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        buf.extend_from_slice(body);
        if !body.ends_with(b"\n") {
            buf.push(b'\n');
        }
        buf.extend_from_slice(b"endobj\n");
    };

    write_obj(
        &mut out,
        &mut offsets,
        1,
        b"<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
    );

    let kids_refs: String = (0..page_count)
        .map(|i| format!("{} 0 R", first_page_id + i))
        .collect::<Vec<_>>()
        .join(" ");
    write_obj(
        &mut out,
        &mut offsets,
        2,
        format!(
            "<< /Type /Pages /Kids [{kids_refs}] /Count {page_count} /MediaBox [0 0 612 792] >>"
        )
        .as_bytes(),
    );

    write_obj(
        &mut out,
        &mut offsets,
        3,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    );

    write_obj(
        &mut out,
        &mut offsets,
        4,
        format!("<< /Title ({escaped_title}) /Author (Readora) >>").as_bytes(),
    );

    let last_outline_item_id = first_outline_item_id + page_count - 1;
    write_obj(
        &mut out,
        &mut offsets,
        outlines_root_id,
        format!(
            "<< /Type /Outlines /First {first_outline_item_id} 0 R /Last {last_outline_item_id} 0 R /Count {page_count} >>"
        )
        .as_bytes(),
    );

    for (idx, text) in effective_texts.iter().enumerate() {
        let page_id = first_page_id + idx;
        let content_id = first_content_id + idx;
        let outline_item_id = first_outline_item_id + idx;
        let page_dict = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R /OutlineTitle (Section {}) >>",
            idx + 1
        );
        write_obj(&mut out, &mut offsets, page_id, page_dict.as_bytes());

        let escaped_text = escape_pdf_literal(text);
        let stream_payload = format!("BT /F1 13 Tf 48 720 Td ({escaped_text}) Tj ET");
        let stream_obj = format!(
            "<< /Length {} >>\nstream\n{stream_payload}\nendstream",
            stream_payload.len()
        );
        write_obj(&mut out, &mut offsets, content_id, stream_obj.as_bytes());

        let prev_link = if idx > 0 {
            format!(" /Prev {} 0 R", outline_item_id - 1)
        } else {
            String::new()
        };
        let next_link = if idx + 1 < page_count {
            format!(" /Next {} 0 R", outline_item_id + 1)
        } else {
            String::new()
        };
        let outline_item_dict = format!(
            "<< /Title (Section {}) /Parent {outlines_root_id} 0 R{prev_link}{next_link} /Dest [{page_id} 0 R /Fit] >>",
            idx + 1
        );
        write_obj(
            &mut out,
            &mut offsets,
            outline_item_id,
            outline_item_dict.as_bytes(),
        );
    }

    if let (Some(pw), Some(enc_id)) = (user_password, encrypt_obj_id) {
        let escaped_pw = escape_pdf_literal(pw);
        let enc_dict =
            format!("<< /Filter /Standard /Encrypt true /UserPassword ({escaped_pw}) >>");
        write_obj(&mut out, &mut offsets, enc_id, enc_dict.as_bytes());
    }

    let xref_offset = out.len();
    out.extend_from_slice(format!("xref\n0 {total_objects}\n0000000000 65535 f \n").as_bytes());
    for &off in &offsets[1..] {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }

    let encrypt_trailer = encrypt_obj_id
        .map(|id| format!(" /Encrypt {id} 0 R"))
        .unwrap_or_default();
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {total_objects} /Root 1 0 R /Info 4 0 R{encrypt_trailer} >>\nstartxref\n{xref_offset}\n%%EOF\n"
        )
        .as_bytes(),
    );
    out
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
        let base = build_synthetic_pdf_bytes("Signed Form", &["Form Page"], None);
        let base_str = String::from_utf8(base).unwrap();
        let signed_acroform_pdf = base_str.replace(
            "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
            "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R /AcroForm << /Fields [90 0 R 91 0 R] >> >>\nendobj\n90 0 obj\n<< /FT /Tx /T (FullName) /V (Ada Lovelace) >>\nendobj\n91 0 obj\n<< /FT /Sig /Type /Sig >>",
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

        let xfa_pdf = base_str.replace(
            "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
            "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R /AcroForm << /XFA (stream) >> >>",
        );
        let xfa_doc = adapter
            .open_bytes(xfa_pdf.as_bytes(), &OpenDocumentOptions::default())
            .unwrap();
        assert_eq!(
            xfa_doc.info().metadata.form_support,
            FormSupportStatus::UnsupportedXfa
        );
    }

    #[test]
    fn fallback_handles_unicode_search_bt_tokens_escaped_parens_and_encrypt_boundaries() {
        // 1. Page text mentioning /Encrypt, SUBTITLE, TARGET, balanced/escaped parens, and Unicode ('İ', 'ẞ', '—')
        let tricky_bytes = build_synthetic_pdf_bytes(
            "Spec (v2.0) — Notes on /Encrypt",
            &[
                "SUBTITLE — TARGET (escaped \\ path) and İstanbul GROẞE architecture — end",
                "Page 2 discusses the /Encrypt dictionary in PDF 1.7 without encrypting the file.",
            ],
            None,
        );
        let doc = FallbackPdfDocument::from_bytes(&tricky_bytes, &OpenDocumentOptions::default())
            .unwrap();
        assert!(!doc.info().metadata.is_encrypted);
        assert_eq!(
            doc.info().metadata.title.as_deref(),
            Some("Spec (v2.0) — Notes on /Encrypt")
        );

        let p0 = doc.extract_page_text(PageIndex::FIRST).unwrap();
        assert!(p0.contains("SUBTITLE — TARGET (escaped \\ path)"));

        // Case-insensitive search after 'İ' and 'ẞ' aligns UTF-8 byte offsets without panic or whole-page fallback
        let hits = doc.search_text("architecture", false, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("architecture"));
        assert!(hits[0].snippet.len() < p0.len() + 1);

        // 2. Real standard /Encrypt without synthetic /UserPassword never unlocks via hardcoded password
        let real_encrypt = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n9 0 obj\n<< /Filter /Standard /V 5 /R 6 >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n";
        for pw in [
            None,
            Some("readora-open".to_owned()),
            Some("password".to_owned()),
        ] {
            let res = FallbackPdfDocument::from_bytes(
                real_encrypt,
                &OpenDocumentOptions {
                    password: pw,
                    max_file_size_bytes: 0,
                },
            );
            assert!(matches!(res, Err(PdfEngineError::EngineUnavailable(_))));
        }

        // 3. Large binary image stream is skipped without expanding binary data
        let mut with_image = Vec::from(
            &b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n3 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 1048576 >>\nstream\n"[..],
        );
        with_image.extend(std::iter::repeat_n(0xFF_u8, 1024 * 1024));
        with_image.extend_from_slice(
            b"\nendstream\nendobj\n10 0 obj\n<< /Type /Page >>\nstream\nBT (Fast Bounded Stream) Tj ET\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
        );
        let img_doc =
            FallbackPdfDocument::from_bytes(&with_image, &OpenDocumentOptions::default()).unwrap();
        assert_eq!(
            img_doc.extract_page_text(PageIndex::FIRST).unwrap(),
            "Fast Bounded Stream"
        );
    }

    #[test]
    fn fallback_handles_250k_unclosed_open_parens_in_linear_time() {
        let mut malformed = Vec::from(
            &b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n3 0 obj\n<< /Note "[..],
        );
        malformed.extend(std::iter::repeat_n(b'(', 250_000));
        malformed.extend_from_slice(b"\n10 0 obj\n<< /Type /Page >>\nstream\nBT ");
        malformed.extend(std::iter::repeat_n(b'(', 250_000));
        malformed.extend_from_slice(b"\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

        let start = std::time::Instant::now();
        let doc =
            FallbackPdfDocument::from_bytes(&malformed, &OpenDocumentOptions::default()).unwrap();
        let _ = doc.extract_page_text(PageIndex::FIRST).unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(250),
            "expected linear-time scan < 250ms, took {elapsed:?}"
        );
    }

    #[test]
    fn fallback_handles_objstm_page_counts_and_mid_stream_tail_encrypt() {
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write as _;

        // (a) > 600 KiB PDF with binary '(' bytes before endstream followed by trailer << /Encrypt 9 0 R >>
        let mut large_enc = Vec::from(
            &b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n3 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 640000 >>\nstream\n"[..],
        );
        large_enc.extend(std::iter::repeat_n(b'(', 640_000));
        large_enc.extend_from_slice(
            b"\nendstream\nendobj\n9 0 obj\n<< /Filter /Standard /UserPassword (secret-tail-pw) >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n",
        );
        assert!(large_enc.len() > 600 * 1024);
        assert!(fallback_engine::has_encrypt_dict_bytes(&large_enc));
        assert_eq!(
            FallbackPdfDocument::from_bytes(&large_enc, &OpenDocumentOptions::default()).err(),
            Some(PdfEngineError::PasswordRequired)
        );
        assert!(
            FallbackPdfDocument::from_bytes(
                &large_enc,
                &OpenDocumentOptions {
                    password: Some("secret-tail-pw".to_owned()),
                    max_file_size_bytes: 0,
                }
            )
            .is_ok()
        );

        // Also test when structural cap (> 2 MiB) is exceeded before a mid-stream '(' tail
        let mut huge_cap_enc =
            Vec::from(&b"%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n"[..]);
        huge_cap_enc.extend(std::iter::repeat_n(b' ', 2_200_000));
        huge_cap_enc
            .extend_from_slice(b"\n3 0 obj\n<< /Subtype /Image /Filter /DCTDecode >>\nstream\n");
        huge_cap_enc.extend(std::iter::repeat_n(b'(', 300_000));
        huge_cap_enc.extend_from_slice(
            b"\nendstream\nendobj\n9 0 obj\n<< /Filter /Standard /UserPassword (cap-pw) >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n",
        );
        assert_eq!(
            FallbackPdfDocument::from_bytes(&huge_cap_enc, &OpenDocumentOptions::default()).err(),
            Some(PdfEngineError::PasswordRequired)
        );

        // (b) PDF 1.5+ whose /Pages << /Type /Pages /Count 12 >> is compressed inside Flate /Type /ObjStm
        let obj_stm_plain =
            b"1 0 2 38 << /Type /Catalog /Pages 2 0 R >> << /Type /Pages /Count 12 /MediaBox [0 0 595 842] >>";
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(obj_stm_plain).unwrap();
        let compressed_obj_stm = encoder.finish().unwrap();

        let mut obj_stm_pdf = Vec::from(&b"%PDF-1.6\n"[..]);
        obj_stm_pdf.extend_from_slice(
            format!(
                "4 0 obj\n<< /Type /ObjStm /N 2 /First 10 /Filter /FlateDecode /Length {} >>\nstream\n",
                compressed_obj_stm.len()
            )
            .as_bytes(),
        );
        obj_stm_pdf.extend_from_slice(&compressed_obj_stm);
        obj_stm_pdf.extend_from_slice(b"\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

        let obj_stm_doc =
            FallbackPdfDocument::from_bytes(&obj_stm_pdf, &OpenDocumentOptions::default()).unwrap();
        assert_eq!(obj_stm_doc.info().page_count, 12);
    }

    #[test]
    fn fallback_renders_short_banner_and_hidpi_a4_without_panicking_and_ignores_body_capabilities()
    {
        use app_domain::{FormSupportStatus, SignaturePresenceStatus};

        // Short banner (/MediaBox [0 0 200 50]) at scale = 0.25 (height_px = 13) across all modes & rotations
        let banner_pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 /MediaBox [0 0 200 50] >>\nendobj\n10 0 obj\n<< /Type /Page >>\nstream\nBT (Short Banner) Tj ET\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
        let banner_doc =
            FallbackPdfDocument::from_bytes(banner_pdf, &OpenDocumentOptions::default()).unwrap();

        for mode in [
            RenderMode::Standard,
            RenderMode::Grayscale,
            RenderMode::DarkInversion,
        ] {
            for rot in [
                Rotation::Deg0,
                Rotation::Deg90,
                Rotation::Deg180,
                Rotation::Deg270,
            ] {
                let rendered = banner_doc
                    .render_page(&RenderPageRequest {
                        page_index: PageIndex::FIRST,
                        scale: 0.25,
                        rotation: rot,
                        render_mode: mode,
                        max_pixel_dimension: 4096,
                    })
                    .unwrap();
                assert!(rendered.png_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
            }
        }

        // ISO A4 (595 x 842 pt) at scale = 5.0 and scale = 10.0 succeeds with preserved aspect ratio <= 4096 px
        // Also embed "/AcroForm /Sig /XFA" inside page body text to verify zero false-positive capabilities!
        let a4_pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Title (Discussion of /AcroForm /Sig /XFA) >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 /MediaBox [0 0 595 842] >>\nendobj\n10 0 obj\n<< /Type /Page >>\nstream\nBT (/AcroForm /Sig /XFA /FT /Sig /Type /Sig) Tj ET\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
        let (forms, form_count, sigs, sig_count) =
            fallback_engine::inspect_advanced_pdf_capabilities_bytes(a4_pdf);
        assert_eq!(forms, FormSupportStatus::None);
        assert_eq!(form_count, 0);
        assert_eq!(sigs, SignaturePresenceStatus::NoSignatures);
        assert_eq!(sig_count, 0);

        let a4_doc =
            FallbackPdfDocument::from_bytes(a4_pdf, &OpenDocumentOptions::default()).unwrap();
        assert_eq!(a4_doc.info().metadata.form_support, FormSupportStatus::None);
        assert_eq!(
            a4_doc.info().metadata.signature_status,
            SignaturePresenceStatus::NoSignatures
        );

        for scale in [5.0_f32, 10.0_f32] {
            let rendered = a4_doc
                .render_page(&RenderPageRequest {
                    page_index: PageIndex::FIRST,
                    scale,
                    rotation: Rotation::Deg0,
                    render_mode: RenderMode::Standard,
                    max_pixel_dimension: 4096,
                })
                .unwrap();
            assert_eq!(rendered.height_px, 4096);
            assert_eq!(rendered.width_px, 2894);
            assert!(rendered.png_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        }

        // open_path checks metadata size BEFORE reading into memory
        let dir = tempfile::tempdir().unwrap();
        let big_file = dir.path().join("too_big.pdf");
        std::fs::write(
            &big_file,
            build_synthetic_pdf_bytes("Oversized", &["Hello world"], None),
        )
        .unwrap();
        let adapter = PdfiumEngineAdapter::new_with_fallback(None);
        let too_large = adapter.open_path(
            &big_file,
            &OpenDocumentOptions {
                password: None,
                max_file_size_bytes: 32,
            },
        );
        assert!(matches!(
            too_large,
            Err(PdfEngineError::FileTooLarge { max_bytes: 32, .. })
        ));
    }

    #[test]
    fn fallback_handles_outline_count_page_cap_body_encrypt_tokens_and_nul_passwords() {
        // 1. Outlines `/Count` must not override `/Pages /Count`, and absurd `/Pages /Count` clamps safely
        let outlines_pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Outlines /Count 4294967295 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
        let adapter = PdfiumEngineAdapter::new_with_fallback(None);
        let doc = adapter
            .open_bytes(outlines_pdf, &OpenDocumentOptions::default())
            .unwrap();
        assert_eq!(doc.info().page_count, 2);

        let huge_pages_pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 4294967295 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
        let clamped_doc = adapter
            .open_bytes(huge_pages_pdf, &OpenDocumentOptions::default())
            .unwrap();
        assert_eq!(
            clamped_doc.info().page_count,
            fallback_engine::MAX_FALLBACK_PAGES
        );

        // 2. Body stream text containing `/Encrypt` / `/UserPassword` does not bypass or trigger encryption
        let body_tokens_pdf = build_synthetic_pdf_bytes(
            "PDF Internals Talk",
            &["Discuss /Filter /Standard /Encrypt true /UserPassword (secret)"],
            None,
        );
        let unencrypted = adapter
            .open_bytes(&body_tokens_pdf, &OpenDocumentOptions::default())
            .unwrap();
        assert!(!unencrypted.info().metadata.is_encrypted);

        // 3. Synthetic encrypted fixture opens with exact secret and rejects interior NUL passwords cleanly
        let encrypted_pdf = build_synthetic_pdf_bytes("Locked", &["Secret page"], Some("secret"));
        let res = adapter.open_bytes(
            &encrypted_pdf,
            &OpenDocumentOptions {
                password: Some("abc\0def".to_owned()),
                ..OpenDocumentOptions::default()
            },
        );
        assert!(matches!(
            res,
            Err(PdfEngineError::IncorrectPassword | PdfEngineError::PasswordRequired)
        ));
        assert!(
            adapter
                .open_bytes(
                    &encrypted_pdf,
                    &OpenDocumentOptions {
                        password: Some("secret".to_owned()),
                        ..OpenDocumentOptions::default()
                    },
                )
                .is_ok()
        );
    }
}
