# Virtual Layout & Scrolling

**English** · [简体中文](../zh-CN/architecture/virtual-layout.md)

Jot supports multi-megabyte documents by mounting only the blocks near the viewport and estimating off-screen heights accurately enough to keep scrollbars stable.

## Which Layer Owns Height?

- **Preview (`EditorSurface`)**: Uses a virtualized block axis (`VirtualAxis`) with off-screen height spacers. Root blocks, table rows/columns, block quotes, and long code blocks each request projection windows driven by scroll position and viewport size.
- **Live Preview (`LivePreviewController`)**: Lets CodeMirror 6 manage the physical line heights of paragraphs, headings, quotes, and code lines natively, while adding bounded height estimates only for replacement widgets (such as tables and block math) so native lines are never double-counted.
- **Off-screen estimator (`layout/pretext`)**: Estimates unmounted block heights using cached Canvas grapheme measurements, font metrics, and shared `EditorLayoutStyle` settings, then refines heights once real DOM elements are mounted and measured. Long tables use bounded row sampling; images use `resolveImageMetadata` dimensions or configured fallback heights.

**Key modules**: [preview/surface.ts](../../packages/editor/src/hosts/preview/surface.ts) · [live-preview/pretext-estimator.ts](../../packages/editor/src/hosts/live-preview/pretext-estimator.ts) · [pretext/options.ts](../../packages/editor/src/layout/pretext/options.ts)

## Scroll Anchors & Geometry Updates

Font loads, container width changes, table column resizing, and image loads invalidate prior height estimates.

- **Preserving user scroll intent**: Programmatic scroll compensation (for example when a block above the viewport grows after mounting) adjusts scroll position smoothly without fighting active user scrollbar drags.
- **Covering full viewports**: `around-range` projections return a bounded slice starting from a target offset; when a tall viewport has missing trailing blocks, `projection-window.ts` calculates missing root indices from the confirmed block index and fetches the remaining gap explicitly.
- **Keep CSS and estimator aligned**: Always update typography, line heights, and spacing through `EditorLayoutStyle` (`theme.layout` / `setLayoutStyle`) rather than overriding block CSS directly.
