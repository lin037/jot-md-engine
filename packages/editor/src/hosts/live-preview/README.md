# Live Preview Host (`hosts/live-preview`)

**English** · [简体中文](README.zh-CN.md)

`LivePreviewController` coordinates CodeMirror 6 state, selections, and visible ranges to schedule projections from the Worker. `planner.ts` turns confirmed `RenderNode` trees into CodeMirror decoration plans, and `widget.ts` delegates rich block widgets to the shared `RenderRuntime`, while CodeMirror remains the single owner of editable text and undo history.

## Source Reveal & Selection

- Placing the caret inside a normal block reveals its raw Markdown syntax; moving out restores the rendered view.
- Multi-block selections and Select All work directly over the rendered view without forcing an entire large document to expand at once.
- Opening and closing delimiters for fenced code and math blocks carry guarded boundaries; pressing Arrow Up from the first content line moves cleanly into the opening delimiter line.
- Elements carry `data-jot-source-from` and `data-jot-source-to` attributes so pointer clicks map accurately to UTF-16 source offsets.

## Tables & IME Composition

- Each table mounts a single root widget whose interactive cell and delimiter ranges come from the confirmed projection.
- Clicking a cell updates the underlying CodeMirror selection, which `TableGrid` reflects visually. During active IME composition, a single host-level transient surface captures composition text before committing an atomic transaction.
- Deleting across an entire table is allowed; partial edits that cross table delimiters are intercepted to preserve Markdown structure.

## Revision & Measurement Safety

During rapid input or paste bursts, CodeMirror may advance ahead of Worker confirmation. Untouched widgets remain mounted while position-sensitive table actions pause until revisions catch up, and out-of-date projection patches are discarded automatically.

`SyntaxBlockIndex` resolves visible root blocks, `ProjectionStore` fetches only the needed windows, `layout/pretext` estimates off-screen block heights, and `ResizeObserver` triggers CodeMirror re-measurement once widgets settle in the DOM.
