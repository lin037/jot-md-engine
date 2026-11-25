# @lin037/jot-md-engine

Jot 是一个浏览器 Markdown 编辑器。CodeMirror 处理键盘输入、选区和撤销，Rust 在独立的 Worker 中解析文档。同一份源码可以原位编辑、只读预览，也可以左右对照。

## 接入

在应用目录中安装编辑器。下面用 Vite 和 TypeScript 举例。

```sh
npm install @lin037/jot-md-engine
```

从 v0.3.1 的 GitHub 附件升级时，请将已有导入路径的包名前缀从 `@jot-md/editor` 改为 `@lin037/jot-md-engine`，各子路径保持一致。

在 `index.html` 为编辑器留出高度，并加载主线程入口。

```html
<div id="editor" style="height: 80vh"></div>
<script type="module" src="/src/main.ts"></script>
```

在 `src/editor.worker.ts` 中加载包内的 Wasm。打包工具需要支持模块 Worker，并能为 Wasm 文件生成可访问的 URL。使用 Vite 构建静态站点时，将 `worker.format` 设为 `"es"`。

```ts
import { bootstrapEditorWorker } from "@lin037/jot-md-engine/worker";

void bootstrapEditorWorker({
  endpoint: self,
  loadWasm: () => import("@lin037/jot-md-engine/wasm"),
});
```

在 `src/main.ts` 中创建编辑器实例。

```ts
import { MarkdownEditor, type MarkdownEditorOptions } from "@lin037/jot-md-engine";

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

void editor.open().catch(console.error);

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    editor.dispose();
    worker.terminate();
  }
});
```

每个实例使用独立的 Worker。在单页应用里，把上例的清理操作放在组件卸载时执行。编辑命令要等 `editor.open()` 完成后再调用。

保存 Markdown 时，先在输入法选词结束后调用 `await editor.input.settled()`，再读取 `editor.confirmedValue` 与 `editor.revision`。正文确认表示 Rust 已接受这次修改，后台语法解析期间就可以写入文件。是否已经保存取决于宿主写入的结果。

## 界面语言

省略 `locale` 或传入 `"auto"`，组件会按浏览器的语言偏好依次匹配，并在偏好改变时更新界面。内置简体中文（`zh-CN`）和英语（`en`）。例如 `zh-TW` 默认显示简体中文，`en-GB` 显示英语。没有匹配项时使用英语。

```ts
const editor = new MarkdownEditor({ root, session, locale: "auto" });
languageSelect.addEventListener("change", () => editor.setLocale(languageSelect.value));
```

`editor.locale` 返回当前实际显示的语言。工具栏、命令面板、搜索、快捷键设置和大纲随当前实例切换，保留正文、选区和撤销记录。宿主有自己的语言设置时，可以直接把所选语言传给 `setLocale()`。

应用可以通过 `translations` 增加语言或覆盖内置措辞。例如传入 `translations: { fr: { Bold: "Gras", "Insert image": "Insérer une image" } }` 后，调用 `editor.setLocale("fr")` 就能使用这份词典。键是组件的英文原文，`$1`、`$2` 表示可调整顺序的参数。缺少的译文会回退到上一级语言和英语。[完整词条](./src/core/phrases.ts)

自建菜单可用 `editor.i18n.command(command).title` 读取当前语言的命令名称，使用 `editor.i18n.subscribe(refresh)` 监听切换。返回的函数用于取消监听。

## 多标签页的撤销与重做

宿主可以在切换标签时保留当前编辑器，也可以用 `editor.captureHistory()` 只保存历史快照并释放编辑器及其 Worker。

1. 完成输入法组字，等待 `editor.input.settled()`，保存正文。
2. 调用 `editor.captureHistory()`，将返回值保存在该标签的内存状态中。没有可撤销或重做的修改时返回 `undefined`。保存完成后可调用 `editor.dispose()` 和 `worker.terminate()`。
3. 回到标签时，创建新的编辑器和 Worker，将快照传给 `MarkdownEditorOptions.history`。只有文档 ID 和初始正文均匹配时才恢复历史。
4. 用户关闭标签时，删除该标签保存的快照。如果标签仍持有编辑器，先保存正文，再释放编辑器和 Worker。

应用决定标签的数量和会话的生命周期。历史快照仅供当前页面在内存中复用。需要还原选区、滚动位置或编辑模式时，宿主可与历史快照一起保存这些状态。

## 编辑模式

| `mode` | 页面显示 |
| --- | --- |
| `live-preview` | 在同一栏编辑和预览。光标所在的普通块显示源码，表格继续在单元格内编辑。 |
| `source` | 只显示 CodeMirror 源码编辑区。 |
| `preview` | 只读的 Markdown 预览。 |
| `split` | 左侧编辑、右侧显示 `surfaceMode` 指定的视图，默认是预览。 |
| `pretext` | 用占位块显示各段内容的预估高度，便于排查长文档布局。 |

打开后可用 `await editor.setMode("split")` 切换。`editor.setReadOnly(true)` 可以锁定输入。外部修改文档时调用 `editor.setValue(markdown)`。

## 命令和快捷键

表格导航、文本格式、块结构、搜索和替换通过命令注册表执行。用 `editor.openCommandPalette()` 查看命令，`editor.commands.shortcuts` 读取当前平台上的绑定。应用可挂载现成的设置面板，让用户修改和恢复快捷键。

```ts
import { mountShortcutSettings } from "@lin037/jot-md-engine/component";

const settings = mountShortcutSettings(settingsElement, editor.commands, editor.i18n);
// 面板卸载时调用 settings.dispose()。
```

`editor.replaceTableCell(offset, text)` 按源码位置替换单元格。列宽可用 `editor.setTableColumnWidth(tableId, column, width)` 和 `editor.resetTableLayout(tableId)` 控制。文本偏移量均以 UTF-16 码元计数。

### 命令和事件 API 清单

快捷键、工具栏按钮和命令面板都可调用同一个命令。自己的按钮可以先用 `editor.canExecuteCommand(id, anchor?)` 检查当前选区是否适用，再用 `editor.executeCommand(id, anchor?, options?)` 执行。省略 `anchor` 就使用当前选区。返回 `true` 表示组件接下了操作，保存文件还需等待宿主写入成功。

| 类别 | 默认命令 ID |
| --- | --- |
| 行内格式 | `format.bold`、`format.italic`、`format.code`、`format.strikethrough`、`format.math`、`format.link` |
| 段落、标题、列表 | `format.paragraph`、`format.heading-1` 至 `format.heading-6`、`format.bullet-list`、`format.ordered-list`、`format.task-list`、`format.quote`、`task.toggle-checked`、`list.renumber` |
| 插入 | `insert.image`、`insert.code-block`、`insert.math-block`、`insert.table`、`insert.thematic-break` |
| 表格 | `table.next-cell`、`table.previous-cell`、`table.cell-above`、`table.cell-below`、`table.clear-cell`、`table.insert-row-below`、`table.delete-row`、`table.insert-column-after`、`table.delete-column` |
| 搜索 | `search.open`、`search.replace`、`search.next`、`search.previous`、`search.replace-next`、`search.replace-all` |
| 编辑和导航 | `history.undo`、`history.redo`、`document.goto-line`、`selection.next-occurrence`、`editor.exit-block`、`editor.insert-before` |
| 焦点和视图 | `focus.editor`、`focus.outline`、`focus.toolbar`、`mode.source`、`mode.live-preview`、`mode.preview` |
| 面板 | `command.palette`、`shortcut.settings`、`toolbar.open-heading`、`toolbar.open-table`、`toolbar.open-image`、`toolbar.open-more` |

默认注册 56 条命令、35 个按键绑定。大纲和工具栏操作需要挂载对应 UI。启用标题折叠插件会增加 `heading-fold.toggle` 和 `heading-fold.unfold-all`。可以从 `editor.commands.commands` 和 `editor.commands.shortcuts` 读取当前实例的完整目录，包括插件与用户改键。输入文字、粘贴普通文本和输入法组词走原生输入事务。

| 想知道或接管的事情 | 接入点 | 发生时机或返回值 |
| --- | --- | --- |
| 用户执行了哪条命令 | `editor.onCommandExecuted(listener)`、构造选项 `input.onCommandExecuted` | 成功处理命令后收到 `{ id, userEvent }`，包括打开面板等 UI 操作。配置图片存储后，打开选择器和实际插入各有自己的 `userEvent`。 |
| 本地正文刚被编辑 | 构造时传 `input.onInputTransaction` | 收到编辑来源、UTF-16 替换范围、前后选区和输入法批次。此时 Worker 可能还在处理。 |
| 引擎已确认一版正文 | `editor.onDocumentChange(listener)` | 每次确认新的文档修订，收到 `{ value, revision, patch }`。只刷新预览不会触发。 |
| 命令或快捷键配置变化 | `editor.commands.subscribe(listener)` | 注册、解绑或改键后刷新宿主的命令列表。 |
| 观察解析、渲染和耗时 | `editor.subscribe(listener)`、`editor.events.subscribe(listener)`、`observability.onOperation` | 前者接收文档、分析和投影变化。后两者提供带操作 ID 的阶段快照，可按 ID 更新同一条记录。 |
| 观察每次视图提交 | `surface.onCommit`、`livePreview.onCommit` | 各视图完成一次渲染或布局提交。 |
| 接管图片、公式和链接 | `saveImage`、`resolveImageSrc`、`resolveImageMetadata`、`renderMath`、`onLink` | 前两项可配置在组件顶层。图片尺寸、公式节点和链接点击由对应的 `surface` 或 `livePreview` 选项提供。 |
| 接管表格交互和布局 | `surface.onTableCellFocus`、`surface.resolveSelectionAnchor`、两种视图的 `onTableCommand` | 提供单元格焦点、源码选区和表格命令的宿主处理。视图的 `table` 选项另有 `onColumnResize`、`onLayoutChange`、`resolveTableKey`、`resolveColumnWidths`。 |
| 接入自定义命令或面板 | `editor.commands.register / unregister / bind`、`editor.registerCommandAction`、`editor.registerFocusTarget`、`openShortcutSettings` | 命令的 `run(context)` 是纯函数，返回源码编辑或宿主动作。宿主动作可在注册时提供第三个函数以判断可用性，也可通过 `input.onCommandAction` 和 `input.canHandleAction` 处理。 |
| 插件生命周期与折叠 | `plugins[].activate`、`editor.disposeSignal`、`editor.headingFolds.subscribe` | 插件可返回卸载函数。实例销毁时 signal 中止。折叠变化只影响视图。 |
| 自定义代码块和工具栏图标 | `plugins[].codeBlocks[].render`、工具栏插件选项 `renderIcon` | 代码块按语言选择渲染函数，可用 `signal` 取消异步绘制。图标函数按命令 ID 返回节点。 |
| 诊断与错误 | `onError`、`session.onProtocolEvent`、`session.onBackgroundEffect` | 分别处理组件错误、Worker 请求与响应、后台分析变化。即时预览和观测回调可各自配置 `livePreview.onError`、`observability.onError`。 |

```ts
const stop = editor.onDocumentChange(({ value, revision }) => {
  showDocumentRevision(revision, value); // 应用自己的保存状态或预览
});
editor.executeCommand("task.toggle-checked");
stop();
```

通过 `canExecuteCommand` 可以在不移动选区的情况下检查命令。搜索和异步宿主动作仍以实际执行结果为准。订阅方法返回取消订阅函数。使用 `editor.commands.configureShortcuts`、`resetShortcuts` 或 `setShortcutDefaults` 调整当前实例的按键。调整绑定不影响已有按钮通过 ID 调用命令。

### 粘贴和插入图片

给 `MarkdownEditor` 传入 `saveImage(file, { source, signal })`。粘贴图片文件或通过「插入图片」选取文件时，组件调用它。宿主决定重命名、写入目录或上传到 OSS，再返回要写进 Markdown 的 `destination` 和可选的 `alt`。省略说明时使用文件名。默认工具栏的图片按钮支持填写图片地址，配置保存钩子后也可选择本地文件。图片插在光标处，选中文字时会替换选区。已经有地址时，可直接调用 `editor.insertImage({ destination, alt })`。

```ts
import { MarkdownEditor, type SaveEditorImage } from "@lin037/jot-md-engine";

const saveImage: SaveEditorImage = async (file, { signal }) => {
  // upload 是应用的上传接口，返回持久地址，例如 OSS URL 或 ./images/照片.png。
  const { destination } = await upload(file, { signal });
  return { destination, alt: file.name };
};

const editor = new MarkdownEditor({
  root, session, saveImage,
  // 此 Web 应用的笔记图片由 HTTP(S) 提供，相对路径以笔记所在目录为基准。
  resolveImageSrc: destination => {
    const url = new URL(destination, noteAssetsBaseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  },
});
await editor.open();
editor.insertImage({ destination: "./images/架构图 (2).png", alt: "架构图" });
```

`resolveImageSrc` 只决定显示地址，Markdown 保留宿主给出的持久地址。可返回 HTTP(S)、blob URL，或在支持的桌面宿主中显式映射到 `file://`、`asset://` 资源。返回 `undefined` 可跳过加载。普通网页读取本机文件仍取决于浏览器授予的访问权限。

同次粘贴或多选的图片按原顺序插在同一行，用空格分开，因此列表、引用和表格单元格都能保留原结构。整次插入可一次撤销。等待期间继续输入或移动光标，图片仍插入原位置。覆盖原选区、切到只读或销毁实例会中止相应的待处理操作。任一文件保存失败时整批不插入，并通过 `onError` 通知宿主。宿主可用 `signal` 停止尚未完成的上传，并自行管理已写入的文件。省略 `saveImage` 时，普通文本照常粘贴，「插入图片」仍提供手填地址的模板。

### 组件间切换焦点

支持焦点导航的版本可以在快捷键设置中为「聚焦文档大纲」「聚焦编辑工具栏」和「返回编辑器」绑定按键。也可从命令面板直接执行。三条命令默认留空，宿主可以统一指定组合键。

```ts
editor.commands.configureShortcuts({
  "focus.editor": "Mod-Shift-7",
  "focus.outline": "Mod-Shift-8",
  "focus.toolbar": "Mod-Shift-0",
});
```

大纲和工具栏需要挂载在当前编辑器上。回到正文时保留编辑模式和当前选区，只读预览会聚焦正文视口。

应用自己的面板也可以注册焦点命令。命令 ID 使用 `focus.` 前缀，命令执行时以同一个 ID 请求聚焦。

```ts
propertiesPanel.tabIndex = -1;
editor.commands.register({
  id: "focus.properties",
  title: "聚焦属性面板",
  requiresInput: false,
  run: () => ({ action: "focus.properties", userEvent: "command.focus.properties" }),
});
const unbindProperties = editor.registerFocusTarget("focus.properties", propertiesPanel);
```

`registerFocusTarget` 的第三个参数可以返回要聚焦的控件。焦点在面板内时也能使用已绑定的焦点命令。面板卸载时调用 `unbindProperties()`。

## 样式和布局

默认样式随组件注入。要由应用统一加载编辑器样式，可导入 `@lin037/jot-md-engine/styles.css`，并在构造选项中设置 `installStyles: false`。只需基础样式时可改用 `@lin037/jot-md-engine/core.css`。

```ts
await editor.setTheme({
  colors: { background: "#fff", text: "#24292f", link: "var(--brand-link)" },
  layout: { fontSize: 16, metrics: { paragraphLineHeight: 26 } },
});
await editor.setLayoutStyle({ codeBlockWrap: "wrap" });
```

颜色可以使用宿主的 CSS 变量。行高、字号和间距也会影响离屏内容的估高，通过 `theme.layout` 或 `setLayoutStyle` 修改可同步更新预览和布局估算。外部字体加载后可调用 `await editor.invalidateLayout()` 触发重新测量。

## 可选功能

- **公式**。从 `@lin037/jot-md-engine/math/lazy` 导入 `createLazyKaTeXRenderer`，把 `createLazyKaTeXRenderer()` 传给 `surface.renderMath`。KaTeX 首次遇到公式时才加载。同步版本位于 `@lin037/jot-md-engine/math`。两种方式都需要 `math.css` 或已包含公式样式的 `styles.css`。
- **Mermaid**。从 `@lin037/jot-md-engine/mermaid` 导入 `createMermaidPlugin`，把插件加入 `plugins`。应用提供 `load` 函数加载自己的 Mermaid 依赖，渲染器只处理标记为 Mermaid 的代码块。
- **标题折叠**。从 `@lin037/jot-md-engine/heading-fold` 导入 `createHeadingFoldPlugin`，把 `createHeadingFoldPlugin()` 加入 `plugins`。点击标题旁的按钮可以折叠章节。macOS 默认按 Control–Shift–O，其他平台按 Ctrl–Alt–F。折叠状态只影响显示，源文本完整保留。
- **编辑工具栏**。从 `@lin037/jot-md-engine/toolbar` 导入 `createToolbarPlugin`，把 `createToolbarPlugin()` 加入 `plugins`。工具栏用图标提供撤销、重做、正文格式、搜索和命令面板。标题菜单支持 H1–H6。表格可点选格子，也可输入行列数，行数包含表头（1–100 行、1–50 列）。只读时禁用修改正文的按钮，搜索仍可用。宿主也可用 `editor.insertTable({ rows: 4, columns: 3 })` 在当前选区插入指定尺寸的表格。

```ts
import { createToolbarPlugin } from "@lin037/jot-md-engine/toolbar";

const editor = new MarkdownEditor({
  root,
  session,
  plugins: [createToolbarPlugin({ enabled: false })],
});
await editor.open();
await editor.setPluginEnabled("toolbar", true);
```

无需工具栏时可以省略该导入和插件注册。开启后可用 `setPluginEnabled("toolbar", false)` 卸载工具栏，样式可通过 `.jot-editor-toolbar` 和 `.jot-editor-toolbar__button` 定制。

任务列表按钮紧邻无序和有序列表。标题菜单可切回正文。「更多」按文字格式、列表操作和插入内容分组，显示当前快捷键。用 ↑↓ 选择、Enter 执行、Esc 返回。表格网格可用方向键选择，展开「自定义尺寸」可输入更大的行列数。链接命令在现有链接内选中地址以便修改。插入表格或分隔线时，若已有选区，新块放在最后一条选中行之后。

### 自定义工具栏

用 `className` 加自定义样式，用 `groups` 按命令 ID 选择和排列按钮，用 `renderIcon(command, document)` 返回自己的图标节点。返回 `undefined` 时使用内置图标，未配图标的自定义命令显示命令名称。

```ts
createToolbarPlugin({
  className: "notes-toolbar",
  groups: [
    ["history.undo", "history.redo"],
    ["toolbar.open-heading", "format.bold", "toolbar.open-table"],
    ["search.open"],
  ],
});
```

```css
.notes-toolbar {
  --jot-toolbar-background: #eef5f1;
  --jot-toolbar-text: #22352e;
  --jot-toolbar-accent: #08795e;
  --jot-toolbar-button-size: 38px;
  --jot-toolbar-icon-size: 18px;
}
```

也可省略工具栏插件，在挂载点外渲染自己的按钮。用 `editor.canEdit` 判断编辑按钮当前可用性，鼠标按下时保留编辑区选区，点击时执行同一个命令。

```ts
boldButton.addEventListener("mousedown", (event) => {
  if (event.button === 0) event.preventDefault();
});
boldButton.addEventListener("click", () => {
  if (editor.canEdit && editor.executeCommand("format.bold", undefined, { preserveViewport: true })) {
    editor.focus();
  }
});
```

自建表格选择器可调用 `editor.insertTable({ rows, columns }, { preserveViewport: true })`，搜索按钮可调用 `editor.openSearch()`。快捷键设置包含所有已注册命令，未分配的快捷键可以直接填写。也可以用 `editor.commands.configureShortcuts({ "toolbar.open-table": "Mod-Alt-t", "format.strikethrough": "Mod-Alt-s" })` 配置。选择器命令是 `toolbar.open-heading`、`toolbar.open-table`、`toolbar.open-image` 和 `toolbar.open-more`。

需要直接管理会话或观察渲染耗时时，可分别从 `@lin037/jot-md-engine/adapter` 和 `@lin037/jot-md-engine/observability` 导入对应接口。自定义输入、预览和 Worker 时使用 `/source`、`/preview`、`/render`、`/worker` 子路径。


### 文档大纲

大纲按正文标题的层级显示目录，点击标题可跳到正文。使用提供 `@lin037/jot-md-engine/outline` 入口的编辑器版本，在侧栏、抽屉或其他位置准备一个容器，例如 `<aside id="outline"></aside>`。

```ts
import { mountOutline } from "@lin037/jot-md-engine/outline";

const sidebar = document.querySelector<HTMLElement>("#outline")!;
const outline = mountOutline(sidebar, editor);
```

移除面板或切换绑定的编辑器前，调用 `outline.dispose()`。销毁编辑器时会自动解除绑定。

也可以从同一入口导入 `createOutlinePlugin`，把 `createOutlinePlugin({ container: sidebar, enabled: false })` 加入编辑器的 `plugins`。打开编辑器后，调用 `await editor.setPluginEnabled("outline", true)` 显示大纲，传 `false` 关闭。省略 `enabled` 时默认开启。

`mountOutline` 的第三个参数和 `createOutlinePlugin` 的配置共用以下选项。

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `rowHeight` | `32` | 每行高度，单位为 CSS 像素。 |
| `scrollbar` | `"direct"` | 点击轨道按比例跳转，拖动滑块滚动。传 `"native"` 使用浏览器原生滚动条。 |
| `label` | 随组件语言显示「文档大纲」或相应译文 | 大纲的无障碍名称。指定后使用宿主传入的文字。 |
| `onError` | — | 处理加载大纲或跳转时抛出的异常。 |

多个大纲面板可分别折叠子标题。大纲从容器继承字体和文字颜色。`--jot-outline-max-height` 和 `--jot-outline-indent` 分别控制高度上限和每级缩进。`--jot-outline-accent` 设置当前章节的文字颜色，`--jot-outline-highlight` 设置当前章节和悬停项的背景色。

## 自定义样式

给安装点加上自己的 class，例如 `root.classList.add("notes-editor")`，再在 `.notes-editor` 上设置 `--jot-background`、`--jot-text-color` 和 `--jot-link-color`。用 `.notes-editor .jot-md-heading` 改标题颜色，表格按钮可用 `.jot-table-toolbar__button`。需要运行时更新颜色时调用 `setTheme({ colors: { link: "#086c60" } })`。

几何变化走 `setLayoutStyle({ fontSize: 16, metrics: { paragraphLineHeight: 26, blankLineHeight: 26 } })`。让宿主为挂载点分配可计算的高度。若直接覆盖 `.cm-line` 的边距、虚拟占位尺寸、表格列宽或编辑器内部滚动方式，离屏估算会与真实尺寸分开，出现空白和滚动跳动。

## Vite 生产分包

编辑器 npm 包提供组件模块和独立的 Worker/Wasm 资源。应用的 Vite 配置决定主线程 JS 怎样分块。Vite 8 的默认提示按单块的未 gzip 大小计算。需要控制块大小时，可以把 CodeMirror 和 Lezer 单独分组。[Vite 构建配置](https://v8.vite.dev/config/build-options#build-chunksizewarninglimit)

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

这段配置调整初始模块的分组。计算下载量时，合计入口加载的所有 JS，并把 Worker 和 Wasm 分开统计。
