import type React from "react";
import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled):not(.sr-only)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export interface UseModalDialogOptions {
  initialFocusSelector?: string;
}

export function useModalDialog<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  options?: UseModalDialogOptions,
): {
  dialogRef: React.RefObject<T | null>;
  handleBackdropMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
} {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const initialFocusSelector = options?.initialFocusSelector;

  useEffect(() => {
    const previousActive =
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const container = dialogRef.current;
    if (container) {
      const currentFocused = document.activeElement;
      const alreadyInside =
        currentFocused instanceof HTMLElement &&
        currentFocused !== document.body &&
        container.contains(currentFocused);

      if (!alreadyInside) {
        const preferred = initialFocusSelector
          ? container.querySelector<HTMLElement>(initialFocusSelector)
          : null;
        const firstFocusable =
          preferred ?? container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        if (firstFocusable) {
          firstFocusable.focus();
        } else {
          container.focus();
        }
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (event.shiftKey) {
          if (active === first || !root.contains(active)) {
            event.preventDefault();
            last?.focus();
          }
        } else if (active === last || !root.contains(active)) {
          event.preventDefault();
          first?.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousActive && document.contains(previousActive)) {
        previousActive.focus();
      }
    };
  }, [initialFocusSelector]);

  const handleBackdropMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) {
      onCloseRef.current();
    }
  };

  return { dialogRef, handleBackdropMouseDown };
}
