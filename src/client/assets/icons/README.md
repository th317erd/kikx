# Kikx icons

Tracing source for the inline SVG icon set. Each SVG was generated with
`bot-svg-create` from the same prompt shape:

> flat solid black silhouette of a simple **<object>** icon, centered, plain
> white background, no shading, no outline, no text, minimal app icon

The browser never fetches these files directly. Their path data is mirrored in
`src/client/lib/icons.mjs`; keep that module in sync when replacing an SVG.
Icons use `currentColor`, so the surrounding component controls their colour.
