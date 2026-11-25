# 编辑器配置与交互

[English](../../guides/editor.md) · **简体中文**

本文介绍 `MarkdownEditor` 的编辑模式、键盘快捷键、搜索替换、表格操作、标题折叠、大纲导航、焦点切换与安全保存机制。安装与插件接入示例见[组件接入指南](package.md)。

## 编辑模式

`MarkdownEditor` 默认使用双栏模式 `split`（左侧 CodeMirror 源码，右侧渲染视图）。如需单栏原位编辑可传入 `mode: "live-preview"`；纯源码编辑可使用 `"source"`；只读渲染可使用 `"preview"`。

## 键盘快捷键与搜索

在编辑器内打开命令面板（`Ctrl+Shift+P`）即可按名称或命令 ID 查找操作，也可打开快捷键设置面板。下表中 macOS 的 `Ctrl` 指 Control（`⌃`），`⌘` 指 Command，`⌥` 指 Option。

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 打开命令面板 | `Ctrl+Shift+P` | `Ctrl+Shift+P` |
| 查找 / 替换 | `⌘F` / `Ctrl+Shift+H` | `Ctrl+F` / `Ctrl+Shift+H` |
| 下一个 / 上一个匹配 | `Ctrl+G` / `Ctrl+Shift+G` | `F3` / `Shift+F3` |
| 跳转到源码行 | `Ctrl+Shift+L` | `Ctrl+Alt+G` |
| 选中下一个相同文本 | `Ctrl+Shift+D` | `Ctrl+D` |
| 撤销 / 重做 | `⌘Z` / `⌘Shift+Z` | `Ctrl+Z` / `Ctrl+Shift+Z` |
| 在当前块后 / 前继续编辑 | `⌘Enter` / `⌘Shift+Enter` | `Ctrl+Enter` / `Ctrl+Shift+Enter` |
| 切换到即时预览 | `Ctrl+Shift+E` | `Ctrl+E` |
| 加粗 / 斜体 | `⌘B` / `⌘I` | `Ctrl+B` / `Ctrl+I` |
| 行内代码 / 插入链接 | `Ctrl+Shift+C` / `Ctrl+Shift+K` | `` Ctrl+` `` / `Ctrl+K` |
| 切换任务列表 | `Ctrl+Shift+9` | `Ctrl+Shift+9` |
| 切换任务完成状态 | `⌘⌥Enter` | `Ctrl+Alt+Enter` |
| 设置 1 至 6 级标题 | `Ctrl+Shift+1`..`6` | `Ctrl+Alt+1`..`6` |
| 折叠 / 展开当前标题（需启用插件） | `Ctrl+Shift+O` | `Ctrl+Alt+F` |

### 搜索与替换

搜索直接针对 Markdown 源码进行。在即时预览模式下，系统会优先高亮已渲染内容；若命中隐藏标记或公式内部源码，会自动临时展开对应块以便查看与编辑。全部替换可一次撤销，只读模式下同样支持查找。

### 自定义快捷键

每个编辑器实例拥有独立的命令注册表，可在运行时修改或禁用快捷键：

```ts
editor.commands.configureShortcuts({
  "format.bold": null, // 禁用加粗快捷键
  "format.italic": "Mod-Shift-i", // 修改绑定（Mod 在 macOS 为 Command，其余平台为 Ctrl）
});
```

编辑器应用改键前会检查冲突。要记住用户改过的键位，保存传给 `configureShortcuts` 的配置，下次打开时再传一次。

## 列表、任务与图片

- **任务列表**：选中行后按 `Ctrl+Shift+9`（`format.task-list`）添加或移除任务标记；光标位于任务项或其续行时，按 `⌘⌥Enter` / `Ctrl+Alt+Enter`（`task.toggle-checked`）或直接在即时预览中点击复选框即可切换完成状态。
- **重排有序列表编号**：在有序列表项内通过命令面板或工具栏执行 `list.renumber`，即可从首项序号开始自动顺延编号（例如 `9) A / 2) B / 2) C` 变为 `9) A / 10) B / 11) C`），同时保留原有分隔符与嵌套结构，支持一次撤销。
- **图片处理**：通过 `MarkdownEditorOptions.saveImage` 接入持久化上传或落盘逻辑，详见[图片粘贴与插入](package.md#图片粘贴与插入)。

## 表格交互与列宽

表格基于标准 Markdown 管道语法，支持在即时预览中直接点击单元格编辑。在即时预览末格按 `Tab` 会自动新增一行并聚焦新行首格，在末行按 `Enter` 可继续向下移动或离开表格。

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 下一格 / 上一格 | `Tab` / `Shift+Tab` | `Tab` / `Shift+Tab` |
| 下一行同列 / 上一行同列 | `Enter` / `Shift+Enter` | `Enter` / `Shift+Enter` |
| 同列向上 / 向下 | `⌥↑` / `⌥↓` | `Alt+↑` / `Alt+↓` |
| 在下方插入行 / 在右方插入列 | `Ctrl+Shift+↓` / `Ctrl+Shift+→` | `Ctrl+Alt+↓` / `Ctrl+Alt+→` |
| 删除行 / 删除列 | `⌘⌥Backspace` / `⌘⌥Shift+Backspace` | `Ctrl+Alt+Backspace` / `Ctrl+Alt+Shift+Backspace` |
| 清空当前单元格 | `⌥Shift+Backspace` | `Alt+Shift+Backspace` |

### 列宽策略与持久化

通过 `surface.table.mode` 配置列宽策略（未单独配置 `livePreview.table` 时两者共享）：

- `"content"`（默认）：按单元格内容自适应宽度，可搭配 `fillRatio` 指定最小占宽比。
- `"adaptive"`：按容器可用宽度比例分配列宽。
- `"fixed"`：完全采用宿主指定的固定列宽。

Markdown 文件本身只保存文本与对齐标记。如果希望重新打开文件后恢复用户拖拽调整过的列宽，可通过 `resolveTableKey` 为表格提供稳定标识，监听 `onLayoutChange` 保存 `widths` 与 `pinnedColumns`，并在重新打开时通过 `resolveColumnWidths` 返回（固定列传像素值，自适应列传 `"auto"`）。

## 组件间焦点导航

宿主可以为编辑器正文、文档大纲和工具栏配置焦点切换快捷键：

```ts
editor.commands.configureShortcuts({
  "focus.editor": "Mod-Shift-7",
  "focus.outline": "Mod-Shift-8",
  "focus.toolbar": "Mod-Shift-0",
});
```

- **大纲聚焦后**：`↑`/`↓` 切换可见标题，`←`/`→` 收起或展开子标题，`Home`/`End` 跳至首尾，`Enter` 跳转到对应正文位置。
- **工具栏聚焦后**：`←`/`→`、`Home`/`End` 移动焦点，`Enter` 或 `Space` 执行操作。
- **返回编辑器**（`focus.editor`）：在编辑模式下恢复光标与选区，在只读预览模式下聚焦滚动视口。

应用自身的扩展面板也可以通过 `editor.registerFocusTarget("focus.<name>", panelElement)` 接入同一套焦点快捷键体系。

## 标题折叠

注册 `createHeadingFoldPlugin()` 即可启用标题折叠。折叠范围从标题下一行起至下一个同级或更高级标题之前。折叠状态在各视图间同步且仅影响显示，全选仍包含已折叠内容，搜索命中折叠区时会自动展开。

## 安全保存与实例生命周期

`editor.value` 反映 CodeMirror 中尚未确认的当前文本，而 `editor.confirmedValue` 才是 Rust/Wasm 引擎已确认的最新文本。执行保存前（并确保输入法已结束选词），请先等待本轮编辑提交：

```ts
await editor.input.settled();
const revision = editor.revision;
const markdown = editor.confirmedValue;
await saveToHost(revision, markdown);
```

- 仅当写入成功后且期间未产生新修改时，才将界面标记为“已保存”。
- 这两个值都用 LF（`\n`）换行。需要还原原文件的换行符时，从[协议快照](../architecture/protocol.md#请求与响应信封)读取 `lineEndings`。
- 组件卸载或页面关闭时，先调用 `editor.dispose()` 清理监听与视图，再调用 `worker.terminate()` 释放 Worker。

关于 CSS 变量、排版尺寸与样式定制，请阅读[主题与排版定制](theming.md)。
