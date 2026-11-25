# Jot 文档中心

[English](../README.md) · **简体中文**

## 使用编辑器

- [组件接入指南（`@jot-md/editor`）](guides/package.md) — 安装、快速开始、插件、国际化与 API 清单
- [编辑器配置与交互](guides/editor.md) — 编辑模式、快捷键、搜索替换、表格、大纲、焦点导航与安全保存
- [Markdown 方言与扩展语法](guides/markdown.md) — 支持的语法、代码围栏、引用嵌套与列表续行规则
- [主题与排版定制](guides/theming.md) — CSS 变量、排版指标、大纲样式与样式隔离原则

## 架构与原理

- [编辑管线](architecture/editing-pipeline.md) — 从按键输入到 Rust/Wasm 确认与 DOM 更新
- [通信协议](architecture/protocol.md) — 主线程、Worker 与 Wasm 之间的消息契约与修订一致性
- [虚拟布局与滚动](architecture/virtual-layout.md) — 投影窗口、离屏高度估算与滚动位置补偿
- [工程不变量与常见陷阱](architecture/regressions.md) — 解析、输入法、表格与虚拟滚动中的关键约束

## 参与贡献

- [贡献指南](../../CONTRIBUTING.zh-CN.md) — 提交 Issue 与 Pull Request 流程
- [开发与测试指南](contributing/development.md) — 源码目录结构、测试分层与调试工具
- [编码规范与检查](contributing/code-style.md) — 代码约定、注释规范与本地检查命令
- [发布与部署手册](contributing/releasing.md) — npm 发包与 Demo 站点部署流程
