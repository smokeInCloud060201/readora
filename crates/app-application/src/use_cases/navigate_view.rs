//! Use case for mutating reader view state, advancing render cancellation generation,
//! and persisting updated reading position in recent documents.

use app_domain::{PageIndex, RecentDocument, ViewState, ZoomLevel};

use crate::dto::NavigationAction;
use crate::error::ApplicationError;
use crate::ports::platform::PlatformPort;
use crate::ports::render_cache::RenderCancellationPort;
use crate::ports::storage::RecentDocumentRepository;

/// Applies a `NavigationAction` to `view_state`, increments the document's render generation
/// to cancel obsolete in-flight renders, and persists the updated reading position.
pub fn execute_navigation_action(
    view_state: &mut ViewState,
    canonical_path: &str,
    display_name: &str,
    action: NavigationAction,
    cancellation: &dyn RenderCancellationPort,
    recent_repo: &dyn RecentDocumentRepository,
    platform: &dyn PlatformPort,
) -> Result<(ViewState, u64), ApplicationError> {
    match action {
        NavigationAction::GoToPage(zero_based) => {
            view_state.go_to_page(PageIndex::new(zero_based))?;
        }
        NavigationAction::NextPage => {
            let _ = view_state.next_page();
        }
        NavigationAction::PreviousPage => {
            let _ = view_state.previous_page();
        }
        NavigationAction::SetZoom(factor) => {
            let zoom = ZoomLevel::new(factor)?;
            view_state.set_manual_zoom(zoom);
        }
        NavigationAction::StepZoomIn => {
            let next_zoom = view_state.zoom.step_in();
            view_state.set_manual_zoom(next_zoom);
        }
        NavigationAction::StepZoomOut => {
            let prev_zoom = view_state.zoom.step_out();
            view_state.set_manual_zoom(prev_zoom);
        }
        NavigationAction::SetFitMode(fit_mode) => {
            view_state.fit_mode = fit_mode;
        }
        NavigationAction::RotateClockwise => {
            let _ = view_state.rotate_clockwise();
        }
        NavigationAction::RotateCounterClockwise => {
            let _ = view_state.rotate_counter_clockwise();
        }
        NavigationAction::SetLayoutMode(layout_mode) => {
            view_state.layout_mode = layout_mode;
        }
        NavigationAction::SetRenderMode(render_mode) => {
            view_state.render_mode = render_mode;
        }
    }

    let new_generation = cancellation.next_generation(&view_state.document_id);

    let recent = RecentDocument::from_view_state(
        canonical_path,
        display_name,
        view_state,
        platform.current_unix_ms(),
    );
    recent_repo.upsert(&recent)?;

    Ok((view_state.clone(), new_generation))
}
