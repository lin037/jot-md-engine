# Off-Screen Height Estimation (`layout/pretext`)

**English** · [简体中文](README.zh-CN.md)

Both Preview and Live Preview need accurate initial height estimates for unmounted blocks so scrollbars and viewport jumps behave predictably on large documents.

- `filter.ts`: Estimates block heights from Rust `RenderNode` metadata, container width, and shared `EditorLayoutStyle` metrics.
- `text-layout.ts`: Caches Canvas grapheme measurements and computes line wrapping without touching the DOM; long paragraphs and large tables use bounded sampling (`components/table/pretext.ts`).
- `style-metrics.ts`: Synchronizes line heights, padding, and spacing to shared CSS custom properties so estimated heights match mounted DOM heights.

When a block enters the viewport, real DOM measurements replace its estimate and adjust scroll anchors smoothly. Call `surface.resolveImageMetadata` to provide image dimensions prior to loading, and call `editor.invalidateLayout()` after loading external fonts.
