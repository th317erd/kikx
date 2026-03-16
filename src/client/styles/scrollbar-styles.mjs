'use strict';

// Shared scrollbar CSS via constructable stylesheets.
// Usage in a WebComponent:
//   import { scrollbarStyleSheet } from 'kikx/lib/../styles/scrollbar-styles.mjs';
//   document.adoptedStyleSheets = [...document.adoptedStyleSheets, scrollbarStyleSheet];

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

::-webkit-scrollbar-button {
  display: none;
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
