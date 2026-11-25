# editor-protocol

[English](README.md) · **简体中文**

Jot 通信协议 **v1** 的 Rust 端类型定义，在原生引擎、Wasm 宿主、Web Worker 与 TypeScript 前端之间保持一致。源码坐标均以 UTF-16 码元计数，范围采用左闭右开 `[from, to)`。

## 模块结构

| 路径 | 内容 |
| --- | --- |
| `src/request.rs`、`src/response.rs` | 消息信封与命令定义（握手、打开、事务、投影、快照、分析） |
| `src/common.rs`、`src/error.rs` | 协议版本、请求 ID 分区、文档与修订标识、语法配置及错误码 |
| `src/transaction.rs` | 文本编辑、选区、换行策略与操作意图 |
| `src/analysis.rs` | 分析预算、视口优先范围、进度状态与取消原因 |
| `src/projection.rs`、`src/diagnostic.rs` | 窗口查询、渲染节点、文档补丁与诊断数据结构 |
| `tests/wire_shape.rs` | 校验序列化字段名、枚举标签与协议版本契约 |

修改任意协议字段时，请同步更新 `packages/editor-protocol/` 与[通信协议](../../docs/zh-CN/architecture/protocol.md)。

```sh
cargo test -p editor-protocol
```
