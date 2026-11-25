# @jot-md/editor-protocol

这个包定义 Jot 编辑器主线程、Worker 和 Rust/Wasm 引擎之间的消息类型，以及双方共用的请求编号范围。当前通信协议版本是 **1**。

```ts
import { PROTOCOL_VERSION, type RequestEnvelope } from "@jot-md/editor-protocol";

const request: RequestEnvelope = {
  protocolVersion: PROTOCOL_VERSION,
  requestId: 1,
  generation: 1,
  body: { type: "handshake", clientName: "notes", clientVersion: "0.1.0" },
};
```

- 文本范围使用全局 UTF-16 码元偏移，包含起点，不含终点。
- `generation` 区分文档会话，`revision` 标识引擎已确认的文本版本。`DocumentTransaction` 携带编辑范围、替换文本、选区和历史操作意图。
- `AnalysisState` 表示解析进度、已确认范围或失败原因。`RenderPatch` 按请求的窗口返回 `RenderNode`。内容可以直接引用当前版本的源码，子节点也可以延后加载。
- 表格列的内容统计随节点属性传输。列宽、字体、滚动位置和 DOM 测量由浏览器维护。

使用现成的浏览器组件请安装 `@lin037/jot-md-engine`。直接实现消息端点时，前端请求编号使用 `0x00000000` 到 `0x7fffffff`，Worker 后台请求使用 `0x80000000` 到 `0xffffffff`。
