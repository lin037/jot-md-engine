# @jot-md/editor

**English** · [简体中文](https://github.com/lin037/jot-md-engine/blob/main/docs/zh-CN/guides/package.md)

A framework-neutral, Rust/WebAssembly-powered Markdown editor component for the browser. CodeMirror 6 handles typing, IME composition, selections, and undo/redo on the main thread, while a Rust engine running inside a Web Worker parses Markdown incrementally and projects only the visible viewport.

## Installation

```sh
npm install @jot-md/editor
```

Upgrading from the v0.3.1 GitHub download? Switch the dependency to npm and keep your existing `@jot-md/editor` imports.

## Quick Start (Vite + TypeScript)

### 1. Create a container with an explicit height

The editor uses an internal virtualized scroll container, so its host element must have a bounded height:

```html
<div id="editor" style="height: 80vh"></div>
<script type="module" src="/src/main.ts"></script>
```

### 2. Create the Web Worker entry

Create `src/editor.worker.ts` to host the bundled Rust/Wasm engine. Your bundler must support module Workers and resolve `.wasm` assets (in Vite, set `worker: { format: "es" }`):

```ts
import { bootstrapEditorWorker } from "@jot-md/editor/worker";

void bootstrapEditorWorker({
  endpoint: self,
  loadWasm: () => import("@jot-md/editor/wasm"),
});
```

### 3. Mount `MarkdownEditor`

```ts
import { MarkdownEditor, type MarkdownEditorOptions } from "@jot-md/editor";

type DocumentId = MarkdownEditorOptions["session"]["documentId"];

const worker = new Worker(new URL("./editor.worker.ts", import.meta.url), {
  type: "module",
});

const editor = new MarkdownEditor({
  root: document.querySelector<HTMLElement>("#editor")!,
  mode: "live-preview",
  session: {
    endpoint: worker,
    documentId: "note" as DocumentId,
    generation: 1,
    source: "# My Note\n\nStart writing here.\n",
    syntaxProfile: { id: "default", version: 1, enabledExtensions: [] },
  },
  onError: console.error,
});

await editor.open();

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    editor.dispose();
    worker.terminate();
  }
});
```

- Each `MarkdownEditor` instance expects its own Worker. Call `editor.dispose()` followed by `worker.terminate()` when unmounting in a single-page application.
- Wait for `await editor.open()` before invoking editing commands.

### Saving Safely

`editor.value` reflects the latest optimistic text in CodeMirror, while `editor.confirmedValue` reflects the latest text committed by the Rust/Wasm Worker. Before persisting a document (once any active IME composition finishes), wait for pending input to settle:

```ts
await editor.input.settled();
const revision = editor.revision;
const markdown = editor.confirmedValue;
await saveDocument(revision, markdown);
```

## Editor Modes

| Mode | Description |
| --- | --- |
| `live-preview` | Inline rich editing in a single pane. The active block reveals raw syntax while tables remain editable in place. |
| `split` | Default mode. Side-by-side CodeMirror source on the left and a rendered surface on the right (controlled by `surfaceMode`). |
| `source` | Plain CodeMirror Markdown source editor. |
| `preview` | Read-only virtualized Markdown preview. |
| `pretext` | Diagnostic layout view rendering estimated block heights prior to DOM measurement. |

Switch modes at runtime with `await editor.setMode("live-preview")`, lock editing with `editor.setReadOnly(true)`, or replace the entire document externally with `editor.setValue(markdown)`.

## Optional Plugins & Rich Content

### Math (KaTeX)

Use the lazy renderer (loads KaTeX on first math block/inline formula) or the eager renderer, and pass it to `surface.renderMath` (also shared with `livePreview` unless overridden):

```ts
import { MarkdownEditor } from "@jot-md/editor";
import { createLazyKaTeXRenderer } from "@jot-md/editor/math/lazy";
// Or eager: import { createKaTeXRenderer } from "@jot-md/editor/math";

const editor = new MarkdownEditor({
  root,
  session,
  surface: {
    renderMath: createLazyKaTeXRenderer(),
  },
});
```

For KaTeX, import `@jot-md/editor/math.css` alongside the default editor styles. If you set `installStyles: false`, import `@jot-md/editor/styles.css` for both.

### Mermaid Diagrams

`createMermaidPlugin` renders `mermaid` fenced code blocks lazily. Supply your own `load` function so Mermaid is never bundled unless you use it:

```ts
import { createMermaidPlugin } from "@jot-md/editor/mermaid";

const mermaidPlugin = createMermaidPlugin({
  load: () => import("mermaid"),
});
```

### Heading Folding

Add `createHeadingFoldPlugin()` to `plugins` to fold and unfold sections under headings (default shortcut: `Ctrl+Shift+O` on macOS, `Ctrl+Alt+F` elsewhere). Folding affects only display; the underlying Markdown source remains untouched.

### Toolbar

Add `createToolbarPlugin()` to `plugins` for a customizable formatting, table, image, search, and command-palette toolbar:

```ts
import { createToolbarPlugin } from "@jot-md/editor/toolbar";

const editor = new MarkdownEditor({
  root,
  session,
  plugins: [
    createToolbarPlugin({
      className: "my-toolbar",
      groups: [
        ["history.undo", "history.redo"],
        ["toolbar.open-heading", "format.bold", "toolbar.open-table"],
        ["search.open"],
      ],
    }),
  ],
});
```

Toggle plugins dynamically with `await editor.setPluginEnabled("toolbar", false)`. You can also supply `renderIcon(commandId, document)` or build your own external buttons using `editor.canEdit` and `editor.executeCommand(id, undefined, { preserveViewport: true })`.

### Document Outline

Mount an interactive, virtualized heading outline into any container (sidebar, drawer, etc.):

```ts
import { mountOutline } from "@jot-md/editor/outline";

const outline = mountOutline(document.querySelector<HTMLElement>("#outline")!, editor, {
  rowHeight: 32,
  scrollbar: "direct", // or "native"
});

// Clean up when removing the panel:
outline.dispose();
```

Or manage its lifecycle through `createOutlinePlugin({ container, enabled: false })` and toggle it via `editor.setPluginEnabled("outline", true)`.

## Commands, Shortcuts & Focus

All formatting, block structure, table, search, and view operations go through `editor.commands`:

- **Command palette & shortcut UI**: Call `editor.openCommandPalette()`, or mount the built-in shortcut editor with `mountShortcutSettings(container, editor.commands, editor.i18n)` from `@jot-md/editor/component`.
- **Programmatic execution**: Check applicability with `editor.canExecuteCommand(id, anchor?)` and execute with `editor.executeCommand(id, anchor?, options?)`.
- **Custom keybindings**: Update bindings via `editor.commands.configureShortcuts({ "format.bold": "Mod-Shift-b", "format.italic": null })` (`Mod` resolves to `Command` on macOS and `Ctrl` elsewhere).
- **Focus navigation**: Bind `"focus.editor"`, `"focus.outline"`, and `"focus.toolbar"`, or register your own panels via `editor.registerFocusTarget("focus.properties", panelElement)`.

<details>
<summary>Built-in command IDs</summary>

| Category | Command IDs |
| --- | --- |
| Inline formatting | `format.bold`, `format.italic`, `format.code`, `format.strikethrough`, `format.math`, `format.link` |
| Blocks & lists | `format.paragraph`, `format.heading-1`..`format.heading-6`, `format.bullet-list`, `format.ordered-list`, `format.task-list`, `format.quote`, `task.toggle-checked`, `list.renumber` |
| Insertions | `insert.image`, `insert.code-block`, `insert.math-block`, `insert.table`, `insert.thematic-break` |
| Table | `table.next-cell`, `table.previous-cell`, `table.cell-above`, `table.cell-below`, `table.clear-cell`, `table.insert-row-below`, `table.delete-row`, `table.insert-column-after`, `table.delete-column` |
| Search & replace | `search.open`, `search.replace`, `search.next`, `search.previous`, `search.replace-next`, `search.replace-all` |
| Editing & navigation | `history.undo`, `history.redo`, `document.goto-line`, `selection.next-occurrence`, `editor.exit-block`, `editor.insert-before` |
| Focus & view | `focus.editor`, `focus.outline`, `focus.toolbar`, `mode.source`, `mode.live-preview`, `mode.preview` |
| Panels & pickers | `command.palette`, `shortcut.settings`, `toolbar.open-heading`, `toolbar.open-table`, `toolbar.open-image`, `toolbar.open-more` |

</details>

## Images

Provide `saveImage` to persist pasted or picked image files (for example, uploading to object storage or writing to disk) and `resolveImageSrc` to map Markdown destinations to browser-loadable URLs:

```ts
const editor = new MarkdownEditor({
  root,
  session,
  async saveImage(file, { signal }) {
    const { destination } = await uploadImage(file, { signal });
    return { destination, alt: file.name };
  },
  resolveImageSrc(destination) {
    const url = new URL(destination, noteAssetsBaseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  },
});

await editor.open();
editor.insertImage({ destination: "./images/diagram.png", alt: "Architecture" });
```

Multiple pasted or picked images are inserted inline in order, separated by spaces, preserving list, quote, and table cell structure with a single undo step. If any upload fails or is aborted, none of the images in that batch are inserted.

## Internationalization (i18n)

`locale` defaults to `"auto"` (matching `navigator.languages` against built-in `en` and `zh-CN`, falling back to `en`). Switch languages at runtime with `editor.setLocale("zh-CN")`, or supply custom dictionaries via `translations`:

```ts
const editor = new MarkdownEditor({
  root,
  session,
  locale: "fr",
  translations: {
    fr: {
      Bold: "Gras",
      "Insert image": "Insérer une image",
    },
  },
});
```

Dictionary keys are the English source strings (see [phrases.ts](src/core/phrases.ts)), with `$1`, `$2`, ... for positional placeholders.

## Multi-Tab History

To release editor instances and Workers for background tabs while preserving undo/redo:

1. Wait for `await editor.input.settled()` and save `editor.confirmedValue`.
2. Call `const history = editor.captureHistory()` (returns `undefined` if there is no history) and store it per tab in memory, then call `editor.dispose()` and `worker.terminate()`.
3. When reopening the tab, pass `history` in `MarkdownEditorOptions`. History is restored automatically when both `documentId` and initial `source` match.

## Styling & Layout

Styles are injected automatically by default. To bundle CSS yourself, import `@jot-md/editor/styles.css` (or `@jot-md/editor/core.css` without KaTeX) and pass `installStyles: false`.

Update colors and layout metrics via `theme` options or at runtime:

```ts
await editor.setTheme({
  colors: {
    background: "#ffffff",
    text: "#24292f",
    link: "var(--brand-link)",
  },
  layout: {
    fontFamily: "system-ui, sans-serif",
    fontSize: 16,
    codeBlockWrap: "wrap",
    metrics: { paragraphLineHeight: 26 },
  },
});
```

Always use `theme.layout` or `editor.setLayoutStyle()` for font size, line height, and padding so that off-screen height estimation stays aligned with rendered DOM lines. After loading custom web fonts, call `await editor.invalidateLayout()`. See [Theming & Layout](../../docs/guides/theming.md) for all CSS variables and selectors.

## Events & Subpath Exports

| Need | API |
| --- | --- |
| Confirmed Markdown changes | `editor.onDocumentChange(({ value, revision, patch }) => ...)` |
| Executed commands | `editor.onCommandExecuted(({ id, userEvent }) => ...)` |
| Local input transactions | `input.onInputTransaction` |
| Session effects & diagnostics | `editor.subscribe(...)`, `editor.events.subscribe(...)`, `observability.onOperation` |
| Table programmatic edits & widths | `editor.insertTable()`, `editor.replaceTableCell()`, `editor.setTableColumnWidth()`, `editor.resetTableLayout()` |

<details>
<summary>All package subpath exports</summary>

| Subpath | Purpose |
| --- | --- |
| `@jot-md/editor` | `MarkdownEditor`, core commands, theme/layout types, math/mermaid/heading-fold/table helpers |
| `@jot-md/editor/worker` | `bootstrapEditorWorker` |
| `@jot-md/editor/wasm` | Bundled Rust/Wasm module (`editor_wasm.js` + `.wasm`) |
| `@jot-md/editor/toolbar` | `createToolbarPlugin` |
| `@jot-md/editor/outline` | `mountOutline`, `createOutlinePlugin` |
| `@jot-md/editor/heading-fold` | `createHeadingFoldPlugin` |
| `@jot-md/editor/mermaid` | `createMermaidPlugin` |
| `@jot-md/editor/math` · `/math/lazy` | `createKaTeXRenderer`, `createLazyKaTeXRenderer` |
| `@jot-md/editor/component` · `/commands` · `/table` | Component, command registry, and table command exports |
| `@jot-md/editor/adapter` · `/source` · `/preview` · `/render` · `/observability` | Low-level session, hosts, runtime, and telemetry |
| `@jot-md/editor/styles.css` · `/core.css` · `/math.css` | Stylesheets |

</details>

## Bundler Configuration (Vite)

When bundling for production with Vite, configure ES module Workers (`worker.format: "es"`). Optionally group `@lezer` and `@codemirror` into separate chunks to keep the main entry bundle small:

```js
export default {
  worker: { format: "es" },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "parser-vendor", test: /node_modules[\\/]@lezer[\\/]/, tags: ["$initial"], priority: 2 },
            { name: "editor-vendor", test: /node_modules[\\/]@codemirror[\\/]/, tags: ["$initial"], priority: 1 },
          ],
        },
      },
    },
  },
};
```

## Further Reading

- [Editor Interaction & Configuration](../../docs/guides/editor.md)
- [Markdown Dialect & Extensions](../../docs/guides/markdown.md)
- [Theming & Layout Customization](../../docs/guides/theming.md)
