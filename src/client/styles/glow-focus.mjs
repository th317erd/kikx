'use strict';

// ---------------------------------------------------------------------------
// Animated border glow — rotating conic-gradient border ring
//
// A conic-gradient with two bright spots (cyan + pink, 180° apart) is
// masked to a thin ring around the element's border. Two custom properties
// animate on the base element permanently (zero rendering cost):
//
//   --glow-angle  — rotates the gradient around the border
//   --glow-hue    — cycles colors through the rainbow via hue-rotate
//
// The pseudo-elements only appear on hover/focus and read the parent's
// properties, so neither animation restarts across state changes.
//
// NO filter: blur() is used — softness comes from wide gradient stop
// transitions, which cost nothing at runtime.
//
// ::before  — conic-gradient ring (the border glow + dot peaks)
// ::after   — conic-gradient bloom (soft ambient wash behind the ring)
// ---------------------------------------------------------------------------

// Register animatable custom properties via JS API.
// CSS @property at-rules don't work inside shadow DOM <style> tags,
// but CSS.registerProperty() registers globally and works everywhere.
if (typeof CSS !== 'undefined' && CSS.registerProperty) {
  let properties = [
    { name: '--glow-angle', syntax: '<angle>', initialValue: '0deg', inherits: true },
    { name: '--glow-hue',   syntax: '<angle>', initialValue: '0deg', inherits: true },
  ];

  for (let prop of properties) {
    try {
      CSS.registerProperty(prop);
    } catch (_) {
      // Already registered — safe to ignore
    }
  }
}

// Sets up the always-running animations on the base element.
// Call with the element selector that will later receive hover/focus glow.
export function glowInitCSS(baseSelector) {
  return `
    @keyframes glow-rotate {
      from { --glow-angle: 0deg; }
      to   { --glow-angle: 360deg; }
    }

    @keyframes glow-hue-cycle {
      from { --glow-hue: 0deg; }
      to   { --glow-hue: 360deg; }
    }

    ${baseSelector} {
      animation:
        glow-rotate 20s linear infinite,
        glow-hue-cycle 30s linear infinite;
    }
  `;
}

// Backward compat — deprecated, prefer glowInitCSS()
export const GLOW_KEYFRAMES = `
  @keyframes glow-rotate {
    from { --glow-angle: 0deg; }
    to   { --glow-angle: 360deg; }
  }
`;

function glowBase(selector, borderWidth, opacity, bloomSpread) {
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

      /* Hue cycle — no blur, just hue-rotate (cheap) */
      filter: hue-rotate(var(--glow-hue, 0deg));

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
    }

    ${selector}::after {
      content: '';
      position: absolute;
      pointer-events: none;
      border-radius: inherit;
      inset: -${bloomSpread}px;
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

      filter: hue-rotate(var(--glow-hue, 0deg));
    }
  `;
}

// ---------------------------------------------------------------------------
// Hover glow: faint border highlights
// ---------------------------------------------------------------------------
export function glowHoverCSS(selector) {
  return `
    ${glowBase(selector, 2, 0.35, 8)}
  `;
}

// ---------------------------------------------------------------------------
// Focus glow: bright border with prominent dot peaks + ambient bloom
// ---------------------------------------------------------------------------
export function glowCSS(selector) {
  return `
    ${glowBase(selector, 3, 0.85, 12)}
  `;
}
