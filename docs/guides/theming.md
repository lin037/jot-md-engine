# 定制编辑器样式

最外层尺寸由宿主决定。先给传给 `MarkdownEditor` 的 `root` 加自己的 class。组件会附加 `.jot-markdown-editor`，主题规则可以限定在当前挂载点内。

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

如果父容器用 Flex 或 Grid 分配高度，给容纳编辑器的项保留可计算的高度及 `min-height: 0`。编辑器的内部滚动层按分配到的高度计算视口。把它放进没有高度约束的容器，可能让整页接管滚动，拖动跳转时失去预期的视口锚点。

## 改颜色

可在宿主 CSS 设置变量，或在初始化传 `theme.colors`。运行中用 `await editor.setTheme({ colors: { link: "#086c60" } })`。只写需要更新的项，传 `null` 移除该项的行内值，让宿主 CSS 生效。

| `theme.colors` | 宿主 CSS 变量 |
| --- | --- |
| `background` / `text` | `--jot-background` / `--jot-text-color` |
| `codeBackground` / `muted` / `link` | `--jot-code-background` / `--jot-muted-color` / `--jot-link-color` |
| `quote` / `quoteBackground` / `quoteBorder` | `--jot-quote-color` / `--jot-quote-background` / `--jot-quote-border` |
| `searchMatch` / `searchCurrent` / `selection` | `--jot-search-match` / `--jot-search-match-selected` / `--jot-selection-background` |

## 改字体、行高和间距

初始化把布局放在 `theme.layout`，运行中用 `setLayoutStyle`。同一配置会进入 Preview 和 Live Preview 的 CSS 与虚拟布局估算。常见值以像素为单位，标题的行高传六项，依次对应 H1 至 H6。文字相关的默认行高会随字号变化，显式指标保留给定值。

```ts
await editor.setLayoutStyle({
  fontFamily: "system-ui, sans-serif",
  fontSize: 16,
  codeBlockWrap: "scroll",
  metrics: {
    paragraphLineHeight: 26,
    blankLineHeight: 26,
    paragraphPaddingX: 8,
    headingLineHeights: [34, 32, 30, 28, 26, 26],
    codeLineHeight: 24,
    blockGap: 0,
  },
});
```

| 部位 | `metrics` 字段 |
| --- | --- |
| 正文、空行、标题、分隔线 | `paragraphLineHeight`、`paragraphPaddingX`、`blankLineHeight`、`headingLineHeights`、`thematicHeight` |
| 块与边界 | `blockGap`、`boundaryWidth` |
| 引用和列表 | `quotePaddingX`、`quotePaddingY`、`quoteMinContentWidth`、`listIndent`、`listMinContentWidth` |
| 代码和公式 | `codeLineHeight`、`codePaddingY`、`mathLineHeight`、`mathPaddingY` |
| 表格 | `tableHeaderHeight`、`tableRowHeight`、`tableToolbarHeight`、`tableFrame` |
| 图片 | `imageFallbackHeight`、`imageMaxHeight` |

外部字体加载完或宿主布局发生变化后，可调用 `await editor.invalidateLayout()` 重新读取并估算。需要指定固定行高、间距或换行方式时仍从布局 API 设置。要在加载前稳定预留媒体尺寸，可用 `surface.resolveImageMetadata` 提供图片的宽高或宽高比。调整表格列宽用 `setTableColumnWidth(tableId, column, width)`。实际选项见下列类型。[主题类型](../../packages/editor/src/component/theme.ts) · [布局类型](../../packages/editor/src/layout/pretext/options.ts) · [几何指标](../../packages/editor/src/layout/pretext/filter.ts)

## 文档大纲样式

给大纲容器添加自己的 class，例如 `.notes-outline`。大纲继承容器的字体和文字颜色，折叠箭头随字号缩放。

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

前两个变量控制大纲的最大高度和每级缩进。`--jot-outline-accent` 设置当前章节的文字颜色，`--jot-outline-highlight` 设置当前章节和悬停项的背景色。调整行高可在挂载大纲时传入 `{ rowHeight: 36 }`。[大纲接入](../../packages/editor/README.md#文档大纲)

## 可用于视觉修饰的类名

| 用途 | 选择器 |
| --- | --- |
| 编辑器外壳 | `.jot-markdown-editor`，建议再加宿主自己的 class |
| 语义块 | `.jot-md-paragraph`、`.jot-md-heading`、`.jot-md-list-item`、`.jot-md-block-quote`、`.jot-md-fenced-code` |
| 富内容 | `.jot-md-image`、`.jot-md-inline-math`、`.jot-md-math-block`、`.jot-md-table` |
| 即时预览行内修饰 | `.jot-live-preview-strong`、`.jot-live-preview-emphasis`、`.jot-live-preview-link`；源码显示时有对应的 `jot-live-preview-source-*` 类 |
| 代码内容行 | `.jot-code-line[data-jot-line-number]`，编号从正文起算，不含围栏 |
| 表格控件及内容 | `.jot-table-toolbar`、`.jot-table-toolbar__button`、`.jot-table-row`、`.jot-table-cell` |

类会随组件和模式出现，使用它们时限定在自己的挂载点，下列几何属性走组件 API。

| 保持组件管理的属性 | 直接覆盖后会发生什么 |
| --- | --- |
| `.cm-line`、语义块和代码行的 `margin`、`padding`、`line-height`、`white-space` | 离屏高度和实际行盒不同，滚到可见区再测量时可能跳动。空行、列表续行和围栏的差异会放大。宿主全局的 `p`、`pre`、`blockquote` 样式也要限定作用域。 |
| 虚拟行、占位元素的 `height`、`display`、`position`、`transform` | 滚动索引与真实盒子位置错开，表现为无内容间隙、点击偏移或跳转落点错误。内部滚动层的 `overflow` 也需要由组件管理。 |
| 表格单元格和网格的 `min-width`、列宽和工具条尺寸 | 表头和正文按同一列轴放置。CSS 额外撑宽会留下空白或错列，改列宽走表格 API。 |
| 图片元素的固定宽高与代码的独立换行规则 | 真实盒子与未挂载时的估算会采用不同尺寸。图片用尺寸元数据及布局指标，代码使用 `codeBlockWrap`。 |

验证自定义主题时，来回切换 Source、Live Preview 和 Preview，编辑一个空行、长代码行和表格，再滚出视口后返回。关注光标位置、代码行高和表头列对齐。[浏览器几何用例](../../scripts/browser/layout/editor-metric-guard-browser.mjs) · [已修复的样式回归](../architecture/regressions.md)
