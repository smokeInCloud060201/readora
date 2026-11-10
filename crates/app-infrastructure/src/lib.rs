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

/// Thread-safe generation registry used to cancel obsolete page render requests.
#[derive(Default)]
pub struct GenerationCancellationRegistry {
    generations: Mutex<HashMap<DocumentId, u64>>,
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
        let Ok(mut guard) = self.generations.lock() else {
            return 0;
        };
        let counter = guard.entry(document_id.clone()).or_insert(0);
        *counter = counter.saturating_add(1);
        *counter
    }

    fn current_generation(&self, document_id: &DocumentId) -> u64 {
        let Ok(guard) = self.generations.lock() else {
            return 0;
        };
        *guard.get(document_id).unwrap_or(&0)
    }

    fn is_current(&self, document_id: &DocumentId, generation: u64) -> bool {
        self.current_generation(document_id) == generation
    }

    fn clear_document(&self, document_id: &DocumentId) {
        if let Ok(mut guard) = self.generations.lock() {
            guard.remove(document_id);
        }
    }
}

/// Encodes raw PNG bytes into a `data:image/png;base64,...` URL suitable for `<img src>` display.
#[must_use]
pub fn encode_png_data_url(png_bytes: &[u8]) -> String {
    let encoded = BASE64_STANDARD.encode(png_bytes);
    let mut url = String::with_capacity(22 + encoded.len());
    url.push_str("data:image/png;base64,");
    url.push_str(&encoded);
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
}
