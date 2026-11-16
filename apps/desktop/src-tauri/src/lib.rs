//! Desktop composition root, authenticated RPC server, and typed IPC command handlers for Readora.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub mod commands;
pub mod server;

pub use commands::{CommandErrorDto, DesktopCommandHandler};

/// Initializes structured tracing without logging sensitive document contents or paths.
pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .try_init();
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use app_application::{
        NavigationAction, ReleaseManifestDto, RenderPageCommand, UpsertAnnotationCommand,
        UpsertBookmarkCommand,
    };
    use app_domain::{AnnotationKind, RenderMode};
    use pdfium_adapter::build_synthetic_pdf_bytes;
    use serde_json::json;

    use super::server::{
        CONTENT_SECURITY_POLICY, constant_time_eq, generate_session_token,
        read_and_authorize_http_request, route_http_request,
    };
    use super::*;

    #[test]
    fn desktop_command_handler_executes_full_ipc_contract() {
        let handler = DesktopCommandHandler::try_new_in_memory().unwrap();

        let session = handler.document_open_sample().unwrap();
        let doc_id = session.descriptor.id.as_str().to_owned();
        assert_eq!(session.descriptor.page_count, 5);
        assert_eq!(
            serde_json::to_value(session.view_state.rotation).unwrap(),
            json!("deg0")
        );

        let rendered = handler
            .page_render(RenderPageCommand {
                document_id: doc_id.clone(),
                page_index: 0,
                scale: 1.0,
                rotation_degrees: 0,
                render_mode: RenderMode::Standard,
                generation: None,
            })
            .unwrap();
        assert!(rendered.data_url.starts_with("data:image/png;base64,"));

        let nav_state = handler
            .document_navigate(&doc_id, NavigationAction::NextPage)
            .unwrap();
        assert_eq!(nav_state.current_page.zero_based(), 1);

        let rotated = handler
            .document_navigate(&doc_id, NavigationAction::RotateClockwise)
            .unwrap();
        assert_eq!(
            serde_json::to_value(rotated.rotation).unwrap(),
            json!("deg90")
        );

        let bm = handler
            .bookmark_upsert(UpsertBookmarkCommand {
                document_id: doc_id.clone(),
                page_index: 1,
                label: "Architecture Overview".to_owned(),
            })
            .unwrap();
        assert_eq!(handler.bookmark_list(&doc_id).unwrap().len(), 1);
        assert!(handler.bookmark_delete(bm.id.as_str()).unwrap());

        let ann = handler
            .annotation_upsert(UpsertAnnotationCommand {
                document_id: doc_id.clone(),
                page_index: 1,
                kind: AnnotationKind::Highlight,
                color_hex: "#a9d5b2".to_owned(),
                quote_text: "Hexagonal Architecture".to_owned(),
                note_text: "Key architecture pattern".to_owned(),
            })
            .unwrap();
        assert_eq!(handler.annotation_list(&doc_id).unwrap().len(), 1);

        let exported = handler.annotation_export(&doc_id, true, None).unwrap();
        assert_eq!(exported.annotation_count, 1);
        assert!(exported.markdown_content.contains("Hexagonal Architecture"));

        assert!(handler.annotation_delete(ann.id.as_str()).unwrap());

        let recents = handler.recent_documents_list(10).unwrap();
        assert_eq!(recents.len(), 1);

        let fav = handler
            .recent_document_set_favorite(&doc_id, true)
            .unwrap()
            .unwrap();
        assert!(fav.is_favorite);

        let arch = handler
            .recent_document_set_archived(&doc_id, true)
            .unwrap()
            .unwrap();
        assert!(arch.is_archived);

        let diag = handler.system_diagnostics().unwrap();
        assert_eq!(diag.sqlite_schema_version, 3);
        assert!(!diag.third_party_notices.is_empty());

        let staged = handler
            .app_stage_update_manifest(ReleaseManifestDto {
                version: "1.1.0".to_owned(),
                title: "Focus Reader 1.1 is ready".to_owned(),
                notes: "A faster reader, improved annotations, and accessibility updates are ready to install.".to_owned(),
                package_size_bytes: 44_040_192,
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
                published_at: "2026-11-10T00:00:00Z".to_owned(),
                download_url: Some("https://github.com/smokeInCloud060201/readora/releases/tag/v1.1.0".to_owned()),
            })
            .unwrap();
        assert!(staged.update_available);
        assert_eq!(staged.latest_version.as_deref(), Some("1.1.0"));

        let dismissed = handler.app_dismiss_update("1.1.0").unwrap();
        assert!(!dismissed.update_available);
        let manual_check = handler.app_check_for_updates(true).unwrap();
        assert!(manual_check.update_available);

        let installed = handler.app_install_update("1.1.0").unwrap();
        assert!(!installed.update_available);
        assert!(installed.staged_for_restart);
        assert_eq!(installed.current_version, "1.1.0");
        assert_eq!(handler.system_diagnostics().unwrap().app_version, "1.1.0");

        handler.document_close(&doc_id).unwrap();
    }

    #[test]
    fn loopback_server_blocks_csrf_dns_rebinding_and_unauthenticated_requests() {
        let port = 52419_u16;
        let token = generate_session_token();
        assert_eq!(token.len(), 64);
        assert!(constant_time_eq(&token, &token));
        assert!(!constant_time_eq(&token, "wrong"));

        // 1. Drive-by GET /__readora_update from an external webpage -> rejected (405)
        let drive_by_get = format!(
            "GET /__readora_update?version=9.9.9&repo=attacker/evil HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
        );
        let mut cursor = Cursor::new(drive_by_get.into_bytes());
        let err = read_and_authorize_http_request(&mut cursor, port, &token).unwrap_err();
        assert_eq!(err.status, "405 Method Not Allowed");

        // 2. DNS rebinding attack with forged Host header -> rejected (403)
        let rebind_req = "GET /index.html HTTP/1.1\r\nHost: rebind.attacker.example\r\n\r\n";
        let mut cursor = Cursor::new(rebind_req.as_bytes());
        let err = read_and_authorize_http_request(&mut cursor, port, &token).unwrap_err();
        assert_eq!(err.status, "403 Forbidden");

        // 3. Cross-origin POST without matching Origin or session token -> rejected (403)
        let cross_origin_post = format!(
            "POST /__readora_rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        let mut cursor = Cursor::new(cross_origin_post.into_bytes());
        let err = read_and_authorize_http_request(&mut cursor, port, &token).unwrap_err();
        assert_eq!(err.status, "403 Forbidden");

        // 4. Same-origin POST with missing/invalid X-Readora-Token -> rejected (403)
        let wrong_token_post = format!(
            "POST /__readora_rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nX-Readora-Token: invalid\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        let mut cursor = Cursor::new(wrong_token_post.into_bytes());
        let err = read_and_authorize_http_request(&mut cursor, port, &token).unwrap_err();
        assert_eq!(err.status, "403 Forbidden");
    }

    #[test]
    fn loopback_server_executes_authenticated_rpc_import_and_attaches_csp() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("index.html"),
            b"<!doctype html><title>Readora</title>",
        )
        .unwrap();
        let handler = DesktopCommandHandler::try_new_in_memory().unwrap();
        let port = 52420_u16;
        let token = generate_session_token();

        // Static index.html includes CSP
        let get_html = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        let mut cursor = Cursor::new(get_html.into_bytes());
        let parsed = read_and_authorize_http_request(&mut cursor, port, &token)
            .unwrap()
            .unwrap();
        let resp = route_http_request(parsed, dir.path(), &handler, |_, _| r#"{"status":"noop"}"#);
        assert_eq!(resp.status, "200 OK");
        assert!(resp.include_csp);
        let mut wire = Vec::new();
        resp.write_to(&mut wire);
        let wire_str = String::from_utf8_lossy(&wire);
        assert!(wire_str.contains(CONTENT_SECURITY_POLICY));

        // Authenticated PDF import + RPC roundtrip through SQLite AppCore
        let pdf_bytes = build_synthetic_pdf_bytes(
            "Imported Study",
            &["Page 1 content", "Page 2 content"],
            None,
        );
        let import_header = format!(
            "POST /__readora_import HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Origin: http://127.0.0.1:{port}\r\n\
             Sec-Fetch-Site: same-origin\r\n\
             X-Readora-Token: {token}\r\n\
             X-Readora-Filename: Imported%20Study.pdf\r\n\
             Content-Length: {}\r\n\r\n",
            pdf_bytes.len()
        );
        let mut raw_import = import_header.into_bytes();
        raw_import.extend_from_slice(&pdf_bytes);
        let mut cursor = Cursor::new(raw_import);
        let parsed_import = read_and_authorize_http_request(&mut cursor, port, &token)
            .unwrap()
            .unwrap();
        let import_resp = route_http_request(
            parsed_import,
            dir.path(),
            &handler,
            |_, _| r#"{"status":"noop"}"#,
        );
        assert_eq!(import_resp.status, "200 OK");
        let import_json: serde_json::Value = serde_json::from_slice(&import_resp.body).unwrap();
        assert_eq!(import_json["ok"], json!(true));
        assert_eq!(
            import_json["data"]["descriptor"]["file_name"],
            json!("Imported Study.pdf")
        );
        let doc_id = import_json["data"]["descriptor"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Authenticated RPC recent_documents_list reflects imported document in SQLite
        let rpc_body = serde_json::to_vec(&json!({
            "cmd": "recent_documents_list",
            "args": { "limit": 10 }
        }))
        .unwrap();
        let rpc_req = format!(
            "POST /__readora_rpc HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Origin: http://127.0.0.1:{port}\r\n\
             X-Readora-Token: {token}\r\n\
             Content-Length: {}\r\n\r\n",
            rpc_body.len()
        );
        let mut raw_rpc = rpc_req.into_bytes();
        raw_rpc.extend_from_slice(&rpc_body);
        let mut cursor = Cursor::new(raw_rpc);
        let parsed_rpc = read_and_authorize_http_request(&mut cursor, port, &token)
            .unwrap()
            .unwrap();
        let rpc_resp = route_http_request(
            parsed_rpc,
            dir.path(),
            &handler,
            |_, _| r#"{"status":"noop"}"#,
        );
        assert_eq!(rpc_resp.status, "200 OK");
        let rpc_json: serde_json::Value = serde_json::from_slice(&rpc_resp.body).unwrap();
        assert_eq!(rpc_json["data"][0]["document_id"], json!(doc_id));
    }
}
