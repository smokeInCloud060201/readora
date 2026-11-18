import type React from "react";

/**
 * Provides roving keyboard focus (`ArrowDown`, `ArrowUp`, `Home`, `End`)
 * across enabled `[role="menuitem"]` elements inside a `role="menu"` container.
 */
export function handleMenuKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
): void {
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled)',
    ),
  );
  if (items.length === 0) {
    return;
  }

  const active = document.activeElement as HTMLElement | null;
  const currentIdx = active ? items.indexOf(active) : -1;

  switch (event.key) {
    case "ArrowDown": {
      event.preventDefault();
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % items.length : 0;
      items[nextIdx]?.focus();
      break;
    }
    case "ArrowUp": {
      event.preventDefault();
      const prevIdx = currentIdx > 0 ? currentIdx - 1 : items.length - 1;
      items[prevIdx]?.focus();
      break;
    }
    case "Home": {
      event.preventDefault();
      items[0]?.focus();
      break;
    }
    case "End": {
      event.preventDefault();
      items[items.length - 1]?.focus();
      break;
    }
  }
}
