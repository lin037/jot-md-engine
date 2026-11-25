# Table Component

**English** · [简体中文](README.zh-CN.md)

`components/table` is the single implementation for Markdown pipe tables. It derives layout, PreText height estimation, Preview DOM, Live Preview interaction, and editing commands from one shared `TableComponentModel`.

## Module Responsibilities

- `model.ts`: Converts Rust `RenderNode` structures into a stable table model.
- `layout.ts`: Resolves column widths, container fitting, pinned widths, and Rust content metrics.
- `pretext.ts`: Bounded row sampling for off-screen table height estimation.
- `source.ts`: Pure source-level cell and column transformations (with conservative fallbacks before projection loads).
- `commands.ts`: DOM-free commands for cell navigation, clearing, and row/column mutations.
- `toolbar.ts`: Dispatches toolbar button actions through the same `TableCommandExecutor`.
- `adapters/interaction.ts`: Resolves active cells and protected delimiter surfaces from confirmed `sourceRange` data.
- `adapters/projection.ts`: Declares table projection depth and window budgets.
- `adapters/preview.ts`: Shared `TableGrid` with 2D row/column virtualization and interactive column resizing.
- `adapters/live-preview.ts`: Emits a single `table-root` widget descriptor for CodeMirror.
- `adapters/dom.ts`: Shared row and cell DOM contract used by both Preview and Live Preview.

## Architectural Invariants

1. **Rust is the syntax authority**: `source.ts` never promotes arbitrary pipe lines into a table without a confirmed Rust `RenderNode`.
2. **One shared grid**: Both Preview and Live Preview mount `TableGrid` through `RenderRuntime`. Live Preview mounts a single root widget (`selection: "mapped"`) rather than per-row widgets or separate per-cell `<input>` elements.
3. **Selection is projected**: Active cell highlighting reflects CodeMirror's main selection mapped onto confirmed cell `sourceRange`s; active IME composition uses a single transient host surface before committing through `EditorDocumentSession`.
4. **Scoped incremental updates**:

| Update Kind | Preserve | Update |
| --- | --- | --- |
| **Cell text edit** | Table root DOM, `TableGrid`, column widths, row `VirtualAxis`, untouched row DOM, horizontal scroll anchor | Target row/cell subtree and measured height (plus re-measurement under `"live"` auto-width only when widths actually change) |
| **Source offset shift** | All DOM and layout state above | Rebase `data-jot-source-from`/`to` attributes on affected subtrees |
| **Row insert / delete** | Existing column widths and untouched keyed row DOM | Vertical `VirtualAxis`, visible row window, and row heights |
| **Column geometry change** | Keyed reusable DOM and user-pinned column widths | Column window, auto-width calculation, and affected row wrapping/heights |

Additional guardrails:
- Under `autoWidth: "stable"`, character edits inside cells do not re-trigger full intrinsic column re-convergence.
- Column count is fixed by the confirmed header and delimiter rows; overflowing data rows stay in source without widening the grid.
- Temporary gaps in sparse projections represent unprojected cells, not deleted columns—keep confirmed cell shells until the slice arrives.
- Table root widgets use `inPlaceUpdate` so cell edits do not wipe CodeMirror's measured block height; `ResizeObserver` reconciles final heights smoothly.
- In `"content"` mode, the outer shell width follows the column axis; the table toolbar wraps within that width rather than stretching narrow tables.
