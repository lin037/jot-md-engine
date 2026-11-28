import type { EditorSelection, TextRange } from "@jot-md/editor-protocol";
import type { EditorDocumentSession } from "../../adapter/session.js";
import type { TableCommandExecutor } from "../../components/table/commands.js";
import type { TableRowReader } from "../../components/table/preview-host.js";
import type { TableLayoutOptions } from "../../components/table/layout.js";
import type { EditorPluginRegistry } from "../../plugins/registry.js";
import type {
  DomRenderContext,
  ImageMetadataResolver,
} from "../../components/common/dom-renderer.js";

/**
 * RenderRuntime 的宿主端口。
 *
 * Runtime 只依赖这组稳定能力，不依赖 Preview Surface 或 Live Preview Host。
 * `root` 是 DOM 生命周期边界，`scrollElement` 是嵌套虚拟子轴使用的滚动事实；
 * 两者可以相同，也可以由不同宿主分别提供。
 */
export interface RenderRuntimeOptions {
  readonly root: HTMLElement;
  readonly scrollElement?: HTMLElement;
  readonly session: EditorDocumentSession;
  readonly pluginRegistry?: EditorPluginRegistry;
  readonly overscanPixels?: number;
  readonly estimatedLineHeight?: number;
  readonly estimatedRowHeight?: number;
  readonly estimatedColumnWidth?: number;
  readonly minTableColumnWidth?: number;
  readonly table?: TableLayoutOptions;
  readonly onTableCommand?: TableCommandExecutor;
  readonly readTableRow?: TableRowReader;
  /**
   * TableGrid 已经拥有 pointer 命中的精确 cell range。把它和 offset 一起交给
   * 宿主，避免宿主为了恢复同一事实再次线性扫描整张 Markdown table。
   */
  readonly onTableCellFocus?: (
    offset: number,
    cellRange: TextRange,
    cellElement: HTMLElement,
    event?: MouseEvent,
  ) => void;
  /** Editable mapped cells use ordinary clicks for caret placement. */
  readonly resolveSelectionAnchor?: (
    fallback: number,
    tableRange: TextRange,
  ) => number;
  /**
   * 读取宿主唯一的 CodeMirror selection。RenderRuntime 只把它投影成组件视觉
   * 状态（当前为 TableGrid active cell/caret），不持有或修改第二份 selection。
   */
  readonly resolveSelection?: (tableRange: TextRange) => EditorSelection | undefined;
  readonly renderMath?: DomRenderContext["renderMath"];
  readonly onLink?: DomRenderContext["onLink"];
  readonly resolveImageSrc?: (destination: string) => string | undefined;
  readonly resolveImageMetadata?: ImageMetadataResolver;
  readonly onError?: (error: unknown) => void;
}
