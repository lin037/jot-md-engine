# 即时预览宿主（`hosts/live-preview`）

[English](README.md) · **简体中文**

`LivePreviewController` 结合 CodeMirror 6 的文档状态、选区与可视范围调度 Worker 投影。`planner.ts` 基于引擎返回的 `RenderNode` 生成 CodeMirror 装饰计划，`widget.ts` 将富文本块交由共用的 `RenderRuntime` 渲染；可编辑文本与撤销历史始终由 CodeMirror 统一保管。

## 源码展开与选区映射

- 光标进入普通语义块时展开显示原始 Markdown 源码，移出后自动恢复预览态。
- 跨块选区与全选可以直接覆盖在预览视图上，不会因全选而强制展开长文档中的全部块。
- 闭合代码块与公式块的起止边界设有保护策略，从正文首行向上移动光标可自然进入起始标记行。
- 渲染节点通过 `data-jot-source-from` / `data-jot-source-to` 记录源码区间，点击正文时可精确换算回 UTF-16 偏移。

## 表格与输入法处理

- 每张表格仅挂载一个根部件，单元格可编辑区与分隔符保护区均由已确认的行列投影决定。
- 点击单元格会更新真实的 CodeMirror 选区并映射为高亮状态；输入法组合阶段由宿主级共享的瞬态输入区接收候选词，选词完成后一次性提交为编辑事务。
- 当选区完整覆盖整张表格时允许整表删除或替换；跨过部分分隔符的破坏性编辑会被规则拦截。

## 修订校验与动态测量

在连续快速输入或粘贴期间，CodeMirror 会领先于 Worker 确认。未受影响的部件可暂留画面，位置敏感的表格操作会在版本追平前暂停，过期版本的投影回包会被自动丢弃。

`SyntaxBlockIndex` 用于检索视口内的顶层块，`ProjectionStore` 仅按需读取对应窗口，PreText 为未挂载块提供初始估高，真实挂载后的图片、公式与表格则通过 `ResizeObserver` 通知 CodeMirror 重新测量高度。
