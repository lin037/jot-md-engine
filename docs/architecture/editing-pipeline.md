# Editing Pipeline

**English** · [简体中文](../zh-CN/architecture/editing-pipeline.md)

Jot decouples immediate user interaction from document parsing so typing and IME composition never wait on syntax analysis or DOM preview updates.

## Edit Synchronization

CodeMirror 6 owns the optimistic editor text, selection, active IME composition, and undo/redo history on the main thread. The TypeScript adapter (`EditorDocumentSession`) tracks the latest text and `revision` committed by the Rust/Wasm Worker.

- **Immediate feedback & batching**: While an edit request is in flight to the Worker, CodeMirror continues accepting input and merges subsequent changes into a pending `ChangeSet`.
- **Serial coordination**: `EditorTransactionCoordinator` serializes commits. If the Worker's confirmed text still matches the `ChangeSet` origin, the exact edit range is sent; otherwise, the coordinator computes a clean diff against the latest confirmed text.
- **Revision-safe responses**: The session matches replies to pending requests by `requestId`. It also checks transaction replies and ignores analysis or projection updates for older revisions.
- **Error recovery**: If a transaction fails while the Worker is alive, the editor reports the error via `onError` and rolls CodeMirror back to `confirmedValue`. If the Worker terminates unexpectedly, the session enters a terminal error state.

While waiting for confirmation, Live Preview maps safe inline decorations and container boundaries across `ChangeSet` edits and defers structural re-renders until Rust confirms the new tree.

**Key modules**: [codemirror-source.ts](../../packages/editor/src/hosts/source/codemirror-source.ts) · [transaction-coordinator.ts](../../packages/editor/src/adapter/transaction-coordinator.ts) · [session.ts](../../packages/editor/src/adapter/session.ts) · [live-preview/controller.ts](../../packages/editor/src/hosts/live-preview/controller.ts)

## Incremental Parsing in Rust

On the Worker side, `WasmEditorHost` routes protocol envelopes by `documentId` and `generation` to `EditorDocument`:

1. **Commit text first**: `EditorDocument` stores LF-normalized text in a `crop::Rope` (alongside per-line original line endings), validates UTF-16 half-open `[from, to)` boundaries, applies the transaction against `baseRevision`, and increments `revision` immediately.
2. **Fast local rewrites**: Single-line edits inside unambiguous block boundaries re-parse only the owning block. Equal-length edits avoid touching the trailing suffix; length-changing edits rebase subsequent ranges and preserve node IDs and content versions for untouched blocks.
3. **Fallback & budgeted analysis**: Structural edits (such as closing a fence, changing table column counts, or altering list continuations) fall back to safe block-boundary re-parsing. Background analysis advances by line, block, and UTF-16 budgets (`analysisId` + `sequence`), leaving unanalyzed dirty regions in source view until confirmed.

**Key modules**: [document/mod.rs](../../crates/editor-engine/src/document/mod.rs) · [local_rewrite.rs](../../crates/editor-engine/src/syntax/local_rewrite.rs) · [incremental.rs](../../crates/editor-engine/src/syntax/incremental.rs) · [analysis.rs](../../crates/editor-engine/src/syntax/analysis.rs)

## Versioned Viewport Projections

Instead of serializing the entire AST across the Wasm boundary, the engine exposes `project()` queries scoped to a parent node, axis, and window (such as root blocks, table rows/columns, quoted lines, or long fenced code lines).

- The main-thread adapter caches sparse child slices per `(parentId, axis)` and rejects patches that no longer match the active `generation` or `revision`.
- Shallow projections return summary metadata so off-screen layout estimation can size unmounted blocks without pulling every nested child.

**Key modules**: [projection/mod.rs](../../crates/editor-engine/src/projection/mod.rs) · [projection-window.ts](../../packages/editor/src/hosts/live-preview/projection-window.ts)
