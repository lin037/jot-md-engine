# Table 组件

[English](README.md) · **简体中文**

`components/table` 是 Markdown 管道表格的唯一实现模块。基于同一个 `TableComponentModel`，统一驱动列宽布局、PreText 高度估算、只读预览 DOM、即时预览交互以及全部表格编辑命令。

## 模块职责

- `model.ts`：将 Rust 返回的 `RenderNode` 转换为稳定的组件模型。
- `layout.ts`：计算列宽、容器适配、用户固定列与内容宽度统计。
- `pretext.ts`：通过有界行采样估算大型表格的离屏高度。
- `source.ts`：纯源码层的单元格与行列变换（含投影尚未加载时的保守边界降级）。
- `commands.ts`：无 DOM 依赖的单元格导航、清空与增删行列命令。
- `toolbar.ts`：将工具条按钮操作转发至统一的 `TableCommandExecutor`。
- `adapters/interaction.ts`：消费已确认的 `sourceRange`，定位活动单元格与分隔符保护区。
- `adapters/projection.ts`：声明表格投影的层级深度与切片预算。
- `adapters/preview.ts`：封装共用的 `TableGrid`，支持二维行列虚拟滚动与列宽拖拽。
- `adapters/live-preview.ts`：为 CodeMirror 生成单一的 `table-root` 部件描述。
- `adapters/dom.ts`：只读预览与即时预览共用的行/单元格 DOM 契约。

## 关键不变量

1. **语义以 Rust 为准**：`source.ts` 不会将未经引擎确认的普通竖线文本升级为表格。
2. **单一根部件与共享网格**：只读预览与即时预览均通过 `RenderRuntime` 挂载 `TableGrid`。即时预览每张表仅挂载一个 `selection: "mapped"` 根部件，不创建逐行部件或独立 `<input>`。
3. **选区映射与输入法**：单元格激活态是 CodeMirror 主选区在单元格 `sourceRange` 上的实时投影；输入法组词期间由宿主共享的瞬态输入区承接候选词，提交后再进入 `EditorDocumentSession`。
4. **局部更新边界**：

| 更新类型 | 必须保留 | 允许更新 |
| --- | --- | --- |
| **单元格内容修改** | 表格根 DOM、`TableGrid`、列宽、行虚拟轴、未改动行 DOM 与横向滚动锚点 | 目标行/单元格子树与实测行高（`"live"` 自适应模式下仅当列宽确实变化时重测） |
| **源码位置平移** | 上述全部 DOM 与布局状态 | 仅更新受影响子树的 `data-jot-source-from`/`to` 属性 |
| **增删正文行** | 既有列宽与未受影响的可复用行 DOM | 垂直虚拟轴、可见行窗口与行高 |
| **列几何变化** | 按稳定 key 复用的 DOM 与用户固定列宽 | 列窗口、自动列宽计算及受影响行的换行高度 |

核心约束补充：
- 在 `autoWidth: "stable"` 模式下，单元格内容字符数微调不会重新触发全表列宽收敛。
- 表列数由已确认的表头与分隔行决定；超列正文行保留在源码中，不撑大网格。
- 稀疏投影暂时缺失某单元格时应保留已确认的单元格外壳等待数据返回，不可闪烁为空单元格。
- 表格根部件声明 `inPlaceUpdate`，单元格编辑不会重置 CodeMirror 已实测的块高，最终尺寸由 `ResizeObserver` 平滑校正。
- `content` 模式下外壳宽度由列轴决定，表格工具条在可用宽度内自动换行，不反向撑宽窄表格。
