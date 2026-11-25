import type {
  ProjectionSlice,
  RenderNode,
  TextRange,
} from "@jot-md/editor-protocol";
import type { AdapterEffect } from "../../adapter/document-adapter.js";
import type { EditorDocumentSession } from "../../adapter/session.js";
import { installEditorSurfaceStyles } from "./styles.js";
import {
  PreTextProjectionFilter,
  type PreTextProjectionContext,
  type PreTextStyleMetrics,
  type PreTextSurfaceItem,
} from "../../layout/pretext/filter.js";
import { applyPreTextStyleMetrics } from "../../layout/pretext/style-metrics.js";
import {
  surfaceLayoutContextKey,
  type SurfaceLayoutContext,
} from "../../core/projection/projection-filter.js";
import type {
  DomRenderContext,
  ImageMetadataResolver,
} from "../../components/common/dom-renderer.js";
import { VirtualAxis } from "../../core/virtual/virtual-axis.js";
import { FoldedVirtualAxis } from "../../core/virtual/folded-axis.js";
import {
  resolveTableLayoutOptions,
  type TableLayoutOptions,
  type TableLayoutSnapshot,
} from "../../components/table/layout.js";
import {
  DomVirtualList,
  type VirtualCommitMetrics,
} from "../../core/virtual/dom-virtual-list.js";
import {
  PreTextTextLayout,
  type PreTextTextStyle,
} from "../../layout/pretext/text-layout.js";
import { applyEditorTypography, type EditorLayoutStyle, type PreTextOptions } from "../../layout/pretext/options.js";
import {
  DirectScrollbar,
  type EditorScrollbarMode,
} from "../../layout/direct-scrollbar.js";
import { RenderRuntime } from "../../render/runtime/dom-runtime.js";
import {
  cssPixels,
  domDepth,
  isAtScrollEnd,
  mapOffsetThroughEdits,
  monotonicNow,
  nextLayoutFrame,
  normalizePositiveInteger,
  normalizePositiveNumber,
  pretextContentSignature,
  replacesMostDocument,
  resolveSurfaceImageMetadata,
  safeUtf16SliceEnd,
  scrollElementToEnd,
  isRevisionMismatch,
  tolerateStaleProjection,
} from "../../components/common/render-utils.js";
import {
  preTextDetailDepth,
  previewDetailDepth,
} from "./projection/detail-depth.js";
import type { TableCommandExecutor } from "../../components/table/commands.js";

export {
  mapOffsetThroughEdits,
  renderNodeKey,
  renderNodeShapeKey,
  replacesMostDocument,
} from "../../components/common/render-utils.js";

/** 可复用编辑器 API 对外暴露的规范 Surface 模式。 */
export type EditorSurfaceMode = "pretext" | "preview";

export interface EditorSurfaceOptions {
  readonly root: HTMLElement;
  readonly session: EditorDocumentSession;
  readonly pluginRegistry?: import("../../plugins/registry.js").EditorPluginRegistry;
  readonly headingFolds?: import("../folding/heading-fold.js").HeadingFoldController;
  readonly mode?: EditorSurfaceMode;
  /** 隐藏的 Surface 可暂停 DOM 与投影工作；重新激活时从当前 revision 重建。 */
  readonly active?: boolean;
  readonly overscanPixels?: number;
  /** Initial height for unprojected roots. Defaults to one paragraph line including its frame and gap. */
  readonly estimatedBlockHeight?: number;
  readonly estimatedLineHeight?: number;
  readonly estimatedRowHeight?: number;
  readonly estimatedColumnWidth?: number;
  readonly minTableColumnWidth?: number;
  readonly maxTableColumnWidth?: number;
  /** 虚拟 Surface 默认使用可按比例点击的滚动条；需要原生外观时可显式关闭。 */
  readonly scrollbar?: EditorScrollbarMode;
  /** 由前端持有的表格几何信息和可选用户列宽。 */
  readonly table?: TableLayoutOptions;
  readonly installStyles?: boolean;
  readonly renderMath?: DomRenderContext["renderMath"];
  readonly onLink?: DomRenderContext["onLink"];
  /** 浏览器侧图片元数据；同一份数据同时服务 Preview 和 PreText。 */
  readonly resolveImageSrc?: (destination: string) => string | undefined;
  readonly resolveImageMetadata?: ImageMetadataResolver;
  /** Preview 表格工具条使用的统一 command 端口；不直接修改 DOM 或源码。 */
  readonly onTableCommand?: TableCommandExecutor;
  /** Preview 点击 cell 后回到唯一的 CodeMirror source 选区。 */
  readonly onTableCellFocus?: (offset: number, options?: {
    readonly focusInput?: boolean;
  }) => void;
  /** Preview 工具条从宿主唯一 selection 解析当前表格的 command anchor。 */
  readonly resolveSelectionAnchor?: (fallback: number, tableRange: TextRange) => number;
  readonly pretext?: PreTextOptions;
  readonly onCommit?: (event: EditorSurfaceCommitEvent) => void;
  readonly onError?: (error: unknown) => void;
}

/** 可在两个 Surface 之间传递的逻辑根块位置。 */
export interface EditorSurfaceScrollAnchor {
  readonly blockIndex: number;
  readonly sourceOffset: number;
  /** 当前块在实测或估算外部高度中的相对进度。 */
  readonly progress: number;
}

export type EditorSurfaceCommitReason =
  | "open"
  | "mode"
  | "document"
  | "projection"
  | "viewport";

export interface EditorSurfaceCommitEvent extends VirtualCommitMetrics {
  readonly revision: import("@jot-md/editor-protocol").Revision;
  readonly viewRevision: number;
  readonly mode: EditorSurfaceMode;
  readonly reason: EditorSurfaceCommitReason;
  readonly window: import("../../core/virtual/virtual-axis.js").VirtualWindow;
  readonly filteredItems: number;
  readonly truncatedItems: number;
  readonly filterDurationMs: number;
}

interface RootVirtualList {
  readonly axis: VirtualAxis;
  readonly window: import("../../core/virtual/virtual-axis.js").VirtualWindow | undefined;
  setCount(count: number): void;
  schedule(): void;
  splice(changes: readonly import("../../core/virtual/virtual-axis.js").VirtualSplice[]): void;
  invalidateMeasurements(): void;
  refresh(): Promise<void>;
  settled(): Promise<void>;
  dispose(): void;
}

/**
 * 只读 DOM projection Surface。编辑事件有意留在宿主编辑器中；源码变化通过
 * EditorTransactionCoordinator 进入。
 */
export class EditorSurface {
  #options: EditorSurfaceOptions;
  #layoutEpoch = 0;
  readonly #content: HTMLElement;
  #metrics: PreTextStyleMetrics;
  readonly #runtime: RenderRuntime;
  readonly #pretextFilter: PreTextProjectionFilter;
  readonly #pretextTextLayout: PreTextTextLayout;
  readonly #directScrollbar: DirectScrollbar | undefined;
  #pretextTextStyleCache: { readonly key: string; readonly style: PreTextTextStyle } | undefined;
  readonly #pretextCache = new Map<string, PreTextSurfaceItem>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeFold: (() => void) | undefined;
  #foldAxis: FoldedVirtualAxis | undefined;
  #foldGutterEnabled = false;
  #mode: EditorSurfaceMode;
  #active: boolean;
  #rootList: RootVirtualList | undefined;
  #opened = false;
  #disposed = false;
  #rebuildEpoch = 0;
  #projectionRefreshScheduled = false;
  #projectionRefreshRunning = false;
  #projectionRefreshRequested = false;
  #projectionRefreshNeedsProject = false;
  #projectionRefreshPreserveEnd = false;
  #projectionRefreshEndGeneration = 0;
  readonly #rootProjectionOwner = Symbol("preview-root-window");
  #scrollGeneration = 0;
  readonly #onScroll = () => {
    this.#scrollGeneration += 1;
  };
  #commitReason: EditorSurfaceCommitReason | undefined;
  #filteredItems = 0;
  #truncatedItems = 0;
  #filterDurationMs = 0;
  #contentWidthCache: { readonly key: string; readonly width: number } | undefined;
  #refreshChain: Promise<void> = Promise.resolve();

  constructor(options: EditorSurfaceOptions) {
    this.#options = options;
    this.#mode = options.mode ?? "preview";
    this.#active = options.active ?? true;
    options.session.adapter.setMode("preview");
    options.root.classList.add("jot-editor-surface");
    if (options.installStyles !== false) {
      installEditorSurfaceStyles(options.root.ownerDocument);
    }
    this.#content = options.root.ownerDocument.createElement("div");
    this.#content.className = "jot-editor-content";
    options.root.replaceChildren(this.#content);
    this.#metrics = applyPreTextStyleMetrics(this.#content, options.pretext?.metrics);
    this.#directScrollbar = (options.scrollbar ?? "direct") === "direct"
      ? new DirectScrollbar({
        scrollElement: options.root,
        contentElement: this.#content,
        installStyles: options.installStyles !== false,
        onUserScroll: this.#onScroll,
      })
      : undefined;
    this.#directScrollbar?.setEnabled(this.#active);
    options.root.addEventListener("scroll", this.#onScroll, { passive: true });
    // EditorSurface 的公开回调保留 `focusInput` 选项；RenderRuntime 的内部
    // TableGrid 回调还会附带已命中的 cell range。这里显式收窄端口，不能把
    // cell range 误当成公开 options 透传给宿主。
    const { onTableCellFocus, ...runtimeOptions } = options;
    this.#runtime = new RenderRuntime({
      ...runtimeOptions,
      ...(onTableCellFocus === undefined
        ? {}
        : { onTableCellFocus: (offset: number) => onTableCellFocus(offset) }),
    });
    this.#pretextFilter = new PreTextProjectionFilter(options.pretext);
    this.#pretextTextLayout = new PreTextTextLayout({
      document: options.root.ownerDocument,
      fallbackCharacterWidth: normalizePositiveNumber(options.pretext?.averageCharacterWidth, 8),
    });
    this.#unsubscribe = options.session.subscribe((effect) => this.#accept(effect));
    this.#unsubscribeFold = options.headingFolds?.subscribe(() => {
      if (this.#disposed) return;
      const enabled = options.headingFolds!.enabled;
      if (this.#content.classList.toggle("jot-heading-fold-enabled", enabled) !== this.#foldGutterEnabled) {
        this.#foldGutterEnabled = enabled;
        this.#contentWidthCache = undefined;
        this.#pretextCache.clear();
        this.#rootList?.invalidateMeasurements();
      }
      if (this.#foldAxis === undefined) return;
      this.#foldAxis.setHidden(options.headingFolds!.visibleRanges.map(fold => ({ from: fold.fromBlock, toExclusive: fold.toBlock })));
      this.#rootList?.schedule();
    });
  }

  get mode(): EditorSurfaceMode {
    return this.#mode;
  }

  captureScrollAnchor(): EditorSurfaceScrollAnchor {
    this.#assertLive();
    const axis = this.#rootList?.axis;
    if (axis === undefined || axis.count === 0) {
      return { blockIndex: 0, sourceOffset: 0, progress: 0 };
    }
    const localTop = this.#localScrollTop();
    const blockIndex = Math.min(axis.count - 1, axis.indexAt(localTop));
    const blockTop = axis.offsetAt(blockIndex);
    const blockHeight = Math.max(1, axis.sizeAt(blockIndex));
    const physicalIndex = this.#foldAxis?.physicalAt(blockIndex) ?? blockIndex;
    const node = this.#options.session.adapter.projection.nodeAt(
      "0",
      "syntax-children",
      physicalIndex,
    );
    const indexed = this.#options.session.adapter.blocks.blocks[physicalIndex];
    return {
      blockIndex: physicalIndex,
      sourceOffset: Number(node?.sourceRange.from ?? indexed?.sourceRange.from ?? 0),
      progress: Math.max(0, Math.min(1, (localTop - blockTop) / blockHeight)),
    };
  }

  applyScrollAnchor(anchor: EditorSurfaceScrollAnchor): void {
    this.#assertLive();
    const list = this.#rootList;
    if (list === undefined || list.axis.count === 0) return;
    const indexIsUsable = Number.isSafeInteger(anchor.blockIndex) &&
      anchor.blockIndex >= 0 && anchor.blockIndex < (this.#foldAxis?.physicalCount ?? list.axis.count);
    const mapped = indexIsUsable
      ? anchor.blockIndex
      : this.#options.session.adapter.blocks.blockAt(anchor.sourceOffset);
    const blockIndex = Math.max(
      0,
      Math.min(list.axis.count - 1, this.#foldAxis?.visibleAt(mapped ?? anchor.blockIndex) ?? (mapped ?? anchor.blockIndex)),
    );
    const progress = Math.max(0, Math.min(1, anchor.progress));
    const localTarget = list.axis.offsetAt(blockIndex) +
      list.axis.sizeAt(blockIndex) * progress;
    const contentTop = this.#contentTopInScrollContent();
    const maximum = Math.max(0, this.#options.root.scrollHeight - this.#options.root.clientHeight);
    this.#options.root.scrollTop = Math.max(0, Math.min(maximum, contentTop + localTarget));
    list.schedule();
  }

  /**
   * 按 Surface 自己的滚动轴设置绝对偏移。列表仍会继续测量可见节点，后续
   * 尺寸修正由虚拟轴处理，不要求宿主直接操作内部 DOM。
   */
  scrollToOffset(offset: number): void {
    this.#assertLive();
    const maximum = Math.max(0, this.#options.root.scrollHeight - this.#options.root.clientHeight);
    this.#setUserScrollTop(Math.max(0, Math.min(maximum, offset)));
    this.#rootList?.schedule();
  }

  /** 将 Surface 定位到当前可用的末尾；动态高度稳定后会继续保持在末尾。 */
  scrollToEnd(): void {
    this.#assertLive();
    this.#setUserScrollTop(Math.max(
      0,
      this.#options.root.scrollHeight - this.#options.root.clientHeight,
    ));
    this.#rootList?.schedule();
  }

  /** 返回前端几何信息，但不暴露 DOM 内部结构。 */
  tableLayout(tableId: string): TableLayoutSnapshot | undefined {
    this.#assertLive();
    return this.#runtime.tableLayoutSnapshot(tableId);
  }

  setTableColumnWidth(tableId: string, column: number, width: number): boolean {
    this.#assertLive();
    return this.#runtime.setTableColumnWidth(tableId, column, width);
  }

  resetTableLayout(tableId: string): boolean {
    this.#assertLive();
    return this.#runtime.resetTableLayout(tableId);
  }

  async open(): Promise<void> {
    this.#assertLive();
    if (this.#opened) return;
    await this.#options.session.open({ visibleRanges: [] });
    this.#opened = true;
    if (!this.#active) return;
    // 首次 DOM/虚拟列表构建是渲染宿主工作，不是编辑核心的前置条件。
    // 只要 session 握手完成就返回，让 MarkdownEditor 立即解锁 CodeMirror；
    // 首屏投影在后台建立，失败也不会把编辑器永久留在只读状态。
    void this.#rebuild(0, "open").catch((error) => this.#options.onError?.(error));
  }

  async attach(): Promise<void> {
    this.#assertLive();
    this.#opened = true;
    if (this.#active) await this.#rebuild(0, "open");
  }

  async setActive(active: boolean): Promise<void> {
    this.#assertLive();
    if (active === this.#active) return;
    this.#active = active;
    this.#directScrollbar?.setEnabled(active);
    this.#rebuildEpoch += 1;
    if (!active) {
      this.#rootList?.dispose();
      this.#rootList = undefined;
      this.#runtime.disposeSubtree(this.#content);
      this.#content.replaceChildren();
      return;
    }
    if (this.#opened) await this.#rebuild(0, "mode");
  }

  async setMode(mode: EditorSurfaceMode): Promise<void> {
    this.#assertLive();
    if (mode === this.#mode) return;
    const anchor = this.#visibleSourceOffset();
    const preserveEnd = isAtScrollEnd(this.#options.root);
    const scrollGeneration = this.#scrollGeneration;
    this.#mode = mode;
    this.#options.session.adapter.setMode("preview");
    if (this.#active) {
      await this.#rebuild(anchor, "mode", preserveEnd, scrollGeneration);
    }
  }

  async refresh(): Promise<void> {
    this.#assertLive();
    if (!this.#active) return;
    const scrollTop = this.#options.root.scrollTop;
    const preserveEnd = isAtScrollEnd(this.#options.root);
    const scrollGeneration = this.#scrollGeneration;
    await this.#enqueueProjectionRefresh(
      this.#visibleSourceOffset(),
      scrollTop,
      false,
      "projection",
      preserveEnd,
      scrollGeneration,
    );
  }

  async invalidateLayout(style?: EditorLayoutStyle): Promise<void> {
    this.#assertLive();
    const anchor = this.captureScrollAnchor();
    const generation = this.#scrollGeneration;
    const epoch = ++this.#layoutEpoch;
    if (style !== undefined) {
      applyEditorTypography(this.#options.root, style);
      if (style.metrics !== undefined) this.#options = { ...this.#options, pretext: {
        ...this.#options.pretext, metrics: { ...this.#options.pretext?.metrics, ...style.metrics },
      } };
    }
    this.#metrics = applyPreTextStyleMetrics(this.#content, this.#options.pretext?.metrics);
    this.#pretextTextStyleCache = undefined;
    this.#contentWidthCache = undefined;
    this.#pretextCache.clear();
    this.#pretextTextLayout.clear();
    this.#runtime.invalidateLayout();
    this.#rootList?.invalidateMeasurements();
    if (!this.#active || !this.#opened) return;
    if (this.#rootList && this.#rootList.axis.estimatedSize !== this.#rootEstimate) {
      await this.#rebuild(anchor.sourceOffset);
    } else {
      await this.#rootList?.refresh();
    }
    if (!this.#disposed && epoch === this.#layoutEpoch && generation === this.#scrollGeneration) {
      this.applyScrollAnchor(anchor);
    }
    this.#directScrollbar?.schedule();
  }

  /** 等待已接受 effect 所调度的渲染/投影工作应用完成。 */
  async settled(): Promise<void> {
    await this.#refreshChain;
    while (
      this.#projectionRefreshScheduled ||
      this.#projectionRefreshRunning ||
      this.#projectionRefreshRequested
    ) {
      await nextLayoutFrame(this.#options.root);
      await this.#refreshChain;
    }
    await this.#rootList?.settled();
    await nextLayoutFrame(this.#options.root);
    await this.#rootList?.settled();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rebuildEpoch += 1;
    this.#unsubscribe();
    this.#unsubscribeFold?.();
    this.#options.root.removeEventListener("scroll", this.#onScroll);
    this.#rootList?.dispose();
    this.#directScrollbar?.dispose();
    this.#runtime.disposeSubtree(this.#content);
    this.#content.replaceChildren();
    this.#pretextCache.clear();
  }

  async #rebuild(
    anchorOffset: number,
    reason: EditorSurfaceCommitReason = "projection",
    preserveEnd = false,
    initialScrollGeneration = this.#scrollGeneration,
    preferredScrollTop?: number,
  ): Promise<void> {
    if (!this.#opened || this.#disposed) return;
    const epoch = ++this.#rebuildEpoch;
    this.#rootList?.dispose();
    this.#runtime.disposeSubtree(this.#content);
    this.#content.replaceChildren();
    const list = this.#mode === "pretext"
      ? this.#buildPreTextList()
      : this.#buildRenderList();
    this.#rootList = list;
    const effect = await this.#projectRootAround(anchorOffset);
    if (effect === undefined) return;
    if (this.#disposed || epoch !== this.#rebuildEpoch || this.#rootList !== list) {
      return;
    }
    const operation = effect.renderPatch?.operations.find(
      (candidate) =>
        candidate.parentId === "0" && candidate.axis === "syntax-children",
    );
    list.setCount(operation?.totalChildren ??
      this.#options.session.adapter.projection.totalChildren("0", "syntax-children"));
    const relative = operation?.inserted.findIndex((node) =>
      Number(node.sourceRange.from) <= anchorOffset &&
      anchorOffset <= Number(node.sourceRange.to));
    const index = operation === undefined
      ? 0
      : operation.from + Math.max(0, relative ?? 0);
    const canRestoreScroll = this.#scrollGeneration === initialScrollGeneration;
    if (canRestoreScroll && list.axis.count > 0) {
      if (preserveEnd) {
        scrollElementToEnd(this.#options.root);
      } else {
        const maximum = Math.max(
          0,
          this.#options.root.scrollHeight - this.#options.root.clientHeight,
        );
        this.#options.root.scrollTop = preferredScrollTop === undefined
          ? list.axis.offsetAt(Math.min(this.#foldAxis?.visibleAt(index) ?? index, list.axis.count - 1))
          : Math.min(preferredScrollTop, maximum);
      }
    }
    await this.#withCommitReason(reason, () => list.refresh());
    if (preserveEnd && this.#scrollGeneration === initialScrollGeneration) {
      scrollElementToEnd(this.#options.root);
    }
  }

  get #rootEstimate(): number {
    return this.#options.estimatedBlockHeight ??
      (this.#metrics.paragraphLineHeight + this.#metrics.boundaryWidth + this.#metrics.blockGap);
  }

  #buildPreTextList(): DomVirtualList<PreTextSurfaceItem> {
    const store = this.#options.session.adapter.projection;
    const estimate = this.#rootEstimate;
    const axis = this.#newFoldAxis("root:syntax-children:pretext", estimate);
    return new DomVirtualList({
      host: this.#content,
      scrollElement: this.#options.root,
      estimatedItemHeight: estimate,
      axis,
      overscanPixels: this.#options.overscanPixels,
      getItem: (index) => {
        const node = store.nodeAt("0", "syntax-children", axis.physicalAt(index));
        return node === undefined ? undefined : this.#pretextItem(node);
      },
      itemKey: (item) => item.key,
      itemLayoutKey: (item) => item.layoutKey,
      estimateItemHeight: (item) => item.estimatedHeight,
      measurementContextKey: () => this.#pretextMeasurementKey(),
      loadContextKey: () => `${this.#options.session.adapter.revision}:${this.#mode}:${this.#options.headingFolds?.epoch ?? 0}`,
      loadRange: (from, toExclusive) => this.#loadVisibleRootRange(axis, from, toExclusive, 2),
      renderItem: (item) => { const element = this.#runtime.mountPreTextBlock(item); this.#options.headingFolds?.decorateHeading(element, item.node); return element; },
      updateItem: (element, item) => { this.#runtime.updatePreTextBlock(element, item); this.#options.headingFolds?.decorateHeading(element, item.node); },
      disposeElement: (element) => this.#runtime.disposeSubtree(element),
      onCommit: (window, metrics) => this.#surfaceCommitted(window, metrics),
      onError: this.#options.onError,
    });
  }

  #buildRenderList(): DomVirtualList<RenderNode> {
    const store = this.#options.session.adapter.projection;
    const estimate = this.#rootEstimate;
    const axis = this.#newFoldAxis("root:syntax-children", estimate);
    return new DomVirtualList({
      host: this.#content,
      scrollElement: this.#options.root,
      estimatedItemHeight: estimate,
      axis,
      overscanPixels: this.#options.overscanPixels,
      getItem: (index) => store.nodeAt("0", "syntax-children", axis.physicalAt(index)),
      itemKey: (item) => this.#runtime.key(item),
      itemLayoutKey: (item) => this.#pretextItem(item).layoutKey,
      estimateItemHeight: (item) => this.#pretextItem(item).estimatedHeight,
      measurementContextKey: () => this.#pretextMeasurementKey(),
      loadContextKey: () => `${this.#options.session.adapter.revision}:${this.#mode}:${this.#options.headingFolds?.epoch ?? 0}`,
      // 把有界的 inline/ListItem 详情合并到同一次根窗口加载中。
      // 否则每个可见物理 ListItem 都会挂载子组件，并在大列表滚动时各自发起
      // projection 请求。
      loadRange: (from, toExclusive) => this.#loadVisibleRootRange(axis, from, toExclusive, 4),
      renderItem: (item) => { const element = this.#runtime.mount(item); this.#options.headingFolds?.decorateHeading(element, item); return element; },
      updateItem: (element, item) => { this.#runtime.update(element, item); this.#options.headingFolds?.decorateHeading(element, item); },
      disposeElement: (element) => this.#runtime.disposeSubtree(element),
      onCommit: (window, metrics) => this.#surfaceCommitted(window, metrics),
      onError: this.#options.onError,
    });
  }

  #newFoldAxis(key: string, estimate: number): FoldedVirtualAxis {
    const axis = new FoldedVirtualAxis(this.#runtime.axis(key, estimate), estimate);
    this.#foldAxis = axis;
    axis.setHidden((this.#options.headingFolds?.visibleRanges ?? []).map(fold => ({ from: fold.fromBlock, toExclusive: fold.toBlock })));
    return axis;
  }

  async #loadVisibleRootRange(axis: FoldedVirtualAxis, from: number, toExclusive: number, depth: number): Promise<void> {
    for (const range of axis.physicalRanges(from, toExclusive)) await this.#loadRootRange(range.from, range.toExclusive, depth);
  }

  #accept(effect: AdapterEffect): void {
    if (!this.#opened || !this.#active || this.#disposed) return;
    if (effect.documentPatch !== undefined) {
      const scrollTop = this.#options.root.scrollTop;
      const preserveEnd = isAtScrollEnd(this.#options.root);
      const scrollGeneration = this.#scrollGeneration;
      const edits = effect.appliedEdits ?? [];
      const anchor = mapOffsetThroughEdits(
        this.#visibleSourceOffset(),
        edits,
      );
      this.#applyRootBlockSplices(effect.documentPatch.syntax?.blockChanges);
      if (replacesMostDocument(edits, this.#options.session.adapter.text.utf16Length)) {
        this.#runtime.clearLayoutCache();
        this.#pretextCache.clear();
        void this.#rebuild(anchor, "document", preserveEnd, scrollGeneration, scrollTop)
          .catch((error) => this.#options.onError?.(error));
        return;
      }
      void this.#enqueueProjectionRefresh(
        anchor,
        scrollTop,
        effect.documentPatch.syntax !== undefined,
        "document",
        preserveEnd,
        scrollGeneration,
      )
        .catch((error) => this.#options.onError?.(error));
      return;
    }
    if (effect.projectionChanged) {
      // The virtual list awaits its own root projection before committing the
      // window. Re-scheduling it from that same response creates a feedback
      // refresh; projections requested by every other owner still propagate.
      if (this.#options.session.ownsProjection(effect, this.#rootProjectionOwner)) return;
      this.#scheduleProjectionRefresh(true);
      return;
    }
    if (effect.analysisUpdate?.syntax !== undefined) {
      this.#applyRootBlockSplices(effect.analysisUpdate.syntax.blockChanges);
      this.#scheduleProjectionRefresh(false);
      return;
    }
    if (effect.analysis !== undefined) {
      this.#scheduleProjectionRefresh(false);
    }
  }

  /**
   * 批量解析期间可能收到数百次 Analysis 和 projection 响应。最多保持一个
   * refresh 运行，并把其后的全部响应合并为一次最新状态 refresh。非缓存请求
   * 优先于仅缓存工作，因为它可以填充最新的稀疏根窗口。
   */
  #scheduleProjectionRefresh(cachedOnly: boolean): void {
    if (this.#disposed) return;
    if (isAtScrollEnd(this.#options.root)) {
      this.#projectionRefreshPreserveEnd = true;
      this.#projectionRefreshEndGeneration = this.#scrollGeneration;
    }
    this.#projectionRefreshRequested = true;
    if (!cachedOnly) this.#projectionRefreshNeedsProject = true;
    this.#ensureProjectionRefresh();
  }

  #ensureProjectionRefresh(): void {
    if (
      this.#disposed ||
      this.#projectionRefreshScheduled ||
      this.#projectionRefreshRunning ||
      !this.#projectionRefreshRequested
    ) {
      return;
    }
    this.#projectionRefreshScheduled = true;
    const run = () => {
      this.#projectionRefreshScheduled = false;
      if (this.#disposed) return;
      const cachedOnly = !this.#projectionRefreshNeedsProject;
      const preserveEnd = this.#projectionRefreshPreserveEnd;
      const scrollGeneration = preserveEnd
        ? this.#projectionRefreshEndGeneration
        : this.#scrollGeneration;
      this.#projectionRefreshRequested = false;
      this.#projectionRefreshNeedsProject = false;
      this.#projectionRefreshPreserveEnd = false;
      this.#projectionRefreshRunning = true;
      void this.#enqueueProjectionRefresh(
        undefined,
        undefined,
        cachedOnly,
        "projection",
        preserveEnd,
        scrollGeneration,
      ).catch((error) => this.#options.onError?.(error))
        .finally(() => {
          this.#projectionRefreshRunning = false;
          this.#ensureProjectionRefresh();
        });
    };
    const view = this.#options.root.ownerDocument.defaultView;
    if (view === null || view === undefined) queueMicrotask(run);
    else view.requestAnimationFrame(run);
  }

  #pretextItem(node: RenderNode): PreTextSurfaceItem {
    const cacheKey = [
      node.id,
      node.kind,
      node.contentVersion,
      pretextContentSignature(node),
      Number(node.sourceRange.from),
      Number(node.sourceRange.to),
      this.#pretextMeasurementKey(),
    ].join(":");
    const cached = this.#pretextCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const startedAt = monotonicNow();
    const result = this.#pretextFilter.filter({
      revision: this.#options.session.adapter.revision,
      viewRevision: this.#options.session.adapter.viewRevision,
      items: [node],
      layout: this.#pretextLayout(),
      context: this.#pretextContext(),
    });
    this.#filterDurationMs += monotonicNow() - startedAt;
    this.#filteredItems += result.items.length;
    const item = result.items[0]!;
    if (item.sourcePreviewTruncated) this.#truncatedItems += 1;
    this.#pretextCache.set(cacheKey, item);
    if (this.#pretextCache.size > 1_024) {
      const oldest = this.#pretextCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#pretextCache.delete(oldest);
    }
    return item;
  }

  #pretextLayout(): SurfaceLayoutContext {
    const options = this.#options.pretext;
    return {
      availableWidth: this.#availableContentWidth(),
      lineHeight: normalizePositiveNumber(this.#options.estimatedLineHeight, 24),
      averageCharacterWidth: normalizePositiveNumber(options?.averageCharacterWidth, 8),
      tabSize: normalizePositiveInteger(options?.tabSize, 4),
      widthBucketSize: normalizePositiveNumber(options?.widthBucketSize, 32),
      typographyVersion: options?.typographyVersion ?? "default",
      wrap: true,
    };
  }

  #availableContentWidth(): number {
    const root = this.#options.root;
    const typographyVersion = this.#options.pretext?.typographyVersion ?? "default";
    const clientWidth = root.clientWidth;
    const rectWidth = root.getBoundingClientRect().width;
    const key = `${clientWidth}:${rectWidth}:${typographyVersion}`;
    if (this.#contentWidthCache?.key === key) return this.#contentWidthCache.width;

    let width = clientWidth || rectWidth || 1;
    const view = root.ownerDocument.defaultView;
    if (view !== null && view !== undefined && clientWidth > 0) {
      const style = view.getComputedStyle(root);
      width -= cssPixels(style.paddingInlineStart) + cssPixels(style.paddingInlineEnd);
      const contentStyle = view.getComputedStyle(this.#content);
      width -= cssPixels(contentStyle.paddingInlineStart) + cssPixels(contentStyle.paddingInlineEnd);
    }
    const resolved = Math.max(1, width);
    this.#contentWidthCache = { key, width: resolved };
    return resolved;
  }

  #pretextContext(): PreTextProjectionContext {
    const maximum = normalizePositiveInteger(
      this.#options.pretext?.maxSourcePreviewUtf16,
      2_048,
    );
    return {
      sourceStats: (range) => this.#sourceStats(range, maximum),
      sourceText: (range) => this.#source(range),
      metrics: this.#metrics,
      codeBlockWrap: this.#options.root.dataset["jotCodeWrap"] === "wrap",
      textLayout: this.#pretextTextLayout,
      textStyle: this.#pretextTextStyle(),
      resolveImageMetadata: (source) => resolveSurfaceImageMetadata(this.#options.resolveImageMetadata, source, this.#content.ownerDocument),
      tableSampleRows: this.#options.pretext?.tableSampleRows ?? 24,
      tableLayout: resolveTableLayoutOptions(this.#options),
      tableHasToolbar: this.#options.onTableCommand !== undefined,
    };
  }

  #pretextTextStyle(): PreTextTextStyle {
    const key = this.#options.pretext?.typographyVersion ?? "default";
    const cached = this.#pretextTextStyleCache;
    if (cached?.key === key) return cached.style;
    const view = this.#options.root.ownerDocument.defaultView;
    const font = view?.getComputedStyle(this.#options.root).font || "16px sans-serif";
    const computed = view?.getComputedStyle(this.#options.root);
    const style: PreTextTextStyle = { font, whiteSpace: "pre-wrap",
      letterSpacing: Number.parseFloat(computed?.letterSpacing ?? "0") || 0 };
    this.#pretextTextStyleCache = { key, style };
    return style;
  }

  #source(range: TextRange): string {
    return this.#options.session.adapter.text.text.slice(
      Number(range.from),
      Number(range.to),
    );
  }

  #sourceStats(range: TextRange, maximum: number): import("../../layout/pretext/filter.js").PreTextSourceStats {
    const text = this.#options.session.adapter.text;
    const from = Number(range.from);
    const to = Number(range.to);
    const requestedEnd = Math.min(to, from + maximum);
    const previewEnd = safeUtf16SliceEnd(text.text, requestedEnd, to);
    const fromLine = text.lineAt(range.from);
    const toLine = text.lineAt(range.to);
    const lastLine = to > from && Number(text.lineRange(toLine).from) === to
      ? toLine - 1
      : toLine;
    return {
      preview: text.text.slice(from, previewEnd),
      utf16Length: to - from,
      lineCount: to === from ? 0 : Math.max(1, lastLine - fromLine + 1),
    };
  }

  #pretextMeasurementKey(): string {
    return `${this.#layoutEpoch}:${surfaceLayoutContextKey(this.#pretextLayout())}:${JSON.stringify(
      this.#pretextContext().metrics,
    )}:${JSON.stringify(this.#pretextTextStyle())}`;
  }

  async #loadRootRange(from: number, toExclusive: number, maxDepth: number): Promise<void> {
    const store = this.#options.session.adapter.projection;
    const sparseMissing = store.missingRanges("0", "syntax-children", from, toExclusive);
    if (sparseMissing.length > 0) {
      await tolerateStaleProjection(() =>
        this.#options.session.project(
          sparseMissing.map((range): ProjectionSlice => ({
            parentId: "0",
            axis: "syntax-children",
            window: { type: "index", ...range },
            maxDepth: 0,
          })),
          { owner: this.#rootProjectionOwner },
        )).then(() => {});
    }
    // 批量局部解析期间，同一个可见根窗口可能被重复发布多次。
    // 将嵌套详情延迟到目标 revision 完成后，否则每个局部前缀都会提前重复传输
    // 同一 ListItem/inline 子树，并延迟根虚拟轴的建立。
    if (maxDepth === 0 || this.#options.session.adapter.analysis?.state !== "complete") return;

    const detailSlices: ProjectionSlice[] = [];
    for (let index = from; index < toExclusive; index += 1) {
      const node = store.nodeAt("0", "syntax-children", index);
      if (node === undefined) continue;
      const detailDepth = this.#mode === "preview"
        ? previewDetailDepth(node)
        : preTextDetailDepth(node);
      if (detailDepth === 0) continue;
      if (node.content.type !== "deferred") continue;
      detailSlices.push({
          parentId: "0",
          axis: "syntax-children",
          window: { type: "index", from: index, toExclusive: index + 1 },
          maxDepth: detailDepth,
      });
    }
    if (detailSlices.length === 0) return;
    await tolerateStaleProjection(() =>
      this.#options.session.project(detailSlices, { owner: this.#rootProjectionOwner })).then(() => {});
  }

  #applyRootBlockSplices(
    changes: readonly import("@jot-md/editor-protocol").BlockRangeChange[] | undefined,
  ): void {
    if (changes === undefined || changes.length === 0) return;
    this.#rootList?.splice(changes.map((change) => ({
      from: this.#foldAxis?.visibleAt(change.fromBlock) ?? change.fromBlock,
      removeCount: change.removeCount,
      insertCount: change.inserted.length,
    })));
  }

  #surfaceCommitted(
    window: import("../../core/virtual/virtual-axis.js").VirtualWindow,
    metrics: VirtualCommitMetrics,
  ): void {
    this.#options.onCommit?.({
      revision: this.#options.session.adapter.revision,
      viewRevision: this.#options.session.adapter.viewRevision,
      mode: this.#mode,
      reason: this.#commitReason ?? "viewport",
      window,
      filteredItems: this.#filteredItems,
      truncatedItems: this.#truncatedItems,
      filterDurationMs: this.#filterDurationMs,
      ...metrics,
    });
  }

  async #withCommitReason<T>(
    reason: EditorSurfaceCommitReason,
    task: () => Promise<T>,
  ): Promise<T> {
    const previousReason = this.#commitReason;
    this.#commitReason = reason;
    this.#filteredItems = 0;
    this.#truncatedItems = 0;
    this.#filterDurationMs = 0;
    try {
      return await task();
    } finally {
      this.#commitReason = previousReason;
    }
  }

  #visibleSourceOffset(): number {
    const viewportRect = this.#options.root.getBoundingClientRect();
    const viewportTop = viewportRect.top + 1;
    const viewportBottom = viewportRect.bottom - 1;
    let nearestVirtual:
      | { readonly offset: number; readonly distance: number; readonly span: number }
      | undefined;
    for (const element of this.#content.querySelectorAll<HTMLElement>(
      "[data-jot-virtual-index][data-jot-source-from][data-jot-source-to]",
    )) {
      const from = Number(element.dataset["jotSourceFrom"]);
      const to = Number(element.dataset["jotSourceTo"]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom < viewportTop || rect.top > viewportBottom) continue;
      const candidate = {
        offset: from,
        distance: Math.abs(rect.top - viewportTop),
        span: Math.max(0, to - from),
      };
      if (
        nearestVirtual === undefined ||
        candidate.distance < nearestVirtual.distance ||
        (candidate.distance === nearestVirtual.distance &&
          candidate.span < nearestVirtual.span)
      ) {
        nearestVirtual = candidate;
      }
    }
    if (nearestVirtual !== undefined) return nearestVirtual.offset;

    let intersecting:
      | { readonly offset: number; readonly span: number; readonly depth: number }
      | undefined;
    let nearest:
      | { readonly offset: number; readonly distance: number }
      | undefined;
    for (const element of this.#content.querySelectorAll<HTMLElement>(
      "[data-jot-source-from][data-jot-source-to]",
    )) {
      const from = Number(element.dataset["jotSourceFrom"]);
      const to = Number(element.dataset["jotSourceTo"]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom >= viewportTop && rect.top <= viewportTop) {
        const candidate = {
          offset: from,
          span: Math.max(0, to - from),
          depth: domDepth(element, this.#content),
        };
        if (
          intersecting === undefined ||
          candidate.span < intersecting.span ||
          (candidate.span === intersecting.span && candidate.depth > intersecting.depth)
        ) {
          intersecting = candidate;
        }
      } else if (rect.top > viewportTop) {
        const distance = rect.top - viewportTop;
        if (nearest === undefined || distance < nearest.distance) {
          nearest = { offset: from, distance };
        }
      }
    }
    if (intersecting !== undefined) return intersecting.offset;
    if (nearest !== undefined) return nearest.offset;

    const from = this.#rootList?.window?.from ?? 0;
    const mounted = this.#content.querySelector<HTMLElement>(
      `[data-jot-virtual-index="${from}"]`,
    );
    const mountedOffset = mounted?.dataset["jotSourceFrom"];
    if (mountedOffset !== undefined) return Number(mountedOffset);
    return Number(
      this.#options.session.adapter.projection.nodeAt(
        "0",
        "syntax-children",
        this.#foldAxis?.physicalAt(from) ?? from,
      )?.sourceRange.from ?? 0,
    );
  }

  #mountedVirtualIndexAtSourceOffset(offset: number): number | undefined {
    let match: { readonly index: number; readonly span: number } | undefined;
    for (const element of this.#content.querySelectorAll<HTMLElement>(
      "[data-jot-virtual-index][data-jot-source-from][data-jot-source-to]",
    )) {
      const from = Number(element.dataset["jotSourceFrom"]);
      const to = Number(element.dataset["jotSourceTo"]);
      const index = Number(element.dataset["jotVirtualIndex"]);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isSafeInteger(index)) {
        continue;
      }
      if (from > offset || to < offset) continue;
      const span = Math.max(0, to - from);
      if (match === undefined || span < match.span) match = { index, span };
    }
    return match?.index;
  }

  #localScrollTop(): number {
    return Math.max(0, this.#options.root.scrollTop - this.#contentTopInScrollContent());
  }

  #setUserScrollTop(value: number): void {
    if (Math.abs(value - this.#options.root.scrollTop) < 1) return;
    this.#onScroll();
    this.#options.root.scrollTop = value;
  }

  #contentTopInScrollContent(): number {
    const contentRect = this.#content.getBoundingClientRect();
    const rootRect = this.#options.root.getBoundingClientRect();
    return contentRect.top - rootRect.top + this.#options.root.scrollTop;
  }

  #enqueueProjectionRefresh(
    anchorOffset?: number,
    scrollTop?: number,
    cachedOnly = false,
    reason: EditorSurfaceCommitReason = "projection",
    preserveEnd = false,
    initialScrollGeneration = this.#scrollGeneration,
  ): Promise<void> {
    const task = this.#refreshChain
      .catch(() => {})
      .then(() => {
        return this.#withCommitReason(reason, () => {
          if (cachedOnly) return this.#refreshCachedProjection();
          return this.#refreshProjection(
            anchorOffset ?? this.#visibleSourceOffset(),
            scrollTop ?? this.#options.root.scrollTop,
            preserveEnd,
            initialScrollGeneration,
          );
        });
      });
    this.#refreshChain = task;
    return task;
  }

  async #refreshCachedProjection(): Promise<void> {
    if (!this.#opened || !this.#active || this.#disposed) return;
    const list = this.#rootList;
    if (list === undefined) return;
    list.setCount(
      this.#options.session.adapter.projection.totalChildren(
        "0",
        "syntax-children",
      ),
    );
    await list.refresh();
  }

  async #refreshProjection(
    anchorOffset: number,
    scrollTop: number,
    preserveEnd: boolean,
    initialScrollGeneration: number,
  ): Promise<void> {
    if (!this.#opened || !this.#active || this.#disposed) return;
    const list = this.#rootList;
    if (list === undefined) {
      await this.#rebuild(
        anchorOffset,
        this.#commitReason ?? "projection",
        preserveEnd,
        initialScrollGeneration,
      );
      return;
    }
    const mountedAnchorIndex = this.#mountedVirtualIndexAtSourceOffset(anchorOffset);
    const epoch = ++this.#rebuildEpoch;
    const effect = await this.#projectRootAround(anchorOffset);
    if (effect === undefined) return;
    if (this.#disposed || epoch !== this.#rebuildEpoch || this.#rootList !== list) {
      return;
    }
    const operation = effect.renderPatch?.operations.find(
      (candidate) =>
        candidate.parentId === "0" && candidate.axis === "syntax-children",
    );
    list.setCount(operation?.totalChildren ??
      this.#options.session.adapter.projection.totalChildren("0", "syntax-children"));
    const relativeAnchorIndex = operation?.inserted.findIndex((node) =>
      Number(node.sourceRange.from) <= anchorOffset &&
      anchorOffset <= Number(node.sourceRange.to),
    ) ?? -1;
    const operationAnchorIndex = operation === undefined || relativeAnchorIndex < 0
      ? undefined
      : this.#foldAxis?.visibleAt(operation.from + relativeAnchorIndex) ?? operation.from + relativeAnchorIndex;
    const anchorIndex = mountedAnchorIndex ?? operationAnchorIndex;
    await list.refresh();
    await this.#restoreScrollTop(
      scrollTop,
      epoch,
      initialScrollGeneration,
      preserveEnd,
      this.#commitReason === "document" ? anchorIndex : undefined,
    );
  }

  async #projectRootAround(anchorOffset: number): Promise<AdapterEffect | undefined> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const boundedAnchor = Math.min(
        anchorOffset,
        this.#options.session.adapter.text.utf16Length,
      );
      const anchor: TextRange = {
        from: boundedAnchor as import("@jot-md/editor-protocol").Utf16Offset,
        to: boundedAnchor as import("@jot-md/editor-protocol").Utf16Offset,
      };
      try {
        return await this.#options.session.project([{
          parentId: "0",
          axis: "syntax-children",
          window: { type: "around-range", range: anchor, before: 24, after: 96 },
          maxDepth: 0,
        }], { owner: this.#rootProjectionOwner });
      } catch (error) {
        if (!isRevisionMismatch(error)) throw error;
      }
    }
    return undefined;
  }

  #restoreScrollTop(
    target: number,
    epoch: number,
    initialScrollGeneration = this.#scrollGeneration,
    preserveEnd = false,
    anchorIndex?: number,
  ): Promise<void> {
    const root = this.#options.root;
    const view = root.ownerDocument.defaultView;
    return new Promise((resolve) => {
      let attempts = 0;
      let observedScrollGeneration = initialScrollGeneration;
      let lastApplied: number | undefined;
      const restore = () => {
        if (this.#disposed || epoch !== this.#rebuildEpoch) {
          resolve();
          return;
        }
        if (this.#scrollGeneration !== observedScrollGeneration) {
          // 程序化恢复本身也可能触发 scroll 事件。只有视口仍等于刚应用的值时
          // 才继续；其他位置属于更新的用户/程序滚动，旧 refresh 不得覆盖它。
          if (lastApplied === undefined || Math.abs(root.scrollTop - lastApplied) >= 1) {
            resolve();
            return;
          }
          observedScrollGeneration = this.#scrollGeneration;
        }
        const maximum = Math.max(0, root.scrollHeight - root.clientHeight);
        const axis = this.#rootList?.axis;
        const semanticTarget = anchorIndex !== undefined && axis !== undefined &&
          anchorIndex >= 0 && anchorIndex < axis.count
          ? this.#contentTopInScrollContent() + axis.offsetAt(anchorIndex)
          : target;
        lastApplied = preserveEnd ? maximum : Math.min(semanticTarget, maximum);
        root.scrollTop = lastApplied;
        attempts += 1;
        if (!preserveEnd && maximum + 1 < semanticTarget && attempts < 12 && view !== null) {
          view.requestAnimationFrame(restore);
        } else {
          resolve();
        }
      };
      restore();
    });
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("editor surface disposed");
  }
}
