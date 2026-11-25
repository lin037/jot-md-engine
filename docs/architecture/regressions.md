# Engineering Invariants & Pitfalls

**English** · [简体中文](../zh-CN/architecture/regressions.md)

This reference summarizes critical invariants verified by Jot's Rust, TypeScript, and browser test suites. When modifying parsing, Live Preview, tables, or virtual scrolling, check that your changes preserve these guarantees.

| Area | Invariant / Constraint | Primary Verification |
| --- | --- | --- |
| **Incremental parsing** | Incremental updates must produce the exact same syntax tree, ranges, and unaffected node IDs as a full parse; suffix reuse uses binary search over ordered source offsets rather than linear scans. | [incremental/main.rs](../../crates/editor-engine/tests/incremental/main.rs) · [document_flow.rs](../../crates/editor-engine/tests/integration/document_flow.rs) |
| **IME & structural shells** | Active IME composition stays in CodeMirror until committed. Structural decorations and line geometry must remain stable across `ChangeSet` mapping and Worker confirmation, especially on blank lines, quotes, and list prefixes. | [editor-ime-shell-scenarios.mjs](../../scripts/browser/interaction/scenarios/editor-ime-shell-scenarios.mjs) · [editor-structural-stability-browser.mjs](../../scripts/browser/layout/editor-structural-stability-browser.mjs) |
| **Tables & toolbars** | A table mounts a single root widget whose grid width is governed by the column axis. Deleting columns or wrapping the table toolbar must never leave stale spacer gaps or widen narrow tables artificially. | [editor-table-delete-scenarios.mjs](../../scripts/browser/interaction/scenarios/editor-table-delete-scenarios.mjs) · [editor-boundary-audit-browser.mjs](../../scripts/browser/layout/editor-boundary-audit-browser.mjs) |
| **Viewport & scrollbar** | Direct scrollbar drags must never be overridden by stale semantic scroll anchors, and tall viewports must request any missing trailing root blocks beyond the initial projection window. | [editor-scrollbar-browser.mjs](../../scripts/browser/layout/editor-scrollbar-browser.mjs) · [live-preview-projection-window.cases.ts](../../packages/editor/tests/views/live-preview/live-preview-projection-window.cases.ts) |
| **Line-height & padding parity** | Blank lines, paragraphs, and code lines must share synchronized padding and line-height metrics across CSS and off-screen estimation to prevent caret jumps or height drift on scroll. | [editor-padding-geometry-scenarios.mjs](../../scripts/browser/interaction/scenarios/editor-padding-geometry-scenarios.mjs) · [editor-metric-guard-browser.mjs](../../scripts/browser/layout/editor-metric-guard-browser.mjs) |
| **Large-document interactions** | Opening, folding, scrolling, and prepending megabytes of mixed Markdown must keep mounted DOM lines bounded and hit targets aligned after layout measurements settle. | [demo-large-mixed-browser.mjs](../../scripts/browser/demo/demo-large-mixed-browser.mjs) |

Run browser suites via `pnpm run test:browser interaction`, `pnpm run test:browser layout`, or `pnpm run test:browser quote`. See [Development & Testing](../contributing/development.md) for details.
