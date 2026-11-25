# 通信协议

[English](../../architecture/protocol.md) · **简体中文**

Jot 主线程、Web Worker 与 Rust/Wasm 引擎之间通过 **v1** 协议通信，数据结构在 Rust（`crates/editor-protocol`）与 TypeScript（`packages/editor-protocol`）中保持严格一致。使用 `MarkdownEditor` 时协议由组件自动处理；仅当构建自定义会话或协议端点时才需关注以下约定。

**协议源码**：[crates/editor-protocol/src/lib.rs](../../../crates/editor-protocol/src/lib.rs) · [packages/editor-protocol/src/index.ts](../../../packages/editor-protocol/src/index.ts)

## 请求与响应信封

每条请求均包含 `protocolVersion`、`requestId`、`generation` 与具体 `body`：

```json
{
  "protocolVersion": 1,
  "requestId": 1,
  "generation": 1,
  "body": {
    "type": "handshake",
    "clientName": "example",
    "clientVersion": "0.1.0"
  }
}
```

- **请求编号分区**：主线程请求占用 `0x00000000`–`0x7fffffff`，Worker 后台调度请求占用 `0x80000000`–`0xffffffff`。
- **会话与版本标识**：`documentId` 标识逻辑文档，`generation` 区分先后打开的生命周期实例，`revision` 标识同一实例内已确认的文本版本。

| 请求 `body.type` | 对应响应 `body.type` | 用途 |
| --- | --- | --- |
| `handshake` | `handshake-ack` | 协商协议能力与引擎版本 |
| `open-document` | `document-opened` | 提交初始文本与 `syntaxProfile`，返回起始 `revision` 与分析状态 |
| `apply-transaction` | `transaction-committed` | 基于 `baseRevision` 原子应用编辑事务，返回 `DocumentPatch` 及可选投影 |
| `project` | `projection-ready` | 按范围或索引窗口拉取 `RenderNode` 切片 |
| `get-snapshot` | `snapshot-ready` | 读取指定 `revision` 的文本及逐行 `lineEndings` |
| `schedule-analysis`、`reprioritize-analysis`、`process-analysis-queue`、`cancel-analysis`、`get-analysis-status` | `analysis-state-changed` | 创建、调优、推进、取消或查询后台语法分析状态 |
| `close-document` | `document-closed` | 释放引擎中的文档实例 |

请求失败时统一返回 `failure` 响应，附带 `error.code`、`error.recoverable` 以及版本冲突时的预期/实际修订号。

## 编辑坐标与事务约束

- **UTF-16 半开区间**：所有范围 `[from, to)` 均为 LF 归一化文本中的 UTF-16 码元偏移（例如长度为 4 的 `A😀B` 中替换 emoji 的范围为 `[1, 3)`），端点严禁切分代理对。
- **换行符约定**：`open-document` 可接收 LF、CRLF 或 CR 并单独保存逐行换行记录；`apply-transaction` 中插入的文本仅允许包含 LF。
- **原子事务**：同一笔事务中的 `edits` 必须基于同一个 `baseRevision`，按起点升序排列且互不重叠。引擎要么整体提交并递增 `revision`，要么整体拒绝。

## 异步分析与视口投影

文本确认与语法解析相互独立。Worker 在确认文本后立即返回 `transaction-committed`，再按预算分批推进解析：

- `AnalysisState` 包含 `"pending"`（附带 `confirmedRanges`）、`"complete"`、`"cancelled"` 与 `"failed"` 状态。
- 可见区域提示会动态提升视口附近未解析区域的优先级。
- 投影数据仅代表请求的局部窗口；源码型节点仅携带 `sourceRange`，由前端直接从本地文本切片读取。应用任何投影补丁前，必须校验 `generation` 与 `revision` 是否仍与当前会话一致。
