# @jot-md/editor-protocol

[English](README.md) · **简体中文**

内部工作区包，用于定义 Jot 主线程适配层、Web Worker 运行时与 Rust/Wasm 引擎（`crates/editor-protocol`）之间共用的 TypeScript 通信契约与常量。当前协议版本为 **1**。

> **如果你只需在项目中使用编辑器组件**：请直接安装 [`@jot-md/editor`](../editor/README.zh-CN.md)，该包已内置本协议，无需单独安装。本包仅面向仓库源码开发或自定义协议端点的场景。

## 使用示例

```ts
import { PROTOCOL_VERSION, type RequestEnvelope } from "@jot-md/editor-protocol";

const request: RequestEnvelope = {
  protocolVersion: PROTOCOL_VERSION,
  requestId: 1,
  generation: 1,
  body: { type: "handshake", clientName: "notes", clientVersion: "0.1.0" },
};
```

## 协议约定

- **文本坐标**：所有范围均为 LF 归一化文档中的左闭右开 `[from, to)` UTF-16 码元偏移。
- **会话与修订**：`generation` 区分不同文档会话周期，`revision` 标识引擎已确认的文本版本；`DocumentTransaction` 携带编辑内容、选区与历史操作意图。
- **增量分析与投影**：`AnalysisState` 描述后台解析进度、已确认范围或错误原因；`RenderPatch` 按请求的视口或子节点窗口返回 `RenderNode`。
- **请求 ID 划分**：主线程请求编号使用 `0x00000000`–`0x7fffffff`，Worker 后台请求使用 `0x80000000`–`0xffffffff`。

完整协议说明见 [通信协议](../../docs/zh-CN/architecture/protocol.md)。
