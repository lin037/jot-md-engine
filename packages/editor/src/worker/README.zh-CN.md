# Worker 运行时调度（`packages/editor/src/worker`）

[English](README.md) · **简体中文**

Web Worker 模块负责在独立线程中运行 Rust/Wasm 引擎：

- `bootstrap.ts`：在 Wasm 模块加载期间缓冲到达的消息；初始化完成后实例化 `WasmEditorHost`，将缓冲请求交由 `runtime.ts` 处理并接管后续消息分发。接入示例见[组件接入指南](https://github.com/lin037/jot-md-engine/blob/main/docs/zh-CN/guides/package.md#2-创建-web-worker-入口)。
- `analysis-pump.ts`：每次调度至多推进一轮 `process-analysis-queue`，仅在状态仍为 `pending` 时安排下一轮；文档关闭、会话替换或分析目标变更时自动中止旧任务。
- **请求 ID 分区与致命异常**：主线程请求编号占用 `0x00000000`–`0x7fffffff`，Worker 后台推送占用 `0x80000000`–`0xffffffff`。遇到不可恢复异常时，Worker 会发送 `editor-worker-fatal` 通知主线程会话终止等待中的请求。
