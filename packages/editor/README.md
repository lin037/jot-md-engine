# @jot-md/editor

Jot 是一个浏览器 Markdown 编辑器。CodeMirror 处理键盘输入、选区和撤销，Rust 在独立的 Worker 中解析文档。同一份源码可以原位编辑、只读预览，也可以左右对照。

## 接入

在应用目录中安装编辑器。下面用 Vite 和 TypeScript 举例。

```sh
npm install https://github.com/lin037/jot-md-engine/releases/download/v0.1.0/jot-md-editor-0.1.0.tgz
```

在 `index.html` 为编辑器留出高度，并加载主线程入口。

```html
<div id="editor" style="height: 80vh"></div>
<script type="module" src="/src/main.ts"></script>
```

在 `src/editor.worker.ts` 中加载包内的 Wasm。打包工具需要支持模块 Worker，并能为 Wasm 文件生成可访问的 URL。使用 Vite 构建静态站点时，将 `worker.format` 设为 `"es"`。

```ts
import { bootstrapEditorWorker } from "@jot-md/editor/worker";

void bootstrapEditorWorker({
  endpoint: self,
  loadWasm: () => import("@jot-md/editor/wasm"),
});
```

在 `src/main.ts` 中创建编辑器实例。

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
import { mountShortcutSettings } from "@jot-md/editor/component";

const settings = mountShortcutSettings(settingsElement, editor.commands);
// 面板卸载时调用 settings.dispose()。
```

`editor.replaceTableCell(offset, text)` 按源码位置替换单元格。列宽可用 `editor.setTableColumnWidth(tableId, column, width)` 和 `editor.resetTableLayout(tableId)` 控制。文本偏移量均以 UTF-16 码元计数。

## 样式和布局

默认样式随组件注入。要由应用统一加载编辑器样式，可导入 `@jot-md/editor/styles.css`，并在构造选项中设置 `installStyles: false`。只需基础样式时可改用 `@jot-md/editor/core.css`。

```ts
await editor.setTheme({
  colors: { background: "#fff", text: "#24292f", link: "var(--brand-link)" },
  layout: { fontSize: 16, metrics: { paragraphLineHeight: 26 } },
});
await editor.setLayoutStyle({ codeBlockWrap: "wrap" });
```

颜色可以使用宿主的 CSS 变量。行高、字号和间距也会影响离屏内容的估高，通过 `theme.layout` 或 `setLayoutStyle` 修改可同步更新预览和布局估算。外部字体加载后可调用 `await editor.invalidateLayout()` 触发重新测量。

## 可选功能

- **公式**。从 `@jot-md/editor/math/lazy` 导入 `createLazyKaTeXRenderer`，把 `createLazyKaTeXRenderer()` 传给 `surface.renderMath`。KaTeX 首次遇到公式时才加载。同步版本位于 `@jot-md/editor/math`。两种方式都需要 `math.css` 或已包含公式样式的 `styles.css`。
- **Mermaid**。从 `@jot-md/editor/mermaid` 导入 `createMermaidPlugin`，把插件加入 `plugins`。应用提供 `load` 函数加载自己的 Mermaid 依赖，渲染器只处理标记为 Mermaid 的代码块。
- **标题折叠**。从 `@jot-md/editor/heading-fold` 导入 `createHeadingFoldPlugin`，把 `createHeadingFoldPlugin()` 加入 `plugins`。点击标题旁的按钮可以折叠章节。macOS 默认按 Control–Shift–O，其他平台按 Ctrl–Alt–F。折叠状态只影响显示，源文本完整保留。

需要直接管理会话或观察渲染耗时时，可分别从 `@jot-md/editor/adapter` 和 `@jot-md/editor/observability` 导入对应接口。自定义输入、预览和 Worker 时使用 `/source`、`/preview`、`/render`、`/worker` 子路径。


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
