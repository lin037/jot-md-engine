# 离屏高度估算（`layout/pretext`）

[English](README.md) · **简体中文**

在语义块尚未挂载到 DOM 前，只读预览与即时预览需要借助离屏估算建立准确的滚动条范围。

- `filter.ts`：结合 Rust `RenderNode` 元数据、当前容器宽度与共享的 `EditorLayoutStyle` 指标估算各类块高度。
- `text-layout.ts`：在不触发 DOM 排版的前提下，利用 Canvas 缓存字素宽度并计算折行；超长文本与大型表格分别采用有界采样（表格采样位于 `components/table/pretext.ts`）。
- `style-metrics.ts`：将行高、内边距与块间距写入共享 CSS 变量，确保估算尺寸与真实 DOM 渲染一致。

节点进入视口后，宿主会用真实 DOM 尺寸校正估值并自动补偿滚动偏移。如需在图片加载前预留准确空间，可配置 `resolveImageMetadata`；外部字体加载完成后请调用 `editor.invalidateLayout()` 触发重测。
