//! Shared infrastructure implementations: byte-bounded LRU render cache,
//! per-document render cancellation registry, and PNG data-URL encoding.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use app_application::{CachedPageEntry, RenderCacheKey, RenderCachePort, RenderCancellationPort};
use app_domain::{DEFAULT_CACHE_BUDGET_BYTES, DocumentId};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

struct LruCacheInner {
    entries: HashMap<RenderCacheKey, CachedPageEntry>,
    order: VecDeque<RenderCacheKey>,
    current_bytes: usize,
    budget_bytes: usize,
}

impl LruCacheInner {
    fn new(budget_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            current_bytes: 0,
            budget_bytes: budget_bytes.max(1024),
        }
    }

    fn touch(&mut self, key: &RenderCacheKey) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.clone());
    }

    fn evict_to_fit(&mut self, incoming_bytes: usize) {
        while !self.order.is_empty()
            && self.current_bytes.saturating_add(incoming_bytes) > self.budget_bytes
        {
            if let Some(oldest_key) = self.order.pop_front() {
                if let Some(removed) = self.entries.remove(&oldest_key) {
                    self.current_bytes = self.current_bytes.saturating_sub(removed.byte_size);
                }
            }
        }
    }
}

/// Thread-safe, byte-bounded LRU cache for rendered PDF pages.
pub struct MemoryRenderCache {
    inner: Mutex<LruCacheInner>,
}

impl MemoryRenderCache {
    /// Creates a new `MemoryRenderCache` with the given byte budget.
    #[must_use]
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(LruCacheInner::new(budget_bytes)),
        }
    }

    /// Returns the number of cached page entries currently stored.
    #[must_use]
    pub fn entry_count(&self) -> usize {
        self.inner.lock().map(|g| g.entries.len()).unwrap_or(0)
    }
}

impl Default for MemoryRenderCache {
    fn default() -> Self {
        Self::new(DEFAULT_CACHE_BUDGET_BYTES)
    }
}

impl RenderCachePort for MemoryRenderCache {
    fn get(&self, key: &RenderCacheKey) -> Option<CachedPageEntry> {
        let mut guard = self.inner.lock().ok()?;
        let entry = guard.entries.get(key).cloned()?;
        guard.touch(key);
        Some(entry)
    }

    fn put(&self, key: RenderCacheKey, entry: CachedPageEntry) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };

        // Do not cache a single entry larger than the entire cache budget.
        if entry.byte_size > guard.budget_bytes {
            return;
        }

        if let Some(existing) = guard.entries.remove(&key) {
            guard.current_bytes = guard.current_bytes.saturating_sub(existing.byte_size);
            if let Some(pos) = guard.order.iter().position(|k| k == &key) {
                guard.order.remove(pos);
            }
        }

        guard.evict_to_fit(entry.byte_size);
        guard.current_bytes = guard.current_bytes.saturating_add(entry.byte_size);
        guard.order.push_back(key.clone());
        guard.entries.insert(key, entry);
    }

    fn invalidate_document(&self, document_id: &DocumentId) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        let keys_to_remove: Vec<RenderCacheKey> = guard
            .entries
            .keys()
            .filter(|k| &k.document_id == document_id)
            .cloned()
            .collect();

        for key in keys_to_remove {
            if let Some(removed) = guard.entries.remove(&key) {
                guard.current_bytes = guard.current_bytes.saturating_sub(removed.byte_size);
            }
        }
        guard.order.retain(|k| &k.document_id != document_id);
    }

    fn set_budget_bytes(&self, budget_bytes: usize) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        guard.budget_bytes = budget_bytes.max(1024);
        guard.evict_to_fit(0);
    }

    fn current_usage_bytes(&self) -> usize {
        self.inner.lock().map(|g| g.current_bytes).unwrap_or(0)
    }
}

/// Maximum number of distinct document IDs retained in [`GenerationCancellationRegistry`].
pub const MAX_TRACKED_GENERATION_DOCUMENTS: usize = 4_096;

#[derive(Default)]
struct GenerationRegistryInner {
    generations: HashMap<DocumentId, u64>,
    order: VecDeque<DocumentId>,
    next_id: u64,
}

impl GenerationRegistryInner {
    fn advance(&mut self, document_id: &DocumentId) -> u64 {
        self.next_id = self.next_id.saturating_add(1);
        let assigned = self.next_id;

        if let Some(counter) = self.generations.get_mut(document_id) {
            *counter = assigned;
            if let Some(pos) = self.order.iter().position(|id| id == document_id) {
                self.order.remove(pos);
            }
            self.order.push_back(document_id.clone());
            return assigned;
        }

        while self.generations.len() >= MAX_TRACKED_GENERATION_DOCUMENTS {
            if let Some(oldest) = self.order.pop_front() {
                self.generations.remove(&oldest);
            } else {
                break;
            }
        }

        self.order.push_back(document_id.clone());
        self.generations.insert(document_id.clone(), assigned);
        assigned
    }
}

/// Thread-safe generation registry used to cancel obsolete page render requests.
#[derive(Default)]
pub struct GenerationCancellationRegistry {
    inner: Mutex<GenerationRegistryInner>,
}

impl GenerationCancellationRegistry {
    /// Creates a new `GenerationCancellationRegistry`.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl RenderCancellationPort for GenerationCancellationRegistry {
    fn next_generation(&self, document_id: &DocumentId) -> u64 {
        let Ok(mut guard) = self.inner.lock() else {
            return 0;
        };
        guard.advance(document_id)
    }

    fn current_generation(&self, document_id: &DocumentId) -> u64 {
        let Ok(guard) = self.inner.lock() else {
            return 0;
        };
        *guard.generations.get(document_id).unwrap_or(&0)
    }

    fn is_current(&self, document_id: &DocumentId, generation: u64) -> bool {
        self.current_generation(document_id) == generation
    }

    fn clear_document(&self, document_id: &DocumentId) {
        // Advance rather than removing `document_id` (`MED-04`) so any in-flight `gen=0`
        // render started before close sees a newer generation and cannot poison the cache.
        if let Ok(mut guard) = self.inner.lock() {
            let _ = guard.advance(document_id);
        }
    }
}

/// Encodes raw PNG bytes into a `data:image/png;base64,...` URL suitable for `<img src>` display.
#[must_use]
pub fn encode_png_data_url(png_bytes: &[u8]) -> String {
    const PREFIX: &str = "data:image/png;base64,";
    let b64_len = png_bytes.len().div_ceil(3).saturating_mul(4);
    let mut url = String::with_capacity(PREFIX.len() + b64_len);
    url.push_str(PREFIX);
    BASE64_STANDARD.encode_string(png_bytes, &mut url);
    url
}

#[cfg(test)]
mod tests {
    use app_domain::{PageIndex, RenderMode, Rotation, ScaleBucket};

    use super::*;

    fn make_key(doc: &str, page: u32) -> RenderCacheKey {
        RenderCacheKey {
            document_id: DocumentId::new(doc).unwrap(),
            page_index: PageIndex::new(page),
            scale_bucket: ScaleBucket::from_scale(1.0),
            rotation: Rotation::Deg0,
            render_mode: RenderMode::Standard,
        }
    }

    #[test]
    fn lru_cache_evicts_least_recently_used_when_budget_exceeded() {
        let cache = MemoryRenderCache::new(2500);

        cache.put(
            make_key("doc-1", 0),
            CachedPageEntry {
                width_px: 100,
                height_px: 100,
                data_url: "page0".to_owned(),
                byte_size: 1000,
            },
        );
        cache.put(
            make_key("doc-1", 1),
            CachedPageEntry {
                width_px: 100,
                height_px: 100,
                data_url: "page1".to_owned(),
                byte_size: 1000,
            },
        );

        // Touch page 0 so page 1 becomes least-recently-used.
        assert!(cache.get(&make_key("doc-1", 0)).is_some());

        // Inserting page 2 (1000 bytes) requires evicting page 1 to stay <= 2500 bytes.
        cache.put(
            make_key("doc-1", 2),
            CachedPageEntry {
                width_px: 100,
                height_px: 100,
                data_url: "page2".to_owned(),
                byte_size: 1000,
            },
        );

        assert!(cache.get(&make_key("doc-1", 0)).is_some());
        assert!(cache.get(&make_key("doc-1", 1)).is_none());
        assert!(cache.get(&make_key("doc-1", 2)).is_some());
        assert_eq!(cache.current_usage_bytes(), 2000);

        cache.invalidate_document(&DocumentId::new("doc-1").unwrap());
        assert_eq!(cache.current_usage_bytes(), 0);
    }

    #[test]
    fn cancellation_registry_advances_on_clear_and_bounds_entries() {
        let registry = GenerationCancellationRegistry::new();
        let doc = DocumentId::new("doc-close-race").unwrap();

        assert_eq!(registry.current_generation(&doc), 0);
        assert!(registry.is_current(&doc, 0));

        // Closing a document at gen=0 advances generation so stale gen=0 renders are rejected
        registry.clear_document(&doc);
        assert!(!registry.is_current(&doc, 0));
        assert_eq!(registry.current_generation(&doc), 1);

        for idx in 0..(MAX_TRACKED_GENERATION_DOCUMENTS + 64) {
            let d = DocumentId::new(format!("doc-cap-{idx}")).unwrap();
            let _ = registry.next_generation(&d);
        }
        {
            let guard = registry.inner.lock().unwrap();
            assert_eq!(guard.generations.len(), MAX_TRACKED_GENERATION_DOCUMENTS);
        }
        // Evicted key must never reset back to 1 when advanced again
        let re_opened_gen = registry.next_generation(&doc);
        assert!(re_opened_gen > MAX_TRACKED_GENERATION_DOCUMENTS as u64);
    }
}
