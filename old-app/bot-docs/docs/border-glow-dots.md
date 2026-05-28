# Border Glow Dots — Animated Border Effect

An animated CSS effect where two color-cycling glowing dots continuously orbit an element's border. Used on the message input field, with plans to extend to all bordered elements in the UI.

---

## Visual Effect

- Two small bright dots travel clockwise around the element's border
- Each dot has a soft glow halo behind it
- Dot colors cycle through the rainbow (hue-rotate)
- Motion is slow and continuous (8s per full orbit)
- Color cycle is even slower (15s per full rainbow)

## Technique

### Core Concept: Conic Gradient + CSS Mask

The effect uses a **conic-gradient** with two narrow bright color stops (the "dots") positioned 180 degrees apart. The gradient is rotated via an animated CSS custom property (`--border-angle`), and a **CSS mask** confines visibility to just the border strip.

### Layer Stack

```
z-index -2:  ::after   — Blurred glow halo (8px blur, 40% opacity)
z-index -1:  ::before  — Sharp dot (1.5px border, 85% opacity)
z-index  0:  element   — Glass background, backdrop-filter
z-index  1:  children  — Textarea, button (normal flow, above everything)
```

The parent element's `backdrop-filter` creates a stacking context automatically, so `z-index: -1` places pseudo-elements above the glass background but below normal-flow children.

### CSS Custom Property Animation

Standard CSS cannot interpolate custom properties in `@keyframes` because it doesn't know the property's type. The `CSS.registerProperty()` API tells the browser that `--border-angle` is an `<angle>`, enabling smooth interpolation:

```javascript
CSS.registerProperty({
  name:         '--border-angle',
  syntax:       '<angle>',
  inherits:     true,
  initialValue: '0deg',
});
```

With `inherits: true`, the animation runs on the parent element and pseudo-elements inherit the animated value — both `::before` and `::after` stay in sync without separate animations.

### The Mask Technique

The key trick that confines the gradient to just the border area:

```css
/* Two identical full-coverage masks, composited with XOR/exclude */
-webkit-mask:
  linear-gradient(#fff 0 0) content-box,
  linear-gradient(#fff 0 0);
-webkit-mask-composite: xor;
mask:
  linear-gradient(#fff 0 0) content-box,
  linear-gradient(#fff 0 0);
mask-composite: exclude;
```

How it works:
1. First mask layer: `content-box` — covers only the content area (inside padding)
2. Second mask layer: default (`border-box`) — covers the full element area
3. XOR/exclude compositing: subtracts the content-box from the border-box
4. Result: only the **padding strip** is visible — this is the "border"

The pseudo-element's `padding` property controls the visible border thickness:
- `::before` has `padding: 1.5px` — sharp 1.5px border
- `::after` has `padding: 18px` and `inset: -14px` — wide glow extending well outside the border

### The Gradient

```css
conic-gradient(
  from var(--border-angle, 0deg),
  transparent 0%,
  #00e5ff 6%,         /* Dot 1: cyan peak at ~22 degrees */
  transparent 12%,
  transparent 44%,
  #ff4081 50%,         /* Dot 2: pink peak at 180 degrees */
  transparent 56%,
  transparent 100%
)
```

Each dot spans ~12% of the gradient (43.2 degrees) with smooth ramps from transparent to peak color and back. The two dots are 180 degrees apart (opposite sides of the border).

### Color Cycling

The `filter: hue-rotate()` animation shifts all colors uniformly:

```css
@keyframes dot-hue-cycle {
  to { filter: hue-rotate(360deg); }
}
```

Starting colors: cyan (#00e5ff, ~180deg hue) and pink (#ff4081, ~340deg hue). As hue-rotate progresses, both colors shift together, maintaining their relative difference while cycling through the full rainbow.

For the glow layer, the animation includes `blur()` alongside `hue-rotate()` since CSS `filter` is a single property:

```css
@keyframes dot-hue-cycle-glow {
  from { filter: blur(22px) hue-rotate(0deg); }
  to   { filter: blur(22px) hue-rotate(360deg); }
}
```

---

## Implementation Files

- **Message input**: `src/client/components/kikx-message-input/kikx-message-input.mjs`
- **Property registration**: `CSS.registerProperty()` call at module scope (runs once globally)

## Animation Timing

| Animation | Duration | Purpose |
|-----------|----------|---------|
| `border-rotate` | 14s | Dot orbital speed (one full loop) |
| `dot-hue-cycle` | 15s | Color rainbow cycle (sharp dot layer) |
| `dot-hue-cycle-glow` | 15s | Color rainbow cycle (glow layer, includes blur) |

## Extending to Other Elements

To apply this effect to any bordered element:

1. Ensure the element has `position: relative` (or something that establishes positioning context)
2. Ensure a stacking context exists (via `backdrop-filter`, `isolation: isolate`, `z-index`, `transform`, etc.)
3. Add the `::before` / `::after` pseudo-element styles
4. Add `animation: border-rotate 14s linear infinite` to the element
5. The `CSS.registerProperty()` call only needs to happen once globally

The effect automatically adapts to any element size and border-radius since:
- `border-radius: inherit` matches the parent's corners
- `inset: 0` / `inset: -4px` sizes to the parent
- The conic gradient emanates from center, so it works for any rectangle

## Browser Support

- **Required**: `CSS.registerProperty()` (Chrome 78+, Edge 79+, Safari 16.4+, Firefox 128+)
- **Required**: `mask-composite: exclude` / `-webkit-mask-composite: xor`
- **Required**: `conic-gradient()`
- **Fallback**: Without `CSS.registerProperty()`, the dots won't animate (static position). The existing `border` provides a graceful fallback.

## Performance Notes

- All animations use compositor-friendly properties (custom properties, filter)
- No JavaScript animation loop — pure CSS `@keyframes`
- Two pseudo-elements per animated border (negligible GPU cost)
- `filter: blur()` on the glow layer is GPU-accelerated
