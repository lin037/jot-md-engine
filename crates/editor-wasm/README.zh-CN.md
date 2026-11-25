# editor-wasm

[English](README.md) · **简体中文**

`editor-engine` 的 WebAssembly 绑定与多文档请求路由层。`EditorHost` 负责校验协议版本，按 `documentId` 与 `generation` 隔离文档生命周期，并将请求分派至 `EditorDocument`。

在 `wasm32` 目标上，`wasm-bindgen` 导出 `WasmEditorHost`，供 Web Worker 同步调用 `handle(requestEnvelope)`：

```ts
const host = new WasmEditorHost();
const response = host.handle(requestEnvelope);
```

## 测试与构建

```sh
# 在本机运行宿主集成测试（握手、事务、UTF-16 范围与投影链路）
cargo test -p editor-wasm

# 在仓库根目录重新生成 Demo 所需的 Wasm 绑定
pnpm run wasm:demo
```

消息字段与修订号约束见[通信协议](../../docs/zh-CN/architecture/protocol.md)。
