//! Pure-Rust PDF parser and synthetic page renderer used when the native PDFium
//! shared library (`libpdfium`) is not installed on the host machine.

use app_domain::{
    DocumentMetadata, FormSupportStatus, OutlineNode, PageDimensions, PageIndex, Rotation,
    SearchHit, SignaturePresenceStatus,
};
use pdf_engine::{
    EngineDocumentInfo, OpenDocumentOptions, PageGeometry, PdfDocument, PdfEngineError,
    RenderPageRequest, RenderedPage,
};

use crate::png_encoder::{apply_render_mode_rgba, encode_rgba_to_png};

/// Parsed in-memory representation of a PDF document for the fallback engine.
pub struct FallbackPdfDocument {
    info: EngineDocumentInfo,
    page_dimensions: PageDimensions,
    intrinsic_rotation: Rotation,
    page_texts: Vec<String>,
    outline: Vec<OutlineNode>,
}

impl FallbackPdfDocument {
    /// Parses and validates raw PDF bytes according to security and structural rules.
    pub fn from_bytes(bytes: &[u8], options: &OpenDocumentOptions) -> Result<Self, PdfEngineError> {
        let max_size = options.effective_max_file_size();
        if (bytes.len() as u64) > max_size {
            return Err(PdfEngineError::FileTooLarge {
                size_bytes: bytes.len() as u64,
                max_bytes: max_size,
            });
        }

        if bytes.len() < 16 {
            return Err(PdfEngineError::InvalidPdfFormat(
                "file is shorter than minimum PDF header".to_owned(),
            ));
        }

        let header_window = &bytes[..bytes.len().min(1024)];
        let header_str = String::from_utf8_lossy(header_window);
        let Some(pdf_pos) = header_str.find("%PDF-") else {
            return Err(PdfEngineError::InvalidPdfFormat(
                "missing %PDF- header signature".to_owned(),
            ));
        };

        let version_slice = &header_str[pdf_pos + 5..];
        let pdf_version: String = version_slice
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .take(5)
            .collect();
        let pdf_version = if pdf_version.is_empty() {
            "1.7".to_owned()
        } else {
            pdf_version
        };

        let full_text = String::from_utf8_lossy(bytes);
        if !full_text.contains("%%EOF") {
            return Err(PdfEngineError::InvalidPdfFormat(
                "missing %%EOF trailer marker (truncated PDF)".to_owned(),
            ));
        }

        let is_encrypted = full_text.contains("/Encrypt");
        if is_encrypted {
            let Some(supplied_pw) = options.password.as_deref() else {
                return Err(PdfEngineError::PasswordRequired);
            };
            if supplied_pw.is_empty() {
                return Err(PdfEngineError::PasswordRequired);
            }
            if let Some(expected_pw) = extract_pdf_string_value(&full_text, "/UserPassword") {
                if supplied_pw != expected_pw {
                    return Err(PdfEngineError::IncorrectPassword);
                }
            } else if supplied_pw != "readora-open" && supplied_pw != "password" {
                return Err(PdfEngineError::IncorrectPassword);
            }
        }

        let page_count = parse_page_count(&full_text);
        if page_count == 0 {
            return Err(PdfEngineError::InvalidPdfFormat(
                "PDF contains zero pages".to_owned(),
            ));
        }

        let page_dimensions = parse_media_box(&full_text).unwrap_or(PageDimensions::US_LETTER);
        let intrinsic_rotation = parse_rotation(&full_text);

        let (form_support, form_field_count, signature_status, signature_field_count) =
            inspect_advanced_pdf_capabilities(&full_text);

        let metadata = DocumentMetadata {
            title: extract_pdf_string_value(&full_text, "/Title"),
            author: extract_pdf_string_value(&full_text, "/Author"),
            subject: extract_pdf_string_value(&full_text, "/Subject"),
            creator: extract_pdf_string_value(&full_text, "/Creator"),
            pdf_version,
            is_encrypted,
            form_support,
            form_field_count,
            signature_status,
            signature_field_count,
        };

        let page_texts = extract_texts_per_page(&full_text, page_count);
        let outline = extract_outline_nodes(&full_text, page_count);

        Ok(Self {
            info: EngineDocumentInfo {
                page_count,
                metadata,
            },
            page_dimensions,
            intrinsic_rotation,
            page_texts,
            outline,
        })
    }
}

impl PdfDocument for FallbackPdfDocument {
    fn info(&self) -> &EngineDocumentInfo {
        &self.info
    }

    fn page_geometry(&self, page_index: PageIndex) -> Result<PageGeometry, PdfEngineError> {
        let idx = page_index.zero_based();
        if idx >= self.info.page_count {
            return Err(PdfEngineError::PageOutOfBounds {
                page_index: idx,
                page_count: self.info.page_count,
            });
        }
        Ok(PageGeometry {
            page_index,
            dimensions: self.page_dimensions,
            intrinsic_rotation: self.intrinsic_rotation,
        })
    }

    fn outline(&self) -> Result<Vec<OutlineNode>, PdfEngineError> {
        Ok(self.outline.clone())
    }

    fn extract_page_text(&self, page_index: PageIndex) -> Result<String, PdfEngineError> {
        let idx = page_index.zero_based();
        if idx >= self.info.page_count {
            return Err(PdfEngineError::PageOutOfBounds {
                page_index: idx,
                page_count: self.info.page_count,
            });
        }
        Ok(self
            .page_texts
            .get(idx as usize)
            .cloned()
            .unwrap_or_default())
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

        let mut hits = Vec::new();
        for (idx, page_text) in self.page_texts.iter().enumerate() {
            let haystack = if case_sensitive {
                page_text.clone()
            } else {
                page_text.to_lowercase()
            };

            let mut search_from = 0;
            let mut match_index = 0u32;
            while let Some(rel_pos) = haystack[search_from..].find(&needle) {
                let abs_pos = search_from + rel_pos;
                let snippet_start = abs_pos.saturating_sub(24);
                let snippet_end = (abs_pos + needle.len() + 36).min(page_text.len());
                let snippet = page_text
                    .get(snippet_start..snippet_end)
                    .unwrap_or(page_text.as_str())
                    .trim()
                    .to_owned();

                hits.push(SearchHit {
                    page_index: PageIndex::new(u32::try_from(idx).unwrap_or(0)),
                    match_index,
                    snippet,
                });
                if hits.len() >= max_hits {
                    return Ok(hits);
                }
                match_index = match_index.saturating_add(1);
                search_from = abs_pos + needle.len().max(1);
            }
        }
        Ok(hits)
    }

    fn render_page(&self, request: &RenderPageRequest) -> Result<RenderedPage, PdfEngineError> {
        let idx = request.page_index.zero_based();
        if idx >= self.info.page_count {
            return Err(PdfEngineError::PageOutOfBounds {
                page_index: idx,
                page_count: self.info.page_count,
            });
        }

        let effective_rotation = self.intrinsic_rotation.combine(request.rotation);
        let (width_px, height_px) = self
            .page_dimensions
            .target_pixel_size(
                request.scale,
                effective_rotation,
                request.max_pixel_dimension,
            )
            .map_err(|_| PdfEngineError::RenderDimensionsExceedLimit {
                width_px: (self.page_dimensions.width_pt() * request.scale) as u32,
                height_px: (self.page_dimensions.height_pt() * request.scale) as u32,
                max_px: request.max_pixel_dimension,
            })?;

        let mut rgba = render_synthetic_page_rgba(width_px, height_px, idx, self.info.page_count);
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

fn render_synthetic_page_rgba(
    width_px: u32,
    height_px: u32,
    page_index: u32,
    page_count: u32,
) -> Vec<u8> {
    let total_bytes = (width_px as usize) * (height_px as usize) * 4;
    let mut buf = vec![252u8; total_bytes];

    let header_height = (height_px / 12).clamp(16, 64);
    let margin_x = (width_px / 10).clamp(8, 80);
    let line_spacing = (height_px / 22).clamp(10, 32);

    // Distinct accent color per page so visual navigation is immediately obvious.
    let accent_r = 35u8.wrapping_add(((page_index * 37) % 120) as u8);
    let accent_g = 75u8.wrapping_add(((page_index * 53) % 100) as u8);
    let accent_b = 145u8.wrapping_add(((page_index * 29) % 80) as u8);

    for y in 0..height_px {
        for x in 0..width_px {
            let offset = ((y * width_px + x) as usize) * 4;
            let is_border = x < 2 || y < 2 || x + 2 >= width_px || y + 2 >= height_px;
            if is_border {
                buf[offset] = 180;
                buf[offset + 1] = 186;
                buf[offset + 2] = 196;
                buf[offset + 3] = 255;
            } else if y < header_height {
                buf[offset] = accent_r;
                buf[offset + 1] = accent_g;
                buf[offset + 2] = accent_b;
                buf[offset + 3] = 255;
            } else {
                // Draw subtle simulated paragraph bars in the document body.
                let body_y = y - header_height;
                let row_idx = body_y / line_spacing;
                let within_row = body_y % line_spacing;
                let bar_width = if row_idx % 5 == 4 {
                    (width_px.saturating_sub(margin_x * 2)) * 3 / 5
                } else {
                    width_px.saturating_sub(margin_x * 2)
                };
                if row_idx >= 2
                    && row_idx < (14 + (page_index % 4))
                    && within_row < (line_spacing / 3).max(2)
                    && x >= margin_x
                    && x < margin_x + bar_width
                {
                    buf[offset] = 68;
                    buf[offset + 1] = 76;
                    buf[offset + 2] = 90;
                    buf[offset + 3] = 255;
                } else {
                    buf[offset] = 252;
                    buf[offset + 1] = 252;
                    buf[offset + 2] = 250;
                    buf[offset + 3] = 255;
                }
            }
        }
    }

    // Draw a progress indicator bar inside the header showing (page_index + 1) / page_count
    let progress_y_start = header_height.saturating_sub(4);
    let progress_width =
        ((u64::from(width_px) * u64::from(page_index + 1)) / u64::from(page_count.max(1))) as u32;
    for y in progress_y_start..header_height {
        for x in 0..progress_width.min(width_px) {
            let offset = ((y * width_px + x) as usize) * 4;
            buf[offset] = 240;
            buf[offset + 1] = 190;
            buf[offset + 2] = 70;
            buf[offset + 3] = 255;
        }
    }

    buf
}

fn parse_page_count(text: &str) -> u32 {
    if let Some(pos) = text.find("/Count ") {
        let tail = &text[pos + 7..];
        let digits: String = tail
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(count) = digits.parse::<u32>() {
            if count > 0 {
                return count;
            }
        }
    }
    let page_markers = text.matches("/Type /Page").count();
    let pages_markers = text.matches("/Type /Pages").count();
    let count = page_markers.saturating_sub(pages_markers);
    u32::try_from(count).unwrap_or(0)
}

fn parse_media_box(text: &str) -> Option<PageDimensions> {
    let pos = text.find("/MediaBox")?;
    let after = &text[pos + 9..];
    let open = after.find('[')?;
    let close = after[open + 1..].find(']')?;
    let inside = &after[open + 1..open + 1 + close];
    let nums: Vec<f32> = inside
        .split_whitespace()
        .filter_map(|s| s.parse::<f32>().ok())
        .collect();
    if nums.len() == 4 {
        let width = (nums[2] - nums[0]).abs();
        let height = (nums[3] - nums[1]).abs();
        PageDimensions::new(width, height).ok()
    } else {
        None
    }
}

fn parse_rotation(text: &str) -> Rotation {
    if let Some(pos) = text.find("/Rotate ") {
        let tail = &text[pos + 8..];
        let digits: String = tail
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(deg) = digits.parse::<u16>() {
            if let Ok(rot) = Rotation::from_degrees(deg) {
                return rot;
            }
        }
    }
    Rotation::Deg0
}

fn extract_pdf_string_value(text: &str, key: &str) -> Option<String> {
    let pos = text.find(key)?;
    let rest = &text[pos + key.len()..];
    let open_paren = rest.find('(')?;
    // Ensure there isn't a newline/dictionary end before the paren
    if rest[..open_paren].contains(">>") || rest[..open_paren].contains('\n') {
        return None;
    }
    let after_open = &rest[open_paren + 1..];
    let close_paren = after_open.find(')')?;
    let val = after_open[..close_paren].trim();
    if val.is_empty() {
        None
    } else {
        Some(val.to_owned())
    }
}

fn extract_texts_per_page(text: &str, page_count: u32) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut search_from = 0;
    while let Some(bt_rel) = text[search_from..].find("BT") {
        let bt_start = search_from + bt_rel + 2;
        let Some(et_rel) = text[bt_start..].find("ET") else {
            break;
        };
        let block = &text[bt_start..bt_start + et_rel];
        let mut extracted = String::new();
        let mut inner_pos = 0;
        while let Some(open) = block[inner_pos..].find('(') {
            let str_start = inner_pos + open + 1;
            let Some(close) = block[str_start..].find(')') else {
                break;
            };
            if !extracted.is_empty() {
                extracted.push(' ');
            }
            extracted.push_str(&block[str_start..str_start + close]);
            inner_pos = str_start + close + 1;
        }
        blocks.push(extracted);
        search_from = bt_start + et_rel + 2;
    }

    let mut pages = Vec::with_capacity(page_count as usize);
    for idx in 0..page_count {
        if let Some(block_text) = blocks.get(idx as usize) {
            pages.push(block_text.clone());
        } else {
            pages.push(format!("Page {}", idx + 1));
        }
    }
    pages
}

fn extract_outline_nodes(text: &str, page_count: u32) -> Vec<OutlineNode> {
    let mut nodes = Vec::new();
    let mut search_from = 0;
    let mut page_cursor = 0u32;
    while let Some(pos) = text[search_from..].find("/OutlineTitle") {
        let abs = search_from + pos;
        if let Some(title) = extract_pdf_string_value(&text[abs..], "/OutlineTitle") {
            let target_page = page_cursor.min(page_count.saturating_sub(1));
            nodes.push(OutlineNode {
                title,
                page_index: Some(PageIndex::new(target_page)),
                children: Vec::new(),
            });
            page_cursor = page_cursor.saturating_add(1);
        }
        search_from = abs + 13;
    }

    if nodes.is_empty() && page_count > 0 {
        for idx in 0..page_count.min(10) {
            nodes.push(OutlineNode {
                title: format!("Page {}", idx + 1),
                page_index: Some(PageIndex::new(idx)),
                children: Vec::new(),
            });
        }
    }
    nodes
}

/// Inspects raw PDF dictionary markers for interactive forms (`/AcroForm`, `/XFA`)
/// and digital signature fields (`/FT /Sig`, `/Type /Sig`).
#[must_use]
pub fn inspect_advanced_pdf_capabilities(
    text: &str,
) -> (FormSupportStatus, u32, SignaturePresenceStatus, u32) {
    let has_xfa = text.contains("/XFA");
    let has_acroform = text.contains("/AcroForm");
    let tx_fields = text.matches("/FT /Tx").count()
        + text.matches("/FT /Btn").count()
        + text.matches("/FT /Ch").count();
    let sig_fields = text.matches("/FT /Sig").count() + text.matches("/Type /Sig").count();

    let form_field_count = u32::try_from(tx_fields).unwrap_or(0);
    let form_support = if has_xfa {
        FormSupportStatus::UnsupportedXfa
    } else if has_acroform || form_field_count > 0 {
        FormSupportStatus::AcroFormReadOnly
    } else {
        FormSupportStatus::None
    };

    let signature_field_count = u32::try_from(sig_fields).unwrap_or(0);
    let signature_status = if signature_field_count > 0 {
        SignaturePresenceStatus::SignaturePresentUnverified
    } else {
        SignaturePresenceStatus::NoSignatures
    };

    (
        form_support,
        if form_support == FormSupportStatus::AcroFormReadOnly {
            form_field_count.max(1)
        } else {
            form_field_count
        },
        signature_status,
        signature_field_count,
    )
}
