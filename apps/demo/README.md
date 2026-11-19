# 浏览器 Demo

Demo 直接挂载 `MarkdownEditor`，默认进入即时预览。选择「源码与预览」后，宽屏左右并排，窄屏上下排列。示例页面的 Worker 在本地加载编译好的 Rust 引擎。

安装依赖后，在仓库根目录启动开发服务。[环境要求](../../README.md)

```sh
pnpm run demo:dev
```

打开 `http://127.0.0.1:4173/`。选好文档后，用「打开示例」替换全文，或插入光标所在位置。「混合大文本」包含标题、列表、引用、代码、表格、公式和图表，内容顺序由固定种子生成。要观察文末未闭合的围栏或公式，请打开整份示例，避免与原文中已有的结束标记配对。

「快捷键」提供 macOS 和 Windows 两套键位。首次打开时按系统选择，也可手动切换。两套改键分开保存，保存后立即更新编辑器和命令面板。恢复默认只重置当前方案。[快捷键与布局选项](../../docs/guides/editor.md)

「样式」可以切换字体、字号、主题和代码换行。Demo 默认使用系统字体，正文字号为 17 px，一级和二级标题分别为 28 和 22 px。标题折叠和 Mermaid 可以分别关闭，图表随页面主题配色。选择标题、正文、引用或表格等组件后，可以实时预览 CSS 颜色。尺寸与间距由宿主布局 API 设置。[语法说明](../../docs/guides/markdown.md) · [样式定制](../../docs/guides/theming.md)

「运行数据」可直接打开 1 MiB 示例。悬停、点按或用 Tab 聚焦指标名称，即可查看含义。正文确认后就可以保存 Markdown。后台解析决定何时能看到整份文档的语法预览。[浏览器基准](../../benchmarks/README.md)

| 命令 | 用途 |
| --- | --- |
| `pnpm run demo:build` | 生成可由静态 HTTP 服务托管的 `dist/demo/` |
| `pnpm run test:browser` | 在 Chromium 中运行应用和组件的浏览器回归 |
| `pnpm run test:browser demo` | 通过 Demo 加载混合大文本，检查滚动、编辑、撤销和折叠 |
| `node scripts/browser/demo/demo-paper-browser.mjs`（先运行 `build:protocol` 和 `wasm:demo`） | 检查窄屏、字体、主题、图片与长代码等排版行为 |

示例入口装配编辑器与 Worker，示例文档和样式都位于 `src/`。独立接入自己的页面可参考[组件接入说明](../../packages/editor/README.md)。
