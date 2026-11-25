# 编码规范与检查约定

[English](../../contributing/code-style.md) · **简体中文**

## 文件组织与导入顺序

- 单个文件通常按以下顺序组织：模块说明、导入语句、类型与常量、公开入口、内部辅助函数，单元测试置于文件末尾。
- **Rust 导入顺序**：依次为标准库 `std`、外部 crate、当前 crate 及相邻模块。
- **TypeScript 导入顺序**：依次为外部 npm 包、工作区包（`@jot-md/...`）与本地相对路径。纯类型导入请使用 `import type` 或内联 `type`，本地相对模块导入须保留编译产物后缀 `.js`。

## 注释与命名

- 源码注释建议统一使用英文，以便全球开发者阅读与协作；聚焦于解释“为什么”需要某个约束、调用顺序或坐标约定（如 UTF-16 偏移、失败回退状态），避免复述显而易见的代码操作。
- 测试名称应清晰描述可观察到的预期行为。

## 提交前必须通过的检查

发起或更新 PR 前，请在本地运行以下检查：

- **Rust 侧**：
  ```sh
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo clippy --workspace --target wasm32-unknown-unknown --all-targets -- -D warnings
  cargo test --workspace
  ```
- **TypeScript 与架构边界**：
  ```sh
  pnpm run build:protocol
  pnpm run typecheck
  pnpm run test:ts
  ```
  `pnpm run test:ts` 会自动调用 `check:architecture`（`scripts/checks/check-editor-architecture.mjs`），校验 `core/`、`components/`、`layout/`、`render/` 与 `hosts/` 之间的依赖方向是否合规。

涉及跨端协议修改时，请对照[通信协议](../architecture/protocol.md)同步核对 Rust 与 TypeScript 两端定义；涉及排版几何改动时，请对照[虚拟布局](../architecture/virtual-layout.md)同时验证 DOM 渲染与离屏估算路径。
