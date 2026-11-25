# @jot-md/editor

[English](README.md) · **简体中文**

面向浏览器环境的框架无关 Markdown 编辑器组件。主线程由 CodeMirror 6 处理输入、输入法组词、选区与撤销重做；独立的 Web Worker 运行 Rust/WebAssembly 引擎，负责增量语法解析与按视口投影渲染数据。

## 安装

```sh
npm install @jot-md/editor
```

如果原来用的是 GitHub v0.3.1 附件，换成 npm 依赖即可，原有的 `@jot-md/editor` 导入不用改。

## 快速开始（Vite + TypeScript）

### 1. 准备带明确高度的挂载容器

编辑器内部使用虚拟滚动视口，因此宿主容器需要有明确的可计算高度：

```html
<div id="editor" style="height: 80vh"></div>
<script type="module" src="/src/main.ts"></script>
```

### 2. 创建 Web Worker 入口

创建 `src/editor.worker.ts` 加载内置的 Rust/Wasm 引擎。打包工具需支持 Module Worker 并能解析 `.wasm` 资源（使用 Vite 时请设置 `worker: { format: "es" }`）：

```ts
import { bootstrapEditorWorker } from "@jot-md/editor/worker";

void bootstrapEditorWorker({
  endpoint: self,
  loadWasm: () => import("@jot-md/editor/wasm"),
});
```

### 3. 挂载 `MarkdownEditor`

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
    source: "# 我的笔记\n\n从这里开始。\n",
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

- 每个 `MarkdownEditor` 实例独占一个 Worker。在单页应用中卸载组件时，先调用 `editor.dispose()`，再调用 `worker.terminate()`。
- 请在 `await editor.open()` 完成后再调用编辑命令。

### 安全保存正文

`editor.value` 是编辑区当前的乐观文本，而 `editor.confirmedValue` 是 Rust/Wasm Worker 最近一次确认的文本。执行保存前（且输入法已结束组词时），应等待本轮输入提交完成：

```ts
await editor.input.settled();
const revision = editor.revision;
const markdown = editor.confirmedValue;
await saveDocument(revision, markdown);
```

## 编辑模式

| `mode` | 说明 |
| --- | --- |
| `live-preview` | 即时预览：在同一栏中完成渲染与原位编辑。光标所在普通块展示源码，表格直接在单元格内编辑。 |
| `split` | 默认模式：左侧为 CodeMirror 源码区，右侧为渲染视图（可通过 `surfaceMode` 指定）。 |
| `source` | 纯源码模式：仅展示 CodeMirror Markdown 编辑区。 |
| `preview` | 只读的虚拟化 Markdown 预览视图。 |
| `pretext` | 布局诊断视图：以占位块展示离屏估算高度，用于排查长文档排版尺寸。 |

打开后可通过 `await editor.setMode("live-preview")` 动态切换模式，`editor.setReadOnly(true)` 切换只读状态，`editor.setValue(markdown)` 从外部整体替换正文。

## 可选插件与富文本能力

### 数学公式（KaTeX）

推荐使用按需加载版本（首次遇到公式时才加载 KaTeX），也可使用同步版本，将其传给 `surface.renderMath`（除非另行指定，`livePreview` 会自动复用该配置）：

```ts
import { MarkdownEditor } from "@jot-md/editor";
import { createLazyKaTeXRenderer } from "@jot-md/editor/math/lazy";
// 同步加载版本：import { createKaTeXRenderer } from "@jot-md/editor/math";

const editor = new MarkdownEditor({
  root,
  session,
  surface: {
    renderMath: createLazyKaTeXRenderer(),
  },
});
```

使用 KaTeX 时，再引入 `@jot-md/editor/math.css`。如果设了 `installStyles: false`，直接引入包含编辑器和公式样式的 `@jot-md/editor/styles.css`。

### Mermaid 图表

`createMermaidPlugin` 按需渲染语言标记为 `mermaid` 的围栏代码块。需由应用传入 `load` 函数加载 Mermaid，未启用时不会打包进核心体积：

```ts
import { createMermaidPlugin } from "@jot-md/editor/mermaid";

const mermaidPlugin = createMermaidPlugin({
  load: () => import("mermaid"),
});
```

### 标题折叠

在 `plugins` 中加入 `createHeadingFoldPlugin()` 即可启用章节折叠（默认快捷键：macOS 为 `Ctrl+Shift+O`，其他平台为 `Ctrl+Alt+F`）。折叠仅影响视觉展示，不会改动原始 Markdown 文本。

### 编辑工具栏

在 `plugins` 中加入 `createToolbarPlugin()` 即可启用内置工具栏，涵盖撤销重做、格式、表格尺寸选择器、图片插入、搜索与命令面板：

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

可通过 `await editor.setPluginEnabled("toolbar", false)` 动态开关工具栏，也可以通过 `renderIcon(commandId, document)` 替换图标，或直接使用 `editor.canEdit` 和 `editor.executeCommand(id, undefined, { preserveViewport: true })` 打造外部自建工具栏。

### 文档大纲

将虚拟化标题大纲挂载到侧边栏或抽屉容器中：

```ts
import { mountOutline } from "@jot-md/editor/outline";

const outline = mountOutline(document.querySelector<HTMLElement>("#outline")!, editor, {
  rowHeight: 32,
  scrollbar: "direct", // 或 "native"
});

// 销毁面板时清理：
outline.dispose();
```

也可以通过 `createOutlinePlugin({ container, enabled: false })` 将大纲交由编辑器插件系统管理，并使用 `editor.setPluginEnabled("outline", true)` 控制显隐。

## 命令、快捷键与焦点切换

所有格式、块结构、表格、搜索和视图操作都统一注册在 `editor.commands` 中：

- **命令面板与改键界面**：调用 `editor.openCommandPalette()` 打开命令面板，或从 `@jot-md/editor/component` 导入 `mountShortcutSettings(container, editor.commands, editor.i18n)` 挂载快捷键设置面板。
- **代码调用命令**：用 `editor.canExecuteCommand(id, anchor?)` 检查当前选区是否可用，用 `editor.executeCommand(id, anchor?, options?)` 执行。
- **自定义快捷键**：通过 `editor.commands.configureShortcuts({ "format.bold": "Mod-Shift-b", "format.italic": null })` 修改或禁用绑定（`Mod` 在 macOS 对应 `Command`，其他平台对应 `Ctrl`）。
- **组件间焦点导航**：可为 `"focus.editor"`、`"focus.outline"`、`"focus.toolbar"` 绑定快捷键，或通过 `editor.registerFocusTarget("focus.properties", panelElement)` 注册应用自己的侧边面板。

<details>
<summary>内置命令 ID 一览</summary>

| 类别 | 命令 ID |
| --- | --- |
| 行内格式 | `format.bold`、`format.italic`、`format.code`、`format.strikethrough`、`format.math`、`format.link` |
| 段落、标题与列表 | `format.paragraph`、`format.heading-1`..`format.heading-6`、`format.bullet-list`、`format.ordered-list`、`format.task-list`、`format.quote`、`task.toggle-checked`、`list.renumber` |
| 插入内容 | `insert.image`、`insert.code-block`、`insert.math-block`、`insert.table`、`insert.thematic-break` |
| 表格操作 | `table.next-cell`、`table.previous-cell`、`table.cell-above`、`table.cell-below`、`table.clear-cell`、`table.insert-row-below`、`table.delete-row`、`table.insert-column-after`、`table.delete-column` |
| 搜索与替换 | `search.open`、`search.replace`、`search.next`、`search.previous`、`search.replace-next`、`search.replace-all` |
| 编辑与导航 | `history.undo`、`history.redo`、`document.goto-line`、`selection.next-occurrence`、`editor.exit-block`、`editor.insert-before` |
| 焦点与视图 | `focus.editor`、`focus.outline`、`focus.toolbar`、`mode.source`、`mode.live-preview`、`mode.preview` |
| 面板与选择器 | `command.palette`、`shortcut.settings`、`toolbar.open-heading`、`toolbar.open-table`、`toolbar.open-image`、`toolbar.open-more` |

</details>

## 图片粘贴与插入

配置 `saveImage` 钩子以接管粘贴或本地选取的图片（如上传至对象存储或写入本地目录），并通过 `resolveImageSrc` 将 Markdown 中的持久化路径转换为浏览器可加载的 URL：

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
editor.insertImage({ destination: "./images/diagram.png", alt: "架构图" });
```

多图同时粘贴或选取时会按原顺序以空格分隔插入同一行，从而安全兼容列表、引用与表格单元格，并支持一次撤销。若任意图片上传失败或被中止，整批操作不会写入正文。

## 多语言（i18n）

`locale` 默认为 `"auto"`，自动匹配浏览器语言偏好（内置 `en` 与 `zh-CN`，无匹配时回退至 `en`）。运行中可通过 `editor.setLocale("zh-CN")` 切换语言，或通过 `translations` 扩展语言与覆盖默认文案：

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

词典键名使用英文原文（详见 [phrases.ts](src/core/phrases.ts)），支持 `$1`、`$2` 等占位符。

## 多标签页撤销历史

如果应用希望在切换标签时释放后台标签的编辑器实例与 Worker，同时保留撤销/重做记录：

1. 等待 `await editor.input.settled()` 并保存 `editor.confirmedValue`。
2. 调用 `const history = editor.captureHistory()`（无可撤销记录时返回 `undefined`）并在内存中保存，随后调用 `editor.dispose()` 与 `worker.terminate()`。
3. 重新打开该标签时，将保存的快照传入 `MarkdownEditorOptions.history`。当 `documentId` 与初始 `source` 均匹配时，历史记录会自动恢复。

## 样式与排版定制

组件默认自动注入所需样式。若需由应用统一构建管理 CSS，可导入 `@jot-md/editor/styles.css`（或仅导入不含 KaTeX 的 `@jot-md/editor/core.css`），并在构造选项中设置 `installStyles: false`。

通过 `theme` 选项或运行时方法更新配色与排版参数：

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

字号、行高、内边距和代码换行方式请务必通过 `theme.layout` 或 `editor.setLayoutStyle()` 设置，确保离屏估算高度与实际 DOM 高度一致。外部字体加载完成后可调用 `await editor.invalidateLayout()` 重新测量。完整 CSS 变量与类名见 [主题与布局定制](../../docs/zh-CN/guides/theming.md)。

## 事件与子路径导出

| 需求 | 接口 |
| --- | --- |
| 监听已确认的正文变化 | `editor.onDocumentChange(({ value, revision, patch }) => ...)` |
| 监听命令执行 | `editor.onCommandExecuted(({ id, userEvent }) => ...)` |
| 监听本地输入事务 | `input.onInputTransaction` |
| 观测会话状态与耗时指标 | `editor.subscribe(...)`、`editor.events.subscribe(...)`、`observability.onOperation` |
| 表格编程操作与列宽控制 | `editor.insertTable()`、`editor.replaceTableCell()`、`editor.setTableColumnWidth()`、`editor.resetTableLayout()` |

<details>
<summary>全部子路径导出说明</summary>

| 子路径 | 用途 |
| --- | --- |
| `@jot-md/editor` | `MarkdownEditor`、核心命令、主题与布局类型、数学/Mermaid/折叠/表格辅助入口 |
| `@jot-md/editor/worker` | `bootstrapEditorWorker` |
| `@jot-md/editor/wasm` | 内置 Rust/Wasm 模块（`editor_wasm.js` 与 `.wasm`） |
| `@jot-md/editor/toolbar` | `createToolbarPlugin` |
| `@jot-md/editor/outline` | `mountOutline`、`createOutlinePlugin` |
| `@jot-md/editor/heading-fold` | `createHeadingFoldPlugin` |
| `@jot-md/editor/mermaid` | `createMermaidPlugin` |
| `@jot-md/editor/math` · `/math/lazy` | `createKaTeXRenderer`、`createLazyKaTeXRenderer` |
| `@jot-md/editor/component` · `/commands` · `/table` | 组件、命令注册表与表格命令导出 |
| `@jot-md/editor/adapter` · `/source` · `/preview` · `/render` · `/observability` | 底层会话、宿主视图、渲染运行时与可观测性接口 |
| `@jot-md/editor/styles.css` · `/core.css` · `/math.css` | 样式表文件 |

</details>

## Vite 生产构建建议

在 Vite 中打包生产应用时，请开启 ES 模块 Worker（`worker.format: "es"`）。如需优化首屏产物分块，可将 `@lezer` 与 `@codemirror` 单独拆包：

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

## 延伸阅读

- [编辑器交互与配置](../../docs/zh-CN/guides/editor.md)
- [Markdown 方言与扩展语法](../../docs/zh-CN/guides/markdown.md)
- [主题与布局定制](../../docs/zh-CN/guides/theming.md)
