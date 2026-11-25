# 虚拟布局与滚动

[English](../../architecture/virtual-layout.md) · **简体中文**

为了流畅承载数兆字节的 Markdown 长文档，Jot 仅向 DOM 挂载视口附近的语义块，并通过离屏高度估算维持滚动条的准确性与稳定性。

## 各视图的高度职责

- **只读预览（`EditorSurface`）**：基于虚拟轴（`VirtualAxis`）与屏外占位撑起总滚动高度。顶层块、表格行列、引用块和长代码块均根据当前滚动位置与容器尺寸按窗口请求投影。
- **即时预览（`LivePreviewController`）**：段落、标题、引用和普通代码行的高度由 CodeMirror 原生行盒直接决定；仅对替换源码行的挂载部件（如表格、块级公式）提供有界预估高度，避免与原生行高重复累加。
- **离屏排版估算（`layout/pretext`）**：结合缓存的 Canvas 字素宽度、字体参数及共享 `EditorLayoutStyle` 指标预估未挂载块的高度；块进入视口并完成真实 DOM 渲染后，再以实测高度替换估值并补偿上方滚动偏移。长表格采用有界采样估算，图片优先读取 `resolveImageMetadata` 返回的尺寸或使用默认占位高度。

**相关源码**：[preview/surface.ts](../../../packages/editor/src/hosts/preview/surface.ts) · [live-preview/pretext-estimator.ts](../../../packages/editor/src/hosts/live-preview/pretext-estimator.ts) · [pretext/options.ts](../../../packages/editor/src/layout/pretext/options.ts)

## 滚动锚点与窗口补齐

外部字体加载、容器宽度改变、表格列宽调整以及图片加载均会使既有高度估算失效：

- **尊重用户滚动意图**：当视口上方的块因挂载实测而增高时，编辑器会补偿对应滚动偏移以防阅读位置跳动；同时会区分用户主动拖拽滚动条与程序跳转，避免两者相互抢占控制权。
- **完整覆盖视口窗口**：协议的 `around-range` 查询返回以起点为中心的有限块切片。当高视口出现尾部缺块时，`projection-window.ts` 会根据已确认块索引计算出缺失区间并显式补齐请求。
- **保持估算与样式同步**：修改字体、行高或间距时务必通过 `EditorLayoutStyle`（`theme.layout` / `setLayoutStyle`）统一写入，确保 CSS 与离屏测量使用同一组指标。
