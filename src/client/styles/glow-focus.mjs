'use strict';

// ---------------------------------------------------------------------------
// Shared animated border glow effects — CSS Motion Path particles
//
// Two spherical particles with fading tails orbit the border of an element
// using offset-path: border-box. Pure CSS, no JS positioning needed.
//
// Hover: Faint particles + scrolling rainbow border
// Focus: Bright particles with prominent tails
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
// backdrop-filter) so the pseudo-elements render correctly.
// ---------------------------------------------------------------------------

export const GLOW_KEYFRAMES = `
  @keyframes particle-orbit {
    from { offset-distance: 0%; }
    to   { offset-distance: 100%; }
  }

  @keyframes particle-hue-cycle {
    from { filter: hue-rotate(0deg); }
    to   { filter: hue-rotate(360deg); }
  }

`;

// Shared base styles for both particles (::before and ::after)
function particleBase(selector, size, opacity) {
  return `
    ${selector}::before,
    ${selector}::after {
      content: '';
      position: absolute;
      pointer-events: none;

      /* Particle shape: elongated ellipse for comet tail effect */
      width: ${size * 2.5}px;
      height: ${size}px;
      border-radius: 50%;

      /* Orbit along the element's rounded-rect border */
      offset-path: border-box;
      offset-rotate: auto;
      offset-anchor: ${Math.round(size * 0.85)}% 50%;

      /* Hue cycling for color variation over time */
      animation:
        particle-orbit var(--particle-duration, 10s) linear infinite,
        particle-hue-cycle 30s linear infinite;
    }

    /* Particle 1 — cyan */
    ${selector}::before {
      background: radial-gradient(
        ellipse at 80% 50%,
        rgba(0, 229, 255, ${opacity}) 0%,
        rgba(0, 229, 255, ${opacity * 0.5}) 30%,
        transparent 70%
      );
      box-shadow:
        0 0 ${Math.round(size * 0.6)}px ${Math.round(size * 0.15)}px rgba(0, 229, 255, ${opacity * 0.5}),
        0 0 ${Math.round(size * 0.3)}px rgba(0, 229, 255, ${opacity * 0.3});
      animation-delay: 0s, 0s;
    }

    /* Particle 2 — pink, opposite side */
    ${selector}::after {
      background: radial-gradient(
        ellipse at 80% 50%,
        rgba(255, 64, 129, ${opacity}) 0%,
        rgba(255, 64, 129, ${opacity * 0.5}) 30%,
        transparent 70%
      );
      box-shadow:
        0 0 ${Math.round(size * 0.6)}px ${Math.round(size * 0.15)}px rgba(255, 64, 129, ${opacity * 0.5}),
        0 0 ${Math.round(size * 0.3)}px rgba(255, 64, 129, ${opacity * 0.3});
      animation-delay: calc(var(--particle-duration, 10s) * -0.5), -15s;
    }
  `;
}

// ---------------------------------------------------------------------------
// Hover glow: faint particles + faint rainbow border via box-shadow
// ---------------------------------------------------------------------------
export function glowHoverCSS(selector) {
  return `
    ${selector} {
      --particle-duration: 12s;
    }

    ${particleBase(selector, 12, 0.4)}
  `;
}

// ---------------------------------------------------------------------------
// Focus glow: bright, larger particles with prominent tails
// ---------------------------------------------------------------------------
export function glowCSS(selector) {
  return `
    ${selector} {
      --particle-duration: 10s;
    }

    ${particleBase(selector, 20, 0.9)}
  `;
}
