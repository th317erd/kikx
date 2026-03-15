'use strict';

// ---------------------------------------------------------------------------
// Shared animated border glow effects
//
// Focus: Two color-cycling dots orbit the border of a focused element.
// Hover: Faint scrolling rainbow border + single faint glow dot.
//
// Usage:
//   import { GLOW_KEYFRAMES, glowCSS, glowHoverCSS } from '../../styles/glow-focus.mjs';
//
//   const TEMPLATE_HTML = `<style>
//     ${GLOW_KEYFRAMES}
//     ${glowHoverCSS('.my-element:hover:not(.focused)')}
//     ${glowCSS('.my-element.focused')}
//   </style>`;
//
// Order matters: glowCSS() should come AFTER glowHoverCSS() so focus
// overrides hover when both states are active.
//
// The target element needs position: relative (or a stacking context from
// backdrop-filter) so z-index: -1/-2 on pseudo-elements works correctly.
// If the element does NOT have backdrop-filter, add isolation: isolate.
// ---------------------------------------------------------------------------

// Register --border-angle as an animatable <angle> custom property.
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

// Shared mask rules that confine a gradient to just the border strip.
const BORDER_MASK = `
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: exclude;
`;

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

  @keyframes rainbow-scroll {
    to { background-position: -200% 0; }
  }
`;

// ---------------------------------------------------------------------------
// Hover glow: faint rainbow border (::before) + faint glow dot (::after)
// ---------------------------------------------------------------------------
export function glowHoverCSS(selector) {
  return `
    ${selector} {
      animation: border-rotate 42s linear infinite;
    }

    ${selector}::before,
    ${selector}::after {
      content: '';
      position: absolute;
      border-radius: inherit;
      ${BORDER_MASK}
      pointer-events: none;
    }

    /* Faint scrolling rainbow border */
    ${selector}::before {
      inset: 0;
      padding: 1.5px;
      z-index: -1;
      background: linear-gradient(90deg,
        #ff4081, #b040ff, #448aff, #00e5ff, #00e676, #ffea00, #ff9100,
        #ff4081, #b040ff, #448aff, #00e5ff, #00e676, #ffea00, #ff9100);
      background-size: 200% 100%;
      animation: rainbow-scroll 60s linear infinite;
      opacity: 0.25;
    }

    /* Single faint glow dot */
    ${selector}::after {
      inset: -4px;
      padding: 5px;
      z-index: -2;
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
      opacity: 0.20;
      animation: dot-hue-cycle-glow 45s linear infinite;
    }
  `;
}

// ---------------------------------------------------------------------------
// Focus glow: sharp orbiting dot (::before) + blurred glow halo (::after)
// ---------------------------------------------------------------------------
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
      ${BORDER_MASK}
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
