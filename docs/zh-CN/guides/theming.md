# 主题与排版定制

[English](../../guides/theming.md) · **简体中文**

Jot 支持通过 CSS 变量定制配色与大纲外观，并提供统一的布局 API，在源码、即时预览、只读预览以及离屏高度估算之间同步字体、行高与间距配置。

## 宿主容器配置

建议为编辑器挂载节点添加专属 class（组件会自动附加 `.jot-markdown-editor`），将自定义样式限定在当前实例内：

```css
.notes-editor {
  height: min(76vh, 48rem);
  min-height: 0;
  --jot-background: #fcfcfa;
  --jot-text-color: #202726;
  --jot-link-color: #086c60;
  --jot-quote-border: #80a79e;
  --jot-code-background: #edf1ee;
}

.notes-editor .jot-md-heading { color: #183e36; }
.notes-editor .jot-table-toolbar__button { border-color: #80a79e; }
```

> **注意**：若父容器采用 Flex 或 Grid 布局，请务必为挂载节点设置明确高度及 `min-height: 0`。如果容器高度不受约束，外层页面会接管滚动，导致组件内部的虚拟滚动视口失效。

## 颜色定制

可在宿主 CSS 中定义 `--jot-*` 变量，或在初始化时传入 `theme.colors`，也可在运行时调用 `await editor.setTheme({ colors: ... })`。将某一项设为 `null` 可移除行内覆盖，恢复 CSS 变量控制。

| `theme.colors` 字段 | 对应 CSS 变量 |
| --- | --- |
| `background` / `text` | `--jot-background` / `--jot-text-color` |
| `codeBackground` / `muted` / `link` | `--jot-code-background` / `--jot-muted-color` / `--jot-link-color` |
| `quote` / `quoteBackground` / `quoteBorder` | `--jot-quote-color` / `--jot-quote-background` / `--jot-quote-border` |
| `searchMatch` / `searchCurrent` / `selection` | `--jot-search-match` / `--jot-search-match-selected` / `--jot-selection-background` |

## 字体、行高与间距

初始化通过 `theme.layout`、运行时通过 `editor.setLayoutStyle(...)` 修改排版参数，组件会同步更新各视图 CSS 及离屏高度估算：

```ts
await editor.setLayoutStyle({
  fontFamily: "system-ui, sans-serif",
  fontSize: 16,
  codeBlockWrap: "scroll", // 或 "wrap"
  metrics: {
    paragraphLineHeight: 26,
    blankLineHeight: 26,
    paragraphPaddingX: 8,
    headingLineHeights: [34, 32, 30, 28, 26, 26], // H1 至 H6，单位 px
    codeLineHeight: 24,
    blockGap: 0,
  },
});
```

| 区域 | `metrics` 字段 |
| --- | --- |
| 正文、空行、标题、分隔线 | `paragraphLineHeight`、`paragraphPaddingX`、`blankLineHeight`、`headingLineHeights`、`thematicHeight` |
| 块与边界 | `blockGap`、`boundaryWidth` |
| 引用与列表 | `quotePaddingX`、`quotePaddingY`、`quoteMinContentWidth`、`listIndent`、`listMinContentWidth` |
| 代码与公式 | `codeLineHeight`、`codePaddingY`、`mathLineHeight`、`mathPaddingY` |
| 表格 | `tableHeaderHeight`、`tableRowHeight`、`tableToolbarHeight`、`tableFrame` |
| 图片 | `imageFallbackHeight`、`imageMaxHeight` |

- 外部 Web 字体加载完成或外部容器布局变化后，可调用 `await editor.invalidateLayout()` 重新测量。
- 通过 `surface.resolveImageMetadata` 提前提供图片宽高或宽高比，可避免图片加载引起的滚动跳动。
- 完整类型定义见 [theme.ts](../../../packages/editor/src/component/theme.ts) 与 [options.ts](../../../packages/editor/src/layout/pretext/options.ts)。

## 文档大纲样式

为大纲容器添加自定义 class（如 `.notes-outline`）。大纲继承容器的字体与文本颜色，并支持以下 CSS 变量：

```css
.notes-outline {
  font: 14px/1.4 system-ui, sans-serif;
  color: #202726;
  --jot-outline-max-height: 20rem;
  --jot-outline-indent: 1em;
  --jot-outline-accent: #086c60;
  --jot-outline-highlight: #e7f1ed;
}
```

如需修改大纲行高，可在调用 `mountOutline` 或 `createOutlinePlugin` 时传入 `{ rowHeight: 36 }`。

## 可用选择器与几何约束

| 用途 | CSS 选择器 |
| --- | --- |
| 编辑器外壳 | `.jot-markdown-editor` |
| 语义块 | `.jot-md-paragraph`、`.jot-md-heading`、`.jot-md-list-item`、`.jot-md-block-quote`、`.jot-md-fenced-code` |
| 富内容 | `.jot-md-image`、`.jot-md-inline-math`、`.jot-md-math-block`、`.jot-md-table` |
| 即时预览行内修饰 | `.jot-live-preview-strong`、`.jot-live-preview-emphasis`、`.jot-live-preview-link`（编辑源码时带有 `jot-live-preview-source-*`） |
| 代码正文行 | `.jot-code-line[data-jot-line-number]` |
| 表格控件 | `.jot-table-toolbar`、`.jot-table-toolbar__button`、`.jot-table-row`、`.jot-table-cell` |
| 编辑工具栏 | `.jot-editor-toolbar`、`.jot-editor-toolbar__button` |

请将样式限定在挂载点选择器下，并**避免用 CSS 直接覆盖组件管理的几何属性**（如 `.cm-line` 或语义块的 `margin`、`padding`、`line-height`、`white-space`；虚拟占位元素的 `height`、`position`、`transform`；表格单元格的 `min-width`；以及内部滚动层的 `overflow`）。几何调整请统一使用 `setLayoutStyle()`、`setTableColumnWidth()` 与 `codeBlockWrap`，以保证真实 DOM 与离屏预估高度一致。
