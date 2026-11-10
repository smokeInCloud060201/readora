import React, { useState } from "react";

interface OpenPasswordDialogProps {
  pendingPath: string;
  errorMessage: string | null;
  onSubmitPassword: (password: string) => void;
  onCancel: () => void;
}

export const OpenPasswordDialog: React.FC<OpenPasswordDialogProps> = ({
  pendingPath,
  errorMessage,
  onSubmitPassword,
  onCancel,
}) => {
  const [password, setPassword] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length > 0) {
      onSubmitPassword(password);
    }
  };

  const displayName = pendingPath.split(/[/\\]/).pop() ?? "Encrypted Document";

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Password Required">
      <div className="modal-card">
        <h2>Password Required</h2>
        <p>
          The document <strong>{displayName}</strong> is encrypted. Enter its password to unlock:
        </p>
        {errorMessage && (
          <div className="error-banner" role="alert">
            {errorMessage}
          </div>
        )}
        <form onSubmit={handleSubmit} className="modal-form">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Document password..."
            aria-label="Document password"
            autoFocus
            className="toolbar-input full-width"
          />
          <div className="modal-actions">
            <button type="button" className="toolbar-btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="toolbar-btn primary">
              Unlock PDF
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
