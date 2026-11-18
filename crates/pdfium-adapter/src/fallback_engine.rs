//! Pure-Rust PDF parser and synthetic page renderer used when the native PDFium
//! shared library (`libpdfium`) is not installed on the host machine.

use std::io::Read as _;

use app_domain::{
    DocumentMetadata, FormSupportStatus, OutlineNode, PageDimensions, PageIndex, Rotation,
    SearchHit, SignaturePresenceStatus,
};
use flate2::read::ZlibDecoder;
use pdf_engine::{
    EngineDocumentInfo, OpenDocumentOptions, PageGeometry, PdfDocument, PdfEngineError,
    RenderPageRequest, RenderedPage,
};

use crate::png_encoder::{apply_render_mode_rgba, encode_rgba_to_png};

/// Maximum non-stream structural dictionary bytes buffered in fallback mode (2 MiB).
const MAX_STRUCTURAL_BYTES: usize = 2 * 1024 * 1024;
/// Maximum decompressed `/Type /ObjStm` structural bytes buffered/attempted in fallback mode (2 MiB).
const MAX_OBJSTM_STRUCTURAL_BYTES: usize = 2 * 1024 * 1024;
/// Maximum `/ObjStm` structural bytes buffered during native lightweight inspection (512 KiB).
const MAX_NATIVE_OBJSTM_STRUCTURAL_BYTES: usize = 512 * 1024;
/// Tail window preserved for trailer/xref inspection on huge files (256 KiB).
const MAX_TAIL_WINDOW_BYTES: usize = 256 * 1024;
/// Maximum total page content stream bytes buffered/decompressed in fallback mode (8 MiB).
const MAX_CONTENT_STREAM_BYTES: usize = 8 * 1024 * 1024;
/// Maximum number of PDF streams inspected or decompressed per document in fallback mode.
const MAX_STREAMS_INSPECTED: usize = 4_096;
/// Maximum decoded UTF-8 bytes accumulated for a single PDF `(...)` literal string (64 KiB).
const MAX_PDF_LITERAL_ACCUM_BYTES: usize = 64 * 1024;
/// Hard cap on synthetic/fallback page count parsed from untrusted `/Count` entries.
pub const MAX_FALLBACK_PAGES: u32 = 10_000;

/// Parsed in-memory representation of a PDF document for the fallback engine.
pub struct FallbackPdfDocument {
    info: EngineDocumentInfo,
    page_dimensions: PageDimensions,
    intrinsic_rotation: Rotation,
    extracted_blocks: Vec<String>,
    outline: Vec<OutlineNode>,
}

impl FallbackPdfDocument {
    /// Parses and validates raw PDF bytes according to security and structural rules
    /// without converting large binary stream buffers into UTF-8 strings.
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

        let Some(pdf_version) = extract_header_pdf_version(bytes) else {
            return Err(PdfEngineError::InvalidPdfFormat(
                "missing %PDF- header signature".to_owned(),
            ));
        };

        let tail_start = bytes.len().saturating_sub(MAX_TAIL_WINDOW_BYTES);
        if find_byte_subslice(&bytes[tail_start..], b"%%EOF").is_none() {
            return Err(PdfEngineError::InvalidPdfFormat(
                "missing %%EOF trailer marker (truncated PDF)".to_owned(),
            ));
        }

        let (structural_text, content_text) = extract_bounded_pdf_regions_inner(bytes, true);

        let is_encrypted =
            has_pdf_dict_key(&structural_text, "/Encrypt") || has_encrypt_dict_bytes(bytes);
        if is_encrypted {
            let supplied_pw = options.password.as_deref().filter(|pw| !pw.is_empty());
            let expected_pw = extract_pdf_string_value(&structural_text, "/UserPassword")
                .or_else(|| extract_tail_pdf_string_value(bytes, "/UserPassword"));
            if let Some(mut expected_pw) = expected_pw {
                let Some(pw) = supplied_pw else {
                    pdf_engine::zeroize_string(&mut expected_pw);
                    return Err(PdfEngineError::PasswordRequired);
                };
                let matches = constant_time_eq_bytes(pw.as_bytes(), expected_pw.as_bytes());
                pdf_engine::zeroize_string(&mut expected_pw);
                if !matches {
                    return Err(PdfEngineError::IncorrectPassword);
                }
            } else {
                return Err(PdfEngineError::EngineUnavailable(
                    "native PDFium library required to decrypt standard-encrypted PDF".to_owned(),
                ));
            }
        }

        let page_count = parse_page_count(&structural_text).min(MAX_FALLBACK_PAGES);
        if page_count == 0 {
            return Err(PdfEngineError::InvalidPdfFormat(
                "PDF contains zero pages".to_owned(),
            ));
        }

        let page_dimensions =
            parse_media_box(&structural_text).unwrap_or(PageDimensions::US_LETTER);
        let intrinsic_rotation = parse_rotation(&structural_text);

        let (form_support, form_field_count, signature_status, signature_field_count) =
            inspect_advanced_pdf_capabilities(&structural_text);

        let metadata = DocumentMetadata {
            title: extract_pdf_string_value(&structural_text, "/Title")
                .as_deref()
                .and_then(app_domain::sanitize_metadata_title),
            author: extract_pdf_string_value(&structural_text, "/Author"),
            subject: extract_pdf_string_value(&structural_text, "/Subject"),
            creator: extract_pdf_string_value(&structural_text, "/Creator"),
            pdf_version,
            is_encrypted,
            form_support,
            form_field_count,
            signature_status,
            signature_field_count,
        }
        .sanitized();

        let extracted_blocks = extract_texts_per_page(&content_text, page_count);
        let outline = extract_outline_nodes(&structural_text, page_count);

        Ok(Self {
            info: EngineDocumentInfo {
                page_count,
                metadata,
            },
            page_dimensions,
            intrinsic_rotation,
            extracted_blocks,
            outline,
        })
    }
}

fn constant_time_eq_bytes(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = u8::from(left.len() != right.len());
    for i in 0..max_len {
        let lb = left.get(i).copied().unwrap_or(0);
        let rb = right.get(i).copied().unwrap_or(0);
        diff |= lb ^ rb;
    }
    diff == 0
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
            .extracted_blocks
            .get(idx as usize)
            .cloned()
            .unwrap_or_else(|| format!("Page {}", idx + 1)))
    }

    fn search_text(
        &self,
        query: &str,
        case_sensitive: bool,
        max_hits: usize,
    ) -> Result<Vec<SearchHit>, PdfEngineError> {
        self.search_text_cancellable(query, case_sensitive, max_hits, &|| false)
    }

    fn search_text_cancellable(
        &self,
        query: &str,
        case_sensitive: bool,
        max_hits: usize,
        is_cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<Vec<SearchHit>, PdfEngineError> {
        let trimmed = query.trim();
        if trimmed.is_empty() || max_hits == 0 {
            return Ok(Vec::new());
        }

        let mut hits = Vec::new();
        for (idx, page_text) in self.extracted_blocks.iter().enumerate() {
            if is_cancelled() {
                return Err(PdfEngineError::Cancelled);
            }
            let remaining = max_hits.saturating_sub(hits.len());
            if remaining == 0 {
                break;
            }
            let page_idx = PageIndex::new(u32::try_from(idx).unwrap_or(0));
            let mut page_hits =
                search_page_text_hits(page_text, page_idx, trimmed, case_sensitive, remaining);
            hits.append(&mut page_hits);
            if hits.len() >= max_hits {
                break;
            }
        }

        if hits.len() < max_hits && (self.extracted_blocks.len() as u32) < self.info.page_count {
            let lower = trimmed.to_ascii_lowercase();
            let could_match_synthetic = if case_sensitive {
                "Page ".contains(trimmed)
                    || trimmed.starts_with("Page ")
                    || trimmed.bytes().all(|b| b.is_ascii_digit())
            } else {
                "page ".contains(&lower)
                    || lower.starts_with("page ")
                    || lower.bytes().all(|b| b.is_ascii_digit())
            };
            if could_match_synthetic {
                let start_idx = u32::try_from(self.extracted_blocks.len()).unwrap_or(u32::MAX);
                for idx in start_idx..self.info.page_count {
                    if is_cancelled() {
                        return Err(PdfEngineError::Cancelled);
                    }
                    let remaining = max_hits.saturating_sub(hits.len());
                    if remaining == 0 {
                        break;
                    }
                    let synthetic = format!("Page {}", idx + 1);
                    let mut page_hits = search_page_text_hits(
                        &synthetic,
                        PageIndex::new(idx),
                        trimmed,
                        case_sensitive,
                        remaining,
                    );
                    hits.append(&mut page_hits);
                    if hits.len() >= max_hits {
                        break;
                    }
                }
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
            .clamped_target_pixel_size(
                request.scale,
                effective_rotation,
                request.max_pixel_dimension,
            )
            .map_err(|err| PdfEngineError::Internal(err.to_string()))?;

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

/// Extracts the `%PDF-x.y` version string from the first 1024 bytes of a PDF buffer.
/// Returns `None` if `%PDF-` is absent.
#[must_use]
pub(crate) fn extract_header_pdf_version(bytes: &[u8]) -> Option<String> {
    let header_window = &bytes[..bytes.len().min(1024)];
    let pdf_pos = find_byte_subslice(header_window, b"%PDF-")?;
    let version_bytes = &header_window[pdf_pos + 5..];
    let version: String = version_bytes
        .iter()
        .copied()
        .take_while(|b| b.is_ascii_digit() || *b == b'.')
        .take(5)
        .map(char::from)
        .collect();
    if version.is_empty() {
        Some("1.7".to_owned())
    } else {
        Some(version)
    }
}

/// Inspects bounded header and trailer windows of `bytes` for a structural `/Encrypt` dictionary key,
/// trimming any leading mid-stream binary tail bytes before `endstream` so stray `'('` (`0x28`) bytes
/// inside compressed streams cannot swallow `trailer << /Encrypt ... >>`.
#[must_use]
pub(crate) fn has_encrypt_dict_bytes(bytes: &[u8]) -> bool {
    let head_end = bytes.len().min(MAX_TAIL_WINDOW_BYTES);
    let head_str = extract_non_stream_text(&bytes[..head_end]);
    if has_pdf_dict_key(&head_str, "/Encrypt") {
        return true;
    }
    if bytes.len() > head_end {
        let tail_start = bytes
            .len()
            .saturating_sub(MAX_TAIL_WINDOW_BYTES)
            .max(head_end);
        let tail_slice = trim_leading_partial_stream(&bytes[tail_start..]);
        let tail_str = extract_non_stream_text(tail_slice);
        if has_pdf_dict_key(&tail_str, "/Encrypt") {
            return true;
        }
    }
    false
}

fn extract_tail_pdf_string_value(bytes: &[u8], key: &str) -> Option<String> {
    let tail_start = bytes.len().saturating_sub(MAX_TAIL_WINDOW_BYTES);
    let tail_slice = if tail_start > 0 {
        trim_leading_partial_stream(&bytes[tail_start..])
    } else {
        bytes
    };
    let tail_str = extract_non_stream_text(tail_slice);
    extract_pdf_string_value(&tail_str, key)
}

/// When slicing into the tail of a large PDF (`tail_start > 0`), the slice often begins inside
/// a binary stream whose opening `stream` keyword preceded `tail_start`. If an `endstream`
/// keyword appears before the first `stream` keyword in `slice`, advance past that `endstream`
/// so binary stream bytes (`0x28` `'('`) are never misinterpreted as structural PDF syntax.
fn trim_leading_partial_stream(slice: &[u8]) -> &[u8] {
    if let Some(end_pos) = find_endstream_keyword(slice)
        && find_stream_keyword(slice).is_none_or(|st_pos| end_pos < st_pos)
    {
        return &slice[end_pos + 9..];
    }
    slice
}

fn find_endstream_keyword(haystack: &[u8]) -> Option<usize> {
    let mut offset = 0usize;
    while offset + 9 <= haystack.len() {
        let rel = find_byte_subslice(&haystack[offset..], b"endstream")?;
        let pos = offset + rel;
        let next_ok = haystack
            .get(pos + 9)
            .is_none_or(|&b| is_pdf_token_delim_or_ws(b));
        if next_ok {
            return Some(pos);
        }
        offset = pos + 9;
    }
    None
}

fn contains_pdf_name(haystack: &[u8], name: &[u8]) -> bool {
    if name.is_empty() || haystack.len() < name.len() {
        return false;
    }
    let mut offset = 0usize;
    while offset + name.len() <= haystack.len() {
        let Some(rel) = find_byte_subslice(&haystack[offset..], name) else {
            return false;
        };
        let pos = offset + rel;
        let boundary_ok = haystack
            .get(pos + name.len())
            .is_none_or(|&b| is_pdf_token_delim_or_ws(b));
        if boundary_ok {
            return true;
        }
        offset = pos + name.len();
    }
    false
}

fn extract_non_stream_text(slice: &[u8]) -> String {
    let mut buf = Vec::with_capacity(slice.len().min(16 * 1024));
    let mut cursor = 0usize;
    while cursor < slice.len() {
        let Some(stream_rel) = find_stream_keyword(&slice[cursor..]) else {
            buf.extend_from_slice(&slice[cursor..]);
            break;
        };
        let stream_pos = cursor + stream_rel;
        buf.extend_from_slice(&slice[cursor..stream_pos]);
        let Some(mut data_start) = advance_past_stream_eol(slice, stream_pos) else {
            cursor = stream_pos + 6;
            continue;
        };
        if data_start > slice.len() {
            data_start = slice.len();
        }
        if let Some(end_rel) = find_endstream_keyword(&slice[data_start..]) {
            cursor = data_start + end_rel + 9;
            buf.push(b'\n');
        } else {
            break;
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn advance_past_stream_eol(bytes: &[u8], stream_pos: usize) -> Option<usize> {
    let mut idx = stream_pos.checked_add(6)?;
    while matches!(bytes.get(idx), Some(b' ' | b'\t')) {
        idx += 1;
    }
    if bytes.get(idx) == Some(&b'\r') {
        idx += 1;
        if bytes.get(idx) == Some(&b'\n') {
            idx += 1;
        }
        Some(idx)
    } else if bytes.get(idx) == Some(&b'\n') {
        Some(idx + 1)
    } else {
        None
    }
}

fn bounded_zlib_decompress(raw_stream: &[u8], max_bytes: usize) -> (Vec<u8>, usize) {
    if max_bytes == 0 || raw_stream.is_empty() {
        return (Vec::new(), 0);
    }
    let decoder = ZlibDecoder::new(raw_stream);
    let mut chunk = Vec::new();
    let res = decoder.take(max_bytes as u64).read_to_end(&mut chunk);
    let attempted = chunk.len();
    if res.is_ok() && !chunk.is_empty() {
        (chunk, attempted)
    } else {
        // Deduct attempted decompressed bytes even if the trailer/checksum was invalid so
        // repeated malformed flate streams cannot bypass the decompression budget (`[MED-04]`).
        (Vec::new(), attempted)
    }
}

fn extract_bounded_pdf_regions_inner(
    bytes: &[u8],
    include_content_streams: bool,
) -> (String, String) {
    let mut structural = Vec::with_capacity(bytes.len().min(64 * 1024));
    let mut content = Vec::new();
    let mut cursor = 0usize;
    let mut non_stream_structural_bytes = 0usize;
    let mut objstm_decode_attempts_bytes = 0usize;
    let mut content_decode_attempts_bytes = 0usize;
    let mut hit_structural_cap = false;
    let mut streams_seen = 0usize;
    let max_objstm_bytes = if include_content_streams {
        MAX_OBJSTM_STRUCTURAL_BYTES
    } else {
        MAX_NATIVE_OBJSTM_STRUCTURAL_BYTES
    };

    while cursor < bytes.len() {
        let Some(stream_rel) = find_stream_keyword(&bytes[cursor..]) else {
            let rem = &bytes[cursor..];
            let room = MAX_STRUCTURAL_BYTES.saturating_sub(non_stream_structural_bytes);
            if room > 0 {
                let take_n = rem.len().min(room);
                structural.extend_from_slice(&rem[..take_n]);
                if take_n < rem.len() {
                    hit_structural_cap = true;
                }
            } else {
                hit_structural_cap = true;
            }
            break;
        };

        let stream_pos = cursor + stream_rel;
        let non_stream = &bytes[cursor..stream_pos];
        let room = MAX_STRUCTURAL_BYTES.saturating_sub(non_stream_structural_bytes);
        if room > 0 {
            let take_n = non_stream.len().min(room);
            structural.extend_from_slice(&non_stream[..take_n]);
            structural.push(b'\n');
            non_stream_structural_bytes += take_n;
            if take_n < non_stream.len() {
                hit_structural_cap = true;
            }
        } else {
            hit_structural_cap = true;
        }

        let Some(data_start) = advance_past_stream_eol(bytes, stream_pos) else {
            cursor = stream_pos + 6;
            continue;
        };

        let dict_window_start = stream_pos.saturating_sub(512);
        let dict_header = &bytes[dict_window_start..stream_pos];

        let Some(end_rel) = find_endstream_keyword(&bytes[data_start..]) else {
            break;
        };
        let mut data_end = data_start + end_rel;
        while data_end > data_start && matches!(bytes[data_end - 1], b'\r' | b'\n') {
            data_end -= 1;
        }

        let raw_stream = &bytes[data_start..data_end];
        let is_flate = contains_pdf_name(dict_header, b"/FlateDecode");
        let is_obj_stm = contains_pdf_name(dict_header, b"/ObjStm");

        streams_seen += 1;
        if streams_seen <= MAX_STREAMS_INSPECTED {
            if is_obj_stm {
                let rem_objstm = max_objstm_bytes.saturating_sub(objstm_decode_attempts_bytes);
                if rem_objstm > 0 && !raw_stream.is_empty() && raw_stream.len() <= 16 * 1024 * 1024
                {
                    if is_flate {
                        let (chunk, attempted) = bounded_zlib_decompress(raw_stream, rem_objstm);
                        objstm_decode_attempts_bytes =
                            objstm_decode_attempts_bytes.saturating_add(attempted.max(1));
                        if !chunk.is_empty() {
                            structural.push(b'\n');
                            structural.extend_from_slice(&chunk);
                            structural.push(b'\n');
                        }
                    } else {
                        let take_n = raw_stream.len().min(rem_objstm);
                        structural.push(b'\n');
                        structural.extend_from_slice(&raw_stream[..take_n]);
                        structural.push(b'\n');
                        objstm_decode_attempts_bytes =
                            objstm_decode_attempts_bytes.saturating_add(take_n);
                    }
                }
            } else if include_content_streams {
                let remaining_content =
                    MAX_CONTENT_STREAM_BYTES.saturating_sub(content_decode_attempts_bytes);
                if remaining_content > 0
                    && !is_binary_non_text_stream_dict(dict_header)
                    && !raw_stream.is_empty()
                    && raw_stream.len() <= 16 * 1024 * 1024
                {
                    let mut appended = false;
                    if is_flate || find_byte_subslice(raw_stream, b"BT").is_none() {
                        let (chunk, attempted) =
                            bounded_zlib_decompress(raw_stream, remaining_content);
                        content_decode_attempts_bytes =
                            content_decode_attempts_bytes.saturating_add(attempted);
                        if !chunk.is_empty() {
                            content.push(b'\n');
                            content.extend_from_slice(&chunk);
                            appended = true;
                        }
                    }
                    if !appended && !is_flate {
                        let room =
                            MAX_CONTENT_STREAM_BYTES.saturating_sub(content_decode_attempts_bytes);
                        let take_n = raw_stream.len().min(room);
                        if take_n > 0 {
                            content.push(b'\n');
                            content.extend_from_slice(&raw_stream[..take_n]);
                            content_decode_attempts_bytes =
                                content_decode_attempts_bytes.saturating_add(take_n);
                        }
                    }
                }
            }
        }

        cursor = data_start + end_rel + 9;
    }

    let head_end = MAX_TAIL_WINDOW_BYTES;
    let tail_start = bytes.len().saturating_sub(MAX_TAIL_WINDOW_BYTES);
    if (hit_structural_cap && bytes.len() > MAX_TAIL_WINDOW_BYTES) || tail_start > head_end {
        let raw_tail = &bytes[tail_start..];
        let trimmed_tail = trim_leading_partial_stream(raw_tail);
        if hit_structural_cap {
            let tail_non_stream = extract_non_stream_text(trimmed_tail);
            structural.push(b'\n');
            structural.extend_from_slice(tail_non_stream.as_bytes());
        }
    }

    (
        String::from_utf8_lossy(&structural).into_owned(),
        String::from_utf8_lossy(&content).into_owned(),
    )
}

fn find_stream_keyword(haystack: &[u8]) -> Option<usize> {
    let mut offset = 0usize;
    while offset + 7 <= haystack.len() {
        let rel = find_byte_subslice(&haystack[offset..], b"stream")?;
        let pos = offset + rel;
        let prev_ok = pos == 0
            || matches!(
                haystack[pos - 1],
                b'\r' | b'\n' | b' ' | b'\t' | b'>' | 0x0C
            );
        if prev_ok && advance_past_stream_eol(haystack, pos).is_some() {
            return Some(pos);
        }
        offset = pos + 6;
    }
    None
}

fn is_binary_non_text_stream_dict(dict_bytes: &[u8]) -> bool {
    const BINARY_MARKERS: &[&[u8]] = &[
        b"/Subtype /Image",
        b"/Subtype/Image",
        b"/DCTDecode",
        b"/JPXDecode",
        b"/JBIG2Decode",
        b"/CCITTFaxDecode",
        b"/FontFile",
        b"/Subtype /XML",
        b"/Subtype/XML",
        b"/Type /XRef",
        b"/Type/XRef",
        b"/Type /Metadata",
        b"/Type/Metadata",
    ];
    BINARY_MARKERS
        .iter()
        .any(|marker| find_byte_subslice(dict_bytes, marker).is_some())
}

fn find_byte_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    let first = *needle.first()?;
    if haystack.len() < needle.len() {
        return None;
    }
    let max_start = haystack.len() - needle.len();
    let mut i = 0usize;
    while i <= max_start {
        let rel = haystack[i..=max_start].iter().position(|&b| b == first)?;
        let pos = i + rel;
        if &haystack[pos..pos + needle.len()] == needle {
            return Some(pos);
        }
        i = pos + 1;
    }
    None
}

#[inline]
const fn is_pdf_token_delim_or_ws(b: u8) -> bool {
    matches!(
        b,
        0x00 | 0x09
            | 0x0A
            | 0x0C
            | 0x0D
            | 0x20
            | b'('
            | b')'
            | b'<'
            | b'>'
            | b'['
            | b']'
            | b'{'
            | b'}'
            | b'/'
            | b'%'
    )
}

enum LiteralParseOutcome {
    Parsed { text: String, next_index: usize },
    UnclosedAtEof,
}

#[inline]
fn push_bounded_char(out: &mut String, ch: char) {
    if out.len() + ch.len_utf8() <= MAX_PDF_LITERAL_ACCUM_BYTES {
        out.push(ch);
    }
}

/// Checks whether `key` (e.g. `"/Encrypt"`) appears as an actual PDF dictionary key in
/// `structural_text`, skipping `%` comments and balanced `(...)` literal strings in `O(N)` time.
fn has_pdf_dict_key(structural_text: &str, key: &str) -> bool {
    let bytes = structural_text.as_bytes();
    let key_bytes = key.as_bytes();
    if key_bytes.is_empty() || bytes.len() < key_bytes.len() {
        return false;
    }
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                while i < bytes.len() && !matches!(bytes[i], b'\r' | b'\n') {
                    i += 1;
                }
            }
            b'(' => match parse_pdf_literal_after_open(&structural_text[i + 1..]) {
                LiteralParseOutcome::Parsed { next_index, .. } => {
                    i += 1 + next_index;
                }
                LiteralParseOutcome::UnclosedAtEof => break,
            },
            b'/' if i + key_bytes.len() <= bytes.len()
                && &bytes[i..i + key_bytes.len()] == key_bytes =>
            {
                let boundary_ok = bytes
                    .get(i + key_bytes.len())
                    .is_none_or(|&next_b| is_pdf_token_delim_or_ws(next_b));
                if boundary_ok {
                    return true;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    false
}

/// Parses a PDF literal string starting immediately after the opening `'('`, handling
/// `\(`, `\)`, `\\`, `\n`, `\r`, `\t`, octal escapes, and balanced nested parentheses.
/// Caps `out` accumulation at `MAX_PDF_LITERAL_ACCUM_BYTES` (`64 KiB`) while continuing to scan
/// for the matching closing `')'` or EOF so malformed inputs never cause `O(N^2)` rescanning
/// or transient memory spikes.
fn parse_pdf_literal_after_open(after_open: &str) -> LiteralParseOutcome {
    let mut out = String::new();
    let mut depth = 1usize;
    let mut chars = after_open.char_indices();
    while let Some((idx, ch)) = chars.next() {
        match ch {
            '\\' => {
                if let Some((esc_idx, esc)) = chars.next() {
                    match esc {
                        'n' => push_bounded_char(&mut out, '\n'),
                        'r' => push_bounded_char(&mut out, '\r'),
                        't' => push_bounded_char(&mut out, '\t'),
                        'b' => push_bounded_char(&mut out, '\u{0008}'),
                        'f' => push_bounded_char(&mut out, '\u{000C}'),
                        '(' => push_bounded_char(&mut out, '('),
                        ')' => push_bounded_char(&mut out, ')'),
                        '\\' => push_bounded_char(&mut out, '\\'),
                        '\r' => {
                            if after_open[esc_idx + 1..].starts_with('\n') {
                                let _ = chars.next();
                            }
                        }
                        '\n' => {}
                        d if ('0'..='7').contains(&d) => {
                            let mut oct = u32::from(d as u8 - b'0');
                            let rest = &after_open[esc_idx + d.len_utf8()..];
                            let mut extra = 0usize;
                            for next_c in rest.chars().take(2) {
                                if ('0'..='7').contains(&next_c) {
                                    oct = (oct * 8) + u32::from(next_c as u8 - b'0');
                                    extra += 1;
                                } else {
                                    break;
                                }
                            }
                            for _ in 0..extra {
                                let _ = chars.next();
                            }
                            push_bounded_char(
                                &mut out,
                                char::from_u32(oct & 0xFF).unwrap_or('\u{FFFD}'),
                            );
                        }
                        other => push_bounded_char(&mut out, other),
                    }
                }
            }
            '(' => {
                depth += 1;
                push_bounded_char(&mut out, '(');
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return LiteralParseOutcome::Parsed {
                        text: out,
                        next_index: idx + 1,
                    };
                }
                push_bounded_char(&mut out, ')');
            }
            other => push_bounded_char(&mut out, other),
        }
    }
    LiteralParseOutcome::UnclosedAtEof
}

fn render_synthetic_page_rgba(
    width_px: u32,
    height_px: u32,
    page_index: u32,
    page_count: u32,
) -> Vec<u8> {
    if width_px == 0 || height_px == 0 {
        return Vec::new();
    }
    let total_bytes = (width_px as usize)
        .saturating_mul(height_px as usize)
        .saturating_mul(4);
    let mut buf = vec![252u8; total_bytes];

    let header_height = (height_px / 12).clamp(16, 64).min(height_px);
    let margin_x = (width_px / 10).clamp(8, 80).min(width_px / 2);
    let line_spacing = (height_px / 22).clamp(10, 32).max(1);

    // Distinct accent color per page so visual navigation is immediately obvious.
    let accent_r = 35u8.wrapping_add(((page_index * 37) % 120) as u8);
    let accent_g = 75u8.wrapping_add(((page_index * 53) % 100) as u8);
    let accent_b = 145u8.wrapping_add(((page_index * 29) % 80) as u8);

    for y in 0..height_px {
        for x in 0..width_px {
            let offset =
                (((y as usize) * (width_px as usize) + (x as usize)) * 4).min(total_bytes - 4);
            let is_border = x < 2
                || y < 2
                || x.saturating_add(2) >= width_px
                || y.saturating_add(2) >= height_px;
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
                let usable_w = width_px.saturating_sub(margin_x.saturating_mul(2));
                let bar_width = if row_idx % 5 == 4 {
                    usable_w * 3 / 5
                } else {
                    usable_w
                };
                if row_idx >= 2
                    && row_idx < (14 + (page_index % 4))
                    && within_row < (line_spacing / 3).max(2)
                    && x >= margin_x
                    && x < margin_x.saturating_add(bar_width)
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
    let progress_y_end = header_height.min(height_px);
    let progress_y_start = progress_y_end.saturating_sub(4);
    let progress_width = ((u64::from(width_px) * u64::from(page_index.saturating_add(1)))
        / u64::from(page_count.max(1)))
    .min(u64::from(width_px)) as u32;
    for y in progress_y_start..progress_y_end {
        for x in 0..progress_width.min(width_px) {
            let offset = ((y as usize) * (width_px as usize) + (x as usize)) * 4;
            buf[offset] = 240;
            buf[offset + 1] = 190;
            buf[offset + 2] = 70;
            buf[offset + 3] = 255;
        }
    }

    buf
}

#[derive(Default)]
struct PdfDictFrame {
    has_type_pages: bool,
    has_type_other: bool,
    count: Option<u32>,
    saw_zero_count: bool,
}

fn parse_page_count(text: &str) -> u32 {
    let bytes = text.as_bytes();
    let mut stack: Vec<PdfDictFrame> = Vec::new();
    let mut max_pages_count = 0u32;
    let mut saw_zero_pages_count = false;
    let mut page_leaf_count = 0u32;
    let mut saw_linearized = false;
    let mut linearized_n: Option<u32> = None;
    let mut saw_startxref = false;
    let mut i = 0usize;

    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                while i < bytes.len() && !matches!(bytes[i], b'\r' | b'\n') {
                    i += 1;
                }
            }
            b'(' => match parse_pdf_literal_after_open(&text[i + 1..]) {
                LiteralParseOutcome::Parsed { next_index, .. } => {
                    i += 1 + next_index;
                }
                LiteralParseOutcome::UnclosedAtEof => break,
            },
            b'<' if bytes.get(i + 1) == Some(&b'<') => {
                if stack.len() < 64 {
                    stack.push(PdfDictFrame::default());
                }
                i += 2;
            }
            b'<' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'>' {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1;
                }
            }
            b'>' if bytes.get(i + 1) == Some(&b'>') => {
                if let Some(frame) = stack.pop()
                    && frame.has_type_pages
                    && !frame.has_type_other
                {
                    if let Some(count) = frame.count {
                        max_pages_count = max_pages_count.max(count.min(MAX_FALLBACK_PAGES));
                    }
                    if frame.saw_zero_count {
                        saw_zero_pages_count = true;
                    }
                }
                i += 2;
            }
            b'/' => {
                let mut end = i + 1;
                while end < bytes.len() && !is_pdf_token_delim_or_ws(bytes[end]) {
                    end += 1;
                }
                let name = &bytes[i..end];
                i = end;

                if name == b"/Linearized" {
                    saw_linearized = true;
                } else if name == b"/Type" {
                    let after_ws = skip_pdf_ascii_ws(&bytes[i..]);
                    let consumed_ws = bytes[i..].len() - after_ws.len();
                    if after_ws.starts_with(b"/") {
                        let mut vend = 1usize;
                        while vend < after_ws.len() && !is_pdf_token_delim_or_ws(after_ws[vend]) {
                            vend += 1;
                        }
                        let val_name = &after_ws[..vend];
                        if val_name == b"/Pages" {
                            if let Some(top) = stack.last_mut() {
                                top.has_type_pages = true;
                            }
                        } else if val_name == b"/Page" {
                            page_leaf_count = page_leaf_count.saturating_add(1);
                            if let Some(top) = stack.last_mut() {
                                top.has_type_other = true;
                            }
                        } else if let Some(top) = stack.last_mut() {
                            top.has_type_other = true;
                        }
                        i += consumed_ws + vend;
                    }
                } else if name == b"/Count" {
                    let after_ws = skip_pdf_ascii_ws(&bytes[i..]);
                    let consumed_ws = bytes[i..].len() - after_ws.len();
                    let digit_len = after_ws.iter().take_while(|b| b.is_ascii_digit()).count();
                    if digit_len > 0
                        && after_ws
                            .get(digit_len)
                            .is_none_or(|&b| is_pdf_token_delim_or_ws(b))
                    {
                        if let Ok(digit_str) = std::str::from_utf8(&after_ws[..digit_len]) {
                            let parsed_clamped = digit_str
                                .parse::<u64>()
                                .map(|n| n.min(u64::from(MAX_FALLBACK_PAGES)) as u32)
                                .unwrap_or(MAX_FALLBACK_PAGES);
                            if let Some(top) = stack.last_mut() {
                                if parsed_clamped == 0 {
                                    top.saw_zero_count = true;
                                } else {
                                    top.count = Some(parsed_clamped);
                                }
                            }
                        }
                        i += consumed_ws + digit_len;
                    }
                } else if name == b"/N" {
                    let after_ws = skip_pdf_ascii_ws(&bytes[i..]);
                    let consumed_ws = bytes[i..].len() - after_ws.len();
                    let digit_len = after_ws.iter().take_while(|b| b.is_ascii_digit()).count();
                    if digit_len > 0
                        && let Ok(digit_str) = std::str::from_utf8(&after_ws[..digit_len])
                        && let Ok(parsed) = digit_str.parse::<u64>()
                        && parsed > 0
                    {
                        linearized_n = Some(parsed.min(u64::from(MAX_FALLBACK_PAGES)) as u32);
                        i += consumed_ws + digit_len;
                    }
                }
            }
            b's' if bytes[i..].starts_with(b"startxref") => {
                saw_startxref = true;
                i += 9;
            }
            _ => i += 1,
        }
    }

    if max_pages_count > 0 {
        return max_pages_count.min(MAX_FALLBACK_PAGES);
    }

    if page_leaf_count > 0 {
        return page_leaf_count.min(MAX_FALLBACK_PAGES);
    }

    if saw_linearized
        && let Some(n) = linearized_n
        && n > 0
    {
        return n.min(MAX_FALLBACK_PAGES);
    }

    if !saw_zero_pages_count && saw_startxref {
        return 1;
    }

    0
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
        if let Ok(deg) = digits.parse::<u16>()
            && let Ok(rot) = Rotation::from_degrees(deg)
        {
            return rot;
        }
    }
    Rotation::Deg0
}

fn extract_pdf_string_value(text: &str, key: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let key_bytes = key.as_bytes();
    if key_bytes.is_empty() || bytes.len() < key_bytes.len() {
        return None;
    }
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                while i < bytes.len() && !matches!(bytes[i], b'\r' | b'\n') {
                    i += 1;
                }
            }
            b'(' => match parse_pdf_literal_after_open(&text[i + 1..]) {
                LiteralParseOutcome::Parsed { next_index, .. } => {
                    i += 1 + next_index;
                }
                LiteralParseOutcome::UnclosedAtEof => break,
            },
            b'/' if i + key_bytes.len() <= bytes.len()
                && &bytes[i..i + key_bytes.len()] == key_bytes =>
            {
                let after_key = &text[i + key_bytes.len()..];
                if after_key
                    .as_bytes()
                    .first()
                    .is_none_or(|&b| is_pdf_token_delim_or_ws(b))
                {
                    let trimmed = after_key.trim_start_matches([' ', '\t', '\r', '\n']);
                    if let Some(after_open) = trimmed.strip_prefix('(') {
                        match parse_pdf_literal_after_open(after_open) {
                            LiteralParseOutcome::Parsed { text: decoded, .. } => {
                                let clean = decoded.trim();
                                if !clean.is_empty() {
                                    return Some(clean.to_owned());
                                }
                            }
                            LiteralParseOutcome::UnclosedAtEof => break,
                        }
                    }
                }
                i += key_bytes.len();
            }
            _ => i += 1,
        }
    }
    None
}

fn extract_texts_per_page(content_text: &str, page_count: u32) -> Vec<String> {
    let cap = (page_count.min(MAX_FALLBACK_PAGES)) as usize;
    let mut blocks = Vec::new();
    let bytes = content_text.as_bytes();
    let mut i = 0usize;
    let mut in_bt = false;
    let mut current_parts: Vec<String> = Vec::new();

    while i < bytes.len() && blocks.len() < cap {
        match bytes[i] {
            b'%' => {
                while i < bytes.len() && !matches!(bytes[i], b'\r' | b'\n') {
                    i += 1;
                }
            }
            b'(' => match parse_pdf_literal_after_open(&content_text[i + 1..]) {
                LiteralParseOutcome::Parsed {
                    text: decoded,
                    next_index,
                } => {
                    if in_bt && !decoded.is_empty() {
                        current_parts.push(decoded);
                    }
                    i += 1 + next_index;
                }
                LiteralParseOutcome::UnclosedAtEof => break,
            },
            b'B' if bytes.get(i + 1) == Some(&b'T') => {
                let prev_ok = i == 0 || is_pdf_token_delim_or_ws(bytes[i - 1]);
                let next_ok = i + 2 == bytes.len() || is_pdf_token_delim_or_ws(bytes[i + 2]);
                if prev_ok && next_ok {
                    in_bt = true;
                    current_parts.clear();
                    i += 2;
                } else {
                    i += 1;
                }
            }
            b'E' if bytes.get(i + 1) == Some(&b'T') => {
                let prev_ok = i == 0 || is_pdf_token_delim_or_ws(bytes[i - 1]);
                let next_ok = i + 2 == bytes.len() || is_pdf_token_delim_or_ws(bytes[i + 2]);
                if prev_ok && next_ok && in_bt {
                    blocks.push(current_parts.join(" "));
                    current_parts.clear();
                    in_bt = false;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }

    blocks
}

fn extract_outline_nodes(text: &str, page_count: u32) -> Vec<OutlineNode> {
    let mut nodes = Vec::new();
    let bytes = text.as_bytes();
    let key = b"/OutlineTitle";
    let mut i = 0usize;
    let mut page_cursor = 0u32;

    while i + key.len() <= bytes.len() {
        match bytes[i] {
            b'%' => {
                while i < bytes.len() && !matches!(bytes[i], b'\r' | b'\n') {
                    i += 1;
                }
            }
            b'(' => match parse_pdf_literal_after_open(&text[i + 1..]) {
                LiteralParseOutcome::Parsed { next_index, .. } => {
                    i += 1 + next_index;
                }
                LiteralParseOutcome::UnclosedAtEof => break,
            },
            b'/' if &bytes[i..i + key.len()] == key => {
                let after = &text[i + key.len()..];
                if after
                    .as_bytes()
                    .first()
                    .is_none_or(|&b| is_pdf_token_delim_or_ws(b))
                {
                    let trimmed = after.trim_start_matches([' ', '\t', '\r', '\n']);
                    if let Some(after_open) = trimmed.strip_prefix('(') {
                        match parse_pdf_literal_after_open(after_open) {
                            LiteralParseOutcome::Parsed {
                                text: decoded,
                                next_index,
                            } => {
                                let clean = decoded.trim();
                                if !clean.is_empty() {
                                    let target_page = page_cursor.min(page_count.saturating_sub(1));
                                    nodes.push(OutlineNode {
                                        title: clean.to_owned(),
                                        page_index: Some(PageIndex::new(target_page)),
                                        children: Vec::new(),
                                    });
                                    page_cursor = page_cursor.saturating_add(1);
                                }
                                let ws_len = after.len() - trimmed.len();
                                i += key.len() + ws_len + 1 + next_index;
                                continue;
                            }
                            LiteralParseOutcome::UnclosedAtEof => break,
                        }
                    }
                }
                i += key.len();
            }
            _ => i += 1,
        }
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

/// Searches `page_text` for `trimmed_query` with exact UTF-8 byte boundary alignment, even when
/// Unicode case-folding changes byte lengths (e.g. `'İ'`, `'ẞ'`), and builds clamped snippets.
#[must_use]
pub(crate) fn search_page_text_hits(
    page_text: &str,
    page_index: PageIndex,
    trimmed_query: &str,
    case_sensitive: bool,
    max_hits: usize,
) -> Vec<SearchHit> {
    if trimmed_query.is_empty() || page_text.is_empty() || max_hits == 0 {
        return Vec::new();
    }

    let mut hits = Vec::new();

    if case_sensitive {
        let mut search_from = 0usize;
        let mut match_index = 0u32;
        while let Some(rel) = page_text[search_from..].find(trimmed_query) {
            let abs_start = search_from + rel;
            let abs_end = abs_start + trimmed_query.len();
            hits.push(SearchHit {
                page_index,
                match_index,
                snippet: extract_clamped_snippet(page_text, abs_start, abs_end),
                match_text: page_text.get(abs_start..abs_end).map(ToOwned::to_owned),
                bounding_box: None,
                bounding_boxes: Vec::new(),
            });
            if hits.len() >= max_hits {
                break;
            }
            match_index = match_index.saturating_add(1);
            search_from = abs_end.max(abs_start + 1);
        }
        return hits;
    }

    if page_text.is_ascii() && trimmed_query.is_ascii() {
        let hay = page_text.as_bytes();
        let needle = trimmed_query.as_bytes();
        if hay.len() < needle.len() {
            return hits;
        }
        let mut pos = 0usize;
        let mut match_index = 0u32;
        while pos + needle.len() <= hay.len() {
            if hay[pos..pos + needle.len()].eq_ignore_ascii_case(needle) {
                let end = pos + needle.len();
                hits.push(SearchHit {
                    page_index,
                    match_index,
                    snippet: extract_clamped_snippet(page_text, pos, end),
                    match_text: page_text.get(pos..end).map(ToOwned::to_owned),
                    bounding_box: None,
                    bounding_boxes: Vec::new(),
                });
                if hits.len() >= max_hits {
                    break;
                }
                match_index = match_index.saturating_add(1);
                pos = end;
            } else {
                pos += 1;
            }
        }
        return hits;
    }

    let needle_folded: Vec<char> = trimmed_query.chars().flat_map(char::to_lowercase).collect();
    if needle_folded.is_empty() {
        return hits;
    }

    let mut folded_chars: Vec<(char, usize, usize)> = Vec::with_capacity(page_text.len());
    for (byte_idx, ch) in page_text.char_indices() {
        let end_byte = byte_idx + ch.len_utf8();
        for lower_ch in ch.to_lowercase() {
            folded_chars.push((lower_ch, byte_idx, end_byte));
        }
    }

    let n_len = needle_folded.len();
    if folded_chars.len() < n_len {
        return hits;
    }

    let mut pos = 0usize;
    let mut match_index = 0u32;
    while pos + n_len <= folded_chars.len() {
        let matched = folded_chars[pos..pos + n_len]
            .iter()
            .zip(needle_folded.iter())
            .all(|((hc, _, _), nc)| hc == nc);
        if matched {
            let start_byte = folded_chars[pos].1;
            let end_byte = folded_chars[pos + n_len - 1].2;
            hits.push(SearchHit {
                page_index,
                match_index,
                snippet: extract_clamped_snippet(page_text, start_byte, end_byte),
                match_text: page_text.get(start_byte..end_byte).map(ToOwned::to_owned),
                bounding_box: None,
                bounding_boxes: Vec::new(),
            });
            if hits.len() >= max_hits {
                break;
            }
            match_index = match_index.saturating_add(1);
            pos += n_len;
        } else {
            pos += 1;
        }
    }

    hits
}

fn extract_clamped_snippet(page_text: &str, match_start: usize, match_end: usize) -> String {
    let start = clamp_floor_char_boundary(page_text, match_start.saturating_sub(24));
    let end = clamp_ceil_char_boundary(page_text, match_end.saturating_add(36));
    page_text
        .get(start..end)
        .unwrap_or(page_text)
        .trim()
        .to_owned()
}

pub(crate) fn clamp_floor_char_boundary(s: &str, index: usize) -> usize {
    let mut i = index.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

pub(crate) fn clamp_ceil_char_boundary(s: &str, index: usize) -> usize {
    let mut i = index.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[inline]
fn skip_pdf_ascii_ws(bytes: &[u8]) -> &[u8] {
    let mut idx = 0usize;
    while idx < bytes.len() && matches!(bytes[idx], 0x00 | 0x09 | 0x0A | 0x0C | 0x0D | 0x20) {
        idx += 1;
    }
    &bytes[idx..]
}

/// Inspects structural (non-content-stream) PDF dictionary regions of `bytes` for
/// interactive forms (`/AcroForm`, `/XFA`) and digital signature fields (`/FT /Sig`, `/Type /Sig`).
///
/// Never inspects page content streams, so body text mentioning `/AcroForm` or `/Sig` cannot
/// produce false positives.
#[must_use]
pub fn inspect_advanced_pdf_capabilities_bytes(
    bytes: &[u8],
) -> (FormSupportStatus, u32, SignaturePresenceStatus, u32) {
    let (structural_text, _) = extract_bounded_pdf_regions_inner(bytes, false);
    inspect_advanced_pdf_capabilities(&structural_text)
}

/// Inspects structural PDF dictionary markers for interactive forms (`/AcroForm`, `/XFA`)
/// and digital signature fields (`/FT /Sig`, `/Type /Sig`), skipping `%` comments and
/// balanced `(...)` literal strings.
#[must_use]
pub fn inspect_advanced_pdf_capabilities(
    text: &str,
) -> (FormSupportStatus, u32, SignaturePresenceStatus, u32) {
    let bytes = text.as_bytes();
    let mut has_xfa = false;
    let mut has_acroform = false;
    let mut tx_fields = 0usize;
    let mut sig_fields = 0usize;

    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                while i < bytes.len() && !matches!(bytes[i], b'\r' | b'\n') {
                    i += 1;
                }
                continue;
            }
            b'(' => match parse_pdf_literal_after_open(&text[i + 1..]) {
                LiteralParseOutcome::Parsed { next_index, .. } => {
                    i += 1 + next_index;
                    continue;
                }
                LiteralParseOutcome::UnclosedAtEof => break,
            },
            b'/' => {}
            _ => {
                i += 1;
                continue;
            }
        }
        let rem = &bytes[i..];
        if rem.starts_with(b"/XFA") && rem.get(4).is_none_or(|&b| is_pdf_token_delim_or_ws(b)) {
            has_xfa = true;
            i += 4;
        } else if rem.starts_with(b"/AcroForm")
            && rem.get(9).is_none_or(|&b| is_pdf_token_delim_or_ws(b))
        {
            has_acroform = true;
            i += 9;
        } else if rem.starts_with(b"/FT") && rem.get(3).is_none_or(|&b| is_pdf_token_delim_or_ws(b))
        {
            let after_ft = skip_pdf_ascii_ws(&rem[3..]);
            let is_form_field = (after_ft.starts_with(b"/Tx")
                && after_ft.get(3).is_none_or(|&b| is_pdf_token_delim_or_ws(b)))
                || (after_ft.starts_with(b"/Btn")
                    && after_ft.get(4).is_none_or(|&b| is_pdf_token_delim_or_ws(b)))
                || (after_ft.starts_with(b"/Ch")
                    && after_ft.get(3).is_none_or(|&b| is_pdf_token_delim_or_ws(b)));
            if is_form_field {
                tx_fields += 1;
            } else if after_ft.starts_with(b"/Sig")
                && after_ft.get(4).is_none_or(|&b| is_pdf_token_delim_or_ws(b))
            {
                sig_fields += 1;
            }
            i += 3;
        } else if rem.starts_with(b"/Type")
            && rem.get(5).is_none_or(|&b| is_pdf_token_delim_or_ws(b))
        {
            let after_type = skip_pdf_ascii_ws(&rem[5..]);
            if after_type.starts_with(b"/Sig")
                && after_type
                    .get(4)
                    .is_none_or(|&b| is_pdf_token_delim_or_ws(b))
            {
                sig_fields += 1;
            }
            i += 5;
        } else {
            i += 1;
        }
    }

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
