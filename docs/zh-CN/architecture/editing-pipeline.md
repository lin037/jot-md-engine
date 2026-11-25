# 编辑管线

[English](../../architecture/editing-pipeline.md) · **简体中文**

Jot 将用户的即时输入与后台语法解析解耦，从而确保打字、输入法组词和选区操作无需等待语法树更新。

## 编辑同步流程

主线程中，CodeMirror 6 负责管理乐观文本、光标选区、输入法组合态与撤销/重做历史；TypeScript 适配层（`EditorDocumentSession`）则维护 Rust/Wasm Worker 已确认的正文与 `revision`。

- **即时响应与合并**：当上一批改动正在等待 Worker 确认时，CodeMirror 会继续响应后续按键，并将期间产生的编辑合并为待提交的 `ChangeSet`。
- **串行事务协调**：`EditorTransactionCoordinator` 串行发送事务。若引擎当前已确认文本仍与 `ChangeSet` 起点一致，则直接发送对应编辑范围；否则基于最新已确认文本重新计算最小差异。
- **修订号校验**：会话通过 `requestId` 找到正在等待回包的请求，也会核对事务回包。旧版本的语法分析或投影结果不会更新到视图。
- **错误回退**：若普通编辑事务被引擎拒绝且 Worker 仍存活，组件会通过 `onError` 上报异常并将编辑器回退到 `confirmedValue`；若 Worker 意外终止，会话会进入不可恢复的错误态。

在等待引擎确认的间隙，即时预览会借助 `ChangeSet` 安全映射未触及结构边界的行内装饰，并在遇到结构性改动时等待 Rust 确认后再刷新。

**相关源码**：[codemirror-source.ts](../../../packages/editor/src/hosts/source/codemirror-source.ts) · [transaction-coordinator.ts](../../../packages/editor/src/adapter/transaction-coordinator.ts) · [session.ts](../../../packages/editor/src/adapter/session.ts) · [live-preview/controller.ts](../../../packages/editor/src/hosts/live-preview/controller.ts)

## Rust 引擎的确认与增量解析

在 Worker 中，`WasmEditorHost` 根据 `documentId` 与 `generation` 将请求路由至对应的 `EditorDocument`：

1. **优先确认文本**：`EditorDocument` 使用 `crop::Rope` 保存 LF 归一化后的文本（并单独记录逐行原始换行符），校验 UTF-16 半开区间 `[from, to)` 边界后基于 `baseRevision` 应用事务，立即递增 `revision`。
2. **局部快速重解析**：若单行编辑位于明确的结构边界内，引擎仅重解析所属节点；等长替换可跳过未受影响的后缀，长度变化则重基后续坐标并保留未改动节点的 ID 与内容版本。
3. **块边界回退与预算推进**：遇到可能改变相邻块归属的编辑（如闭合代码围栏、修改表格列数、列表续行变化），局部路径会退回安全块边界重新解析。后台分析按行、块和 UTF-16 预算分批推进（附带 `analysisId` 与 `sequence`），未完成解析的脏区在确认前保持源码显示。

**相关源码**：[document/mod.rs](../../../crates/editor-engine/src/document/mod.rs) · [local_rewrite.rs](../../../crates/editor-engine/src/syntax/local_rewrite.rs) · [incremental.rs](../../../crates/editor-engine/src/syntax/incremental.rs) · [analysis.rs](../../../crates/editor-engine/src/syntax/analysis.rs)

## 带版本号的视口投影

引擎不会跨 Wasm 边界序列化整棵语法树，而是按 `project()` 请求返回指定父节点、轴向和窗口范围内的切片（如顶层块、表格行列、引用行或长代码行）。

- 主线程适配层按 `(parentId, axis)` 维护稀疏子窗口缓存，并丢弃与当前 `generation` 或 `revision` 不匹配的迟到补丁。
- 浅层投影可仅返回节点概要与属性，使虚拟布局能够在不拉取全部子节点的前提下预估屏外高度。

**相关源码**：[projection/mod.rs](../../../crates/editor-engine/src/projection/mod.rs) · [projection-window.ts](../../../packages/editor/src/hosts/live-preview/projection-window.ts)
