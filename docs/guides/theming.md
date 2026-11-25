# Theming & Layout Customization

**English** · [简体中文](../zh-CN/guides/theming.md)

Jot supports CSS custom properties for colors and outline styling, plus a synchronized layout API for typography and spacing across Source, Live Preview, Preview, and off-screen height estimation.

## Host Container Setup

Add a custom class to your editor mount element (Jot automatically adds `.jot-markdown-editor`) so all overrides remain scoped:

```css
.notes-editor {
  height: min(76vh, 48rem);
  min-height: 0;
  --jot-background: #fcfcfa;
  --jot-text-color: #202726;
  --jot-link-color: #086c60;
  --jot-quote-border: #80a79e;
  --jot-code-background: #edf1ee;
}

.notes-editor .jot-md-heading { color: #183e36; }
.notes-editor .jot-table-toolbar__button { border-color: #80a79e; }
```

> **Important**: Inside Flex or Grid layouts, give the editor container an explicit height and `min-height: 0`. If the container grows unbounded, the outer page takes over scrolling and disables the editor's virtualized scroll viewport.

## Colors

Set `--jot-*` CSS variables on your host element, pass `theme.colors` during construction, or update colors at runtime via `await editor.setTheme({ colors: ... })`. Pass `null` for any property to clear an inline override and fall back to your stylesheet.

| `theme.colors` key | CSS Custom Property |
| --- | --- |
| `background` / `text` | `--jot-background` / `--jot-text-color` |
| `codeBackground` / `muted` / `link` | `--jot-code-background` / `--jot-muted-color` / `--jot-link-color` |
| `quote` / `quoteBackground` / `quoteBorder` | `--jot-quote-color` / `--jot-quote-background` / `--jot-quote-border` |
| `searchMatch` / `searchCurrent` / `selection` | `--jot-search-match` / `--jot-search-match-selected` / `--jot-selection-background` |

## Typography, Line Heights & Spacing

Pass typography and metric overrides via `theme.layout` or `editor.setLayoutStyle(...)`. Jot applies these settings consistently to CSS and to its off-screen layout estimator so virtualized scrolling stays accurate:

```ts
await editor.setLayoutStyle({
  fontFamily: "system-ui, sans-serif",
  fontSize: 16,
  codeBlockWrap: "scroll", // or "wrap"
  metrics: {
    paragraphLineHeight: 26,
    blankLineHeight: 26,
    paragraphPaddingX: 8,
    headingLineHeights: [34, 32, 30, 28, 26, 26], // H1..H6 in px
    codeLineHeight: 24,
    blockGap: 0,
  },
});
```

| Area | `metrics` fields |
| --- | --- |
| Text, blanks, headings, rules | `paragraphLineHeight`, `paragraphPaddingX`, `blankLineHeight`, `headingLineHeights`, `thematicHeight` |
| Blocks & boundaries | `blockGap`, `boundaryWidth` |
| Quotes & lists | `quotePaddingX`, `quotePaddingY`, `quoteMinContentWidth`, `listIndent`, `listMinContentWidth` |
| Code & math | `codeLineHeight`, `codePaddingY`, `mathLineHeight`, `mathPaddingY` |
| Tables | `tableHeaderHeight`, `tableRowHeight`, `tableToolbarHeight`, `tableFrame` |
| Images | `imageFallbackHeight`, `imageMaxHeight` |

- Call `await editor.invalidateLayout()` after loading custom web fonts or resizing host layouts externally.
- Provide image dimensions or aspect ratios ahead of load via `surface.resolveImageMetadata` to prevent scroll shifts.
- Full TypeScript definitions are in [theme.ts](../../packages/editor/src/component/theme.ts) and [options.ts](../../packages/editor/src/layout/pretext/options.ts).

## Document Outline Styling

Attach your own class to the outline container (for example `.notes-outline`). The outline inherits `font` and `color` from its container and exposes the following CSS variables:

```css
.notes-outline {
  font: 14px/1.4 system-ui, sans-serif;
  color: #202726;
  --jot-outline-max-height: 20rem;
  --jot-outline-indent: 1em;
  --jot-outline-accent: #086c60;
  --jot-outline-highlight: #e7f1ed;
}
```

Pass `{ rowHeight: 36 }` to `mountOutline` or `createOutlinePlugin` to customize row height.

## Selectors & Layout Guardrails

| Element | CSS Selector |
| --- | --- |
| Editor root | `.jot-markdown-editor` |
| Block elements | `.jot-md-paragraph`, `.jot-md-heading`, `.jot-md-list-item`, `.jot-md-block-quote`, `.jot-md-fenced-code` |
| Rich content | `.jot-md-image`, `.jot-md-inline-math`, `.jot-md-math-block`, `.jot-md-table` |
| Live Preview inline marks | `.jot-live-preview-strong`, `.jot-live-preview-emphasis`, `.jot-live-preview-link` (and `jot-live-preview-source-*` when active) |
| Numbered code lines | `.jot-code-line[data-jot-line-number]` |
| Table UI | `.jot-table-toolbar`, `.jot-table-toolbar__button`, `.jot-table-row`, `.jot-table-cell` |
| Toolbar | `.jot-editor-toolbar`, `.jot-editor-toolbar__button` |

Always scope overrides to your mount class and **avoid overriding geometric CSS properties directly** (`margin`, `padding`, `line-height`, `white-space` on `.cm-line` or blocks; `height`/`position`/`transform` on virtual spacers; `min-width` on table cells; or `overflow` on internal scrollers). Use `setLayoutStyle()`, `setTableColumnWidth()`, and `codeBlockWrap` so DOM rendering and off-screen height estimation stay in sync.
