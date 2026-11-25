# Browser Editor Source (`packages/editor/src`)

**English** · [简体中文](README.zh-CN.md)

The end-to-end edit flow starts in `component/markdown-editor.ts`: CodeMirror 6 captures keystrokes and IME events, `adapter/` commits transactions to the Web Worker, and the Rust/Wasm engine returns confirmed revisions and syntax projections. Both rendering hosts then update visible DOM nodes while preserving selection and scroll anchors.

## Directory Overview

```text
src/
├── index.ts                 Package public entry
├── component/               MarkdownEditor lifecycle, themes, command palette, shortcut UI
├── adapter/                 Worker session, serial transactions, UTF-16 index, sparse projection cache
├── worker/                  Wasm bootstrap, request routing, and analysis pump
├── core/
│   ├── commands/            Command and shortcut registry
│   ├── projection/          Projection contracts, layout options, and cache keys
│   └── virtual/             Logical dimension axes, mounted nodes, and scroll anchors
├── components/              Built-in commands and node-level rendering/interaction strategies
│   ├── common/              Node-to-DOM mapping, URL sanitization, image sizing, cursor offsets
│   ├── closed-container/    Closed code fence and math block boundaries
│   ├── math/                Eager and lazy KaTeX renderers
│   └── table/               Cell editing, row/column commands, column sizing, and layout
│       └── adapters/        2D virtualized table adapters for Preview and Live Preview
├── hosts/
│   ├── source/              CodeMirror input, search/replace, and transaction sync
│   ├── live-preview/        In-place editing decorations, viewport windows, and widget lifecycle
│   ├── preview/             Read-only Preview and PreText diagnostic surface
│   │   └── projection/      Depth policies for Preview and PreText projections
│   ├── folding/             Shared heading fold state
│   └── shared/              Immutable snapshot helpers shared across hosts
├── layout/                  Quote/list geometry and direct scrollbar
│   └── pretext/             Off-screen height estimation from font, width, and layout metrics
├── render/
│   └── runtime/             Shared DOM node mount, update, and recycle runtime
├── plugins/                 Plugin registry, toolbar, outline, heading folding, and Mermaid
└── observability/           Transaction-level telemetry across input, protocol, and layout
```

Preview (`hosts/preview`) and Live Preview (`hosts/live-preview`) share the same semantic renderers and `TableGrid` component while managing their own scroll and DOM lifecycles. All syntax offsets use UTF-16 code units—never pass raw browser DOM offsets directly to the protocol.

## Module Deep Dives

- [Table Component](components/table/README.md)
- [Live Preview Host](hosts/live-preview/README.md)
- [Off-Screen Height Estimation (`layout/pretext`)](layout/pretext/README.md)
- [Worker Scheduling](worker/README.md)
