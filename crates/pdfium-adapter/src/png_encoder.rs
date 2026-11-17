//! Pure-Rust RGBA8 to PNG encoder and pixel post-processing (`Grayscale`, `DarkInversion`).

use std::io::Write;

use app_domain::RenderMode;
use crc32fast::Hasher as Crc32Hasher;
use flate2::Compression;
use flate2::write::ZlibEncoder;
use pdf_engine::PdfEngineError;

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// Applies the requested `RenderMode` transformation in-place on an RGBA8 pixel buffer.
pub fn apply_render_mode_rgba(rgba: &mut [u8], mode: RenderMode) {
    match mode {
        RenderMode::Standard => {}
        RenderMode::Grayscale => {
            for px in rgba.chunks_exact_mut(4) {
                let luma =
                    ((u32::from(px[0]) * 77 + u32::from(px[1]) * 150 + u32::from(px[2]) * 29) >> 8)
                        as u8;
                px[0] = luma;
                px[1] = luma;
                px[2] = luma;
            }
        }
        RenderMode::DarkInversion => {
            for px in rgba.chunks_exact_mut(4) {
                px[0] = 255u8.saturating_sub(px[0]);
                px[1] = 255u8.saturating_sub(px[1]);
                px[2] = 255u8.saturating_sub(px[2]);
            }
        }
    }
}

/// Encodes an RGBA8 buffer of `width x height` pixels into a valid PNG byte vector.
pub fn encode_rgba_to_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, PdfEngineError> {
    if width == 0 || height == 0 {
        return Err(PdfEngineError::Internal(format!(
            "PNG dimensions must be non-zero, got {width}x{height}"
        )));
    }

    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| PdfEngineError::Internal("PNG buffer size overflow".to_owned()))?;

    if rgba.len() != expected_len {
        return Err(PdfEngineError::Internal(format!(
            "RGBA buffer length mismatch: expected {expected_len}, got {}",
            rgba.len()
        )));
    }

    let row_bytes = (width as usize) * 4;
    let raw_cap = row_bytes
        .checked_add(1)
        .and_then(|stride| stride.checked_mul(height as usize))
        .ok_or_else(|| PdfEngineError::Internal("PNG scanline buffer size overflow".to_owned()))?;
    let mut raw_scanlines = Vec::with_capacity(raw_cap);
    for row in rgba.chunks_exact(row_bytes) {
        raw_scanlines.push(0u8); // Filter type 0 (None)
        raw_scanlines.extend_from_slice(row);
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&raw_scanlines)
        .map_err(|e| PdfEngineError::Internal(format!("PNG zlib compression failed: {e}")))?;
    let compressed = encoder
        .finish()
        .map_err(|e| PdfEngineError::Internal(format!("PNG zlib finish failed: {e}")))?;

    let mut png = Vec::with_capacity(64 + compressed.len());
    png.extend_from_slice(&PNG_SIGNATURE);

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth: 8 bits per channel
    ihdr[9] = 6; // color type: 6 (RGBA)
    ihdr[10] = 0; // compression method
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // interlace method: none
    write_png_chunk(&mut png, b"IHDR", &ihdr);
    write_png_chunk(&mut png, b"IDAT", &compressed);
    write_png_chunk(&mut png, b"IEND", &[]);

    Ok(png)
}

fn write_png_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    let len = u32::try_from(data.len()).unwrap_or(0);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(data);

    let mut hasher = Crc32Hasher::new();
    hasher.update(chunk_type);
    hasher.update(data);
    let crc = hasher.finalize();
    out.extend_from_slice(&crc.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_encoder_rejects_zero_dimensions_and_encodes_one_by_one_pixel() {
        assert!(encode_rgba_to_png(0, 10, &[]).is_err());
        assert!(encode_rgba_to_png(10, 0, &[]).is_err());
        assert!(encode_rgba_to_png(0, 0, &[]).is_err());
        assert!(encode_rgba_to_png(2, 2, &[0u8; 12]).is_err());

        let png = encode_rgba_to_png(1, 1, &[255, 128, 64, 255]).unwrap();
        assert!(png.starts_with(&PNG_SIGNATURE));
    }
}
