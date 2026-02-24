'use strict';

// Shared scrollbar CSS for Shadow DOM adoption via constructable stylesheets.
// Usage in a WebComponent:
//   import { scrollbarStyleSheet } from 'hero/lib/../styles/scrollbar-styles.mjs';
//   this.shadowRoot.adoptedStyleSheets = [scrollbarStyleSheet, ...];

export const scrollbarCSS = `
::-webkit-scrollbar {
  width: var(--scrollbar-width, 8px);
  height: var(--scrollbar-width, 8px);
}

::-webkit-scrollbar-track {
  background: var(--scrollbar-track, transparent);
}

::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb, rgba(255, 255, 255, 0.15));
  border-radius: 9999px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover, rgba(255, 255, 255, 0.25));
}

* {
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb, rgba(255, 255, 255, 0.15)) var(--scrollbar-track, transparent);
}
`;

let _scrollbarStyleSheet;

export function getScrollbarStyleSheet() {
  if (!_scrollbarStyleSheet) {
    _scrollbarStyleSheet = new CSSStyleSheet();
    _scrollbarStyleSheet.replaceSync(scrollbarCSS);
  }

  return _scrollbarStyleSheet;
}
