import React, { useEffect, useRef, useState } from "react";
import { useModalDialog } from "../../shared/hooks/useModalDialog";

interface OpenPasswordDialogProps {
  pendingPath: string;
  errorMessage: string | null;
  onSubmitPassword: (password: string) => void | Promise<void>;
  onCancel: () => void;
}

export const OpenPasswordDialog: React.FC<OpenPasswordDialogProps> = ({
  pendingPath,
  errorMessage,
  onSubmitPassword,
  onCancel,
}) => {
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const { dialogRef, handleBackdropMouseDown } = useModalDialog(onCancel, {
    initialFocusSelector: 'input[type="password"]',
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setPassword("");
    };
  }, []);

  useEffect(() => {
    setIsSubmitting(false);
    if (errorMessage) {
      passwordInputRef.current?.focus();
      passwordInputRef.current?.select();
    }
  }, [errorMessage, pendingPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || password.length === 0) {
      return;
    }
    setIsSubmitting(true);
    try {
      await Promise.resolve(onSubmitPassword(password));
    } finally {
      if (mountedRef.current) {
        setIsSubmitting(false);
      }
    }
  };

  const displayName = pendingPath.split(/[/\\]/).pop() ?? "Encrypted Document";

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Password Required"
      onMouseDown={handleBackdropMouseDown}
    >
      <div ref={dialogRef} tabIndex={-1} className="modal-card">
        <h2>Password Required</h2>
        <p>
          The document <strong>{displayName}</strong> is encrypted. Enter its
          password to unlock:
        </p>
        {errorMessage && (
          <div className="error-banner" role="alert">
            {errorMessage}
          </div>
        )}
        <form onSubmit={handleSubmit} className="modal-form">
          <input
            ref={passwordInputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Document password..."
            aria-label="Document password"
            disabled={isSubmitting}
            autoFocus
            className="focus-input full-width"
          />
          <div className="modal-actions">
            <button
              type="button"
              className="focus-btn secondary"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="focus-btn primary"
              disabled={isSubmitting || password.length === 0}
            >
              {isSubmitting ? "Unlocking..." : "Unlock PDF"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
