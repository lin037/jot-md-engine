# 开发与测试指南

[English](../../contributing/development.md) · **简体中文**

本文介绍 Jot 仓库的源码结构、测试分层与常用调试工具。本地工具链安装请参阅[项目首页](../../../README.zh-CN.md#从源码构建)。

## 仓库目录结构

```text
.
├── crates/
│   ├── editor-engine/       Rust 核心引擎：Rope 文本缓冲、增量解析器与投影
│   ├── editor-protocol/     Rust 通信协议结构体与序列化测试
│   └── editor-wasm/         wasm-bindgen 宿主入口，路由协议请求至 EditorDocument
├── packages/
│   ├── editor-protocol/     与 Rust 对齐的 TypeScript 协议类型（内部包）
│   └── editor/              浏览器编辑器包（适配层、视图、组件、Worker）
├── apps/demo/               交互式示例应用
├── benchmarks/              基于生产构建的浏览器性能基准
├── scripts/
│   ├── build/               Wasm 编译、资源生成与构建清理脚本
│   ├── checks/              模块架构边界检查与 TypeScript 测试运行器
│   ├── release/             发布归档打包与独立项目装包校验
│   └── browser/             Chromium 自动化套件（demo、interaction、layout、quote、diagnostics）
└── docs/                    项目文档（英文默认 + docs/zh-CN/ 中文目录）
```

构建与临时产物位于 `target/`、`dist/`、`.tmp/` 以及 `apps/*/src/generated`、`benchmarks/src/generated`。

## 常用检查与测试命令

以下命令均在仓库根目录运行：

| 命令 | 检查内容 |
| --- | --- |
| `cargo fmt --all -- --check` | Rust 代码格式检查 |
| `cargo clippy --workspace --all-targets -- -D warnings` | Rust 静态检查（同时建议检查 `--target wasm32-unknown-unknown`） |
| `cargo test --workspace` | Rust 单元测试及语法、增量解析、协议、Wasm 宿主集成测试 |
| `pnpm run build:protocol && pnpm run typecheck` | 构建协议声明并检查全部 TypeScript 类型 |
| `pnpm run test:ts` | 校验模块依赖边界，并在 Node 环境运行 TypeScript 单元测试 |
| `pnpm run test:browser` | 在真实 Chromium 中运行 `demo`、`interaction`、`layout`、`quote` 套件 |
| `pnpm run package:verify` | 打包后在空项目试装，检查各导入入口和 Worker |
| `pnpm run benchmark` | 运行生产环境浏览器性能基准测试 |

## 定向测试与调试工具

### Rust 语法与增量解析调试

可按测试目标单独运行 Rust 集成套件：

```sh
cargo test -p editor-engine --test syntax
cargo test -p editor-engine --test incremental
cargo test -p editor-engine --test integration
```

排查 Markdown 解析结果时，可以使用内置命令行工具 `md-inspect` 打印指定文件的语法树、UTF-16 范围与解析耗时：

```sh
cargo run -p editor-engine --bin md-inspect -- path/to/example.md
```

### 浏览器自动化套件

修改局部交互或布局时，可按分组单独运行对应浏览器套件：

```sh
pnpm run test:browser demo         # Demo 模式切换、Mermaid 视口与 1 MiB 混合文档
pnpm run test:browser interaction  # 快捷键、搜索、IME、列表、表格、插件与折叠
pnpm run test:browser layout       # 滚动条、行高一致性、表格几何与结构稳定性
pnpm run test:browser quote        # 嵌套引用渲染、选区与逐行导航
```

如需指定 Chrome/Chromium 可执行文件路径，可设置环境变量 `CHROME_BIN`。运行浏览器套件期间请勿重新生成协议或 Wasm 产物，以免触发开发服务器自动刷新。

大文档压力测试、随机模糊测试与容量审计脚本位于 `scripts/browser/diagnostics/`，运行前先执行 `pnpm run build:protocol && pnpm run wasm:demo`。
