# 工程不变量与常见陷阱

[English](../../architecture/regressions.md) · **简体中文**

本文汇总了 Jot 在 Rust、TypeScript 与浏览器自动化套件中重点保护的核心不变量。在修改语法解析、即时预览、表格布局或虚拟滚动逻辑时，请确保以下约束不被破坏。

| 模块 | 核心不变量与约束 | 对应测试入口 |
| --- | --- | --- |
| **增量解析** | 增量解析产出的语法树、范围与未改动节点 ID 必须与全量解析完全一致；复用旧后缀时按有序源码坐标二分查找，避免线性退化。 | [incremental/main.rs](../../../crates/editor-engine/tests/incremental/main.rs) · [document_flow.rs](../../../crates/editor-engine/tests/integration/document_flow.rs) |
| **输入法与结构外壳** | 输入法候选阶段留在 CodeMirror 中；经过 `ChangeSet` 映射与 Worker 确认前后，空行、引用前缀与列表项的结构装饰与行高不得发生跳变。 | [editor-ime-shell-scenarios.mjs](../../../scripts/browser/interaction/scenarios/editor-ime-shell-scenarios.mjs) · [editor-structural-stability-browser.mjs](../../../scripts/browser/layout/editor-structural-stability-browser.mjs) |
| **表格与工具条边界** | 每张表格仅挂载一个根部件，网格宽度由列轴统一决定；删除列或工具条换行时，占位宽度与真实列宽必须保持同步。 | [editor-table-delete-scenarios.mjs](../../../scripts/browser/interaction/scenarios/editor-table-delete-scenarios.mjs) · [editor-boundary-audit-browser.mjs](../../../scripts/browser/layout/editor-boundary-audit-browser.mjs) |
| **视口与滚动条** | 用户主动拖动滚动条时不得被旧语义锚点拉回；高视口在初始窗口之后若存在缺失根块，须由窗口管理器补齐投影。 | [editor-scrollbar-browser.mjs](../../../scripts/browser/layout/editor-scrollbar-browser.mjs) · [live-preview-projection-window.cases.ts](../../../packages/editor/tests/views/live-preview/live-preview-projection-window.cases.ts) |
| **行高与内边距对齐** | 空行、正文行与代码行在 CSS 与离屏预估路径中须共享一致的内边距与行高指标，避免输入首字横向偏移或滚出视口后高度漂移。 | [editor-padding-geometry-scenarios.mjs](../../../scripts/browser/interaction/scenarios/editor-padding-geometry-scenarios.mjs) · [editor-metric-guard-browser.mjs](../../../scripts/browser/layout/editor-metric-guard-browser.mjs) |
| **长文档交互稳定性** | 打开、折叠、滚动或在兆字节混合文档开头大段插入时，已挂载 DOM 行数须保持受控，且真实测量后交互命中坐标准确。 | [demo-large-mixed-browser.mjs](../../../scripts/browser/demo/demo-large-mixed-browser.mjs) |

按模块运行浏览器测试：`pnpm run test:browser interaction`、`pnpm run test:browser layout` 或 `pnpm run test:browser quote`。完整命令见[开发与测试指南](../contributing/development.md)。
