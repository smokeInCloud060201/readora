//! Reproducible latency and memory budget benchmarks for core reader workloads:
//! large-document open, cold page render, warm LRU cache hit, page navigation, and text search.

use std::time::Instant;

use app_application::{NavigationAction, OpenDocumentRequest, RenderPageCommand, SearchRequestDto};
use app_core::AppCore;
use app_domain::RenderMode;
use pdfium_adapter::build_synthetic_pdf_bytes;

fn run_bench<F: FnMut()>(name: &str, iterations: u32, mut f: F) {
    let start = Instant::now();
    for _ in 0..iterations {
        f();
    }
    let elapsed = start.elapsed();
    let avg_us = elapsed.as_micros() / u128::from(iterations.max(1));
    println!(
        "bench {name:<42} | {iterations:>4} iters | total {:>8.2?} | avg {avg_us:>6} us/op",
        elapsed
    );
}

fn main() {
    let Ok(core) = AppCore::new_in_memory() else {
        eprintln!("failed to initialize in-memory AppCore for benchmarks");
        std::process::exit(1);
    };

    let Ok(temp_dir) = tempfile::tempdir() else {
        eprintln!("failed to allocate temp directory for benchmarks");
        std::process::exit(1);
    };

    let page_strings: Vec<String> = (0..120)
        .map(|idx| {
            format!(
                "Chapter {} — Deterministic hexagonal PDF architecture, LRU memory budget, and full-document search target_keyword_{idx}.",
                idx + 1
            )
        })
        .collect();
    let page_refs: Vec<&str> = page_strings.iter().map(String::as_str).collect();
    let pdf_bytes = build_synthetic_pdf_bytes("Large Workload Benchmark", &page_refs, None);
    let pdf_path = temp_dir.path().join("large_workload_120p.pdf");
    if std::fs::write(&pdf_path, &pdf_bytes).is_err() {
        std::process::exit(1);
    }
    let pdf_path_str = pdf_path.to_string_lossy().into_owned();

    let mut doc_id = String::new();
    run_bench("open_document_120_pages", 25, || {
        if let Ok(session) = core.open_document(OpenDocumentRequest {
            path: pdf_path_str.clone(),
            password: None,
        }) {
            doc_id = session.descriptor.id.as_str().to_owned();
        }
    });

    let mut page_cursor = 0u32;
    run_bench("render_page_cold_1x", 20, || {
        let _ = core.render_page(RenderPageCommand {
            document_id: doc_id.clone(),
            page_index: page_cursor % 120,
            scale: 1.0,
            rotation_degrees: 0,
            render_mode: RenderMode::Standard,
            generation: None,
        });
        page_cursor = page_cursor.wrapping_add(1);
    });

    run_bench("render_page_warm_lru_hit", 200, || {
        let _ = core.render_page(RenderPageCommand {
            document_id: doc_id.clone(),
            page_index: 0,
            scale: 1.0,
            rotation_degrees: 0,
            render_mode: RenderMode::Standard,
            generation: None,
        });
    });

    run_bench("navigate_next_page", 100, || {
        let _ = core.navigate(&doc_id, NavigationAction::NextPage);
    });

    run_bench("search_120_pages_full_scan", 50, || {
        let _ = core.search_document(SearchRequestDto {
            document_id: doc_id.clone(),
            query: "target_keyword_119".to_owned(),
            case_sensitive: false,
            max_hits: 25,
        });
    });

    if let Ok(diag) = core.system_diagnostics() {
        println!(
            "render_cache_usage_bytes after workload: {} bytes (engine: {})",
            diag.render_cache_usage_bytes, diag.pdf_engine_kind
        );
    }
}
