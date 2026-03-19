'use strict';

// ---------------------------------------------------------------------------
// Animated border glow — rotating conic-gradient border ring
//
// A conic-gradient with two bright spots (cyan + pink, 180° apart) is
// masked to a thin ring around the element's border. Two animations run
// directly on the pseudo-elements:
//
//   glow-rotate     — rotates the gradient via --glow-angle (non-inheriting)
//   glow-hue-cycle  — cycles colors via filter: hue-rotate (compositor)
//
// The --glow-angle custom property is registered with inherits: false so
// animating it only restyles the pseudo-element itself — not every
// descendant in the DOM tree.  The hue cycle animates the filter property
// directly, which the compositor handles off-main-thread.
//
// Pseudo-elements read --glow-delay-rotate and --glow-delay-hue from
// their parent for random phase offsets (set once in JS, no perf cost).
//
// ::before  — conic-gradient ring (the border glow + dot peaks)
// ::after   — conic-gradient bloom (soft ambient wash inside the element)
// ---------------------------------------------------------------------------

// Register --glow-angle as a non-inheriting animatable custom property.
// inherits: false is critical — it confines style recalculation to the
// pseudo-element that owns the animation, instead of triggering a full
// restyle of every descendant in the DOM tree.
if (typeof CSS !== 'undefined' && CSS.registerProperty) {
  try {
    CSS.registerProperty({
      name:         '--glow-angle',
      syntax:       '<angle>',
      initialValue: '0deg',
      inherits:     false,
    });
  } catch (_) {
    // Already registered — safe to ignore
  }
}

// Emits the shared @keyframes used by all glow pseudo-elements.
// The baseSelector parameter is accepted for backward compatibility but
// no animation is placed on the parent element — animations run on the
// ::before / ::after pseudo-elements directly (see glowBase).
export function glowInitCSS(_baseSelector) {
  return `
    @keyframes glow-rotate {
      from { --glow-angle: 0deg; }
      to   { --glow-angle: 360deg; }
    }

    @keyframes glow-hue-cycle {
      from { filter: hue-rotate(0deg); }
      to   { filter: hue-rotate(360deg); }
    }
  `;
}

// Backward compat — deprecated, prefer glowInitCSS()
export const GLOW_KEYFRAMES = `
  @keyframes glow-rotate {
    from { --glow-angle: 0deg; }
    to   { --glow-angle: 360deg; }
  }

  @keyframes glow-hue-cycle {
    from { filter: hue-rotate(0deg); }
    to   { filter: hue-rotate(360deg); }
  }
`;

function glowBase(selector, borderWidth, opacity) {
  // Wide, gradual transitions — "pre-softened" with no blur needed.
  // Each peak spreads over ~80deg instead of ~30deg for a diffuse look.
  let peak      = opacity.toFixed(2);
  let high      = (opacity * 0.6).toFixed(2);
  let mid       = (opacity * 0.25).toFixed(2);
  let low       = (opacity * 0.05).toFixed(2);

  // Bloom layer — very wide, ultra-soft gradient (no blur filter).
  // Peaks spread over ~120deg for a naturally diffuse ambient wash.
  let bloomPeak = (opacity * 0.08).toFixed(2);
  let bloomHigh = (opacity * 0.05).toFixed(2);
  let bloomMid  = (opacity * 0.025).toFixed(2);
  let bloomLow  = (opacity * 0.01).toFixed(2);

  return `
    ${selector}::before {
      content: '';
      position: absolute;
      pointer-events: none;
      border-radius: inherit;
      inset: -${borderWidth}px;
      z-index: 1;

      background: conic-gradient(
        from var(--glow-angle, 0deg),
        rgba(0, 229, 255, ${low}) 0deg,
        rgba(0, 229, 255, ${mid}) 5deg,
        rgba(0, 229, 255, ${peak}) 20deg,
        rgba(0, 229, 255, ${high}) 40deg,
        rgba(0, 229, 255, ${mid}) 60deg,
        rgba(0, 229, 255, ${low}) 80deg,
        transparent 100deg,
        transparent 155deg,
        rgba(255, 64, 129, ${low}) 170deg,
        rgba(255, 64, 129, ${mid}) 185deg,
        rgba(255, 64, 129, ${peak}) 200deg,
        rgba(255, 64, 129, ${high}) 220deg,
        rgba(255, 64, 129, ${mid}) 240deg,
        rgba(255, 64, 129, ${low}) 260deg,
        transparent 280deg,
        transparent 355deg,
        rgba(0, 229, 255, ${low}) 360deg
      );

      /* Mask to ring — only border area visible */
      padding: ${borderWidth}px;
      -webkit-mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      mask-composite: exclude;

      /* Animations run on the pseudo-element itself — not the parent.
         glow-rotate:    animates --glow-angle (main-thread, but only restyles this element)
         glow-hue-cycle: animates filter: hue-rotate() (compositor-thread, zero cost) */
      animation:
        glow-rotate 20s linear infinite,
        glow-hue-cycle 30s linear infinite;
      animation-delay:
        var(--glow-delay-rotate, 0s),
        var(--glow-delay-hue, 0s);
    }

    ${selector}::after {
      content: '';
      position: absolute;
      pointer-events: none;
      border-radius: inherit;
      inset: 0;
      z-index: 0;

      background: conic-gradient(
        from var(--glow-angle, 0deg),
        rgba(0, 229, 255, ${bloomLow}) 0deg,
        rgba(0, 229, 255, ${bloomMid}) 10deg,
        rgba(0, 229, 255, ${bloomPeak}) 30deg,
        rgba(0, 229, 255, ${bloomHigh}) 50deg,
        rgba(0, 229, 255, ${bloomMid}) 70deg,
        rgba(0, 229, 255, ${bloomLow}) 100deg,
        transparent 130deg,
        transparent 150deg,
        rgba(255, 64, 129, ${bloomLow}) 170deg,
        rgba(255, 64, 129, ${bloomMid}) 190deg,
        rgba(255, 64, 129, ${bloomPeak}) 210deg,
        rgba(255, 64, 129, ${bloomHigh}) 230deg,
        rgba(255, 64, 129, ${bloomMid}) 250deg,
        rgba(255, 64, 129, ${bloomLow}) 280deg,
        transparent 310deg,
        transparent 355deg,
        rgba(0, 229, 255, ${bloomLow}) 360deg
      );

      /* Fade out center convergence point with a radial mask */
      /* Fade out center convergence point with a radial mask */
      -webkit-mask: radial-gradient(ellipse at center, transparent 0%, black 40%);
      mask: radial-gradient(ellipse at center, transparent 0%, black 40%);

      animation:
        glow-rotate 20s linear infinite,
        glow-hue-cycle 30s linear infinite;
      animation-delay:
        var(--glow-delay-rotate, 0s),
        var(--glow-delay-hue, 0s);
    }
  `;
}

// ---------------------------------------------------------------------------
// Hover glow: faint border highlights
// ---------------------------------------------------------------------------
export function glowHoverCSS(selector) {
  return `
    ${glowBase(selector, 2, 0.35)}
  `;
}

// ---------------------------------------------------------------------------
// Focus glow: bright border with prominent dot peaks + ambient bloom
// ---------------------------------------------------------------------------
export function glowCSS(selector) {
  return `
    ${glowBase(selector, 3, 0.85)}
  `;
}
