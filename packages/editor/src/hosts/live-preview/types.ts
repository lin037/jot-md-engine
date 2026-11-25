import type {
  RenderNode,
  Revision,
  TextRange,
} from "@jot-md/editor-protocol";
import type {
  ComponentLivePreviewDecoration,
  ComponentLivePreviewWidget,
  ComponentLivePreviewWrapper,
} from "../../components/contracts.js";
import type { DomRenderContext, ImageMetadataResolver } from "../../components/common/dom-renderer.js";
import type { PreTextOptions } from "../../layout/pretext/options.js";
import type { TableLayoutOptions } from "../../components/table/layout.js";
import type { TableCommandExecutor } from "../../components/table/commands.js";
import type { EditorScrollbarMode } from "../../layout/direct-scrollbar.js";
import type { EditorPluginRegistry } from "../../plugins/registry.js";

export interface LivePreviewSelectionRange {
  readonly from: number;
  readonly to: number;
}

/** Host-only hint for empty, contiguous syntax replacements at a quote's start. */
export type LivePreviewDecoration = ComponentLivePreviewDecoration & {
  readonly leadingQuoteMarker?: boolean;
  /** A confirmed per-physical-line quote prefix, distinct from other syntax. */
  readonly quotePrefix?: boolean;
  /** URL from a confirmed link node, after the shared URL policy. */
  readonly linkHref?: string;
};

/** Host 接受内置和组件注册的 widget 类型；未知 kind 必须降级回源码。 */
export type LivePreviewWidgetDescriptor = ComponentLivePreviewWidget;
export type LivePreviewWrapper = ComponentLivePreviewWrapper;

export interface LivePreviewPlan {
  readonly decorations: readonly LivePreviewDecoration[];
  readonly wrappers: readonly LivePreviewWrapper[];
  readonly visitedNodes: number;
  readonly activeBlocks: number;
  readonly fallbackBlocks: number;
  /** 当前视口真实 Preview/source decorations；不含离屏 PreText geometry placeholders。 */
  readonly visualDecorationCount: number;
  /** 保持 CodeMirror 全文高度图的离屏 block placeholders 数。 */
  readonly geometryDecorationCount: number;
  readonly widgetCount: number;
  readonly geometryWidgetCount: number;
  readonly truncated: boolean;
  readonly geometryTruncated: boolean;
}

export interface LivePreviewPlanInput {
  readonly source: string;
  readonly nodes: readonly RenderNode[];
  /** Revision-matched, bounded Rust projection of visible quote lines. */
  readonly quoteLines?: readonly RenderNode[];
  readonly selections: readonly LivePreviewSelectionRange[];
  /**
   * 普通（非 composition）源码回显只允许一个 root。Controller 从唯一
   * CodeMirror caret 或一次 pending reveal 推导出该目标；Planner 再以 Rust
   * 的半开 sourceRange 精确命中，避免 caret 落在相邻 root seam 时同时拆开
   * 两个 Preview widget。
   */
  readonly activeSourceRange?: LivePreviewSelectionRange;
  /**
   * IME composition 等不能安全承载在 replacement widget 内的输入阶段，强制
   * 命中的根块回显 CodeMirror 源码。普通 table selection 不设置它，仍保留
   * mapped table-root 与 active-cell 投影。
   */
  readonly forceSource?: boolean;
  /** Explicit search selection reveals syntax in its root without moving the selection. */
  readonly revealSyntax?: boolean;
  /**
   * 非空 source selection 的视觉投影。它只影响 widget selected state，不能让
   * 全选把所有 Preview block 都回退为源码。
   */
  readonly selectionHighlights?: readonly LivePreviewSelectionRange[];
  /**
   * 全文 PreText 高度轴在当前窗口两侧汇总出的 geometry gap。每个 gap 只是一
   * 个透明 block widget，不会按根块数线性创建 DOM。
   */
  readonly geometryGaps?: readonly LivePreviewGeometryGap[];
  /** Keep these source targets addressable even before their RenderNodes arrive. */
  readonly geometryExclusions?: readonly LivePreviewSelectionRange[];
  /** CodeMirror 可见源码窗口；多行 decoration 不得越过该窗口整块物化。 */
  readonly visibleRange?: LivePreviewSelectionRange;
  readonly maxDecorations?: number;
  readonly maxGeometryDecorations?: number;
  readonly pluginRegistry?: EditorPluginRegistry;
  /** Blurred plugin blocks may show their read-only rendering again. */
  readonly editorFocused?: boolean;
  /** Counts physical lines without scanning a large code block on every viewport update. */
  readonly countSourceLines?: (from: number, to: number) => number;
  readonly estimateBlockHeight?: (node: RenderNode) => number | undefined;
}

export interface LivePreviewGeometryGap {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly estimatedHeight: number;
}

export interface LivePreviewCommitEvent {
  readonly revision: Revision;
  readonly planDurationMs: number;
  readonly visibleBlocks: number;
  readonly projectedNodes: number;
  readonly decorationCount: number;
  readonly widgetCount: number;
  readonly geometryDecorationCount?: number;
  readonly geometryWidgetCount?: number;
  readonly geometryTruncated?: boolean;
  readonly activeBlocks: number;
  readonly fallbackBlocks: number;
  readonly truncated: boolean;
  readonly projectionRequests: number;
}

export interface LivePreviewSnapshot extends LivePreviewCommitEvent {
  readonly enabled: boolean;
}

export interface LivePreviewOptions {
  /** 根投影在可见块之前保留的块数。 */
  readonly beforeBlocks?: number;
  /** 根投影在可见块之后保留的块数。 */
  readonly afterBlocks?: number;
  /** 单次规划允许提交的 decoration 硬上限；超过后源码降级。 */
  readonly maxDecorations?: number;
  /** 全局 PreText 高度图可保留的离屏根块占位数；超过后可见区域仍正确渲染。 */
  readonly maxGeometryDecorations?: number;
  /** 单次可展开 inline 详情的根块上限。 */
  readonly maxDetailedBlocks?: number;
  readonly renderMath?: DomRenderContext["renderMath"];
  readonly onLink?: DomRenderContext["onLink"];
  readonly resolveImageSrc?: (destination: string) => string | undefined;
  readonly resolveImageMetadata?: ImageMetadataResolver;
  readonly pretext?: PreTextOptions;
  /**
   * 默认使用与 Preview Surface 相同的直接比例滚动条。它只操作 CodeMirror
   * 的唯一 scrollDOM，不会创建第二条虚拟滚动轴。
   */
  readonly scrollbar?: EditorScrollbarMode;
  /** 与 Preview Surface 共用的 table 列宽选项；无需按单张表重复配置。 */
  readonly table?: TableLayoutOptions;
  /** Live Preview 表格工具条使用的统一 command 端口。 */
  readonly onTableCommand?: TableCommandExecutor;
  readonly onCommit?: (event: LivePreviewCommitEvent) => void;
  readonly onError?: (error: unknown) => void;
}

export function livePreviewRange(from: number, to: number): TextRange {
  return {
    from: from as TextRange["from"],
    to: to as TextRange["to"],
  };
}
