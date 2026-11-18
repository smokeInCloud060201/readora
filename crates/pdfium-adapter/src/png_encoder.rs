//! Pure-Rust RGBA8 to PNG encoder and pixel post-processing (`Grayscale`, `DarkInversion`).

use std::io::Write;
use std::sync::OnceLock;

use app_domain::RenderMode;
use crc32fast::Hasher as Crc32Hasher;
use flate2::Compression;
use flate2::write::ZlibEncoder;
use pdf_engine::PdfEngineError;

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

const PAPER_LIGHT_RGB: [f32; 3] = [252.0, 251.0, 246.0]; // #fcfbf6 (--bg-page-sheet light)
const INK_LIGHT_RGB: [f32; 3] = [35.0, 37.0, 31.0]; // #23251f (warm Readora ink)
const PAPER_GRAY_RGB: [f32; 3] = [244.0, 244.0, 240.0]; // #f4f4f0 (e-ink grayscale paper)
const INK_GRAY_RGB: [f32; 3] = [38.0, 39.0, 36.0]; // #262724
const PAPER_DARK_RGB: [f32; 3] = [38.0, 40.0, 35.0]; // #262823 (--bg-page-sheet dark olive)
const INK_DARK_RGB: [f32; 3] = [230.0, 232.0, 225.0]; // #e6e8e1 (warm ivory ink)

static POW_112_LUT: OnceLock<[f32; 1025]> = OnceLock::new();
static POW_092_LUT: OnceLock<[f32; 1025]> = OnceLock::new();
static LIGHT_GRAY_LUT: OnceLock<[[u8; 3]; 256]> = OnceLock::new();
static GRAYSCALE_LUT: OnceLock<[[u8; 3]; 256]> = OnceLock::new();
static DARK_GRAY_LUT: OnceLock<[[u8; 3]; 256]> = OnceLock::new();

#[inline]
fn pow_112(x: f32) -> f32 {
    let lut = POW_112_LUT.get_or_init(|| {
        let mut table = [0.0_f32; 1025];
        for (idx, slot) in table.iter_mut().enumerate() {
            *slot = ((idx as f32) / 1024.0).powf(1.12);
        }
        table
    });
    let scaled = (x.clamp(0.0, 1.0) * 1024.0).clamp(0.0, 1024.0);
    let idx = (scaled as usize).min(1023);
    let frac = scaled - (idx as f32);
    lut[idx] + (lut[idx + 1] - lut[idx]) * frac
}

#[inline]
fn pow_092(x: f32) -> f32 {
    let lut = POW_092_LUT.get_or_init(|| {
        let mut table = [0.0_f32; 1025];
        for (idx, slot) in table.iter_mut().enumerate() {
            *slot = ((idx as f32) / 1024.0).powf(0.92);
        }
        table
    });
    let scaled = (x.clamp(0.0, 1.0) * 1024.0).clamp(0.0, 1024.0);
    let idx = (scaled as usize).min(1023);
    let frac = scaled - (idx as f32);
    lut[idx] + (lut[idx + 1] - lut[idx]) * frac
}

fn light_achromatic_lut() -> &'static [[u8; 3]; 256] {
    LIGHT_GRAY_LUT.get_or_init(|| {
        let mut table = [[0_u8; 3]; 256];
        for (v, slot) in table.iter_mut().enumerate() {
            let vf = v as f32;
            let luma = (0.299 * vf + 0.587 * vf + 0.114 * vf) / 255.0;
            let t = luma.clamp(0.0, 1.0).powf(1.12);
            *slot = [
                lerp_u8(INK_LIGHT_RGB[0], PAPER_LIGHT_RGB[0], t),
                lerp_u8(INK_LIGHT_RGB[1], PAPER_LIGHT_RGB[1], t),
                lerp_u8(INK_LIGHT_RGB[2], PAPER_LIGHT_RGB[2], t),
            ];
        }
        table
    })
}

fn grayscale_achromatic_lut() -> &'static [[u8; 3]; 256] {
    GRAYSCALE_LUT.get_or_init(|| {
        let mut table = [[0_u8; 3]; 256];
        for (v, slot) in table.iter_mut().enumerate() {
            let vf = v as f32;
            let t = ((0.299 * vf + 0.587 * vf + 0.114 * vf) / 255.0)
                .clamp(0.0, 1.0)
                .powf(1.12);
            *slot = [
                lerp_u8(INK_GRAY_RGB[0], PAPER_GRAY_RGB[0], t),
                lerp_u8(INK_GRAY_RGB[1], PAPER_GRAY_RGB[1], t),
                lerp_u8(INK_GRAY_RGB[2], PAPER_GRAY_RGB[2], t),
            ];
        }
        table
    })
}

fn dark_achromatic_lut() -> &'static [[u8; 3]; 256] {
    DARK_GRAY_LUT.get_or_init(|| {
        let mut table = [[0_u8; 3]; 256];
        for (v, slot) in table.iter_mut().enumerate() {
            let vf = v as f32;
            let luma = (0.299 * vf + 0.587 * vf + 0.114 * vf) / 255.0;
            let inv_t = (1.0 - luma.clamp(0.0, 1.0)).powf(0.92);
            *slot = [
                lerp_u8(PAPER_DARK_RGB[0], INK_DARK_RGB[0], inv_t),
                lerp_u8(PAPER_DARK_RGB[1], INK_DARK_RGB[1], inv_t),
                lerp_u8(PAPER_DARK_RGB[2], INK_DARK_RGB[2], inv_t),
            ];
        }
        table
    })
}

#[inline]
fn lerp_u8(a: f32, b: f32, t: f32) -> u8 {
    (a + (b - a) * t.clamp(0.0, 1.0)).round().clamp(0.0, 255.0) as u8
}

/// Applies the requested `RenderMode` transformation in-place on an RGBA8 pixel buffer,
/// harmonizing PDF page backgrounds and body ink with Readora's warm paper / dark-olive theme.
pub fn apply_render_mode_rgba(rgba: &mut [u8], mode: RenderMode) {
    match mode {
        RenderMode::Standard => {
            let lut = light_achromatic_lut();
            for px in rgba.chunks_exact_mut(4) {
                if px[0] == px[1] && px[1] == px[2] {
                    let mapped = lut[usize::from(px[0])];
                    px[0] = mapped[0];
                    px[1] = mapped[1];
                    px[2] = mapped[2];
                    continue;
                }
                let r = f32::from(px[0]);
                let g = f32::from(px[1]);
                let b = f32::from(px[2]);
                let max_c = r.max(g).max(b);
                let min_c = r.min(g).min(b);
                let chroma = max_c - min_c;
                let luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
                // Subtle reading-contrast gamma (1.12) deepens thin anti-aliased glyph stems
                let t = pow_112(luma);
                let nr = INK_LIGHT_RGB[0] + (PAPER_LIGHT_RGB[0] - INK_LIGHT_RGB[0]) * t;
                let ng = INK_LIGHT_RGB[1] + (PAPER_LIGHT_RGB[1] - INK_LIGHT_RGB[1]) * t;
                let nb = INK_LIGHT_RGB[2] + (PAPER_LIGHT_RGB[2] - INK_LIGHT_RGB[2]) * t;

                if chroma <= 12.0 {
                    px[0] = nr.round().clamp(0.0, 255.0) as u8;
                    px[1] = ng.round().clamp(0.0, 255.0) as u8;
                    px[2] = nb.round().clamp(0.0, 255.0) as u8;
                } else {
                    let cr = r * (PAPER_LIGHT_RGB[0] / 255.0);
                    let cg = g * (PAPER_LIGHT_RGB[1] / 255.0);
                    let cb = b * (PAPER_LIGHT_RGB[2] / 255.0);
                    let w = ((chroma - 12.0) / 24.0).clamp(0.0, 1.0);
                    px[0] = lerp_u8(nr, cr, w);
                    px[1] = lerp_u8(ng, cg, w);
                    px[2] = lerp_u8(nb, cb, w);
                }
            }
        }
        RenderMode::Grayscale => {
            let lut = grayscale_achromatic_lut();
            for px in rgba.chunks_exact_mut(4) {
                if px[0] == px[1] && px[1] == px[2] {
                    let mapped = lut[usize::from(px[0])];
                    px[0] = mapped[0];
                    px[1] = mapped[1];
                    px[2] = mapped[2];
                    continue;
                }
                let r = f32::from(px[0]);
                let g = f32::from(px[1]);
                let b = f32::from(px[2]);
                let luma = pow_112((0.299 * r + 0.587 * g + 0.114 * b) / 255.0);
                px[0] = lerp_u8(INK_GRAY_RGB[0], PAPER_GRAY_RGB[0], luma);
                px[1] = lerp_u8(INK_GRAY_RGB[1], PAPER_GRAY_RGB[1], luma);
                px[2] = lerp_u8(INK_GRAY_RGB[2], PAPER_GRAY_RGB[2], luma);
            }
        }
        RenderMode::DarkInversion => {
            let lut = dark_achromatic_lut();
            for px in rgba.chunks_exact_mut(4) {
                if px[0] == px[1] && px[1] == px[2] {
                    let mapped = lut[usize::from(px[0])];
                    px[0] = mapped[0];
                    px[1] = mapped[1];
                    px[2] = mapped[2];
                    continue;
                }
                let r = f32::from(px[0]);
                let g = f32::from(px[1]);
                let b = f32::from(px[2]);
                let max_c = r.max(g).max(b);
                let min_c = r.min(g).min(b);
                let chroma = max_c - min_c;
                let luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
                // Gentle 0.92 exponent keeps light-on-dark glyph strokes crisp and full-bodied
                let inv_t = pow_092(1.0 - luma.clamp(0.0, 1.0));
                let nr = PAPER_DARK_RGB[0] + (INK_DARK_RGB[0] - PAPER_DARK_RGB[0]) * inv_t;
                let ng = PAPER_DARK_RGB[1] + (INK_DARK_RGB[1] - PAPER_DARK_RGB[1]) * inv_t;
                let nb = PAPER_DARK_RGB[2] + (INK_DARK_RGB[2] - PAPER_DARK_RGB[2]) * inv_t;

                if chroma <= 12.0 {
                    px[0] = nr.round().clamp(0.0, 255.0) as u8;
                    px[1] = ng.round().clamp(0.0, 255.0) as u8;
                    px[2] = nb.round().clamp(0.0, 255.0) as u8;
                } else {
                    // Hue-preserving lightness inversion around the dark-olive surface
                    let src_luma = (0.299 * r + 0.587 * g + 0.114 * b).max(1.0);
                    let target_luma = 0.299 * nr + 0.587 * ng + 0.114 * nb;
                    let delta = target_luma - src_luma;
                    let cr = (r * 0.78 + delta + 12.0).clamp(PAPER_DARK_RGB[0], 242.0);
                    let cg = (g * 0.78 + delta + 12.0).clamp(PAPER_DARK_RGB[1], 242.0);
                    let cb = (b * 0.78 + delta + 12.0).clamp(PAPER_DARK_RGB[2], 242.0);
                    let w = ((chroma - 12.0) / 28.0).clamp(0.0, 1.0);
                    px[0] = lerp_u8(nr, cr, w);
                    px[1] = lerp_u8(ng, cg, w);
                    px[2] = lerp_u8(nb, cb, w);
                }
            }
        }
    }
}

/// Encodes an RGBA8 buffer of `width x height` pixels into a valid PNG byte vector.
pub fn encode_rgba_to_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, PdfEngineError> {
    if width == 0 || height == 0 || width > i32::MAX as u32 || height > i32::MAX as u32 {
        return Err(PdfEngineError::Internal(format!(
            "PNG dimensions must be in 1..={} range, got {width}x{height}",
            i32::MAX
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
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    for row in rgba.chunks_exact(row_bytes) {
        encoder
            .write_all(&[0_u8])
            .map_err(|e| PdfEngineError::Internal(format!("PNG zlib compression failed: {e}")))?;
        encoder
            .write_all(row)
            .map_err(|e| PdfEngineError::Internal(format!("PNG zlib compression failed: {e}")))?;
    }
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
    write_png_chunk(&mut png, b"IHDR", &ihdr)?;
    write_png_chunk(&mut png, b"IDAT", &compressed)?;
    write_png_chunk(&mut png, b"IEND", &[])?;

    Ok(png)
}

fn write_png_chunk(
    out: &mut Vec<u8>,
    chunk_type: &[u8; 4],
    data: &[u8],
) -> Result<(), PdfEngineError> {
    let len = u32::try_from(data.len())
        .map_err(|_| PdfEngineError::Internal("PNG chunk length exceeds u32::MAX".to_owned()))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(data);

    let mut hasher = Crc32Hasher::new();
    hasher.update(chunk_type);
    hasher.update(data);
    let crc = hasher.finalize();
    out.extend_from_slice(&crc.to_be_bytes());
    Ok(())
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

    #[test]
    fn render_modes_harmonize_paper_and_ink_with_app_theme() {
        let mut light_buf = [255, 255, 255, 255, 0, 0, 0, 255];
        apply_render_mode_rgba(&mut light_buf, RenderMode::Standard);
        assert_eq!(&light_buf[0..4], &[252, 251, 246, 255]);
        assert_eq!(&light_buf[4..8], &[35, 37, 31, 255]);

        let mut dark_buf = [255, 255, 255, 255, 0, 0, 0, 255];
        apply_render_mode_rgba(&mut dark_buf, RenderMode::DarkInversion);
        assert_eq!(&dark_buf[0..4], &[38, 40, 35, 255]);
        assert_eq!(&dark_buf[4..8], &[230, 232, 225, 255]);
    }
}
