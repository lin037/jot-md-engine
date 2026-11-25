# 交互式示例应用（`apps/demo`）

[English](README.md) · **简体中文**

Jot 的官方参考示例应用，完整演示了 `MarkdownEditor` 在即时预览与双栏模式下的能力集成，包括文档大纲、工具栏、标题折叠、KaTeX 公式、Mermaid 图表、快捷键设置、多语言切换以及实时运行状态面板。

> **在线体验地址**：[lin037.github.io/jot-md-engine](https://lin037.github.io/jot-md-engine/)

## 本地启动

按[从源码构建](../../README.zh-CN.md#从源码构建)准备好依赖后，在仓库根目录运行：

```sh
pnpm run demo:dev
```

启动后访问 `http://127.0.0.1:4173/`。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm run demo:dev` | 构建协议与 Wasm 绑定，并在 `127.0.0.1:4173` 启动 Vite 开发服务器 |
| `pnpm run demo:build` | 构建可静态托管的站点产物至 `dist/demo/`（使用相对路径 `./`） |
| `pnpm run test:browser demo` | 运行 Demo 浏览器自动化检查（模式切换、Mermaid 视口与 1 MiB 混合文档） |

如需在自己的项目中接入组件，请参阅[组件接入指南](../../packages/editor/README.zh-CN.md)。
