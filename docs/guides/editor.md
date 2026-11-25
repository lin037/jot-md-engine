# Editor Interaction & Configuration

**English** · [简体中文](../zh-CN/guides/editor.md)

This guide covers how `MarkdownEditor` behaves across modes, keyboard shortcuts, search, tables, heading folding, document outline, focus management, and persistence. For installation and plugin setup, see the [Package Guide](../../packages/editor/README.md).

## Modes

`MarkdownEditor` defaults to `split` mode (CodeMirror source on the left, rendered surface on the right). Set `mode: "live-preview"` to edit rendered Markdown in place within a single pane, `mode: "source"` for plain Markdown source, or `mode: "preview"` for a read-only virtualized view.

## Keyboard Shortcuts & Search

Open the command palette (`Ctrl+Shift+P`) to search commands by name or ID, or launch the shortcut settings panel. On macOS, `Ctrl` refers to Control (`⌃`), `⌘` to Command, and `⌥` to Option.

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Command palette | `Ctrl+Shift+P` | `Ctrl+Shift+P` |
| Find / Replace | `⌘F` / `Ctrl+Shift+H` | `Ctrl+F` / `Ctrl+Shift+H` |
| Next / Previous match | `Ctrl+G` / `Ctrl+Shift+G` | `F3` / `Shift+F3` |
| Go to source line | `Ctrl+Shift+L` | `Ctrl+Alt+G` |
| Select next occurrence | `Ctrl+Shift+D` | `Ctrl+D` |
| Undo / Redo | `⌘Z` / `⌘Shift+Z` | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Continue after / before block | `⌘Enter` / `⌘Shift+Enter` | `Ctrl+Enter` / `Ctrl+Shift+Enter` |
| Switch to Live Preview | `Ctrl+Shift+E` | `Ctrl+E` |
| Bold / Italic | `⌘B` / `⌘I` | `Ctrl+B` / `Ctrl+I` |
| Inline code / Link | `Ctrl+Shift+C` / `Ctrl+Shift+K` | `` Ctrl+` `` / `Ctrl+K` |
| Toggle task list | `Ctrl+Shift+9` | `Ctrl+Shift+9` |
| Toggle task completion | `⌘⌥Enter` | `Ctrl+Alt+Enter` |
| Set heading level 1–6 | `Ctrl+Shift+1`..`6` | `Ctrl+Alt+1`..`6` |
| Toggle heading fold (plugin) | `Ctrl+Shift+O` | `Ctrl+Alt+F` |

### Search & Replace

Search operates directly on the Markdown source. In Live Preview, matches are highlighted in the rendered content when possible; if a match falls inside hidden syntax delimiters or raw formula markup, the block expands temporarily so you can see and edit it. All-match replacement (`Replace all`) is recorded as a single undo step. Search remains available in read-only mode.

### Customizing Shortcuts

Each editor instance maintains an independent command registry. Customize or disable bindings at runtime:

```ts
editor.commands.configureShortcuts({
  "format.bold": null, // disable
  "format.italic": "Mod-Shift-i", // rebind (Mod = Command on macOS, Ctrl elsewhere)
});
```

The editor checks for conflicts before applying changes. To remember user shortcuts, save the overrides you pass to `configureShortcuts` and apply them again when reopening the editor.

## Lists, Tasks & Images

- **Task lists**: Toggle task markers with `Ctrl+Shift+9` (`format.task-list`). When the cursor is on a task item or its continuation lines, toggle completion with `⌘⌥Enter` / `Ctrl+Alt+Enter` (`task.toggle-checked`) or click the checkbox directly in Live Preview.
- **Ordered list renumbering**: Run `list.renumber` (via command palette or the toolbar's More menu) inside an ordered list to normalize consecutive numbers starting from the first item's number (for example `9) A / 2) B / 2) C` becomes `9) A / 10) B / 11) C`) while preserving delimiters and nested items as one undo step.
- **Images**: Configure `saveImage` on `MarkdownEditorOptions` to persist pasted or picked image files and return a durable destination string. See [Images](../../packages/editor/README.md#images).

## Tables

Tables are backed by Markdown pipe syntax and can be edited directly in place in Live Preview or in Split/Source mode. In Live Preview, pressing `Tab` on the last cell appends a new row and moves to its first cell; pressing `Enter` on the last row moves to or continues below the table.

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Next / Previous cell | `Tab` / `Shift+Tab` | `Tab` / `Shift+Tab` |
| Row below / above (same column) | `Enter` / `Shift+Enter` | `Enter` / `Shift+Enter` |
| Move up / down in column | `⌥↑` / `⌥↓` | `Alt+↑` / `Alt+↓` |
| Insert row below / column right | `Ctrl+Shift+↓` / `Ctrl+Shift+→` | `Ctrl+Alt+↓` / `Ctrl+Alt+→` |
| Delete row / column | `⌘⌥Backspace` / `⌘⌥Shift+Backspace` | `Ctrl+Alt+Backspace` / `Ctrl+Alt+Shift+Backspace` |
| Clear cell | `⌥Shift+Backspace` | `Alt+Shift+Backspace` |

### Column Width Strategies & Persistence

Configure column sizing via `surface.table.mode` (shared with Live Preview unless `livePreview.table` is set separately):

- `"content"` (default): Sizes columns based on cell content. Use `fillRatio` to specify a minimum share of container width.
- `"adaptive"`: Distributes column widths proportionally to fit the container width.
- `"fixed"`: Uses explicit widths provided by the host.

Because Markdown files store only cell text and alignments, user-dragged column widths are editor layout metadata. To persist resized columns across file reopens, provide `resolveTableKey` and `onLayoutChange` (which emits `widths` and `pinnedColumns`), then restore them via `resolveColumnWidths` (numeric pixel values for pinned columns, `"auto"` for flexible columns).

## Focus Navigation

You can bind shortcuts to switch keyboard focus smoothly between the editor, outline, toolbar, and custom host panels:

```ts
editor.commands.configureShortcuts({
  "focus.editor": "Mod-Shift-7",
  "focus.outline": "Mod-Shift-8",
  "focus.toolbar": "Mod-Shift-0",
});
```

- When the **outline** is focused, use `↑`/`↓` to move between headings, `←`/`→` to collapse or expand branches, `Home`/`End` to jump to the ends, and `Enter` to navigate to that section in the document.
- When the **toolbar** is focused, use `←`/`→`, `Home`/`End`, and `Enter` or `Space` to activate buttons.
- Returning focus to the editor (`focus.editor`) restores the active cursor/selection in edit modes or focuses the scroll viewport in preview mode.

You can also register custom panels using `editor.registerFocusTarget("focus.<name>", containerElement)`.

## Heading Folding

Register `createHeadingFoldPlugin()` to allow collapsing sections under headings. Folding spans from the line after a root heading up to the next heading of the same or higher level. Fold state is synchronized across views and affects display only—select-all still selects hidden content, and search automatically unfolds matched sections.

## Saving & Lifecycle

`editor.value` immediately reflects unconfirmed edits in CodeMirror, whereas `editor.confirmedValue` holds the latest revision committed by the Rust/Wasm Worker. Always wait for pending input and IME composition to settle before persisting:

```ts
await editor.input.settled();
const revision = editor.revision;
const markdown = editor.confirmedValue;
await saveToHost(revision, markdown);
```

- Only mark the document as clean/saved if the document has not changed further while `saveToHost` was running.
- Both values use LF (`\n`). To recover the original line endings, read `lineEndings` from the [protocol snapshot](../architecture/protocol.md#request--response-envelopes).
- On unmount, call `editor.dispose()` followed by `worker.terminate()`.

For CSS variables, typography metrics, and safe styling rules, see [Theming & Layout Customization](theming.md).
