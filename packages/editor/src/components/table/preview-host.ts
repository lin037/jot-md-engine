import type { RenderNode, TextRange } from "@jot-md/editor-protocol";
import type { EditorSelection } from "@jot-md/editor-protocol";
import type { EditorDocumentSession } from "../../adapter/session.js";
import type { VirtualAxis } from "../../core/virtual/virtual-axis.js";
import type { TableLayoutController, TableLayoutOptions } from "./layout.js";
import type { TableCommandExecutor } from "./commands.js";

export type TableRowReader = (tableStart: number, rowOffset: number) =>
  { readonly from: number; readonly text: string } | undefined;

/** Preview host 向 Table 适配器提供的窄接口，避免组件反向依赖 EditorSurface。 */
export interface TablePreviewHost {
  readonly options: {
    readonly root: HTMLElement;
    readonly scrollElement?: HTMLElement;
    readonly session: EditorDocumentSession;
    readonly overscanPixels?: number;
    readonly estimatedRowHeight?: number;
    readonly estimatedColumnWidth?: number;
    readonly minTableColumnWidth?: number;
    readonly table?: TableLayoutOptions;
    readonly onTableCommand?: TableCommandExecutor;
    /** Live Preview may have newer source than the last Worker confirmation. */
    readonly readTableRow?: TableRowReader;
    /** Preview cell pointer 映射回唯一 CodeMirror selection 并激活输入宿主。 */
    readonly onTableCellFocus?: (
      offset: number,
      cellRange: TextRange,
      cellElement: HTMLElement,
      event?: MouseEvent,
    ) => void;
    /** 从宿主的唯一 selection 模型解析当前表格的 command anchor。 */
    readonly resolveSelectionAnchor?: (fallback: number, tableRange: TextRange) => number;
    /** 读取唯一 source selection，用于绘制非交互性的 table visual caret。 */
    readonly resolveSelection?: (tableRange: TextRange) => EditorSelection | undefined;
    readonly onError?: (error: unknown) => void;
  };
  key(node: RenderNode): string;
  axis(key: string, estimatedSize: number): VirtualAxis;
  tableLayout(node: RenderNode, columnCount: number): TableLayoutController;
  mount(node: RenderNode): HTMLElement;
  update(element: HTMLElement, node: RenderNode): void;
  disposeSubtree(root: HTMLElement): void;
}

export interface TablePreviewComponent {
  update(node: RenderNode): void;
  dispose(): void;
}
