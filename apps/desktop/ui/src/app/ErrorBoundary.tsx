import React from "react";

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(): void {
    // Error boundary prevents unhandled render errors from crashing the full window.
  }

  private handleReset = (): void => {
    this.setState({ hasError: false });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <main className="empty-workspace" role="alert" aria-live="assertive">
          <div className="empty-workspace-card">
            <h1 className="empty-workspace-title">
              Something went wrong in the reader view
            </h1>
            <p className="empty-workspace-subtitle">
              Your local documents and saved annotations remain safe. You can
              reset the view or reload the window to continue.
            </p>
            <div className="empty-workspace-actions">
              <button
                type="button"
                className="focus-btn primary"
                onClick={this.handleReset}
              >
                Try again
              </button>
              <button
                type="button"
                className="focus-btn secondary"
                onClick={() => window.location.reload()}
              >
                Reload window
              </button>
            </div>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
