# editor-engine

[English](README.md) · **简体中文**

Jot 的核心 Rust 引擎 crate：使用 Rope 缓冲区维护 Markdown 源码与文档修订号，执行增量语法解析，并按视口生成渲染投影。既可在本机原生运行，也可通过 `editor-wasm` 编译至 WebAssembly。

## 模块结构

| 目录 | 职责 |
| --- | --- |
| `src/document/` | 文档生命周期管理、事务应用、快照读取、投影查询与分析状态维护 |
| `src/text/`、`src/position/` | 基于 `crop::Rope` 的文本缓冲、逐行原始换行符记录与 UTF-16/UTF-8 偏移转换 |
| `src/transaction/` | 后台分析任务队列、优先级重排、取消与预算分片 |
| `src/syntax/` | 语法树、内置语法配置与扩展、全量解析、局部改写与增量失效 |
| `src/syntax/block/`、`src/syntax/inline/` | 块级规则（段落、标题、列表、表格、引用、围栏、公式）与行内规则 |
| `src/projection/` | 按修订号输出顶层块、表格行列、引用/代码行与标题大纲切片 |
| `src/snapshot/` | 生成指定修订号的文本及逐行换行符快照 |
| `src/bin/md-inspect.rs` | 命令行调试工具，输出指定 Markdown 文件的语法树、坐标范围与耗时 |

文本坐标统一使用 UTF-16 半开区间 `[from, to)`。语法规则与协议详情见 [Markdown 方言](../../docs/zh-CN/guides/markdown.md) 与 [通信协议](../../docs/zh-CN/architecture/protocol.md)。

## 测试与调试命令

```sh
# 运行单元测试及语法、增量解析、集成测试套件
cargo test -p editor-engine

# 查看任意 Markdown 文件的解析树与耗时
cargo run -p editor-engine --bin md-inspect -- path/to/example.md
```
