//! Use case for rendering a PDF page with LRU byte-budget caching and stale-request cancellation.

use app_domain::{
    DocumentId, MAX_RENDER_DIMENSION_PX, PageIndex, Rotation, ScaleBucket, ZoomLevel,
};
use pdf_engine::{PdfDocument, RenderPageRequest};

use crate::dto::{RenderPageCommand, RenderedPageResultDto};
use crate::error::ApplicationError;
use crate::ports::render_cache::{
    CachedPageEntry, RenderCacheKey, RenderCachePort, RenderCancellationPort,
};

/// Renders a single page or returns a cached entry, checking cancellation before and after
/// CPU-intensive rendering work.
pub fn execute_render_page<F>(
    command: &RenderPageCommand,
    document: &dyn PdfDocument,
    cache: &dyn RenderCachePort,
    cancellation: &dyn RenderCancellationPort,
    encode_png_data_url: F,
) -> Result<RenderedPageResultDto, ApplicationError>
where
    F: Fn(&[u8]) -> String,
{
    let doc_id = DocumentId::new(&command.document_id)?;
    let page_count = document.info().page_count;
    let page_index = PageIndex::within(command.page_index, page_count)?;
    let rotation = Rotation::from_degrees(command.rotation_degrees)?;
    let zoom = ZoomLevel::new(command.scale)?;
    let scale_bucket = ScaleBucket::from_scale(zoom.factor());

    let effective_gen = command
        .generation
        .unwrap_or_else(|| cancellation.current_generation(&doc_id));

    if !cancellation.is_current(&doc_id, effective_gen) {
        return Err(ApplicationError::Cancelled);
    }

    let cache_key = RenderCacheKey {
        document_id: doc_id.clone(),
        page_index,
        scale_bucket,
        rotation,
        render_mode: command.render_mode,
    };

    if let Some(hit) = cache.get(&cache_key) {
        return Ok(RenderedPageResultDto {
            document_id: doc_id.as_str().to_owned(),
            page_index: page_index.zero_based(),
            width_px: hit.width_px,
            height_px: hit.height_px,
            data_url: hit.data_url,
            cache_hit: true,
            generation: effective_gen,
        });
    }

    let render_req = RenderPageRequest {
        page_index,
        scale: scale_bucket.as_scale(),
        rotation,
        render_mode: command.render_mode,
        max_pixel_dimension: MAX_RENDER_DIMENSION_PX,
    };

    let rendered = document.render_page(&render_req)?;

    // Check if the user navigated away or zoomed again while rendering was in flight.
    if !cancellation.is_current(&doc_id, effective_gen) {
        return Err(ApplicationError::Cancelled);
    }

    let data_url = encode_png_data_url(&rendered.png_bytes);
    let byte_size = rendered.memory_footprint_bytes();

    cache.put(
        cache_key,
        CachedPageEntry {
            width_px: rendered.width_px,
            height_px: rendered.height_px,
            data_url: data_url.clone(),
            byte_size,
        },
    );

    Ok(RenderedPageResultDto {
        document_id: doc_id.as_str().to_owned(),
        page_index: page_index.zero_based(),
        width_px: rendered.width_px,
        height_px: rendered.height_px,
        data_url,
        cache_hit: false,
        generation: effective_gen,
    })
}
