//! Dynamic PDFium library loader, single-threaded worker actor, and `PdfDocument` wrapper.
//!
//! Uses a dedicated background thread (`"readora-pdfium-worker"`) initialized once via `OnceLock`
//! so `libpdfium` is bound once per process and each opened PDF document is parsed once into a
//! worker-owned `PdfDocument<'static>` handle (`100%` safe Rust, zero `unsafe`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;

use app_domain::{
    DocumentMetadata, OutlineNode, PageDimensions, PageIndex, Rotation, SearchBoundingBox,
    SearchHit, sanitize_display_name,
};
use bytes::Bytes;
use pdf_engine::{
    EngineDocumentInfo, OpenDocumentOptions, PageGeometry, PdfDocument as EnginePdfDocument,
    PdfEngineError, RenderPageRequest, RenderedPage,
};
use pdfium_render::prelude::{
    PdfBookmark, PdfDocument as PdfiumNativeDocument, PdfDocumentMetadataTagType,
    PdfDocumentVersion, PdfPageRenderRotation, PdfRenderConfig, PdfSearchDirection,
    PdfSearchOptions, Pdfium, PdfiumError, PdfiumLibraryBindings,
};

use crate::fallback_engine::{
    extract_header_pdf_version, has_encrypt_dict_bytes, inspect_advanced_pdf_capabilities_bytes,
    search_page_text_hits,
};
use crate::png_encoder::{apply_render_mode_rgba, encode_rgba_to_png};

const MAX_OUTLINE_DEPTH: usize = 16;
const MAX_OUTLINE_NODES: usize = 4096;
const WORKER_CHANNEL_CAPACITY: usize = 128;
const MAX_CUSTOM_WORKERS: usize = 8;

#[derive(Debug, Clone)]
enum ResolvedPdfiumSource {
    LibraryFile(PathBuf),
    SystemLibrary,
}

struct OpenedNativeDocument {
    doc_id: u64,
    info: EngineDocumentInfo,
    outline: Vec<OutlineNode>,
    page_dimensions: Vec<Option<PageDimensions>>,
}

struct RawRenderedBitmap {
    width_px: u32,
    height_px: u32,
    rgba: Vec<u8>,
}

type CancelPredicate = Arc<dyn Fn() -> bool + Send + Sync>;

struct ZeroizingPassword(Option<String>);

impl Drop for ZeroizingPassword {
    fn drop(&mut self) {
        if let Some(ref mut pw) = self.0 {
            pdf_engine::zeroize_string(pw);
        }
    }
}

enum WorkerCommand {
    Open {
        bytes: Vec<u8>,
        password: ZeroizingPassword,
        reply: SyncSender<Result<OpenedNativeDocument, PdfEngineError>>,
    },
    PageDimensions {
        doc_id: u64,
        page_index: PageIndex,
        reply: SyncSender<Result<PageDimensions, PdfEngineError>>,
    },
    ExtractPageText {
        doc_id: u64,
        page_index: PageIndex,
        reply: SyncSender<Result<String, PdfEngineError>>,
    },
    SearchText {
        doc_id: u64,
        query: String,
        case_sensitive: bool,
        max_hits: usize,
        cancel_check: Option<CancelPredicate>,
        reply: SyncSender<Result<Vec<SearchHit>, PdfEngineError>>,
    },
    RenderPage {
        doc_id: u64,
        request: RenderPageRequest,
        cancel_check: Option<CancelPredicate>,
        reply: SyncSender<Result<RawRenderedBitmap, PdfEngineError>>,
    },
    Close {
        doc_id: u64,
    },
}

#[derive(Clone)]
struct PdfiumWorkerHandle {
    cmd_tx: SyncSender<WorkerCommand>,
    pending_closes: Arc<Mutex<Vec<u64>>>,
    resolved_source: ResolvedPdfiumSource,
}

static DEFAULT_PDFIUM_WORKER: OnceLock<Option<PdfiumWorkerHandle>> = OnceLock::new();
static CUSTOM_PDFIUM_WORKERS: OnceLock<Mutex<HashMap<PathBuf, Option<PdfiumWorkerHandle>>>> =
    OnceLock::new();
static PDFIUM_SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// Returns ordered bundle candidate paths relative to `exe_dir`, scoped by bundle layout
/// and target platform (`[HIGH-01]`). When running inside a macOS `.app/Contents/MacOS` bundle,
/// probes `../Frameworks` before `../Resources`.
#[must_use]
pub(crate) fn candidate_bundle_library_dirs(exe_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "macos") || exe_dir.ends_with("Contents/MacOS") {
        dirs.push(exe_dir.join("../Frameworks"));
        dirs.push(exe_dir.join("../Frameworks/pdfium"));
        dirs.push(exe_dir.join("../Resources"));
        dirs.push(exe_dir.join("../Resources/pdfium"));
    }
    #[cfg(target_os = "windows")]
    {
        dirs.push(exe_dir.join("pdfium"));
        dirs.push(exe_dir.to_path_buf());
    }
    #[cfg(target_os = "linux")]
    {
        dirs.push(exe_dir.join("../lib/readora"));
        dirs.push(PathBuf::from("/usr/lib/readora"));
        dirs.push(PathBuf::from("/usr/share/readora/pdfium"));
        dirs.push(exe_dir.join("../share/readora/pdfium"));
        dirs.push(exe_dir.join("pdfium"));
    }
    #[cfg(all(target_os = "macos", any(debug_assertions, test)))]
    {
        dirs.push(exe_dir.join("pdfium"));
        dirs.push(exe_dir.to_path_buf());
    }
    dirs
}

fn try_bind_in_dir(dir: &Path) -> Option<(PathBuf, Box<dyn PdfiumLibraryBindings>)> {
    if !dir.exists() {
        return None;
    }
    let lib_path = if dir.is_dir() {
        Pdfium::pdfium_platform_library_name_at_path(dir)
    } else {
        dir.to_path_buf()
    };
    Pdfium::bind_to_library(&lib_path)
        .ok()
        .map(|bindings| (lib_path, bindings))
}

fn bind_pdfium_once(
    custom_dir: Option<&Path>,
) -> Option<(ResolvedPdfiumSource, Box<dyn PdfiumLibraryBindings>)> {
    #[cfg(any(debug_assertions, test))]
    if let Ok(env_dir) = std::env::var("READORA_PDFIUM_PATH") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty()
            && let Some((lib_path, bindings)) = try_bind_in_dir(Path::new(trimmed))
        {
            return Some((ResolvedPdfiumSource::LibraryFile(lib_path), bindings));
        }
    }

    if let Some(dir) = custom_dir {
        return try_bind_in_dir(dir)
            .map(|(lib_path, bindings)| (ResolvedPdfiumSource::LibraryFile(lib_path), bindings));
    }

    if let Ok(exe_path) = std::env::current_exe()
        && let Some(exe_dir) = exe_path.parent()
    {
        for candidate in candidate_bundle_library_dirs(exe_dir) {
            if let Some((lib_path, bindings)) = try_bind_in_dir(&candidate) {
                return Some((ResolvedPdfiumSource::LibraryFile(lib_path), bindings));
            }
        }
    }

    // Never dlopen relative to CWD or ambient system search paths in release builds (`HIGH-01`).
    #[cfg(any(debug_assertions, test))]
    {
        if let Some((lib_path, bindings)) = try_bind_in_dir(Path::new("assets/pdfium")) {
            return Some((ResolvedPdfiumSource::LibraryFile(lib_path), bindings));
        }
        if let Ok(bindings) = Pdfium::bind_to_system_library() {
            return Some((ResolvedPdfiumSource::SystemLibrary, bindings));
        }
    }

    None
}

fn spawn_pdfium_worker(custom_dir: Option<PathBuf>) -> Option<PdfiumWorkerHandle> {
    let _spawn_guard = PDFIUM_SPAWN_LOCK.lock().ok()?;
    let (init_tx, init_rx) = sync_channel::<Option<ResolvedPdfiumSource>>(1);
    let (cmd_tx, cmd_rx) = sync_channel::<WorkerCommand>(WORKER_CHANNEL_CAPACITY);
    let pending_closes = Arc::new(Mutex::new(Vec::<u64>::new()));
    let worker_closes = Arc::clone(&pending_closes);

    let spawn_res = thread::Builder::new()
        .name("readora-pdfium-worker".to_owned())
        .spawn(move || {
            let Some((resolved_source, bindings)) = bind_pdfium_once(custom_dir.as_deref()) else {
                // Receiver only waits until one startup result is sent; ignoring disconnect is safe.
                let _ = init_tx.send(None);
                return;
            };

            // Construct Pdfium bindings before reporting readiness so `Pdfium::new` completes
            // deterministically under `PDFIUM_SPAWN_LOCK` (`[MED-01]`).
            // Intentional process-lifetime leak inside the dedicated singleton PDFium worker thread
            // so `PdfDocument<'static>` handles live safely inside `documents` with zero `unsafe`.
            let pdfium: &'static Pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
            if init_tx.send(Some(resolved_source)).is_err() {
                return;
            }
            let mut documents: HashMap<u64, PdfiumNativeDocument<'static>> = HashMap::new();
            let mut next_doc_id: u64 = 1;

            while let Ok(cmd) = cmd_rx.recv() {
                if let Ok(mut queue) = worker_closes.lock() {
                    for closed_id in queue.drain(..) {
                        documents.remove(&closed_id);
                    }
                }

                match cmd {
                    WorkerCommand::Open {
                        bytes,
                        mut password,
                        reply,
                    } => {
                        let pw_taken = password.0.take();
                        let outcome = worker_open_document(
                            pdfium,
                            bytes,
                            pw_taken,
                            &mut documents,
                            &mut next_doc_id,
                        );
                        // Caller may have dropped its one-shot receiver if cancelled; safe to ignore.
                        let _ = reply.send(outcome);
                    }
                    WorkerCommand::PageDimensions {
                        doc_id,
                        page_index,
                        reply,
                    } => {
                        let outcome = worker_page_dimensions(&documents, doc_id, page_index);
                        let _ = reply.send(outcome);
                    }
                    WorkerCommand::ExtractPageText {
                        doc_id,
                        page_index,
                        reply,
                    } => {
                        let outcome = worker_extract_page_text(&documents, doc_id, page_index);
                        let _ = reply.send(outcome);
                    }
                    WorkerCommand::SearchText {
                        doc_id,
                        query,
                        case_sensitive,
                        max_hits,
                        cancel_check,
                        reply,
                    } => {
                        let outcome = worker_search_text(
                            &documents,
                            doc_id,
                            &query,
                            case_sensitive,
                            max_hits,
                            cancel_check.as_deref(),
                        );
                        let _ = reply.send(outcome);
                    }
                    WorkerCommand::RenderPage {
                        doc_id,
                        request,
                        cancel_check,
                        reply,
                    } => {
                        let outcome = worker_render_page(
                            &documents,
                            doc_id,
                            &request,
                            cancel_check.as_deref(),
                        );
                        let _ = reply.send(outcome);
                    }
                    WorkerCommand::Close { doc_id } => {
                        documents.remove(&doc_id);
                    }
                }
            }
        });

    if spawn_res.is_err() {
        return None;
    }

    let resolved_source = init_rx.recv().ok().flatten()?;
    Some(PdfiumWorkerHandle {
        cmd_tx,
        pending_closes,
        resolved_source,
    })
}

fn get_or_init_worker(custom_dir: Option<&Path>) -> Option<PdfiumWorkerHandle> {
    if let Some(dir) = custom_dir {
        let map = CUSTOM_PDFIUM_WORKERS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut guard = map.lock().ok()?;
        if let Some(cached) = guard.get(dir) {
            return cached.clone();
        }
        let spawned = spawn_pdfium_worker(Some(dir.to_path_buf()));
        if guard.len() < MAX_CUSTOM_WORKERS {
            guard.insert(dir.to_path_buf(), spawned.clone());
        }
        return spawned;
    }

    DEFAULT_PDFIUM_WORKER
        .get_or_init(|| spawn_pdfium_worker(None))
        .clone()
}

/// Returns `true` if the singleton PDFium worker successfully bound to a native `libpdfium` binary.
#[must_use]
pub fn has_native_pdfium_worker(custom_dir: Option<&Path>) -> bool {
    get_or_init_worker(custom_dir).is_some()
}

/// Resolves the concrete `libpdfium` path if found in an explicit or bundled directory.
#[must_use]
pub fn resolve_pdfium_library_path(custom_dir: Option<&Path>) -> Option<PathBuf> {
    match get_or_init_worker(custom_dir)?.resolved_source {
        ResolvedPdfiumSource::LibraryFile(path) => Some(path),
        ResolvedPdfiumSource::SystemLibrary => None,
    }
}

fn zeroize_optional_password(mut password: Option<String>) {
    if let Some(ref mut pw) = password {
        pdf_engine::zeroize_string(pw);
    }
}

fn worker_open_document(
    pdfium: &'static Pdfium,
    bytes: Vec<u8>,
    mut password: Option<String>,
    documents: &mut HashMap<u64, PdfiumNativeDocument<'static>>,
    next_doc_id: &mut u64,
) -> Result<OpenedNativeDocument, PdfEngineError> {
    if password
        .as_deref()
        .is_some_and(|pw| pw.as_bytes().contains(&0))
    {
        zeroize_optional_password(password.take());
        return Err(PdfEngineError::IncorrectPassword);
    }
    let effective_pw = password.as_deref().filter(|pw| !pw.is_empty());
    let had_pw = effective_pw.is_some();

    let (form_support, form_field_count, signature_status, signature_field_count) =
        inspect_advanced_pdf_capabilities_bytes(&bytes);
    let header_slice_len = bytes.len().min(1024);
    let header_bytes = bytes[..header_slice_len].to_vec();
    let encrypted_in_bytes = has_encrypt_dict_bytes(&bytes);

    let load_res = pdfium.load_pdf_from_byte_vec(bytes, effective_pw);
    zeroize_optional_password(password.take());

    let doc = load_res.map_err(|err| map_pdfium_error(err, had_pw))?;
    let page_count = u32::from(doc.pages().len());
    if page_count == 0 {
        return Err(PdfEngineError::InvalidPdfFormat(
            "PDF document contains 0 pages".to_owned(),
        ));
    }

    // Read only initial page dimensions eagerly; remaining pages load lazily on demand (`[MED-08]`).
    let mut page_dimensions = vec![None; page_count as usize];
    for (idx, slot) in page_dimensions.iter_mut().take(16).enumerate() {
        let idx_u16 = u16::try_from(idx).map_err(|_| {
            PdfEngineError::InvalidPdfFormat("PDF page count exceeds u16 limit".to_owned())
        })?;
        let page = doc
            .pages()
            .get(idx_u16)
            .map_err(|e| PdfEngineError::InvalidPdfFormat(format!("invalid page {idx}: {e}")))?;
        let dims = PageDimensions::new(page.width().value, page.height().value)
            .map_err(|e| PdfEngineError::InvalidPdfFormat(e.to_string()))?;
        *slot = Some(dims);
    }

    let mut visited = HashSet::new();
    let mut total_count = 0usize;
    let outline = collect_outline_level(doc.bookmarks().root(), 0, &mut visited, &mut total_count);

    let version_str = format_pdfium_version(doc.version(), &header_bytes);
    let is_encrypted = had_pw || encrypted_in_bytes;
    let metadata = DocumentMetadata {
        title: doc
            .metadata()
            .get(PdfDocumentMetadataTagType::Title)
            .and_then(|t| app_domain::sanitize_metadata_title(t.value())),
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
    }
    .sanitized();

    let doc_id = *next_doc_id;
    *next_doc_id = next_doc_id.saturating_add(1);
    documents.insert(doc_id, doc);

    Ok(OpenedNativeDocument {
        doc_id,
        info: EngineDocumentInfo {
            page_count,
            metadata,
        },
        outline,
        page_dimensions,
    })
}

fn worker_page_dimensions(
    documents: &HashMap<u64, PdfiumNativeDocument<'static>>,
    doc_id: u64,
    page_index: PageIndex,
) -> Result<PageDimensions, PdfEngineError> {
    let doc = documents.get(&doc_id).ok_or_else(|| {
        PdfEngineError::Internal("PDFium document handle is no longer open".to_owned())
    })?;
    let page_count = u32::from(doc.pages().len());
    let idx = page_index.zero_based();
    let idx_u16 = u16::try_from(idx).map_err(|_| PdfEngineError::PageOutOfBounds {
        page_index: idx,
        page_count,
    })?;
    let page = doc
        .pages()
        .get(idx_u16)
        .map_err(|_| PdfEngineError::PageOutOfBounds {
            page_index: idx,
            page_count,
        })?;
    PageDimensions::new(page.width().value, page.height().value)
        .map_err(|e| PdfEngineError::InvalidPdfFormat(e.to_string()))
}

fn worker_extract_page_text(
    documents: &HashMap<u64, PdfiumNativeDocument<'static>>,
    doc_id: u64,
    page_index: PageIndex,
) -> Result<String, PdfEngineError> {
    let doc = documents.get(&doc_id).ok_or_else(|| {
        PdfEngineError::Internal("PDFium document handle is no longer open".to_owned())
    })?;
    let page_count = u32::from(doc.pages().len());
    let idx_u16 =
        u16::try_from(page_index.zero_based()).map_err(|_| PdfEngineError::PageOutOfBounds {
            page_index: page_index.zero_based(),
            page_count,
        })?;
    let page = doc
        .pages()
        .get(idx_u16)
        .map_err(|_| PdfEngineError::PageOutOfBounds {
            page_index: page_index.zero_based(),
            page_count,
        })?;
    let text = page
        .text()
        .map_err(|e| PdfEngineError::Internal(format!("text extraction failed: {e}")))?;
    Ok(text.all())
}

/// Converts PDF bottom-left `(left, top, right, bottom)` point coordinates into a top-left
/// normalized [`SearchBoundingBox`] against `(page_width_pt, page_height_pt)`.
#[must_use]
pub(crate) fn normalize_pdf_rect_to_search_box(
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    page_width_pt: f32,
    page_height_pt: f32,
) -> Option<SearchBoundingBox> {
    if !page_width_pt.is_finite()
        || !page_height_pt.is_finite()
        || page_width_pt <= 0.0
        || page_height_pt <= 0.0
        || !left.is_finite()
        || !top.is_finite()
        || !right.is_finite()
        || !bottom.is_finite()
    {
        return None;
    }

    let x_ratio = (left / page_width_pt).clamp(0.0, 1.0);
    let y_ratio = ((page_height_pt - top) / page_height_pt).clamp(0.0, 1.0);
    let width_ratio = ((right - left) / page_width_pt).clamp(0.005, 1.0);
    let height_ratio = ((top - bottom).abs() / page_height_pt).clamp(0.005, 1.0);

    Some(SearchBoundingBox {
        x_ratio,
        y_ratio,
        width_ratio,
        height_ratio,
    })
}

#[must_use]
pub(crate) fn union_search_bounding_boxes(
    boxes: &[SearchBoundingBox],
) -> Option<SearchBoundingBox> {
    let first = *boxes.first()?;
    if boxes.len() == 1 {
        return Some(first);
    }
    let mut min_x = first.x_ratio;
    let mut min_y = first.y_ratio;
    let mut max_x = (first.x_ratio + first.width_ratio).min(1.0);
    let mut max_y = (first.y_ratio + first.height_ratio).min(1.0);

    for b in &boxes[1..] {
        min_x = min_x.min(b.x_ratio);
        min_y = min_y.min(b.y_ratio);
        max_x = max_x.max((b.x_ratio + b.width_ratio).min(1.0));
        max_y = max_y.max((b.y_ratio + b.height_ratio).min(1.0));
    }

    Some(SearchBoundingBox {
        x_ratio: min_x.clamp(0.0, 1.0),
        y_ratio: min_y.clamp(0.0, 1.0),
        width_ratio: (max_x - min_x).clamp(0.005, 1.0),
        height_ratio: (max_y - min_y).clamp(0.005, 1.0),
    })
}

fn worker_search_text(
    documents: &HashMap<u64, PdfiumNativeDocument<'static>>,
    doc_id: u64,
    query: &str,
    case_sensitive: bool,
    max_hits: usize,
    cancel_check: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> Result<Vec<SearchHit>, PdfEngineError> {
    let doc = documents.get(&doc_id).ok_or_else(|| {
        PdfEngineError::Internal("PDFium document handle is no longer open".to_owned())
    })?;
    let page_count = u32::from(doc.pages().len());
    let search_opts = PdfSearchOptions::new().match_case(case_sensitive);

    let mut hits = Vec::new();
    for idx in 0..page_count {
        if cancel_check.is_some_and(|f| f()) {
            return Err(PdfEngineError::Cancelled);
        }
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

        let page_w = page.width().value;
        let page_h = page.height().value;
        let page_text = text_obj.all();
        let page_idx = PageIndex::new(idx);
        let mut page_hits =
            search_page_text_hits(&page_text, page_idx, query, case_sensitive, remaining);

        if let Ok(search) = text_obj.search(query, &search_opts) {
            if !page_hits.is_empty() {
                for (hit, segments) in page_hits
                    .iter_mut()
                    .zip(search.iter(PdfSearchDirection::SearchForward))
                {
                    let mut boxes = Vec::new();
                    for seg in segments.iter() {
                        let rect = seg.bounds();
                        if let Some(norm) = normalize_pdf_rect_to_search_box(
                            rect.left().value,
                            rect.top().value,
                            rect.right().value,
                            rect.bottom().value,
                            page_w,
                            page_h,
                        ) {
                            boxes.push(norm);
                        }
                    }
                    hit.bounding_box = union_search_bounding_boxes(&boxes);
                    hit.bounding_boxes = boxes;
                }
            } else {
                for (match_idx, segments) in search
                    .iter(PdfSearchDirection::SearchForward)
                    .take(remaining)
                    .enumerate()
                {
                    let mut boxes = Vec::new();
                    let mut seg_texts = Vec::new();
                    for seg in segments.iter() {
                        let rect = seg.bounds();
                        if let Some(norm) = normalize_pdf_rect_to_search_box(
                            rect.left().value,
                            rect.top().value,
                            rect.right().value,
                            rect.bottom().value,
                            page_w,
                            page_h,
                        ) {
                            boxes.push(norm);
                        }
                        let t = seg.text();
                        if !t.trim().is_empty() {
                            seg_texts.push(t.trim().to_owned());
                        }
                    }
                    let snippet = if seg_texts.is_empty() {
                        query.to_owned()
                    } else {
                        seg_texts.join(" ")
                    };
                    hits.push(SearchHit {
                        page_index: page_idx,
                        match_index: u32::try_from(match_idx).unwrap_or(0),
                        snippet,
                        match_text: Some(query.to_owned()),
                        bounding_box: union_search_bounding_boxes(&boxes),
                        bounding_boxes: boxes,
                    });
                }
            }
        }

        hits.append(&mut page_hits);
        if hits.len() >= max_hits {
            break;
        }
    }

    Ok(hits)
}

fn worker_render_page(
    documents: &HashMap<u64, PdfiumNativeDocument<'static>>,
    doc_id: u64,
    request: &RenderPageRequest,
    cancel_check: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> Result<RawRenderedBitmap, PdfEngineError> {
    if cancel_check.is_some_and(|f| f()) {
        return Err(PdfEngineError::Cancelled);
    }
    let doc = documents.get(&doc_id).ok_or_else(|| {
        PdfEngineError::Internal("PDFium document handle is no longer open".to_owned())
    })?;
    let page_count = u32::from(doc.pages().len());
    let idx_u16 = u16::try_from(request.page_index.zero_based()).map_err(|_| {
        PdfEngineError::PageOutOfBounds {
            page_index: request.page_index.zero_based(),
            page_count,
        }
    })?;
    let page = doc
        .pages()
        .get(idx_u16)
        .map_err(|_| PdfEngineError::PageOutOfBounds {
            page_index: request.page_index.zero_based(),
            page_count,
        })?;

    if cancel_check.is_some_and(|f| f()) {
        return Err(PdfEngineError::Cancelled);
    }

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

    if cancel_check.is_some_and(|f| f()) {
        return Err(PdfEngineError::Cancelled);
    }

    let actual_w = u32::try_from(bitmap.width())
        .map_err(|_| PdfEngineError::Internal("negative PDFium bitmap width".to_owned()))?;
    let actual_h = u32::try_from(bitmap.height())
        .map_err(|_| PdfEngineError::Internal("negative PDFium bitmap height".to_owned()))?;
    if actual_w < 1 || actual_h < 1 {
        return Err(PdfEngineError::Internal(format!(
            "PDFium returned zero-dimension bitmap ({actual_w}x{actual_h})"
        )));
    }

    let rgba = bitmap.as_rgba_bytes();
    Ok(RawRenderedBitmap {
        width_px: actual_w,
        height_px: actual_h,
        rgba,
    })
}

/// Computes target `(width_px, height_px)` from PDFium's `page.width()` / `page.height()`,
/// clamping proportionally when HiDPI scales exceed `max_pixel_dimension`.
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
    dimensions
        .clamped_target_pixel_size(scale, user_rotation, max_pixel_dimension)
        .map_err(|err| PdfEngineError::Internal(err.to_string()))
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

/// PDFium-backed document handle communicating with the singleton PDFium worker thread.
///
/// Automatically `Send + Sync` without re-binding `libpdfium` or re-parsing PDF bytes per operation.
pub struct DynamicPdfiumDocument {
    doc_handle_id: u64,
    info: EngineDocumentInfo,
    outline: Vec<OutlineNode>,
    page_dimensions: RwLock<Vec<Option<PageDimensions>>>,
    worker: PdfiumWorkerHandle,
}

impl Drop for DynamicPdfiumDocument {
    fn drop(&mut self) {
        if let Ok(mut queue) = self.worker.pending_closes.lock() {
            queue.push(self.doc_handle_id);
        }
        // Shutdown-safe and lossless: if the bounded channel is full or the worker thread has
        // exited during process teardown, `pending_closes` retains `doc_handle_id` for cleanup.
        let _ = self.worker.cmd_tx.try_send(WorkerCommand::Close {
            doc_id: self.doc_handle_id,
        });
    }
}

impl DynamicPdfiumDocument {
    /// Opens and validates a PDF byte buffer once on the dedicated PDFium worker thread.
    pub fn open(
        bytes: Bytes,
        options: &OpenDocumentOptions,
        library_dir: Option<PathBuf>,
    ) -> Result<Self, PdfEngineError> {
        if options
            .password
            .as_deref()
            .is_some_and(|pw| pw.as_bytes().contains(&0))
        {
            return Err(PdfEngineError::IncorrectPassword);
        }

        let max_size = options.effective_max_file_size();
        if (bytes.len() as u64) > max_size {
            return Err(PdfEngineError::FileTooLarge {
                size_bytes: bytes.len() as u64,
                max_bytes: max_size,
            });
        }

        let worker = get_or_init_worker(library_dir.as_deref()).ok_or_else(|| {
            PdfEngineError::EngineUnavailable("native PDFium library not found".to_owned())
        })?;

        let (reply_tx, reply_rx) = sync_channel(1);
        worker
            .cmd_tx
            .send(WorkerCommand::Open {
                bytes: Vec::from(bytes),
                password: ZeroizingPassword(options.password.clone()),
                reply: reply_tx,
            })
            .map_err(|_| {
                PdfEngineError::EngineUnavailable("PDFium worker thread terminated".to_owned())
            })?;

        let opened = reply_rx.recv().map_err(|_| {
            PdfEngineError::Internal("PDFium worker dropped open response".to_owned())
        })??;

        Ok(Self {
            doc_handle_id: opened.doc_id,
            info: opened.info,
            outline: opened.outline,
            page_dimensions: RwLock::new(opened.page_dimensions),
            worker,
        })
    }

    fn render_page_impl(
        &self,
        request: &RenderPageRequest,
        cancel_check: Option<CancelPredicate>,
    ) -> Result<RenderedPage, PdfEngineError> {
        let idx = request.page_index.zero_based();
        if idx >= self.info.page_count {
            return Err(PdfEngineError::PageOutOfBounds {
                page_index: idx,
                page_count: self.info.page_count,
            });
        }
        if cancel_check.as_ref().is_some_and(|f| f()) {
            return Err(PdfEngineError::Cancelled);
        }

        let (reply_tx, reply_rx) = sync_channel(1);
        self.worker
            .cmd_tx
            .send(WorkerCommand::RenderPage {
                doc_id: self.doc_handle_id,
                request: request.clone(),
                cancel_check: cancel_check.clone(),
                reply: reply_tx,
            })
            .map_err(|_| {
                PdfEngineError::Internal("PDFium worker channel disconnected".to_owned())
            })?;

        let mut rendered = reply_rx.recv().map_err(|_| {
            PdfEngineError::Internal("PDFium worker dropped render response".to_owned())
        })??;

        if cancel_check.as_ref().is_some_and(|f| f()) {
            return Err(PdfEngineError::Cancelled);
        }

        apply_render_mode_rgba(&mut rendered.rgba, request.render_mode);

        if cancel_check.as_ref().is_some_and(|f| f()) {
            return Err(PdfEngineError::Cancelled);
        }

        let png_bytes = encode_rgba_to_png(rendered.width_px, rendered.height_px, &rendered.rgba)?;

        Ok(RenderedPage {
            page_index: request.page_index,
            width_px: rendered.width_px,
            height_px: rendered.height_px,
            png_bytes,
        })
    }
}

impl EnginePdfDocument for DynamicPdfiumDocument {
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

        if let Ok(guard) = self.page_dimensions.read()
            && let Some(Some(dimensions)) = guard.get(idx as usize).copied()
        {
            return Ok(PageGeometry {
                page_index,
                dimensions,
                intrinsic_rotation: Rotation::Deg0,
            });
        }

        let (reply_tx, reply_rx) = sync_channel(1);
        self.worker
            .cmd_tx
            .send(WorkerCommand::PageDimensions {
                doc_id: self.doc_handle_id,
                page_index,
                reply: reply_tx,
            })
            .map_err(|_| {
                PdfEngineError::Internal("PDFium worker channel disconnected".to_owned())
            })?;

        let dimensions = reply_rx.recv().map_err(|_| {
            PdfEngineError::Internal("PDFium worker dropped page dimensions response".to_owned())
        })??;

        if let Ok(mut guard) = self.page_dimensions.write()
            && let Some(slot) = guard.get_mut(idx as usize)
        {
            *slot = Some(dimensions);
        }

        // `page.width()` and `page.height()` in PDFium already incorporate any page `/Rotate`,
        // so `intrinsic_rotation` is reported as `Rotation::Deg0` relative to `dimensions`.
        Ok(PageGeometry {
            page_index,
            dimensions,
            intrinsic_rotation: Rotation::Deg0,
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

        let (reply_tx, reply_rx) = sync_channel(1);
        self.worker
            .cmd_tx
            .send(WorkerCommand::ExtractPageText {
                doc_id: self.doc_handle_id,
                page_index,
                reply: reply_tx,
            })
            .map_err(|_| {
                PdfEngineError::Internal("PDFium worker channel disconnected".to_owned())
            })?;

        reply_rx.recv().map_err(|_| {
            PdfEngineError::Internal("PDFium worker dropped text extraction response".to_owned())
        })?
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

        let (reply_tx, reply_rx) = sync_channel(1);
        self.worker
            .cmd_tx
            .send(WorkerCommand::SearchText {
                doc_id: self.doc_handle_id,
                query: trimmed.to_owned(),
                case_sensitive,
                max_hits,
                cancel_check: None,
                reply: reply_tx,
            })
            .map_err(|_| {
                PdfEngineError::Internal("PDFium worker channel disconnected".to_owned())
            })?;

        reply_rx.recv().map_err(|_| {
            PdfEngineError::Internal("PDFium worker dropped search response".to_owned())
        })?
    }

    fn render_page(&self, request: &RenderPageRequest) -> Result<RenderedPage, PdfEngineError> {
        self.render_page_impl(request, None)
    }

    fn render_page_cancellable(
        &self,
        request: &RenderPageRequest,
        is_cancelled: CancelPredicate,
    ) -> Result<RenderedPage, PdfEngineError> {
        self.render_page_impl(request, Some(is_cancelled))
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
    fn pdfium_rotation_geometry_clamping_search_boxes_and_bundle_probe_order() {
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

        // ISO A4 (595 x 842 pt) at HiDPI scales 5.0 and 10.0 clamps proportionally <= 4096 px
        for scale in [5.0_f32, 10.0_f32] {
            let (w, h) =
                compute_pdfium_target_pixel_size(595.0, 842.0, scale, Rotation::Deg0, 4096)
                    .unwrap();
            assert_eq!(h, 4096);
            assert_eq!(w, 2894);
        }

        // macOS bundle probe checks ../Frameworks BEFORE ../Resources
        let macos_bin_dir = std::env::temp_dir()
            .join("Readora.app")
            .join("Contents")
            .join("MacOS");
        let dirs = candidate_bundle_library_dirs(&macos_bin_dir);
        let fw_idx = dirs
            .iter()
            .position(|p| p.file_name().and_then(|n| n.to_str()) == Some("Frameworks"))
            .unwrap();
        let res_idx = dirs
            .iter()
            .position(|p| p.file_name().and_then(|n| n.to_str()) == Some("Resources"))
            .unwrap();
        assert!(fw_idx < res_idx);

        // PDF bottom-left coordinates convert cleanly to top-left normalized SearchBoundingBox
        let b1 = normalize_pdf_rect_to_search_box(60.0, 720.0, 180.0, 700.0, 600.0, 800.0).unwrap();
        assert!((b1.x_ratio - 0.1).abs() < 1e-5);
        assert!((b1.y_ratio - 0.1).abs() < 1e-5);
        assert!((b1.width_ratio - 0.2).abs() < 1e-5);
        assert!((b1.height_ratio - 0.025).abs() < 1e-5);

        let b2 = normalize_pdf_rect_to_search_box(60.0, 695.0, 240.0, 675.0, 600.0, 800.0).unwrap();
        let merged = union_search_bounding_boxes(&[b1, b2]).unwrap();
        assert!((merged.x_ratio - 0.1).abs() < 1e-5);
        assert!((merged.y_ratio - 0.1).abs() < 1e-5);
        assert!((merged.width_ratio - 0.3).abs() < 1e-5);

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
