'use strict';

// ---------------------------------------------------------------------------
// Shared animated border glow dots
//
// Two color-cycling dots orbit the border of a focused element.
// Uses conic-gradient + CSS mask to confine the dots to the border strip.
//
// Usage:
//   import { GLOW_KEYFRAMES, glowCSS } from '../../styles/glow-focus.mjs';
//
//   const TEMPLATE_HTML = `<style>
//     ${GLOW_KEYFRAMES}
//     ${glowCSS('.my-element.focused')}
//   </style>`;
//
// The target element needs position: relative (or a stacking context from
// backdrop-filter) so z-index: -1/-2 on pseudo-elements works correctly.
// If the element does NOT have backdrop-filter, add isolation: isolate
// to create a stacking context that prevents the pseudo-elements from
// disappearing behind the page background.
// ---------------------------------------------------------------------------

// Register --border-angle as an animatable <angle> custom property.
// Must be global because @property inside shadow DOM is not reliable.
try {
  CSS.registerProperty({
    name:         '--border-angle',
    syntax:       '<angle>',
    inherits:     true,
    initialValue: '0deg',
  });
} catch (e) {
  // Already registered or browser lacks support
}

export const GLOW_KEYFRAMES = `
  @keyframes border-rotate {
    to { --border-angle: 360deg; }
  }

  @keyframes dot-hue-cycle {
    to { filter: hue-rotate(360deg); }
  }

  @keyframes dot-hue-cycle-glow {
    from { filter: blur(14px) hue-rotate(0deg); }
    to   { filter: blur(14px) hue-rotate(360deg); }
  }
`;

export function glowCSS(selector) {
  return `
    ${selector} {
      animation: border-rotate 42s linear infinite;
    }

    ${selector}::before,
    ${selector}::after {
      content: '';
      position: absolute;
      border-radius: inherit;
      background: conic-gradient(
        from var(--border-angle, 0deg),
        transparent 0%,
        #00e5ff 3%,
        transparent 6%,
        transparent 47%,
        #ff4081 50%,
        transparent 53%,
        transparent 100%
      );
      -webkit-mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      mask-composite: exclude;
      pointer-events: none;
    }

    /* Sharp dot layer */
    ${selector}::before {
      inset: 0;
      padding: 1.5px;
      z-index: -1;
      opacity: 0.85;
      animation: dot-hue-cycle 45s linear infinite;
    }

    /* Glow halo layer */
    ${selector}::after {
      inset: -8px;
      padding: 10px;
      z-index: -2;
      opacity: 0.55;
      animation: dot-hue-cycle-glow 45s linear infinite;
    }
  `;
}
