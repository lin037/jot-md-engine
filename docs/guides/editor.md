# 编辑器交互与配置

`MarkdownEditor` 默认使用双栏模式 `split`，左侧是 CodeMirror 源码，右侧是预览。Demo 启动时显式选择 `live-preview`，可以在同一块区域看排版、放光标和修改正文。`source` 只显示源码，`preview` 只读。`pretext` 显示组件预布局，用来检查渲染前估算的内容尺寸。[组件接口](../../packages/editor/README.md)

## 键盘与搜索

在编辑器内打开命令面板，可以按名称或命令 ID 查找操作，也可以进入“快捷键设置”。macOS 一栏的 `Ctrl` 指 Control（⌃），`⌘` 指 Command，`⌥` 指 Option。

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 打开命令面板 | Ctrl+Shift+P | Ctrl+Shift+P |
| 查找 / 替换 | ⌘F / Ctrl+Shift+H | Ctrl+F / Ctrl+Shift+H |
| 下一个 / 上一个匹配 | Ctrl+G / Ctrl+Shift+G | F3 / Shift+F3 |
| 跳到源码行 | Ctrl+Shift+L | Ctrl+Alt+G |
| 选中下一个相同文本 | Ctrl+Shift+D | Ctrl+D |
| 撤销 / 重做 | ⌘Z / ⌘Shift+Z | Ctrl+Z / Ctrl+Shift+Z |
| 在当前块后 / 前继续编辑 | ⌘Enter / ⌘Shift+Enter | Ctrl+Enter / Ctrl+Shift+Enter |
| 切到即时预览 | Ctrl+Shift+E | Ctrl+E |
| 加粗 / 斜体 | ⌘B / ⌘I | Ctrl+B / Ctrl+I |
| 行内代码 / 链接 | Ctrl+Shift+C / Ctrl+Shift+K | Ctrl+反引号 / Ctrl+K |
| 设置 1 至 6 级标题 | Ctrl+Shift+1 至 6 | Ctrl+Alt+1 至 6 |
| 切换当前标题的折叠状态（需启用插件） | Ctrl+Shift+O | Ctrl+Alt+F |

搜索针对 Markdown 源码。即时预览优先在当前渲染内容上高亮。命中被隐藏的标记或无法精确高亮的公式源码时，会临时展开对应块。例如关闭正则时，搜索 `$` 可以定位公式分隔符。开启正则后，`$` 表示行尾，输入 `\$` 才匹配美元符号。搜索框内按 Enter 或 Shift+Enter 跳到下一个或上一个匹配。全部替换可以一次撤销，只读时仍可查找。

搜索和替换面板从编辑区底部打开，正文顶部留在原位。匹配跳到其他位置时，编辑器会滚动到命中项。

每个编辑器实例有独立的命令注册表。宿主可调用 `editor.commands.configureShortcuts({ "format.bold": null })` 禁用加粗快捷键，传入例如 `"Mod-Shift-b"` 的字符串可改键。`Mod` 在 macOS 指 Command，在其他平台指 Ctrl。整组变更会先检查冲突，再应用。跨会话保留改键时，由宿主保存绑定 ID 与键位，并在新实例恢复。面板会显示该实例实际生效的键位。

## 表格

表格单元格以 Markdown 源码为准。导航和结构命令只在相应的表格编辑上下文执行。即时预览中，在最后一格按 Tab 可进入新行首格，在末行按 Enter 可进入下一行同列。

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 下一格 / 上一格 | Tab / Shift+Tab | Tab / Shift+Tab |
| 下一行同列 / 上一行同列 | Enter / Shift+Enter | Enter / Shift+Enter |
| 同列向上 / 向下 | ⌥↑ / ⌥↓ | Alt+↑ / Alt+↓ |
| 在下方插入行 / 在右方插入列 | Ctrl+Shift+↓ / Ctrl+Shift+→ | Ctrl+Alt+↓ / Ctrl+Alt+→ |
| 删除行 / 删除列 | ⌘⌥Backspace / ⌘⌥Shift+Backspace | Ctrl+Alt+Backspace / Ctrl+Alt+Shift+Backspace |
| 清空单元格 | ⌥Shift+Backspace | Alt+Shift+Backspace |

`surface.table.mode` 决定列宽的分配方式。默认 `content` 按内容取宽度，`fillRatio` 可指定至少占容器宽度的比例。`adaptive` 按容器宽度分配空间，Demo 采用此模式。`fixed` 由宿主给定列宽。用户拖动固定的列会保留手动宽度。

列宽是编辑器布局数据，Markdown 文件只保存单元格内容和对齐标记。要在重新打开文件后恢复用户拖动的列宽，宿主应通过 `resolveTableKey` 为表格提供稳定标识，通过 `onLayoutChange` 取得 `widths` 和 `pinnedColumns`。重新打开时由 `resolveColumnWidths` 返回数组，固定列填像素值，其余列填 `"auto"`，让它们继续随字体或容器宽度调整。运行时节点 ID 只在当前文档实例内有意义。[表格布局接口](../../packages/editor/src/components/table/layout.ts)

## 主题与布局

用 `theme.colors` 设置正文、背景、链接、引用、搜索匹配和选区的颜色。传 `null` 可撤销单项颜色覆盖，让 CSS 层叠重新生效。字体、行高、字距和长代码换行方式会影响布局和滚动位置，使用 `theme.layout` 或 `setLayoutStyle` 同步更新源码、即时预览和预览的测量参数。只改其中一个视图的 CSS 行高会让长文档的初始高度估算偏离实际布局。[主题字段](../../packages/editor/src/component/theme.ts) · [布局字段](../../packages/editor/src/layout/pretext/options.ts)

## 标题折叠

在 `plugins` 中注册 `createHeadingFoldPlugin()` 即可启用。折叠范围从根级标题的下一行开始，到下一个同级或更高级标题之前，末节到文档末尾。各视图共享这个状态，重新打开文档或关闭插件后恢复展开。

折叠只改变显示。全文选择仍覆盖隐藏正文，搜索命中时会自动展开。光标停在折叠边界时，第一次按退格或 Delete 先展开。已有明确选区时，编辑仍按该选区执行。有些编辑会改变章节边界。引擎重新确认之前，编辑器可能先展开已有折叠。[折叠插件](../../packages/editor/src/plugins/heading-fold.ts)

## 保存和关闭

输入先出现在编辑区。Rust 把改动写入内存中的文档并返回新的修订号后，组件更新 `editor.confirmedValue`。这就是 Demo 里的「正文确认」。如果用户刚打完字就点保存，立即读取 `confirmedValue` 可能读到上一版。宿主应在已结束输入法组词的保存操作中等待本轮输入提交，然后取出正文和修订号。

```ts
await editor.input.settled();
const revision = editor.revision;
const markdown = editor.confirmedValue;
await saveDocument(revision, markdown); // 宿主实现，写入文件或发送给服务端
```

只有宿主写入成功后，界面才能标记这版为「已保存」。如果写入期间又产生了修改，成功回执只对应刚才取出的那一版。输入法仍在组词时，应等用户选定候选词再保存。事务失败时应保留错误状态。

`editor.value` 可随时读取编辑区当前的 Markdown。语法解析更新标题、表格等结构和预览，未完成的区域可暂时显示源码。保存 Markdown 全文无需等待这些区域解析完毕。两个取值都使用 LF。需要还原混合换行的工具可以从协议快照读取逐行的 `lineEndings`。[坐标与换行约定](../architecture/protocol.md)

页面卸载时先调用 `editor.dispose()` 解除编辑器监听，再对宿主创建的 Worker 调用 `worker.terminate()`。每个编辑器实例的插件、快捷键和折叠视图均有自己的生命周期。

对 CSS 颜色、字号、组件类名和虚拟布局进行定制时，见 [主题与布局定制](theming.md)。
