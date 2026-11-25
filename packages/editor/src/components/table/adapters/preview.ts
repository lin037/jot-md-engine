import { editorI18nAt } from "../../../core/i18n.js";
import type {
  ProjectionSlice,
  RenderNode,
} from "@jot-md/editor-protocol";
import {
  stringsAttribute,
} from "../../common/dom-renderer.js";
import {
  resolveTableLayoutOptions,
  tableLayoutContextKey,
  tableLayoutEvidenceFromNode,
  TableLayoutController,
  type TableLayoutEvidence,
} from "../layout.js";
import { DomVirtualList } from "../../../core/virtual/dom-virtual-list.js";
import {
  cssPixels,
  logicalScrollLeft,
  setLogicalScrollLeft,
  tolerateStaleProjection,
} from "../../common/render-utils.js";
import {
  configureTableCellElement,
  configureTableRowElement,
  createTableCellElement,
  createTableRowElement,
  tableRowDomOptions,
} from "./dom.js";
import {
  domRangeForSourceOffset,
  sourceOffsetAtPoint,
} from "../../common/dom-position.js";
import {
  softWrapCellWidth,
  tableLayoutEvidenceKey,
  unbreakableInlineCellWidth,
} from "../preview-utils.js";
import type { ComponentPreviewAdapter, ComponentPreviewHost } from "../../contracts.js";
import type { TableComponentModel } from "../model.js";
import type { TablePreviewComponent, TablePreviewHost } from "../preview-host.js";
import { createTableToolbar, refreshTableToolbar } from "../toolbar.js";
import { TABLE_COMMAND } from "../commands.js";

/** Table 的 Preview adapter；宿主只提供端口，表格自己拥有二维窗口与列宽策略。 */
export const tablePreviewAdapter: ComponentPreviewAdapter<TableComponentModel> = {
  manages: (model) => model.kind === "table",
  prepareShell(model, element, host) {
    if (model.kind !== "table") return;
    const runtime = tablePreviewHost(host);
    const options = resolveTableLayoutOptions(runtime.options);
    element.dataset["jotTableLayoutMode"] = options.mode ?? "content";
    element.dataset["jotTableAutoWidth"] = options.autoWidth ?? "stable";
  },
  mount(model, element, host) {
    if (model.kind !== "table") return undefined;
    return new TableGrid(model.node, element, tablePreviewHost(host));
  },
};

function tablePreviewHost(host: ComponentPreviewHost): TablePreviewHost {
  const candidate = host as Partial<TablePreviewHost>;
  if (
    candidate.options === undefined ||
    typeof candidate.tableLayout !== "function" ||
    typeof candidate.axis !== "function" ||
    typeof candidate.mount !== "function" ||
    typeof candidate.update !== "function" ||
    typeof candidate.disposeSubtree !== "function"
  ) {
    throw new Error("table preview adapter requires a TablePreviewHost");
  }
  return candidate as TablePreviewHost;
}

/**
 * Preview 表格的二维窗口。行数据由 DomVirtualList 管理，列数据由
 * TableLayoutController 管理；两者共享同一个 RenderRuntime 的 DOM 生命周期。
 */
export class TableGrid implements TablePreviewComponent {
  readonly #runtime: TablePreviewHost;
  readonly #host: HTMLElement;
  readonly #toolbar: HTMLElement | undefined;
  readonly #header: HTMLElement;
  readonly #body: HTMLElement;
  readonly #rows: DomVirtualList<RenderNode>;
  readonly #layout: TableLayoutController;
  readonly #unsubscribeLayout: () => void;
  readonly #scroll = () => {
    const key = this.#columnWindowKey();
    if (key === this.#renderedColumnWindow) return;
    this.#renderedColumnWindow = key;
    this.#rows.schedule();
    this.#renderHeader();
  };
  readonly #resizeObserver: ResizeObserver | undefined;
  readonly #pendingCellRows = new Map<string, RenderNode>();
  // A row can be queued again while its cell projection is still in flight
  // (ResizeObserver, a keyed row update, and a horizontal window change can
  // all do that). Do not post the same sparse range twice; duplicate requests
  // sit in front of the next foreground edit in the Worker event queue.
  readonly #pendingCellLoads = new Set<string>();
  readonly #onResizePointerMove = (event: PointerEvent) => this.#resizeMove(event);
  readonly #onResizePointerUp = (event: PointerEvent) => this.#resizeEnd(event);
  readonly #onCellPointerDown = (event: MouseEvent) => this.#cellPointerDown(event);
  #resizeDrag: {
    readonly pointerId: number;
    readonly column: number;
    readonly startX: number;
    readonly startWidth: number;
    readonly handle: HTMLElement;
  } | undefined;
  #headerNode: RenderNode | undefined;
  #tableRange: RenderNode["sourceRange"];
  #renderedColumnWindow: string | undefined;
  #columnMeasurementEpoch = 0;
  #measureScheduled = false;
  #cellLoadScheduled = false;
  #disposed = false;
  #contentVersion: number;
  #childCount: number;
  #alignmentKey: string;
  #layoutEvidence: TableLayoutEvidence | undefined;
  #headerContentVersion: number | undefined;
  #headerProjectionRootVersion: number | undefined;
  #headerLoad: Promise<void> | undefined;
  #headerLoadKey: string | undefined;
  /** stable 模式下缓存一次批次的 intrinsic 候选，避免 resize 受可视行集合影响。 */
  #intrinsicPreferredWidths: Array<number | undefined> | undefined;

  constructor(node: RenderNode, host: HTMLElement, runtime: TablePreviewHost) {
    this.#runtime = runtime;
    this.#host = host;
    this.#tableRange = node.sourceRange;
    this.#contentVersion = node.contentVersion;
    this.#childCount = node.childCount;
    this.#alignmentKey = stringsAttribute(node, "alignments").join("\u0000");
    this.#layoutEvidence = tableLayoutEvidenceFromNode(node);
    this.#header = host.ownerDocument.createElement("div");
    this.#header.className = "jot-table-grid-header";
    this.#header.setAttribute("role", "rowgroup");
    this.#header.style.position = "sticky";
    this.#header.style.top = "0";
    this.#header.style.zIndex = "1";
    this.#body = host.ownerDocument.createElement("div");
    this.#body.className = "jot-table-grid-body";
    this.#body.setAttribute("role", "rowgroup");
    this.#toolbar = runtime.options.onTableCommand === undefined
      ? undefined
      : createTableToolbar({
          i18n: editorI18nAt(runtime.options.root),
          document: host.ownerDocument,
          tableId: node.id,
          resolveAnchor: () => runtime.options.resolveSelectionAnchor?.(
            Number(this.#tableRange.from),
            this.#tableRange,
          ) ?? Number(this.#tableRange.from),
          canExecute: (command, anchor) => {
            // Applicability is a property of the already mounted cell. Do not
            // reparse every row of a large table for each toolbar button.
            const cell = [...host.querySelectorAll<HTMLElement>(".jot-table-cell[data-jot-source-from]")]
              .find(element => Number(element.dataset["jotSourceFrom"]) <= anchor &&
                anchor <= Number(element.dataset["jotSourceTo"]));
            if (cell === undefined) return false;
            if (command === TABLE_COMMAND.deleteRow) return !this.#header.contains(cell);
            if (command === TABLE_COMMAND.deleteColumn) return this.#layout.count > 1;
            if (command === TABLE_COMMAND.clearCell) return Number(cell.dataset["jotSourceFrom"]) < Number(cell.dataset["jotSourceTo"]);
            return true;
          },
          execute: runtime.options.onTableCommand,
        });
    host.replaceChildren(
      ...(this.#toolbar === undefined ? [] : [this.#toolbar]),
      this.#header,
      this.#body,
    );
    this.#layout = runtime.tableLayout(node, stringsAttribute(node, "alignments").length);
    this.#layout.configure(
      stringsAttribute(node, "alignments").length,
      this.#alignmentKey,
      this.#layoutContextKey(),
    );
    this.#layout.ensureMinimumWidths();
    host.dataset["jotTableLayoutMode"] = this.#layout.mode;
    host.dataset["jotTableAutoWidth"] = this.#layout.autoWidth;
    host.setAttribute("aria-rowcount", String(Math.max(0, node.childCount)));
    host.setAttribute("aria-colcount", String(this.#layout.count));
    this.#unsubscribeLayout = this.#layout.subscribe(() => {
      if (this.#disposed) return;
      this.#renderedColumnWindow = undefined;
      this.#rows.schedule();
      this.#renderHeader();
    });
    this.#header.addEventListener("pointerdown", this.#onResizePointerDown);
    host.addEventListener("mousedown", this.#onCellPointerDown);
    const store = runtime.options.session.adapter.projection;
    this.#rows = new DomVirtualList({
      host: this.#body,
      scrollElement: runtime.options.scrollElement ?? runtime.options.root,
      estimatedItemHeight: runtime.options.estimatedRowHeight ?? 32,
      axis: runtime.axis(
        `table-rows:${node.id}`,
        runtime.options.estimatedRowHeight ?? 32,
      ),
      overscanPixels: runtime.options.overscanPixels,
      getItem: (index) => store.nodeAt(node.id, "syntax-children", index + 1),
      itemKey: (item) => runtime.key(item),
      loadRange: async (from, toExclusive) => {
        const missing = store.missingRanges(
          node.id,
          "syntax-children",
          from + 1,
          toExclusive + 1,
        );
        if (missing.length === 0) return;
        await tolerateStaleProjection(() =>
          runtime.options.session.project(
            missing.map((range): ProjectionSlice => ({
              parentId: node.id,
              axis: "syntax-children",
              window: { type: "index", ...range },
              maxDepth: 0,
            })),
          ));
      },
      renderItem: (row, index) => this.#renderRow(row, false, index),
      updateItem: (element, row, index) => this.#updateRow(element, row, false, index),
      disposeElement: (element) => runtime.disposeSubtree(element),
      onError: runtime.options.onError,
      onCommit: () => {
        this.#scheduleCellLoad();
        if (this.#toolbar !== undefined) refreshTableToolbar(this.#toolbar);
      },
    });
    this.#rows.setCount(Math.max(0, node.childCount - 1));
    host.addEventListener("scroll", this.#scroll, { passive: true });
    const ResizeObserverConstructor = host.ownerDocument.defaultView?.ResizeObserver;
    this.#resizeObserver = ResizeObserverConstructor === undefined
      ? undefined
      : new ResizeObserverConstructor(() => {
          this.#layout.configure(
            this.#layout.count,
            this.#alignmentKey,
            this.#layoutContextKey(),
          );
          this.#scheduleColumnMeasurement();
        });
    this.#resizeObserver?.observe(host);
    void this.#loadHeader(node).catch((error) => runtime.options.onError?.(error));
  }

  update(node: RenderNode): void {
    const tableRangeChanged = !sameSourceRange(this.#tableRange, node.sourceRange);
    this.#tableRange = node.sourceRange;
    const alignments = stringsAttribute(node, "alignments");
    const alignmentKey = alignments.join("\u0000");
    const nextEvidence = tableLayoutEvidenceFromNode(node);
    const contentVersionChanged = node.contentVersion !== this.#contentVersion;
    const rowCountChanged = node.childCount !== this.#childCount;
    const alignmentChanged = alignmentKey !== this.#alignmentKey;
    const evidenceChanged = tableLayoutEvidenceKey(nextEvidence) !==
      tableLayoutEvidenceKey(this.#layoutEvidence);
    if (
      !contentVersionChanged &&
      !rowCountChanged &&
      !alignmentChanged &&
      !evidenceChanged &&
      !tableRangeChanged
    ) {
      return;
    }
    const columnCount = alignments.length;
    const columnCountChanged = columnCount !== this.#layout.count;
    const columnSchemaChanged = alignmentChanged || columnCountChanged;
    this.#contentVersion = node.contentVersion;
    this.#childCount = node.childCount;
    this.#alignmentKey = alignmentKey;
    this.#layoutEvidence = nextEvidence;
    // A table root contentVersion also changes for an ordinary single-cell
    // edit. That is a data update, not a grid/layout reset: keeping the
    // sealed stable widths, row axis and mounted row shells is what prevents
    // one keystroke from visibly rebuilding the whole table.
    //
    // Row count changes resize the vertical axis. Only a column-schema
    // change reopens the stable column widths.
    if (columnSchemaChanged) {
      this.#intrinsicPreferredWidths = undefined;
      this.#layout.invalidateAutoWidths();
      this.#columnMeasurementEpoch += 1;
    }
    this.#layout.configure(columnCount, alignmentKey, this.#layoutContextKey());
    if (columnCountChanged) this.#renderedColumnWindow = undefined;
    this.#layout.ensureMinimumWidths();
    this.#host.setAttribute("aria-rowcount", String(Math.max(0, node.childCount)));
    this.#host.setAttribute("aria-colcount", String(this.#layout.count));
    this.#host.dataset["jotTableLayoutMode"] = this.#layout.mode;
    this.#host.dataset["jotTableAutoWidth"] = this.#layout.autoWidth;
    if (rowCountChanged) this.#rows.setCount(Math.max(0, node.childCount - 1));
    if (columnSchemaChanged) {
      this.#rows.schedule();
      void this.#loadHeader(node).catch((error) => this.#runtime.options.onError?.(error));
      return;
    }

    this.#refreshHeaderFromProjection(node);
    this.#rows.refreshMounted((element, row) =>
      this.#rowNeedsContentUpdate(element, row) ||
      this.#nodeNeedsSourceRebase(element, row));
    if (this.#layout.autoWidth === "live") {
      this.#columnMeasurementEpoch += 1;
      this.#scheduleColumnMeasurement();
    }
  }

  invalidateLayout(): void {
    this.#columnMeasurementEpoch += 1;
    this.#intrinsicPreferredWidths = undefined;
    this.#renderedColumnWindow = undefined;
    this.#layout.resetAutoWidths(false);
    this.#rows.invalidateMeasurements();
    this.#renderHeader();
    this.#rows.schedule();
    this.#scheduleColumnMeasurement();
  }

  updateSelection(): void {
    if (this.#disposed) return;
    this.#refreshHeaderSelection();
    this.#rows.forEachMounted((element, row, index) =>
      this.#refreshRowSelection(element, row, false, index));
    if (this.#toolbar !== undefined) refreshTableToolbar(this.#toolbar);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#host.removeEventListener("scroll", this.#scroll);
    this.#header.removeEventListener("pointerdown", this.#onResizePointerDown);
    this.#host.removeEventListener("mousedown", this.#onCellPointerDown);
    this.#resizeEnd();
    this.#resizeObserver?.disconnect();
    this.#unsubscribeLayout();
    this.#pendingCellRows.clear();
    this.#pendingCellLoads.clear();
    this.#headerLoad = undefined;
    this.#headerLoadKey = undefined;
    this.#rows.dispose();
    this.#runtime.disposeSubtree(this.#header);
  }

  async #loadHeader(node: RenderNode): Promise<void> {
    if (this.#disposed || node.childCount === 0) return;
    const store = this.#runtime.options.session.adapter.projection;
    const existing = store.nodeAt(node.id, "syntax-children", 0);
    // The root content version is the invalidation boundary. A row already in
    // the sparse store is reusable only when it was loaded for this root
    // version; otherwise a structure edit could accidentally keep an old
    // header forever.
    if (existing !== undefined && this.#headerProjectionRootVersion === node.contentVersion) {
      this.#headerNode = existing;
      this.#headerContentVersion = existing.contentVersion;
      this.#queueRowCells(existing);
      this.#renderHeader();
      return;
    }
    const key = `${node.id}:${node.contentVersion}:${node.childCount}`;
    if (this.#headerLoad !== undefined && this.#headerLoadKey === key) {
      await this.#headerLoad;
      return;
    }
    let load!: Promise<void>;
    load = (async () => {
      const missing = store.missingRanges(node.id, "syntax-children", 0, 1);
      if (missing.length > 0) {
        const effect = await tolerateStaleProjection(() =>
          this.#runtime.options.session.project(missing.map((range): ProjectionSlice => ({
            parentId: node.id,
            axis: "syntax-children",
            window: { type: "index", ...range },
            maxDepth: 0,
          }))));
        if (effect === undefined) return;
      }
      if (this.#disposed) return;
      const row = store.nodeAt(node.id, "syntax-children", 0);
      if (row !== undefined) {
        this.#headerProjectionRootVersion = node.contentVersion;
        this.#headerNode = row;
        this.#headerContentVersion = row.contentVersion;
        this.#queueRowCells(row);
        this.#renderHeader();
      }
    })().finally(() => {
      if (this.#headerLoad === load) {
        this.#headerLoad = undefined;
        this.#headerLoadKey = undefined;
      }
    });
    this.#headerLoad = load;
    this.#headerLoadKey = key;
    await load;
  }

  #refreshHeaderFromProjection(node: RenderNode): void {
    if (node.childCount === 0) {
      this.#headerNode = undefined;
      this.#headerContentVersion = undefined;
      this.#headerProjectionRootVersion = undefined;
      this.#runtime.disposeSubtree(this.#header);
      this.#header.replaceChildren();
      return;
    }
    const row = this.#runtime.options.session.adapter.projection.nodeAt(
      node.id,
      "syntax-children",
      0,
    );
    if (row === undefined) {
      // The root descriptor can arrive before its sparse header slice. Keep the
      // current sticky header rather than blanking/rebuilding the table; the
      // normal missing-range loader will replace it when confirmed data lands.
      void this.#loadHeader(node).catch((error) => this.#runtime.options.onError?.(error));
      return;
    }
    const changed = this.#headerNode?.id !== row.id ||
      this.#headerContentVersion !== row.contentVersion ||
      !sameSourceRange(this.#headerNode?.sourceRange, row.sourceRange);
    this.#headerNode = row;
    this.#headerContentVersion = row.contentVersion;
    this.#headerProjectionRootVersion = node.contentVersion;
    if (changed) {
      this.#queueRowCells(row);
      this.#renderHeader();
    }
  }

  #cellPointerDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    if ((event.target as Element | null)?.closest?.("a[href]") != null) return;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".jot-table-cell[data-jot-source-from]")
      : null;
    if (target === null || target.closest(".jot-table-column-resize") !== null) return;
    const from = Number(target.dataset["jotSourceFrom"]);
    const to = Number(target.dataset["jotSourceTo"]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) return;
    event.preventDefault();
    // TableGrid owns the pointer → source mapping. Letting the event continue
    // into CodeMirror makes CM resolve the replacement widget as one opaque
    // boundary and can overwrite the cell-local selection with a position
    // before/after the entire table. This is the same event-isolation rule as
    // other interactive widget controls; the host keeps CodeMirror's source
    // selection and may focus its one transient platform-input surface.
    event.stopPropagation();
    this.#runtime.options.onTableCellFocus?.(
      sourceOffsetAtPoint(target, event.clientX, event.clientY, { from, to }),
      {
        from: from as RenderNode["sourceRange"]["from"],
        to: to as RenderNode["sourceRange"]["to"],
      },
      target,
      event,
    );
  }

  #renderHeader(): void {
    if (this.#disposed || this.#headerNode === undefined) return;
    const existing = this.#header.firstElementChild as HTMLElement | null;
    if (
      existing !== null &&
      existing.dataset["jotNodeId"] === this.#headerNode.id
    ) {
      if (this.#rowNeedsContentUpdate(existing, this.#headerNode)) {
        this.#updateRow(existing, this.#headerNode, true, 0);
      } else if (this.#nodeNeedsSourceRebase(existing, this.#headerNode)) {
        this.#rebaseSourceSubtree(existing, this.#headerNode);
        this.#refreshRowSelection(existing, this.#headerNode, true, 0);
      } else {
        this.#refreshRowSelection(existing, this.#headerNode, true, 0);
      }
    } else {
      this.#runtime.disposeSubtree(this.#header);
      this.#header.replaceChildren(this.#renderRow(this.#headerNode, true, 0));
    }
    this.#renderedColumnWindow = this.#columnWindowKey();
  }

  #renderRow(row: RenderNode, header: boolean, index: number): HTMLElement {
    const element = createTableRowElement(
      this.#host.ownerDocument,
      tableRowDomOptions(row, header, index),
    );
    const window = this.#columnWindow();
    const cells = this.#visibleCells(row, window.from, window.toExclusive);
    this.#queueRowCells(row);
    this.#applyColumnPadding(element, window);
    for (let index = window.from; index < window.toExclusive; index += 1) {
      const cellNode = cells.get(index);
      const cell = cellNode === undefined
        ? this.#emptyCell(row.id, index, header)
        : this.#runtime.mount(cellNode);
      configureTableCellElement(cell, {
        index,
        header,
        width: this.#layout.sizeAt(index),
      });
      this.#applySelection(cell, cellNode);
      if (header) this.#ensureResizeHandle(cell, index);
      element.append(cell);
    }
    this.#scheduleColumnMeasurement();
    return element;
  }

  #updateRow(element: HTMLElement, row: RenderNode, header: boolean, index: number): void {
    const sameRow = element.dataset["jotNodeId"] === row.id;
    const contentChanged = sameRow &&
      element.dataset["jotContentVersion"] !== String(row.contentVersion);
    const rangeChanged = sameRow && this.#nodeNeedsSourceRebase(element, row);
    configureTableRowElement(element, tableRowDomOptions(row, header, index));
    // A row version is expected to change for a normal cell edit. Stable
    // tables keep their existing column geometry; live tables schedule a
    // measurement after only this row/cell subtree has been reconciled.
    if (contentChanged && this.#layout.autoWidth === "live") {
      this.#intrinsicPreferredWidths = undefined;
      this.#layout.invalidateAutoWidths();
      this.#columnMeasurementEpoch += 1;
    }
    const window = this.#columnWindow();
    const visible = this.#visibleCells(row, window.from, window.toExclusive);
    this.#queueRowCells(row);
    this.#applyColumnPadding(element, window);
    const currentCells = Array.from(element.children) as HTMLElement[];
    const byKey = new Map(
      currentCells.map((cell) => [cell.dataset["jotRenderKey"], cell] as const),
    );
    const byColumn = new Map(
      currentCells
        .map((cell) => [Number(cell.dataset["jotColumnIndex"]), cell] as const)
        .filter(([column]) => Number.isSafeInteger(column)),
    );
    const retained = new Set<HTMLElement>();
    let cellDOMChanged = false;
    let reference = element.firstChild;
    for (let index = window.from; index < window.toExclusive; index += 1) {
      const cellNode = visible.get(index);
      const cellUnknown = cellNode === undefined && index < row.childCount;
      const key = cellNode === undefined
        ? `table-empty:${row.id}:${index}`
        : this.#runtime.key(cellNode);
      let cell = byKey.get(key);
      if (cell === undefined) {
        // Sparse projection absence means “unknown”, not “the cell was
        // deleted”. During a cell edit retain the already confirmed shell for
        // that column until the row/cell slice arrives; replacing it with an
        // empty cell is a visible flash and can look like the table rebuilt.
        const retainedUnknown = cellUnknown
          ? byColumn.get(index)
          : undefined;
        cell = retainedUnknown ?? (
          cellNode === undefined
            ? this.#emptyCell(row.id, index, header)
            : this.#runtime.mount(cellNode)
        );
        cellDOMChanged = cell !== retainedUnknown;
      } else if (cellNode !== undefined) {
        if (this.#nodeNeedsContentUpdate(cell, cellNode)) {
          this.#runtime.update(cell, cellNode);
        } else if (this.#nodeNeedsSourceRebase(cell, cellNode)) {
          this.#rebaseSourceSubtree(cell, cellNode);
        }
      }
      configureTableCellElement(cell, {
        index,
        header,
        width: this.#layout.sizeAt(index),
      });
      // A sparse cell hole is not a semantic empty cell. Preserve the current
      // active/selected paint (including the visual caret) until the bounded
      // cell projection confirms the replacement; otherwise a fast edit can
      // briefly make the caret disappear even though the row DOM stayed put.
      if (!cellUnknown) this.#applySelection(cell, cellNode);
      if (header) this.#ensureResizeHandle(cell, index);
      retained.add(cell);
      if (cell !== reference) {
        element.insertBefore(cell, reference);
        cellDOMChanged = true;
      }
      reference = cell.nextSibling;
    }
    for (const cell of currentCells) {
      if (retained.has(cell)) continue;
      this.#runtime.disposeSubtree(cell);
      cell.remove();
      cellDOMChanged = true;
    }
    if (
      this.#layout.autoWidth === "live" &&
      (contentChanged || cellDOMChanged) &&
      !rangeChanged
    ) {
      this.#scheduleColumnMeasurement();
    }
  }

  #refreshHeaderSelection(): void {
    if (this.#headerNode === undefined) return;
    const existing = this.#header.firstElementChild as HTMLElement | null;
    if (
      existing === null ||
      existing.dataset["jotNodeId"] !== this.#headerNode.id ||
      this.#rowNeedsContentUpdate(existing, this.#headerNode)
    ) {
      this.#renderHeader();
      return;
    }
    this.#refreshRowSelection(existing, this.#headerNode, true, 0);
  }

  /**
   * Selection is a host fact, not row content. Repaint only active/selected
   * cell affordances without scheduling the row virtual list or touching the
   * RenderRuntime subtree. This keeps keyboard motion inside a table from
   * becoming an accidental all-visible-row reconciliation.
   */
  #refreshRowSelection(
    element: HTMLElement,
    row: RenderNode,
    header: boolean,
    _index: number,
  ): void {
    if (
      element.dataset["jotNodeId"] !== row.id ||
      this.#rowNeedsContentUpdate(element, row)
    ) {
      return;
    }
    if (this.#nodeNeedsSourceRebase(element, row)) {
      this.#rebaseSourceSubtree(element, row);
    }
    const cells = this.#visibleCells(row, this.#columnWindow().from, this.#columnWindow().toExclusive);
    for (const cell of Array.from(element.children) as HTMLElement[]) {
      const column = Number(cell.dataset["jotColumnIndex"]);
      const cellNode = Number.isSafeInteger(column) ? cells.get(column) : undefined;
      const cellUnknown = Number.isSafeInteger(column) &&
        cellNode === undefined &&
        column < row.childCount;
      if (!cellUnknown) this.#applySelection(cell, cellNode);
      if (header && Number.isSafeInteger(column)) this.#ensureResizeHandle(cell, column);
    }
  }

  #rowNeedsContentUpdate(element: HTMLElement, row: RenderNode): boolean {
    if (element.dataset["jotNodeId"] !== row.id ||
      element.dataset["jotContentVersion"] !== String(row.contentVersion)) return true;
    // Sparse cell hydration does not change the semantic row version. A row
    // rendered before its cells arrive must still reconcile those placeholders.
    const window = this.#columnWindow();
    // Column measurement and horizontal scrolling can change the window
    // without changing a row's semantic version. A header mounted with
    // estimated widths must also update the unmounted column space.
    if (
      element.childElementCount !== window.toExclusive - window.from ||
      // CSS serializes fractional pixel values at a different precision from
      // the Float64 axis. Compare geometry, not its string representation.
      Math.abs(cssPixels(element.style.paddingInlineStart) - window.beforePixels) > 0.5 ||
      Math.abs(cssPixels(element.style.paddingInlineEnd) - window.afterPixels) > 0.5
    ) return true;
    let column = window.from;
    for (const child of Array.from(element.children) as HTMLElement[]) {
      if (!child.classList.contains("jot-table-cell")) continue;
      if (
        Number(child.dataset["jotColumnIndex"]) !== column ||
        Math.abs(Number.parseFloat(child.style.width) - this.#layout.sizeAt(column)) > 0.01
      ) return true;
      column += 1;
    }
    const cells = this.#visibleCells(row, window.from, window.toExclusive);
    for (const child of Array.from(element.children) as HTMLElement[]) {
      if (!child.classList.contains("jot-table-cell")) continue;
      const node = cells.get(Number(child.dataset["jotColumnIndex"]));
      if (node !== undefined && this.#nodeNeedsContentUpdate(child, node)) return true;
    }
    return false;
  }

  #nodeNeedsContentUpdate(element: HTMLElement, node: RenderNode): boolean {
    return element.dataset["jotNodeId"] !== node.id ||
      element.dataset["jotKind"] !== node.kind ||
      element.dataset["jotContentVersion"] !== String(node.contentVersion);
  }

  #nodeNeedsSourceRebase(element: HTMLElement, node: RenderNode): boolean {
    const from = Number(element.dataset["jotSourceFrom"]);
    const to = Number(element.dataset["jotSourceTo"]);
    const nextFrom = Number(node.sourceRange.from);
    const nextTo = Number(node.sourceRange.to);
    return Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      (from !== nextFrom || to !== nextTo);
  }

  /**
   * An unchanged row/cell may move forward in source offsets after text is
   * inserted before it. Its RenderNode contentVersion remains stable, so
   * rerendering all suffix rows would be needless. Rebase only the source
   * anchors already present in this DOM subtree; text, row geometry and
   * component instances stay intact.
   */
  #rebaseSourceSubtree(element: HTMLElement, node: RenderNode): boolean {
    const previousFrom = Number(element.dataset["jotSourceFrom"]);
    const previousTo = Number(element.dataset["jotSourceTo"]);
    const nextFrom = Number(node.sourceRange.from);
    const nextTo = Number(node.sourceRange.to);
    const delta = nextFrom - previousFrom;
    if (
      !Number.isSafeInteger(previousFrom) ||
      !Number.isSafeInteger(previousTo) ||
      !Number.isSafeInteger(delta) ||
      previousTo - previousFrom !== nextTo - nextFrom
    ) {
      return false;
    }
    for (const anchor of [
      element,
      ...element.querySelectorAll<HTMLElement>("[data-jot-source-from][data-jot-source-to]"),
    ]) {
      const from = Number(anchor.dataset["jotSourceFrom"]);
      const to = Number(anchor.dataset["jotSourceTo"]);
      if (
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < previousFrom ||
        to > previousTo
      ) {
        continue;
      }
      anchor.dataset["jotSourceFrom"] = String(from + delta);
      anchor.dataset["jotSourceTo"] = String(to + delta);
    }
    return true;
  }

  #emptyCell(rowId: string, index: number, header: boolean): HTMLElement {
    const cell = createTableCellElement(this.#host.ownerDocument, {
      index,
      header,
      empty: true,
    });
    cell.dataset["jotRenderKey"] = `table-empty:${rowId}:${index}`;
    return cell;
  }

  #applySelection(cell: HTMLElement, node: RenderNode | undefined): void {
    if (node === undefined || node.kind !== "table-cell") {
      setElementClass(cell, "jot-live-preview-table-cell--active", false);
      setElementClass(cell, "jot-live-preview-table-cell--selected", false);
      if (cell.hasAttribute("aria-selected")) cell.removeAttribute("aria-selected");
      this.#clearVisualCaretPosition(cell);
      return;
    }
    const selection = this.#runtime.options.resolveSelection?.(this.#tableRange);
    const from = Number(node.sourceRange.from);
    const to = Number(node.sourceRange.to);
    const selectionFrom = selection === undefined
      ? -1
      : Math.min(Number(selection.anchor), Number(selection.head));
    const selectionTo = selection === undefined
      ? -1
      : Math.max(Number(selection.anchor), Number(selection.head));
    const active = selection !== undefined &&
      selection.anchor === selection.head &&
      containsCellOffset(from, to, Number(selection.head));
    const selected = selection !== undefined &&
      selection.anchor !== selection.head &&
      rangesIntersect(from, to, selectionFrom, selectionTo);
    setElementClass(cell, "jot-live-preview-table-cell--active", active);
    setElementClass(cell, "jot-live-preview-table-cell--selected", selected);
    setElementAttribute(cell, "aria-selected", active || selected ? "true" : "false");
    if (active) {
      this.#positionVisualCaret(cell, Number(selection!.head));
    } else {
      this.#clearVisualCaretPosition(cell);
    }
  }

  /**
   * TableGrid 不创建 contenteditable。caret 是 active cell 的伪元素，只由
   * CodeMirror collapsed selection 映射出的 CSS 几何驱动。它不再作为
   * RenderNode child 被 Runtime.update() 反复卸载/插回，因此连续输入不会重启
   * blink animation，也不会制造看起来像整表刷新的 childList mutation。
   */
  #positionVisualCaret(
    cell: HTMLElement,
    sourceOffset: number,
  ): void {
    const range = domRangeForSourceOffset(cell, sourceOffset);
    const cellRect = cell.getBoundingClientRect();
    const caretRect = range?.getClientRects()[0] ?? range?.getBoundingClientRect();
    const styles = cell.ownerDocument.defaultView?.getComputedStyle(cell);
    const lineHeight = cssPixels(styles?.lineHeight) || cssPixels(styles?.fontSize) || 16;
    const paddingInline = cssPixels(styles?.paddingInlineStart);
    const paddingBlock = cssPixels(styles?.paddingBlockStart);
    const left = caretRect !== undefined && caretRect.width + caretRect.height > 0
      ? caretRect.left - cellRect.left
      : paddingInline;
    const top = caretRect !== undefined && caretRect.width + caretRect.height > 0
      ? caretRect.top - cellRect.top
      : paddingBlock;
    const height = caretRect !== undefined && caretRect.height > 0
      ? caretRect.height
      : lineHeight;
    setStyleProperty(
      cell,
      "--jot-live-table-caret-inline-start",
      `${Math.max(0, left)}px`,
    );
    setStyleProperty(
      cell,
      "--jot-live-table-caret-block-start",
      `${Math.max(0, top)}px`,
    );
    setStyleProperty(
      cell,
      "--jot-live-table-caret-height",
      `${Math.max(1, height)}px`,
    );
  }

  #clearVisualCaretPosition(cell: HTMLElement): void {
    for (const property of [
      "--jot-live-table-caret-inline-start",
      "--jot-live-table-caret-block-start",
      "--jot-live-table-caret-height",
    ]) {
      if (cell.style.getPropertyValue(property) !== "") cell.style.removeProperty(property);
    }
  }

  #visibleCells(
    row: RenderNode,
    from: number,
    toExclusive: number,
  ): ReadonlyMap<number, RenderNode> {
    const cells = new Map<number, RenderNode>();
    if (row.content.type === "structured") {
      for (
        let index = from;
        index < Math.min(toExclusive, row.content.children.length);
        index += 1
      ) {
        const cell = row.content.children[index];
        if (cell !== undefined) cells.set(index, cell);
      }
      return cells;
    }
    const store = this.#runtime.options.session.adapter.projection;
    for (let index = from; index < Math.min(toExclusive, row.childCount); index += 1) {
      const cell = store.nodeAt(row.id, "syntax-children", index);
      if (cell !== undefined) cells.set(index, cell);
    }
    return cells;
  }

  #queueRowCells(row: RenderNode): void {
    if (row.childCount === 0 || row.content.type === "structured") return;
    this.#pendingCellRows.set(row.id, row);
    this.#scheduleCellLoad();
  }

  #scheduleCellLoad(): void {
    if (this.#disposed || this.#cellLoadScheduled || this.#pendingCellRows.size === 0) {
      return;
    }
    this.#cellLoadScheduled = true;
    queueMicrotask(() => {
      this.#cellLoadScheduled = false;
      void this.#loadVisibleCells().catch((error) => this.#runtime.options.onError?.(error));
    });
  }

  async #loadVisibleCells(): Promise<void> {
    if (this.#disposed) return;
    const rows = [...this.#pendingCellRows.values()];
    this.#pendingCellRows.clear();
    const window = this.#columnWindow();
    const store = this.#runtime.options.session.adapter.projection;
    const pendingKeys: string[] = [];
    const slices = rows.flatMap((row): ProjectionSlice[] =>
      store
        .missingRanges(
          row.id,
          "syntax-children",
          window.from,
          Math.min(window.toExclusive, row.childCount),
        )
        .flatMap((range): ProjectionSlice[] => {
          const key = `${row.id}:${range.from}:${range.toExclusive}`;
          if (this.#pendingCellLoads.has(key)) return [];
          this.#pendingCellLoads.add(key);
          pendingKeys.push(key);
          return [{
            parentId: row.id,
            axis: "syntax-children",
            window: { type: "index", ...range },
            maxDepth: 1,
          }];
        }));
    if (slices.length === 0) return;
    try {
      const effect = await tolerateStaleProjection(() =>
        this.#runtime.options.session.project(slices));
      if (this.#disposed || effect === undefined) return;
      const hydrated = new Set(rows.map((row) => row.id));
      this.#rows.refreshMounted((element, row) => hydrated.has(row.id) &&
        this.#rowNeedsContentUpdate(element, row));
      if (this.#toolbar !== undefined) refreshTableToolbar(this.#toolbar);
      this.#rows.schedule();
      this.#renderHeader();
    } finally {
      for (const key of pendingKeys) this.#pendingCellLoads.delete(key);
      // A newer keyed row update may have arrived while the request was
      // pending. Let it recalculate missing ranges after the in-flight guard is
      // released instead of losing that load request.
      if (!this.#disposed && this.#pendingCellRows.size > 0) this.#scheduleCellLoad();
    }
  }

  #applyColumnPadding(row: HTMLElement, window: { beforePixels: number; afterPixels: number }): void {
    setStyleProperty(row, "padding-inline-start", `${Math.max(0, window.beforePixels)}px`);
    setStyleProperty(row, "padding-inline-end", `${Math.max(0, window.afterPixels)}px`);
  }

  #columnWindow() {
    return this.#layout.window(
      logicalScrollLeft(this.#host),
      this.#host.clientWidth,
      this.#runtime.options.table?.estimatedColumnWidth ??
        this.#runtime.options.estimatedColumnWidth ??
        160,
    );
  }

  #columnWindowKey(): string {
    const window = this.#columnWindow();
    return `${window.from}:${window.toExclusive}`;
  }

  #scheduleColumnMeasurement(): void {
    if (this.#disposed || this.#measureScheduled) return;
    this.#measureScheduled = true;
    const epoch = this.#columnMeasurementEpoch;
    const view = this.#host.ownerDocument.defaultView;
    const run = () => {
      this.#measureScheduled = false;
      this.#measureColumns(epoch);
    };
    if (view === null || view === undefined) queueMicrotask(run);
    else view.requestAnimationFrame(run);
  }

  #measureColumns(epoch = this.#columnMeasurementEpoch): void {
    if (
      this.#disposed ||
      this.#layout.count === 0 ||
      !this.#layout.needsAutoWidthMeasurement
    ) return;
    // 表头还没有真实 cell 时，当前窗口只有空占位符；此时冻结宽度会把
    // 最小宽度错误地当成最终宽度。等待表头投影完成后再进行首轮收敛。
    if (
      this.#headerNode === undefined ||
      this.#header.querySelector(".jot-table-cell:not(.jot-table-cell--empty)") === null
    ) return;
    const minimum = this.#minimumColumnWidth();
    const shouldMeasureVisibleCells = this.#layout.autoWidth === "live" ||
      this.#intrinsicPreferredWidths === undefined;
    const preferredWidths = shouldMeasureVisibleCells
      ? Array.from({ length: this.#layout.count }, () => undefined as number | undefined)
      : this.#intrinsicPreferredWidths!.slice();
    if (shouldMeasureVisibleCells) {
      const canvas = this.#host.ownerDocument.createElement("canvas");
      const context = canvas.getContext("2d");
      for (const cell of this.#host.querySelectorAll<HTMLElement>(
        ".jot-table-cell[data-jot-column-index]",
      )) {
        const index = Number(cell.dataset["jotColumnIndex"]);
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.#layout.count) {
          continue;
        }
        const intrinsic = softWrapCellWidth(cell, context, minimum);
        // 不读取 cell.scrollWidth：表头拖拽手柄会越过单元格边界，使该值始终比
        // 当前列宽大几像素。若把它作为下一轮测量依据，ResizeObserver 每触发一次
        // 就会把所有列再撑宽一点。只有真正不可断的行内渲染器单独提供宽度证据。
        const unbreakable = unbreakableInlineCellWidth(cell, minimum);
        preferredWidths[index] = Math.max(
          preferredWidths[index] ?? minimum,
          intrinsic,
          unbreakable,
        );
      }
      if (this.#layout.autoWidth === "stable") {
        this.#intrinsicPreferredWidths = preferredWidths.slice();
      }
    }

    // A newer structural/data update was committed while this measurement was
    // waiting for rAF. Never apply an old visible-cell sample to the current
    // table layout; schedule the latest epoch instead.
    if (epoch !== this.#columnMeasurementEpoch) {
      this.#scheduleColumnMeasurement();
      return;
    }

    const logicalLeft = logicalScrollLeft(this.#host);
    const anchorIndex = this.#layout.indexAt(logicalLeft);
    const insideAnchor = logicalLeft - this.#layout.offsetAt(anchorIndex);
    const changed = this.#layout.reconcile(
      preferredWidths,
      this.#containingWidth(),
      this.#layoutEvidence,
    );
    this.#layout.sealAutoWidths();
    if (!changed) return;

    for (const cell of this.#host.querySelectorAll<HTMLElement>(
      ".jot-table-cell[data-jot-column-index]",
    )) {
      const index = Number(cell.dataset["jotColumnIndex"]);
      if (Number.isSafeInteger(index) && index >= 0 && index < this.#layout.count) {
        cell.style.width = `${this.#layout.sizeAt(index)}px`;
      }
    }
    setLogicalScrollLeft(this.#host, this.#layout.offsetAt(anchorIndex) + insideAnchor);
    this.#renderedColumnWindow = undefined;
    this.#rows.schedule();
    this.#renderHeader();
  }

  #minimumColumnWidth(): number {
    return Math.max(
      48,
      this.#runtime.options.table?.minColumnWidth ??
        this.#runtime.options.minTableColumnWidth ??
        56,
    );
  }

  #onResizePointerDown = (event: PointerEvent): void => {
    if (!this.#layout.resizableColumns || this.#disposed) return;
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>(".jot-table-column-resize")
      : null;
    if (target === null) return;
    const column = Number(target.dataset["jotColumnIndex"]);
    if (!Number.isSafeInteger(column) || column < 0 || column >= this.#layout.count) return;
    event.preventDefault();
    target.setPointerCapture?.(event.pointerId);
    this.#resizeDrag = {
      pointerId: event.pointerId,
      column,
      startX: event.clientX,
      startWidth: this.#layout.sizeAt(column),
      handle: target,
    };
    this.#host.ownerDocument.addEventListener("pointermove", this.#onResizePointerMove);
    this.#host.ownerDocument.addEventListener("pointerup", this.#onResizePointerUp, { once: true });
  };

  #resizeMove(event: PointerEvent): void {
    const drag = this.#resizeDrag;
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    const direction = this.#host.ownerDocument.defaultView?.getComputedStyle(this.#host).direction;
    const delta = (direction === "rtl" ? -1 : 1) * (event.clientX - drag.startX);
    if (!this.#layout.setUserWidth(drag.column, drag.startWidth + delta)) return;
    this.#applyMountedColumnWidths();
  }

  #resizeEnd(event?: PointerEvent): void {
    const drag = this.#resizeDrag;
    if (drag === undefined || (event !== undefined && event.pointerId !== drag.pointerId)) return;
    drag.handle.releasePointerCapture?.(drag.pointerId);
    this.#host.ownerDocument.removeEventListener("pointermove", this.#onResizePointerMove);
    this.#host.ownerDocument.removeEventListener("pointerup", this.#onResizePointerUp);
    this.#resizeDrag = undefined;
  }

  #ensureResizeHandle(cell: HTMLElement, index: number): void {
    if (!this.#layout.resizableColumns) return;
    let handle = cell.querySelector<HTMLElement>(".jot-table-column-resize");
    if (handle === null) {
      handle = cell.ownerDocument.createElement("span");
      handle.className = "jot-table-column-resize";
      handle.setAttribute("role", "separator");
      handle.tabIndex = 0;
      handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const delta = event.key === "ArrowLeft" ? -16 : 16;
        const direction = cell.ownerDocument.defaultView?.getComputedStyle(this.#host).direction;
        const signedDelta = direction === "rtl" ? -delta : delta;
        if (this.#layout.setUserWidth(index, this.#layout.sizeAt(index) + signedDelta)) {
          event.preventDefault();
          this.#applyMountedColumnWidths();
        }
      });
      cell.append(handle);
    }
    handle.dataset["jotColumnIndex"] = String(index);
    editorI18nAt(this.#runtime.options.root).bind(handle, "aria-label", "Resize table column $1", index + 1);
  }

  #applyMountedColumnWidths(): void {
    for (const cell of this.#host.querySelectorAll<HTMLElement>(
      ".jot-table-cell[data-jot-column-index]",
    )) {
      const index = Number(cell.dataset["jotColumnIndex"]);
      if (Number.isSafeInteger(index) && index >= 0 && index < this.#layout.count) {
        cell.style.width = `${this.#layout.sizeAt(index)}px`;
      }
    }
    this.#renderedColumnWindow = undefined;
    this.#rows.schedule();
    this.#renderHeader();
  }

  #layoutContextKey(): string {
    const view = this.#host.ownerDocument.defaultView;
    const direction = view === null ? "ltr" : view.getComputedStyle(this.#host).direction;
    const containingWidth = this.#containingWidth();
    return tableLayoutContextKey(
      this.#layout.mode,
      direction,
      containingWidth,
      this.#layout.fillRatio,
    );
  }

  /** content 表格初始为 intrinsic 宽度，填充策略仍必须读取外层容器而不是自身 clientWidth。 */
  #containingWidth(): number {
    const parent = this.#host.parentElement;
    if (parent === null || parent.clientWidth <= 0) return this.#host.clientWidth;
    const view = parent.ownerDocument.defaultView;
    if (view === null) return parent.clientWidth;
    // A block widget can be a direct child of padded `.cm-content`.
    // clientWidth includes that padding, while width:100% and the column
    // viewport use its content box. Counting the paper inset as table width
    // makes an otherwise fitting table overflow and can enlarge the CM axis.
    const parentStyle = view.getComputedStyle(parent);
    const hostStyle = view.getComputedStyle(this.#host);
    return Math.max(1, parent.clientWidth -
      cssPixels(parentStyle.paddingInlineStart) - cssPixels(parentStyle.paddingInlineEnd) -
      cssPixels(hostStyle.borderInlineStartWidth) - cssPixels(hostStyle.borderInlineEndWidth));
  }
}

function containsCellOffset(from: number, to: number, offset: number): boolean {
  // Empty table cells are valid editing targets. Their only source position is
  // both boundaries, so retain the inclusive check for that special case.
  return from === to
    ? offset === from
    : from <= offset && offset <= to;
}

function rangesIntersect(
  leftFrom: number,
  leftTo: number,
  rightFrom: number,
  rightTo: number,
): boolean {
  if (leftFrom === leftTo) return rightFrom <= leftFrom && leftFrom <= rightTo;
  return leftFrom < rightTo && rightFrom < leftTo;
}

function sameSourceRange(
  left: RenderNode["sourceRange"] | undefined,
  right: RenderNode["sourceRange"],
): boolean {
  return left !== undefined &&
    Number(left.from) === Number(right.from) &&
    Number(left.to) === Number(right.to);
}

function setElementClass(
  element: HTMLElement,
  className: string,
  present: boolean,
): void {
  if (element.classList.contains(className) !== present) {
    element.classList.toggle(className, present);
  }
}

function setElementAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setStyleProperty(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
}
