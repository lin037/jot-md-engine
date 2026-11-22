import { sourceSnapshot } from "../shared/source-snapshot.js";
import { selectionMatchesSearchQuery } from "../shared/search-engine.js";
import type { ProjectionSlice, RenderNode, Revision, Utf16Offset } from "@jot-md/editor-protocol";
import { countColumn, EditorSelection, Text, Transaction, type ChangeSpec, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { getIndentUnit, indentString, indentUnit } from "@codemirror/language";
import { resolveListEnter } from "../../components/list-commands.js";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { readDomSourceRange } from "../../components/common/dom-position.js";
import { activateRenderedLink } from "../../components/common/dom-renderer.js";
import {
  BlockType,
  EditorView,
  runScopeHandlers,
  type ViewUpdate,
} from "@codemirror/view";
import type { TableLayoutSnapshot } from "../../components/table/layout.js";
import type { EditorCommandRegistry } from "../../core/commands/registry.js";
import type { EditorDocumentSession } from "../../adapter/index.js";
import {
  cssPixels,
  logicalScrollLeft,
  safeUtf16Offset,
  setLogicalScrollLeft,
  tolerateStaleProjection,
} from "../../components/common/render-utils.js";
import { DirectScrollbar } from "../../layout/direct-scrollbar.js";
import { applyPreTextStyleMetrics } from "../../layout/pretext/style-metrics.js";
import { applyEditorTypography, type EditorLayoutStyle } from "../../layout/pretext/options.js";
import {
  tableCellAt,
  tableRowCells,
  resolveTableSurfaceNavigation,
  tableSurfacePositionAt,
} from "../../components/table/source.js";
import {
  tableRenderCellAt,
  tableMappedInputChange,
  tableMappedInputUserEvent,
  tableRenderNavigation,
  tableRenderRootAt,
} from "../../components/table/adapters/interaction.js";
import {
  TABLE_INTERACTION_COMMAND,
  TABLE_COMMAND,
  tableLivePreviewCommand,
  type TableInteractionCommandId,
} from "../../components/table/commands.js";
import { RenderRuntime } from "../../render/runtime/dom-runtime.js";
import {
  LivePreviewEditPolicy,
  type ProjectionEditChange,
} from "./edit-policy.js";
import { createLivePreviewExtension, optimisticEmptyFirstInput, type OptimisticEmptyFirstInput } from "./extension.js";
import type { QuoteLine } from "./optimistic-quote.js";
import { planLivePreview } from "./planner.js";
import { resolveSourceRootAt, sourcePresentationRanges } from "./presentation.js";
import { LivePreviewPreTextEstimator } from "./pretext-estimator.js";
import { LivePreviewTableImeSurface } from "./table-ime.js";
import {
  confirmedPrefixMarkerRisks,
  emptyContainerFirstInput,
  optimisticMarkerRisk,
  planEmptyClosedContainerSeparator,
  resolveEmptyClosedContainer,
  resolveOptimisticEmptyMarkerKind,
} from "./empty-block-input.js";
import { canPaintRuntimeSearchRange, LivePreviewSearchHighlights, revealRuntimeSearchRange } from "./search-highlights.js";
import { sameSearchPattern } from "../shared/search-pattern.js";
import {
  beginLivePreviewPointerSelection,
  cancelLivePreviewPointerSelection,
  captureEmptyLinePointerSelection,
  captureRepeatedPreviewPointerSelection,
} from "./pointer-selection.js";
import {
  detailSliceKey,
  missingVisibleRootSlices,
  screenSourceWindow,
  visibleDetailSlices,
  visibleLivePreviewNodes,
  visibleQuoteLines,
  visibleRootNodes,
  visibleRootSlices,
  visibleSourceWindow,
} from "./projection-window.js";
import {
  markLivePreviewUserScroll,
  nearestRevealDelta,
  captureLivePreviewViewport,
  restoreLivePreviewViewport,
  preserveLivePreviewViewport,
  revealLivePreviewTableCaret,
} from "./viewport.js";
import {
  clearMeasuredLivePreviewHeights,
  measuredLivePreviewSubtreeHeight,
} from "./widget.js";
import {
  resolveLivePreviewBlockExit,
  resolveLivePreviewOpeningNavigation,
  resolveLivePreviewOpeningRange,
  resolveLivePreviewVerticalNavigation,
} from "./vertical-navigation.js";
import {
  livePreviewRange,
  type LivePreviewCommitEvent,
  type LivePreviewOptions,
  type LivePreviewSnapshot,
} from "./types.js";

type FoldRange = import("../folding/heading-fold.js").HeadingFoldRange;

function visibleSegments(range: { readonly from: number; readonly to: number }, folds: readonly FoldRange[]): Array<{ from: number; to: number }> {
  const result: Array<{ from: number; to: number }> = [];
  let from = range.from;
  for (const fold of folds) {
    if (fold.to <= from) continue;
    if (fold.from >= range.to) break;
    if (from < fold.from) result.push({ from, to: Math.min(range.to, fold.from) });
    from = Math.max(from, fold.to);
  }
  if (from <= range.to) result.push({ from, to: range.to });
  return result;
}

function visibleFoldNodes(session: EditorDocumentSession, range: { readonly from: number; readonly to: number }, head: number, folds: readonly FoldRange[]): RenderNode[] {
  const nodes = new Map<string, RenderNode>();
  for (const segment of visibleSegments(range, folds)) for (const node of visibleLivePreviewNodes(session, segment, head)) {
    const from = Number(node.sourceRange.from);
    if (!folds.some(fold => fold.from <= from && from < fold.to)) nodes.set(node.id, node);
  }
  return [...nodes.values()].sort((a, b) => Number(a.sourceRange.from) - Number(b.sourceRange.from));
}

function subtractFoldedBlocks(slice: ProjectionSlice, folds: readonly FoldRange[]): ProjectionSlice[] {
  if (slice.parentId !== "0" || slice.axis !== "syntax-children" || slice.window.type !== "index") return [slice];
  let from = slice.window.from;
  const end = slice.window.toExclusive;
  const result: ProjectionSlice[] = [];
  for (const fold of folds) {
    if (fold.toBlock <= from) continue;
    if (fold.fromBlock >= end) break;
    if (from < fold.fromBlock) result.push({ ...slice, window: { type: "index", from, toExclusive: Math.min(end, fold.fromBlock) } });
    from = Math.max(from, fold.toBlock);
  }
  if (from < end) result.push({ ...slice, window: { type: "index", from, toExclusive: end } });
  return result;
}

export interface LivePreviewControllerOptions extends LivePreviewOptions {
  readonly session: EditorDocumentSession;
  readonly commands?: EditorCommandRegistry;
  readonly pluginRegistry?: import("../../plugins/registry.js").EditorPluginRegistry;
  readonly headingFolds?: import("../folding/heading-fold.js").HeadingFoldController;
}

interface SearchScrollTarget {
  readonly doc: EditorView["state"]["doc"];
  readonly from: number;
  readonly to: number;
  readonly epoch: number;
}

interface EmptyComposition {
  readonly before: Text;
  separator: number;
  firstUpdate: boolean;
}

interface PendingBlankMarkers {
  doc: Text;
  from: number;
  to: number;
  readonly prefixRisks: number;
}

interface TrustedLocalGesture {
  readonly doc: Text;
  readonly selection: EditorSelection;
  readonly at: number;
  readonly type: "input" | "key";
  readonly inputType?: string;
  readonly data?: string | null;
  readonly key?: string;
}

/** 协调 CodeMirror 可见窗口与现有稀疏 RenderNode 投影。 */
export class LivePreviewController {
  readonly extension: Extension;
  #options: LivePreviewControllerOptions;
  readonly #allowUnspacedFenceLanguage: boolean;
  #layoutEpoch = 0;
  #userScrollEpoch = 0;
  #endFollowGeneration = 0;
  readonly #pretext: LivePreviewPreTextEstimator;
  readonly #editPolicy = new LivePreviewEditPolicy();
  #renderRuntime: RenderRuntime | undefined;
  #directScrollbar: DirectScrollbar | undefined;
  #tableIme: LivePreviewTableImeSurface | undefined;
  #searchHighlights: LivePreviewSearchHighlights | undefined;
  readonly #unsubscribe: () => void;
  readonly #unsubscribeFold: (() => void) | undefined;
  readonly #handle: ReturnType<typeof createLivePreviewExtension>;
  #view: EditorView | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #availableWidth = 1;
  #enabled = false;
  #opened = false;
  #disposed = false;
  #composing = false;
  #emptyComposition: EmptyComposition | undefined;
  #emptyCompositionTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingBlankMarkers: PendingBlankMarkers | undefined;
  #trustedLocalGesture: TrustedLocalGesture | undefined;
  #trustedLocalGestureTimer: ReturnType<typeof setTimeout> | undefined;
  #applyingPlan = false;
  // Refresh 调度必须是合并式 drain，而不是“每次 input 都在 Promise tail 后再
  // 排一项”。连续粘贴时前一个 sparse projection 会等待 Worker；如果每个中间
  // revision 都排一条 refresh，最终已确认 revision 会长期被陈旧任务淹没，甚至
  // 因投影 effect 继续追加任务而错过最后一次有效 plan。
  #scheduled = false;
  #refreshRequested = false;
  #refreshRunning = false;
  #refreshNeedsProjection = false;
  #refreshTask: Promise<void> = Promise.resolve();
  // 当前 optimistic CodeMirror source 必须在 Rust 确认到同一文本后至少成功
  // 提交一次新 plan。它不能只依赖某个 documentPatch/projectionChanged 恰好落在
  // refresh 空闲窗口；批量输入时中间 revision 的 effect 很容易全部变成 stale。
  #refreshAfterConfirmation = false;
  // Table cell input already carries the exact changed row/cell projection in
  // the transaction response. Keep that response as the confirmation boundary
  // and do not immediately request the whole mapped table again.
  #tableInputFastPath = false;
  // 当前 CodeMirror 值尚未被 Rust 确认时，已挂载的、不受本次 change 影响的
  // Preview widget 可以继续显示，但旧 RenderNode 不再参与 table interaction /
  // protected-range policy。否则连续大粘贴时既可能清空投影，又可能用旧 cell
  // sourceRange 拦截新文本。
  #awaitingConfirmation = false;
  #lastProjectionKey = "";
  // 根节点投影与 table 的稀疏行/cell 详情使用不同粒度：根窗口较粗以限制协议
  // 往返，详情窗口较细以避免滚入同一根窗口时长期只能显示纯文本兜底。
  #lastDetailProjectionKey = "";
  // One confirmed viewport only. Failed/unsupported detail requests are
  // attempted once per scope so a continuation cannot spin forever.
  #detailAttemptScope = "";
  readonly #detailAttempts = new Set<string>();
  #lastPlanSourceWindow: { readonly from: number; readonly to: number } | undefined;
  readonly #viewportCoverageMeasureKey = {};
  #lastViewportCoverageAttempt = "";
  #projectionRequests = 0;
  #epoch = 0;
  // 视口滚动只改变 viewport，不需要再次把整个 CodeMirror 文档转成字符串。
  #source = "";
  #sourceVersion = 0;
  #confirmationSourceVersion = -1;
  #confirmationRevision = -1;
  #sourceConfirmed = false;
  // 仅缓存当前 revision 已由 Rust 投影、且当前窗口可消费的节点。它不是
  // 第二份语义树；revision 变化时立即清空，未投影位置回到安全源码行为。
  #visibleNodes: readonly RenderNode[] = [];
  // 普通 preview widget 被点击或触发第一次 Delete 后，显式要求下一次计划显示
  // 对应源码块。它只是 selection-driven presentation 的一次性补充，不是第二
  // 个 active/caret 状态；hover 永远不会触发它。
  #pendingSourceReveal: { readonly from: number; readonly to: number } | undefined;
  #linkSelectionActive = false;
  #searchSourceReveal = false;
  #searchSelectionActive = false;
  #hiddenPresentationRanges: readonly { readonly from: number; readonly to: number }[] = [];
  #pendingSearchScroll: SearchScrollTarget | undefined;
  #searchScrollTarget: SearchScrollTarget | undefined;
  readonly #searchRevealMeasureKey = {};
  #searchRevealTask: Promise<void> = Promise.resolve();
  #finishSearchReveal: (() => void) | undefined;
  // 当前计划中的 atomic replacement。删除键必须先让其中的源码可见，不能让
  // CodeMirror 把整块隐藏源码当成一个删除单位。
  #replacedRanges: readonly { readonly from: number; readonly to: number }[] = [];
  // 仅用于 ArrowUp/Down 的 block replacement 索引。inline image/math 也可能
  // atomic，但它们不能作为跨物理行的垂直目标。
  #replacedBlockRanges: readonly { readonly from: number; readonly to: number }[] = [];
  // table mapped widget 在 Rust 确认单个 cell 输入之前仍可保持挂载。这里保存
  // 唯一、经 ChangeSet 映射后的 cell range，使连续输入不会因为等待确认而把
  // native beforeinput 写到 replacement 边界；它不是第二个 table editor。
  #optimisticTableCell: { readonly from: number; readonly to: number } | undefined;
  // TableGrid pointer / keyboard navigation 已经解析过的精确 cell。大表只投影
  // table root、按需加载可见 row/cell；缓存这个范围可避免每次 caret paint 都
  // 从文档起点重新扫描整张 pipe table。
  #mappedTableCell: { readonly from: number; readonly to: number } | undefined;
  // DOM handle for the same mapped cell while a whitelisted table transaction
  // is awaiting Rust confirmation. The semantic range remains
  // #optimisticTableCell; this handle only keeps the platform IME target tied
  // to the already-mounted cell shell when its old data attributes are stale.
  #mappedTableCellElement: HTMLElement | undefined;
  #tableSelectionKey = "";
  #tableRevealFrame: number | undefined;
  // Mouse/touch selection must see one stable decoration set from press to
  // release. Revealing syntax during the gesture moves the target DOM under
  // the pointer and is the root cause of many apparent CodeMirror caret bugs.
  #pointerSelecting = false;
  #refreshAfterPointer = false;
  #refreshAfterPointerNeedsProjection = false;
  #snapshot: LivePreviewSnapshot;

  readonly #onPointerDown = (event: Event): void => {
    if (
      !this.#enabled || !this.#opened || this.#disposed ||
      ("button" in event && Number((event as MouseEvent).button) !== 0)
    ) return;
    if ((event.target as Element | null)?.closest?.("a[href]") != null) return;
    // A pointer can move the user's intent away from the in-progress marker
    // sequence. A later source edit must not reuse the previous local proof.
    this.#pendingBlankMarkers = undefined;
    this.#clearTrustedLocalGesture();
    this.#pendingSearchScroll = undefined;
    this.#searchScrollTarget = undefined;
    this.#finishSearchReveal?.();
    this.#userScrollEpoch += 1;
    if (this.#view !== undefined) markLivePreviewUserScroll(this.#view);
    this.#pointerSelecting = true;
    // Pointerdown invalidates any presentation work that may have observed an
    // intermediate browser selection. Always run one coalesced reconciliation
    // after release; the bounded table hydration path keeps this lightweight,
    // while omitting it can leave a large nested TableGrid on the pre-gesture
    // source window and prevent later deep-row virtualization from recovering.
    this.#refreshAfterPointer = true;
    // Invalidate a refresh that was about to apply a different presentation
    // while the browser is resolving this pointer gesture.
    this.#epoch += 1;
  };
  readonly #onContentMouseDown = (event: MouseEvent): void => {
    if (!this.#enabled || !this.#opened || this.#disposed || this.#view === undefined) return;
    if ((event.target as Element | null)?.closest?.("a[href]") != null) {
      // Rendered links live inside the editing surface. Keep them mounted until
      // click and leave the existing source selection in place.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!this.#awaitingConfirmation && captureRepeatedPreviewPointerSelection(this.#view, event)) return;
    if (!this.#composing) captureEmptyLinePointerSelection(this.#view, event);
  };

  readonly #onContentClick = (event: MouseEvent): void => {
    if (!this.#enabled || event.defaultPrevented) return;
    const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>("a.jot-live-preview-link[href]");
    if (link == null) return;
    activateRenderedLink(link, event, this.#options.onLink);
  };

  readonly #onPointerEnd = (event?: Event): void => {
    if (!this.#pointerSelecting) return;
    const canceled = event?.type === "blur" || event?.type === "pointercancel";
    if (canceled && this.#view !== undefined) cancelLivePreviewPointerSelection(this.#view);
    this.#pointerSelecting = false;
    const refresh = this.#refreshAfterPointer;
    const needsProjection = this.#refreshAfterPointerNeedsProjection;
    this.#refreshAfterPointer = false;
    this.#refreshAfterPointerNeedsProjection = false;
    if (!refresh) return;
    const view = this.#view;
    const selectionAtRelease = view?.state.selection;
    const documentAtRelease = view?.state.doc;
    const scrollEpochAtRelease = this.#userScrollEpoch;
    const run = () => {
      if (!canceled && !this.#disposed && this.#enabled && view !== undefined && view === this.#view &&
          !this.#awaitingConfirmation && view.state.doc === documentAtRelease &&
          selectionAtRelease !== undefined && view.state.selection.eq(selectionAtRelease) &&
          this.#userScrollEpoch === scrollEpochAtRelease && view.state.selection.main.empty) {
        const head = view.state.selection.main.head;
        const target = this.#editPolicy.resolveCaret(head);
        if (target !== undefined && target !== head) this.#focusSource(view, target);
      }
      this.#schedule(needsProjection);
    };
    view?.dom.ownerDocument.defaultView?.requestAnimationFrame(run) ?? queueMicrotask(run);
  };
  readonly #onUserScrollIntent = (): void => {
    this.#pendingSearchScroll = undefined;
    this.#searchScrollTarget = undefined;
    this.#finishSearchReveal?.();
    this.#userScrollEpoch += 1;
    if (this.#view !== undefined) markLivePreviewUserScroll(this.#view);
  };
  readonly #onScrollPointerDown = (event: Event): void => {
    if (event.target === this.#view?.scrollDOM) this.#onUserScrollIntent();
  };
  readonly #onSearchGeometryChanged = (): void => {
    const view = this.#view;
    const target = this.#searchScrollTarget;
    if (!this.#applyingPlan && this.#pendingSearchScroll === undefined && view !== undefined && target !== undefined) {
      this.#revealMeasuredSearchTarget(view, target);
    }
  };
  constructor(options: LivePreviewControllerOptions) {
    this.#allowUnspacedFenceLanguage = options.session.adapter.syntaxProfile?.enabledExtensions?.some(
      extension => extension.id === "commonmark-fence-language" && extension.version === "1.0.0",
    ) ?? false;
    this.#options = options;
    this.#pretext = new LivePreviewPreTextEstimator(this.#options.session, this.#options);
    this.#unsubscribeFold = options.headingFolds?.subscribe(() => {
      this.#epoch += 1;
      this.#lastProjectionKey = "";
      this.#detailAttemptScope = "";
      this.#detailAttempts.clear();
      this.#directScrollbar?.schedule();
      this.#schedule(true);
    });
    this.#snapshot = emptySnapshot(this.#options.session.adapter.revision);
    this.#handle = createLivePreviewExtension({
      isEnabled: () => this.#enabled && !this.#disposed,
      onUpdate: (update) => this.#onViewUpdate(update),
      onKeyDown: (view, event) => this.#onKeyDown(view, event),
      onBeforeInput: (view, event) => this.#onBeforeInput(view, event),
      onWidgetActivate: (view, from, to) => this.#onWidgetActivate(view, from, to),
      onTransaction: (transaction) => this.#filterTransaction(transaction),
      onComposition: (active, event, view) => {
        if (active && event.isTrusted && this.#pendingBlankMarkers !== undefined) {
          this.#rememberTrustedLocalGesture(view, { type: "key", key: "compositionstart" });
          // If composition begins before the queued selection reconciliation,
          // establish the same decoration while CM is still handling the
          // compositionstart event, before any candidate DOM is installed.
          const proof = this.#pendingEmptyMarker(view.state.doc, view.state.selection.main.head);
          if (proof !== undefined) this.#handle.prepareOptimisticEmpty(view, proof);
        }
        this.#composing = active;
        if (!active) this.#finishEmptyComposition();
        this.#schedule(false);
      },
    });
    this.extension = [this.#handle.extension, EditorView.scrollHandler.of((view, range) => {
      if (!this.#enabled || !this.#opened || !range.empty) return false;
      const cell = this.#selectionTableCell(view);
      if (cell === undefined || range.head < cell.from || range.head > cell.to) return false;
      // A table replacement has no native per-source-line geometry. Let its
      // visual cell own reveal, including commands issued by the public API.
      this.#scheduleTableReveal(view);
      return true;
    })];
    this.#unsubscribe = options.session.subscribe((effect) => {
      const exactTableInput = this.#tableInputFastPath &&
        effect.documentPatch !== undefined &&
        effect.renderPatch !== undefined &&
        this.#sourceIsConfirmed() &&
        Number(effect.documentPatch.revision) ===
          Number(this.#options.session.adapter.revision);
      const syntaxTopologyChanged = effect.analysisUpdate?.syntax !== undefined ||
        (effect.documentPatch?.syntax !== undefined && !exactTableInput);
      if (
        syntaxTopologyChanged ||
        (effect.analysis?.state === "complete" && effect.documentPatch === undefined)
      ) {
        // `projectAround` is keyed by revision + viewport bucket. A background
        // analysis update can replace a dirty root suffix with many confirmed
        // blocks *without changing either key*. If this cache key survives,
        // the controller schedules a refresh but silently skips the root
        // request, leaving the old partial RenderNode window (and therefore
        // some raw source blocks) indefinitely. Parser topology is part of
        // the projection cache identity, not merely a decoration repaint.
        this.#lastProjectionKey = "";
        this.#lastDetailProjectionKey = "";
        this.#detailAttemptScope = "";
        this.#detailAttempts.clear();
      }
      // Foreground projection callers consume their own response after the
      // adapter cache has been updated: the controller continues the current
      // refresh, while nested components (TableGrid/ProjectedChildren) commit
      // their own window. Re-scheduling every `projectionChanged` response
      // would make one table scroll rebuild the outer CodeMirror decoration
      // twice (rows, then cells) even though the table-root plan is unchanged.
      const requiresProjection = effect.documentPatch !== undefined ||
        effect.analysisUpdate?.syntax !== undefined ||
        effect.analysis?.state === "complete";
      if (exactTableInput) this.#tableInputFastPath = false;
      const confirmedLatestSource = this.#sourceIsConfirmed();
      // `documentPatch` 可能只确认连续粘贴中的一个中间 revision。只要当前
      // CodeMirror source 还不是 adapter text，就保留 latch；最后一个确认到达
      // 后，无论该 effect 是 transaction、analysis 还是 projection，都要补一次
      // fresh projection，不能把收敛寄托在之后“刚好又触发一次”事件。
      const mustRefreshConfirmedSource = this.#refreshAfterConfirmation &&
        confirmedLatestSource;
      // The mapped table fast path intentionally skips a redundant projection,
      // but a new document revision invalidates visible quote-line metadata.
      // Refresh it when a quote shares this viewport so deep nesting does not
      // fall back to the shallower cached tree after typing in a table.
      const refreshVisibleQuotes = exactTableInput && this.#view !== undefined &&
        visibleRootNodes(this.#options.session, visibleSourceWindow(this.#view))
          .some(node => node.kind === "block-quote");
      if (requiresProjection || mustRefreshConfirmedSource) {
        // The table transaction response has already applied the exact root,
        // row and touched-cell patch. A normal edit still requests projection;
        // only this narrow, confirmed table path skips the redundant refresh.
        this.#schedule((requiresProjection && !exactTableInput) || refreshVisibleQuotes);
      }
    });
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get snapshot(): LivePreviewSnapshot {
    return this.#snapshot;
  }

  /**
   * CodeMirror 的唯一事务入口。Live Preview 只在已确认 table 范围内收紧
   * 编辑边界；普通文档仍完全交给 CodeMirror，结构变更必须走 command。
   */
  allowTransaction(transaction: Transaction): boolean {
    if (
      !transaction.docChanged || !this.#enabled || !this.#opened || this.#disposed ||
      this.#composing
    ) return true;
    const userEvent = transaction.annotation(Transaction.userEvent);
    if (
      userEvent === "input.api" ||
      userEvent === "input.engine-sync" ||
      userEvent?.startsWith("input.table.") === true ||
      userEvent === "input.code.quoted-line" ||
      userEvent === "input.quote.delete-empty-line" ||
      userEvent === "input.quote.continue" ||
      userEvent === "input.quote.indent" ||
      userEvent === "input.quote.outdent" ||
      userEvent === "input.block.exit" ||
      transaction.isUserEvent("input.replace") ||
      transaction.isUserEvent("undo") ||
      transaction.isUserEvent("redo")
    ) return true;
    return this.#editPolicy.allows(transactionChanges(transaction));
  }

  #filterTransaction(transaction: Transaction): Transaction | readonly TransactionSpec[] {
    if (!this.allowTransaction(transaction)) return [];
    if (!this.#enabled || !this.#opened || this.#disposed ||
        !transaction.docChanged || !transaction.isUserEvent("input") ||
        transaction.isUserEvent("input.api") || transaction.isUserEvent("input.engine-sync") ||
        transaction.isUserEvent("input.table") || transaction.isUserEvent("input.replace") ||
        transaction.isUserEvent("input.code.quoted-line") ||
        transaction.isUserEvent("input.quote.delete-empty-line") ||
        transaction.isUserEvent("input.quote.continue") ||
        transaction.isUserEvent("input.quote.indent") ||
        transaction.isUserEvent("input.quote.outdent") ||
        transaction.isUserEvent("input.block.exit") || transaction.startState.selection.ranges.length !== 1 ||
        !transaction.startState.selection.main.empty) return transaction;
    const position = transaction.startState.selection.main.head;
    const empty = !this.#awaitingConfirmation && this.#sourceIsConfirmed()
      ? resolveEmptyClosedContainer(this.#visibleNodes, position) : undefined;
    const optimistic = empty === undefined && this.#matchesTrustedEdit(transaction)
      ? this.#pendingEmptyMarker(transaction.startState.doc, position) : undefined;
    if (empty === undefined && optimistic === undefined) return transaction;
    let count = 0, from = -1, to = -1, end = -1, inserted = 0;
    transaction.changes.iterChanges((fromA, toA, _fromB, toB, text) => {
      count += 1; from = fromA; to = toA; end = toB; inserted = text.length;
    });
    if (count !== 1 || from !== position || to !== position || inserted === 0) return transaction;
    const separator = empty === undefined
      ? { from: end, to: end, insert: "\n" } : planEmptyClosedContainerSeparator(empty, inserted);
    if (separator === undefined || separator.from !== end) return transaction;
    if (this.#composing || transaction.isUserEvent("input.type.compose")) {
      this.#emptyComposition = { before: transaction.startState.doc, separator: end, firstUpdate: true };
      // Some browsers deliver the last composition transaction just after
      // compositionend. It still needs the same cancellation/cleanup check.
      if (!this.#composing) this.#finishEmptyComposition();
    }
    this.#pendingBlankMarkers = undefined;
    // The zero-width content range shares the closer's physical line. Add the
    // missing separator as part of the SAME transaction as the user's input,
    // keeping the original caret before it and preserving CM annotations and
    // composition handling. A trailing LF in pasted text is retained too.
    const prepared = optimistic !== undefined && this.#view !== undefined &&
      this.#handle.hasOptimisticEmpty(this.#view, optimistic.id);
    return [transaction, {
      changes: separator,
      selection: transaction.newSelection,
      sequential: true,
      annotations: empty === undefined
        ? prepared
          ? emptyContainerFirstInput.of({ nodeId: optimistic!.id, position, kind: optimistic!.kind })
          : optimisticEmptyFirstInput.of(optimistic!)
        : emptyContainerFirstInput.of({ nodeId: empty.nodeId, position, kind: empty.kind }),
    }];
  }

  #finishEmptyComposition(): void {
    const tracked = this.#emptyComposition;
    if (tracked === undefined) return;
    if (this.#emptyCompositionTimer !== undefined) clearTimeout(this.#emptyCompositionTimer);
    // Source synchronization also defers its composition commit to the next
    // task. Let the browser's last composition input settle first, then only
    // remove our separator when cancellation restored every original byte.
    this.#emptyCompositionTimer = setTimeout(() => {
      this.#emptyCompositionTimer = undefined;
      if (this.#emptyComposition !== tracked || this.#disposed || this.#composing) return;
      this.#emptyComposition = undefined;
      const view = this.#view;
      if (view === undefined || tracked.separator < 0 || tracked.separator >= view.state.doc.length ||
          view.state.doc.sliceString(tracked.separator, tracked.separator + 1) !== "\n" ||
          !view.state.doc.replace(tracked.separator, tracked.separator + 1, Text.empty).eq(tracked.before)) return;
      view.dispatch({
        changes: { from: tracked.separator, to: tracked.separator + 1 },
        annotations: Transaction.addToHistory.of(false),
        userEvent: "input.type.compose",
      });
    }, 0);
  }

  #rememberTrustedLocalGesture(view: EditorView, gesture: Omit<TrustedLocalGesture, "doc" | "selection" | "at">): void {
    const selection = view.state.selection;
    if (this.#pendingBlankMarkers === undefined) {
      if (gesture.type !== "input" || !selection.main.empty || selection.ranges.length !== 1 ||
          view.state.doc.lineAt(selection.main.head).length !== 0 ||
          gesture.data === null || gesture.data === undefined ||
          !["`", "$", "\\"].includes(gesture.data.slice(0, 1))) return;
    }
    this.#clearTrustedLocalGesture();
    const trusted: TrustedLocalGesture = { ...gesture, doc: view.state.doc, selection, at: Date.now() };
    this.#trustedLocalGesture = trusted;
    // DOM mutation reconciliation can happen on the next animation frame,
    // particularly for IME. A bounded lifetime and exact start-state/data
    // checks prevent an unrelated later programmatic transaction reusing it.
    this.#trustedLocalGestureTimer = setTimeout(() => {
      if (this.#trustedLocalGesture === trusted) this.#trustedLocalGesture = undefined;
      this.#trustedLocalGestureTimer = undefined;
    }, 1000);
  }

  #clearTrustedLocalGesture(): void {
    if (this.#trustedLocalGestureTimer !== undefined) clearTimeout(this.#trustedLocalGestureTimer);
    this.#trustedLocalGestureTimer = undefined;
    this.#trustedLocalGesture = undefined;
  }

  #matchesTrustedStart(state: { readonly doc: Text; readonly selection: EditorSelection }): boolean {
    const gesture = this.#trustedLocalGesture;
    return gesture !== undefined && Date.now() - gesture.at <= 1000 &&
      gesture.doc === state.doc && gesture.selection.eq(state.selection, true);
  }

  #matchesTrustedEdit(transaction: Transaction): boolean {
    const gesture = this.#trustedLocalGesture;
    if (gesture === undefined || !this.#matchesTrustedStart(transaction.startState)) return false;
    let count = 0, inserted: Text | undefined, removed = 0;
    transaction.changes.iterChanges((from, to, _fromB, _toB, text) => {
      count += 1;
      removed += to - from;
      if (count === 1) inserted = text;
    });
    // Candidate markers are bounded to two short physical lines. A large
    // insert is never a candidate, and must not be flattened just to check
    // this optimization. The ordinary CodeMirror transaction still proceeds.
    if (count !== 1 || inserted === undefined || inserted.length > 1025) return false;
    const text = inserted.toString();
    if (gesture.type === "input") {
      if (gesture.inputType?.startsWith("delete") === true) return removed > 0 && text.length === 0;
      if (gesture.inputType?.startsWith("insert") !== true || gesture.data == null) return false;
      return transaction.isUserEvent("input") && text === gesture.data;
    }
    if (gesture.key === "Enter") return transaction.isUserEvent("input") && text.includes("\n");
    if (gesture.key === "Backspace" || gesture.key === "Delete") return removed > 0 && text.length === 0;
    return false;
  }

  #trackPendingBlankMarkers(update: ViewUpdate): void {
    let candidate = this.#pendingBlankMarkers;
    if (update.docChanged) {
      const edits = update.transactions.filter((transaction) => transaction.docChanged);
      const transaction = edits.length === 1 ? edits[0] : undefined;
      if (transaction === undefined || !this.#matchesTrustedEdit(transaction) ||
          transaction.isUserEvent("input.api") || transaction.isUserEvent("input.engine-sync") ||
          transaction.isUserEvent("undo") || transaction.isUserEvent("redo")) {
        this.#pendingBlankMarkers = undefined;
        this.#clearTrustedLocalGesture();
        return;
      }
      if (candidate === undefined) {
        const selection = update.startState.selection;
        const position = selection.main.head;
        const line = update.startState.doc.lineAt(position);
        const input = this.#trustedLocalGesture?.type === "input" ? this.#trustedLocalGesture.data : undefined;
        if (this.#awaitingConfirmation || !this.#sourceIsConfirmed() ||
            this.#options.session.adapter.analysis?.state !== "complete" ||
            update.startState.doc.toString() !== this.#source ||
            selection.ranges.length !== 1 || !selection.main.empty || line.length !== 0 ||
            input == null || !["`", "$", "\\"].includes(input.slice(0, 1))) {
          this.#clearTrustedLocalGesture();
          return;
        }
        const adapter = this.#options.session.adapter;
        const risks = confirmedPrefixMarkerRisks(this.#source, adapter.blocks, position,
          adapter.projection.totalChildren("0", "syntax-children"), this.#allowUnspacedFenceLanguage);
        if (risks === undefined) { this.#clearTrustedLocalGesture(); return; }
        candidate = { doc: update.startState.doc, from: position, to: position, prefixRisks: risks };
      }
      let contained = candidate.doc === update.startState.doc;
      update.changes.iterChanges((from, to) => {
        if (from < candidate!.from || to > candidate!.to) contained = false;
      });
      if (!contained) {
        this.#pendingBlankMarkers = undefined;
        this.#clearTrustedLocalGesture();
        return;
      }
      candidate.from = update.changes.mapPos(candidate.from, -1);
      candidate.to = update.changes.mapPos(candidate.to, 1);
      candidate.doc = update.state.doc;
      const selection = update.state.selection;
      this.#pendingBlankMarkers = selection.ranges.length === 1 && selection.main.empty &&
        candidate.from <= selection.main.head && selection.main.head <= candidate.to ? candidate : undefined;
      this.#clearTrustedLocalGesture();
      return;
    }
    if (candidate !== undefined && update.selectionSet) {
      const selection = update.state.selection;
      if (candidate.doc !== update.startState.doc || !this.#matchesTrustedStart(update.startState) || this.#trustedLocalGesture?.type !== "key" ||
          selection.ranges.length !== 1 || !selection.main.empty ||
          selection.main.head < candidate.from || selection.main.head > candidate.to) {
        this.#pendingBlankMarkers = undefined;
      }
      this.#clearTrustedLocalGesture();
    }
  }

  #pendingEmptyMarker(doc: Text, position: number): OptimisticEmptyFirstInput | undefined {
    const candidate = this.#pendingBlankMarkers;
    if (candidate === undefined || candidate.doc !== doc || candidate.to - candidate.from > 1025) return undefined;
    const text = doc.sliceString(candidate.from, candidate.to);
    const newline = text.indexOf("\n");
    if (newline < 0 || text.indexOf("\n", newline + 1) >= 0 || position !== candidate.from + newline + 1) return undefined;
    const kind = resolveOptimisticEmptyMarkerKind(text.slice(0, newline), text.slice(newline + 1), this.#allowUnspacedFenceLanguage);
    if (kind === undefined || (candidate.prefixRisks & optimisticMarkerRisk[kind]) !== 0) return undefined;
    return {
      id: `jot-pending-empty:${candidate.from}:${candidate.to}`,
      from: candidate.from,
      openingTo: position - 1,
      closingFrom: position,
      closingTo: candidate.to,
      kind: kind === "code-bare" || kind === "code-end" ? "fenced-code" : "math-block",
    };
  }

  #preparePendingEmptyAfterSelection(view: EditorView): void {
    if (this.#composing || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return;
    const doc = view.state.doc;
    const selection = view.state.selection;
    const proof = this.#pendingEmptyMarker(doc, selection.main.head);
    if (proof === undefined || this.#handle.hasOptimisticEmpty(view, proof.id)) return;
    // Dispatching a state effect from a ViewUpdate is forbidden by CM. The
    // microtask runs before the next trusted input event, with a synchronous
    // compositionstart fallback for an unusually early IME event.
    queueMicrotask(() => {
      if (this.#disposed || !this.#enabled || !this.#opened || this.#composing || view !== this.#view ||
          view.state.doc !== doc || !view.state.selection.eq(selection, true) ||
          this.#pendingEmptyMarker(doc, selection.main.head)?.id !== proof.id) return;
      this.#handle.prepareOptimisticEmpty(view, proof);
    });
  }

  attach(view: EditorView): void {
    this.#assertLive();
    if (this.#view !== undefined) throw new Error("Live Preview already attached");
    this.#view = view;
    view.contentDOM.addEventListener("pointerdown", this.#onPointerDown, true);
    view.contentDOM.addEventListener("mousedown", this.#onContentMouseDown, true);
    view.contentDOM.addEventListener("click", this.#onContentClick);
    view.scrollDOM.addEventListener("wheel", this.#onUserScrollIntent, { passive: true });
    view.scrollDOM.addEventListener("pointerdown", this.#onScrollPointerDown, true);
    view.scrollDOM.addEventListener("scroll", this.#onSearchGeometryChanged, { passive: true });
    view.scrollDOM.addEventListener("touchstart", this.#onUserScrollIntent, { passive: true });
    view.dom.ownerDocument.addEventListener("pointerup", this.#onPointerEnd, true);
    view.dom.ownerDocument.addEventListener("pointercancel", this.#onPointerEnd, true);
    view.dom.ownerDocument.defaultView?.addEventListener("blur", this.#onPointerEnd);
    this.#source = sourceSnapshot(view);
    this.#sourceVersion += 1;
    this.#lastDetailProjectionKey = livePreviewDetailProjectionKey(visibleSourceWindow(view));
    this.#pretext.attach(view);
    this.#searchHighlights = new LivePreviewSearchHighlights(view,
      () => this.#enabled && !this.#disposed && this.#sourceIsConfirmed(),
      () => this.#searchSelectionActive,
      error => this.#options.onError?.(error));
    const estimatedLineHeight = this.#options.pretext?.metrics?.paragraphLineHeight;
    const estimatedRowHeight = this.#options.pretext?.metrics?.tableRowHeight;
    this.#renderRuntime = new RenderRuntime({
      root: view.dom,
      scrollElement: view.scrollDOM,
      session: this.#options.session,
      ...(this.#options.pluginRegistry === undefined ? {} : { pluginRegistry: this.#options.pluginRegistry }),
      overscanPixels: 640,
      ...(estimatedLineHeight === undefined ? {} : { estimatedLineHeight }),
      ...(estimatedRowHeight === undefined ? {} : { estimatedRowHeight }),
      ...(this.#options.table === undefined ? {} : { table: this.#options.table }),
      ...(this.#options.onTableCommand === undefined
        ? {}
        : { onTableCommand: this.#options.onTableCommand }),
      onTableCellFocus: (offset, cellRange, cellElement, event) => {
        // A desktop IME owns the active cell until compositionend. Pointer
        // movement during candidate selection must not retarget that session.
        if (this.#tableIme?.composing === true) return;
        const safeOffset = safeUtf16Offset(sourceSnapshot(view), offset);
        const from = safeUtf16Offset(sourceSnapshot(view), Number(cellRange.from));
        const to = safeUtf16Offset(sourceSnapshot(view), Number(cellRange.to));
        this.#mappedTableCell = {
          from: Math.min(from, to),
          to: Math.max(from, to),
        };
        this.#mappedTableCellElement = cellElement;
        // The visual cell is the browser input and scroll target. Dispatch only
        // the semantic CodeMirror selection, then focus the sink before an IME
        // can start; hidden Markdown geometry must not decide the viewport.
        if (event !== undefined && cellElement !== undefined) {
          const target = event.target instanceof Element
            ? event.target.closest('[data-jot-kind="inline-math"],[data-jot-kind="image"]') : null;
          const opaque = target === null ? undefined : readDomSourceRange(target);
          beginLivePreviewPointerSelection(view, event, {
            element: cellElement,
            range: this.#mappedTableCell,
            offset: safeOffset,
            lineRange: this.#mappedTableCell,
            ...(opaque === undefined ? {} : { opaque }),
            onCaret: () => this.#activateTableInput(view, cellElement),
          });
        } else {
          view.dispatch({ selection: { anchor: safeOffset } });
          this.#activateTableInput(view, cellElement);
        }
      },
      resolveSelectionAnchor: (fallback, tableRange) => {
        const selection = view.state.selection.main;
        const from = Number(tableRange.from);
        const to = Number(tableRange.to);
        return selection.empty && selection.head >= from && selection.head <= to
          ? selection.head
          : fallback;
      },
      resolveSelection: (tableRange) => {
        const selection = view.state.selection.main;
        const from = Number(tableRange.from);
        const to = Number(tableRange.to);
        const selectionFrom = Math.min(selection.anchor, selection.head);
        const selectionTo = Math.max(selection.anchor, selection.head);
        return selectionFrom <= to && from <= selectionTo
          ? {
            anchor: selection.anchor as import("@jot-md/editor-protocol").Utf16Offset,
            head: selection.head as import("@jot-md/editor-protocol").Utf16Offset,
          }
          : undefined;
      },
      ...(this.#options.renderMath === undefined ? {} : { renderMath: this.#options.renderMath }),
      onLink: (url, event) => {
        // The rendered widget is inside the editing surface; Chromium does
        // not consistently follow its anchors via the native default action.
        if (this.#options.onLink !== undefined) this.#options.onLink(url, event);
        else view.dom.ownerDocument.defaultView?.open(url, "_blank", "noopener,noreferrer");
      },
      ...(this.#options.resolveImageMetadata === undefined
        ? {}
        : { resolveImageMetadata: this.#options.resolveImageMetadata }),
      ...(this.#options.onError === undefined ? {} : { onError: this.#options.onError }),
    });
    this.#tableIme = new LivePreviewTableImeSurface(view, {
      onBeforeInput: (inputType, data) =>
        this.#dispatchTableSurfaceInput(view, inputType, data),
      onKeyDown: (event) => this.#onTableSurfaceKeyDown(view, event),
      onCompositionCommit: (text) => this.#commitTableComposition(view, text),
    });
    this.#availableWidth = livePreviewContentWidth(view);
    this.#pretext.resize(this.#availableWidth);
    this.#directScrollbar = (this.#options.scrollbar ?? "direct") === "direct"
      ? new DirectScrollbar({
        scrollElement: view.scrollDOM,
        contentElement: view.contentDOM,
        onUserScroll: (atEnd) => {
          this.#onUserScrollIntent();
          if (atEnd) this.#followScrollbarEnd(view);
        },
      })
      : undefined;
    this.#directScrollbar?.setEnabled(this.#enabled);
    this.#applyLayoutMetrics(view);
    this.#syncTableCaret(view);
    const ResizeObserverType = view.dom.ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserverType !== undefined) {
      const updateWidth = () => {
        const width = livePreviewContentWidth(view);
        if (width <= 0 || Math.abs(width - this.#availableWidth) < 1) return;
        this.#availableWidth = width;
        this.#pretext.resize(width);
        if (this.#renderRuntime !== undefined) {
          clearMeasuredLivePreviewHeights(this.#renderRuntime);
        }
        this.#directScrollbar?.schedule();
        this.#applyLayoutMetrics(view);
        this.#schedule(false);
      };
      this.#resizeObserver = new ResizeObserverType(updateWidth);
      this.#resizeObserver?.observe(view.scrollDOM);
      this.#resizeObserver?.observe(view.contentDOM);
    }
  }

  /** Keep an explicit thumb-to-end gesture at the end while CM corrects estimates. */
  #followScrollbarEnd(view: EditorView): void {
    const frame = view.dom.ownerDocument.defaultView?.requestAnimationFrame.bind(view.dom.ownerDocument.defaultView);
    if (frame === undefined) return;
    const epoch = this.#userScrollEpoch;
    const generation = ++this.#endFollowGeneration;
    const document = view.state.doc;
    const selection = view.state.selection;
    let remaining = 30;
    const follow = () => {
      if (this.#disposed || !this.#enabled || this.#view !== view ||
          this.#userScrollEpoch !== epoch || this.#endFollowGeneration !== generation || view.state.doc !== document ||
          !view.state.selection.eq(selection)) return;
      const scroll = view.scrollDOM;
      const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      if (maximum - scroll.scrollTop > 1) scroll.scrollTop = maximum;
      if (--remaining > 0) frame(follow);
    };
    frame(follow);
  }

  open(): void {
    this.#assertLive();
    this.#opened = true;
    this.#schedule(true);
  }

  setEnabled(enabled: boolean): void {
    this.#assertLive();
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#lastProjectionKey = "";
    this.#lastDetailProjectionKey = "";
    this.#detailAttemptScope = "";
    this.#detailAttempts.clear();
    this.#lastPlanSourceWindow = undefined;
    const view = this.#view;
    if (!enabled) {
      this.#pendingBlankMarkers = undefined;
      this.#clearTrustedLocalGesture();
      if (view !== undefined) cancelLivePreviewPointerSelection(view);
      this.#searchHighlights?.clear();
      this.#cancelTableReveal();
      this.#tableIme?.cancel();
      this.#directScrollbar?.setEnabled(false);
      if (view !== undefined) this.#handle.clear(view);
      view?.contentDOM.classList.remove("jot-live-preview-content");
      this.#visibleNodes = [];
      this.#pendingSourceReveal = undefined;
      this.#searchSourceReveal = false;
      this.#searchSelectionActive = false;
      this.#hiddenPresentationRanges = [];
      this.#pendingSearchScroll = undefined;
      this.#searchScrollTarget = undefined;
      this.#finishSearchReveal?.();
      this.#replacedRanges = [];
      this.#replacedBlockRanges = [];
      this.#optimisticTableCell = undefined;
      this.#mappedTableCell = undefined;
      this.#mappedTableCellElement = undefined;
      this.#tableSelectionKey = "";
      this.#awaitingConfirmation = false;
      this.#refreshRequested = false;
      this.#refreshNeedsProjection = false;
      this.#refreshAfterConfirmation = false;
      this.#tableInputFastPath = false;
      this.#pointerSelecting = false;
      this.#refreshAfterPointer = false;
      this.#refreshAfterPointerNeedsProjection = false;
      this.#editPolicy.clear();
      this.#renderRuntime?.refreshSelection();
    }
    if (enabled) {
      this.#searchHighlights?.schedule();
      this.#directScrollbar?.setEnabled(true);
      view?.contentDOM.classList.add("jot-live-preview-content");
    }
    this.#syncTableCaret(view);
    this.#snapshot = { ...this.#snapshot, enabled };
    if (enabled) {
      this.#schedule(true);
    }
  }

  async settled(): Promise<void> {
    // `#refreshTask` can finish while a session callback has already merged a
    // newer refresh request. Keep observing the scheduling flags until the
    // controller has no queued/running work, rather than awaiting only the
    // task that happened to exist at method entry.
    let lastCoverageAttempt = "";
    while (true) {
      while (this.#scheduled) await Promise.resolve();
      await this.#refreshTask;
      const reveal = this.#searchRevealTask;
      await reveal;
      const geometry = () => {
        const view = this.#view;
        return view === undefined ? "" : [this.#epoch, this.#userScrollEpoch, view.viewport.from, view.viewport.to,
          view.contentHeight, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft,
          ...view.visibleRanges.flatMap(range => [range.from, range.to])].join(":");
      };
      const before = geometry();
      // This applies to ordinary scrolling as well as search: a pending CM
      // measurement can publish a different viewport in the next paint after
      // the current refresh task has already resolved.
      await new Promise<void>(resolve => {
        const window = this.#view?.dom.ownerDocument.defaultView;
        if (window) window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
        else queueMicrotask(resolve);
      });
      if (before !== geometry()) continue;
      const view = this.#view;
      if (view !== undefined && this.#enabled && !this.#composing && this.#sourceIsConfirmed()) {
        const screen = screenSourceWindow(view);
        const plan = this.#lastPlanSourceWindow;
        const key = `${this.#options.session.adapter.revision}:${screen.from}:${screen.to}:${plan?.from}:${plan?.to}`;
        if ((plan === undefined || screen.from < plan.from || screen.to > plan.to) && key !== lastCoverageAttempt) {
          // A plan may have committed for an earlier source window while a
          // late measurement moved the screen. Ask the normal scheduler for
          // that latest window; try an unchanged coverage gap only once so a
          // large atomic/unsupported block cannot make settled spin forever.
          lastCoverageAttempt = key;
          this.#schedule(true);
          continue;
        }
      }
      if (
        !this.#scheduled &&
        !this.#refreshRunning &&
        !this.#refreshRequested && this.#searchRevealTask === reveal && this.#finishSearchReveal === undefined
      ) {
        return;
      }
    }
  }

  tableLayout(tableId: string): TableLayoutSnapshot | undefined {
    this.#assertLive();
    return this.#renderRuntime?.tableLayoutSnapshot(tableId);
  }

  /** Leave any confirmed root using its source boundary, without node-kind rules. */
  exitBlock(direction: "before" | "after" = "after"): boolean {
    const view = this.#view;
    if (view === undefined || !this.#opened || this.#disposed ||
        view.state.selection.ranges.length !== 1) return false;
    const source = sourceSnapshot(view);
    const adapter = this.#options.session.adapter;
    if (source !== adapter.text.text || this.#enabled && this.#awaitingConfirmation) return false;
    const head = view.state.selection.main.head;
    let node: { readonly sourceRange: { readonly from: number; readonly to: number } } | undefined;
    if (this.#enabled) node = resolveSourceRootAt(source, this.#visibleNodes, head);
    else {
      // Source/split modes do not materialize Live Preview RenderNodes. Their
      // confirmed root index supplies the same boundary contract in O(log n).
      const index = adapter.blocks.blockAt(head);
      if (index !== undefined) {
        const candidates = adapter.blocks.blocks.slice(index, index + 2);
        node = resolveSourceRootAt(source, candidates.filter((block) => !block.dirty), head);
      }
    }
    if (node === undefined) return false;
    const target = resolveLivePreviewBlockExit(source, {
      from: Number(node.sourceRange.from), to: Number(node.sourceRange.to),
    }, direction);
    if (target.insert.length > 0 && view.state.readOnly) return false;
    view.dispatch({
      ...(target.insert.length === 0 ? {} : { changes: { from: target.from, insert: target.insert } }),
      selection: { anchor: target.anchor },
      scrollIntoView: true,
      annotations: Transaction.userEvent.of(target.insert.length === 0 ? "select.keyboard" : "input.block.exit"),
    });
    this.#tableIme?.cancel();
    view.focus();
    return true;
  }

  setTableColumnWidth(tableId: string, column: number, width: number): boolean {
    this.#assertLive();
    return this.#renderRuntime?.setTableColumnWidth(tableId, column, width) ?? false;
  }

  resetTableLayout(tableId: string): boolean {
    this.#assertLive();
    return this.#renderRuntime?.resetTableLayout(tableId) ?? false;
  }

  async invalidateLayout(style?: EditorLayoutStyle): Promise<void> {
    this.#assertLive();
    const view = this.#view;
    const anchor = view === undefined ? undefined : captureLivePreviewViewport(view);
    const document = view?.state.doc;
    const scrollEpoch = this.#userScrollEpoch;
    const epoch = ++this.#layoutEpoch;
    if (style?.metrics !== undefined) this.#options = { ...this.#options, pretext: {
      ...this.#options.pretext, metrics: { ...this.#options.pretext?.metrics, ...style.metrics },
    } };
    if (view !== undefined && style !== undefined) applyEditorTypography(view.contentDOM, style);
    this.#pretext.invalidateLayout(this.#options);
    if (this.#renderRuntime !== undefined) {
      clearMeasuredLivePreviewHeights(this.#renderRuntime);
      this.#renderRuntime.invalidateLayout();
    }
    if (view === undefined) return;
    this.#applyLayoutMetrics(view);
    this.#directScrollbar?.schedule();
    view.requestMeasure();
    if (!this.#opened || !this.#enabled) return;
    // Layout changes keep the document projection valid. A refresh awaiting
    // the Worker can finish loading details and plan with the updated metrics.
    this.#schedule(false);
    await this.settled();
    if (!this.#disposed && view.state.doc === document && epoch === this.#layoutEpoch && scrollEpoch === this.#userScrollEpoch && anchor !== undefined) {
      view.requestMeasure({
        read: () => undefined,
        write: () => {
          if (!this.#disposed && view.state.doc === document && epoch === this.#layoutEpoch && scrollEpoch === this.#userScrollEpoch) {
            restoreLivePreviewViewport(view, anchor);
          }
        },
      });
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#emptyCompositionTimer !== undefined) clearTimeout(this.#emptyCompositionTimer);
    this.#emptyCompositionTimer = undefined;
    this.#emptyComposition = undefined;
    this.#pendingBlankMarkers = undefined;
    this.#clearTrustedLocalGesture();
    this.#searchScrollTarget = undefined;
    this.#finishSearchReveal?.();
    this.#epoch += 1;
    this.#refreshRequested = false;
    this.#refreshNeedsProjection = false;
    this.#refreshAfterConfirmation = false;
    this.#tableInputFastPath = false;
    this.#unsubscribe();
    this.#unsubscribeFold?.();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#pretext.dispose();
    this.#directScrollbar?.dispose();
    this.#directScrollbar = undefined;
    const view = this.#view;
    this.#searchHighlights?.dispose();
    this.#searchHighlights = undefined;
    if (view !== undefined) cancelLivePreviewPointerSelection(view);
    view?.contentDOM.removeEventListener("pointerdown", this.#onPointerDown, true);
    view?.contentDOM.removeEventListener("mousedown", this.#onContentMouseDown, true);
    view?.contentDOM.removeEventListener("click", this.#onContentClick);
    view?.scrollDOM.removeEventListener("wheel", this.#onUserScrollIntent);
    view?.scrollDOM.removeEventListener("pointerdown", this.#onScrollPointerDown, true);
    view?.scrollDOM.removeEventListener("scroll", this.#onSearchGeometryChanged);
    view?.scrollDOM.removeEventListener("touchstart", this.#onUserScrollIntent);
    view?.dom.ownerDocument.removeEventListener("pointerup", this.#onPointerEnd, true);
    view?.dom.ownerDocument.removeEventListener("pointercancel", this.#onPointerEnd, true);
    view?.dom.ownerDocument.defaultView?.removeEventListener("blur", this.#onPointerEnd);
    view?.dom.classList.remove("jot-live-preview-table-focus-active");
    this.#tableIme?.dispose();
    this.#tableIme = undefined;
    if (view !== undefined) this.#handle.clear(view);
    if (this.#renderRuntime !== undefined) {
      clearMeasuredLivePreviewHeights(this.#renderRuntime);
      this.#renderRuntime.clearLayoutCache();
    }
    this.#pendingSourceReveal = undefined;
    this.#hiddenPresentationRanges = [];
    this.#replacedRanges = [];
    this.#replacedBlockRanges = [];
    this.#optimisticTableCell = undefined;
    this.#mappedTableCell = undefined;
    this.#mappedTableCellElement = undefined;
    this.#tableSelectionKey = "";
    this.#cancelTableReveal();
    this.#renderRuntime = undefined;
    this.#view = undefined;
  }

  #pendingTableCommandFocus: number | undefined;
  #pendingTableRowInput: { readonly doc: Text; readonly head: number; readonly previousFrom: number } | undefined;

  #onViewUpdate(update: ViewUpdate): void {
    if (update.state.readOnly) this.#tableIme?.cancel();
    this.#searchHighlights?.schedule();
    const composition = this.#emptyComposition;
    if (composition !== undefined && update.docChanged) {
      if (composition.firstUpdate) composition.firstUpdate = false;
      else composition.separator = update.changes.mapPos(composition.separator, 1);
    }
    // block widget 的增删会让 CodeMirror 重新计算 viewport，并在同步 dispatch 中
    // 产生 `viewportChanged`。这不是用户滚动；若把它再次送入投影，会形成
    // apply decoration -> viewportChanged -> project 的反馈环，甚至饿死下一帧。
    if (this.#applyingPlan) return;
    if (this.#enabled && this.#opened && !this.#disposed) this.#trackPendingBlankMarkers(update);
    if (this.#enabled && update.selectionSet && !update.docChanged &&
        update.transactions.some(transaction => transaction.scrollIntoView)) {
      // A selection-only scroll request is newer than any anchor captured by
      // an in-flight layout/theme refresh, even if the selection is unchanged.
      this.#userScrollEpoch += 1;
      markLivePreviewUserScroll(update.view);
    }
    if (update.selectionSet && !update.docChanged) this.#preparePendingEmptyAfterSelection(update.view);
    if (update.selectionSet || update.docChanged) {
      // The URL is real selected text and must stay editable until the next gesture.
      this.#linkSelectionActive = update.transactions.some(transaction =>
        transaction.isUserEvent("input.format.link") || transaction.isUserEvent("select.format.link"));
    }
    const hadSearchSelection = this.#searchSelectionActive;
    const hadSearchSourceReveal = this.#searchSourceReveal;
    const hadPendingSourceReveal = this.#pendingSourceReveal;
    const query = getSearchQuery(update.state);
    const previousQuery = getSearchQuery(update.startState);
    const queryChanged = !sameSearchPattern(query, previousQuery);
    if (queryChanged) {
      // A new query does not inherit the old query's selected-hit proof.
      // In particular, paint must not scan the rest of a huge document trying
      // to validate an obsolete selection while debounce is pending.
      this.#searchSelectionActive = false;
      this.#pendingSearchScroll = undefined;
      this.#searchScrollTarget = undefined;
      if (this.#searchSourceReveal) this.#pendingSourceReveal = undefined;
      this.#searchSourceReveal = false;
    }
    const panelClosed = searchPanelOpen(update.startState) && !searchPanelOpen(update.state);
    if (update.selectionSet) {
      const selection = update.state.selection.main;
      let searchSelection = update.transactions.some(transaction => transaction.isUserEvent("select.search"));
      if (!searchSelection && query.valid && update.transactions.some(transaction => transaction.isUserEvent("input.replace"))) {
        searchSelection = selectionMatchesSearchQuery(update.state, query, selection.from, selection.to);
      }
      this.#searchSelectionActive = query.valid && searchSelection;
      if (this.#searchSelectionActive) {
        this.#userScrollEpoch += 1;
        markLivePreviewUserScroll(update.view);
        this.#pendingSearchScroll = {
          doc: update.state.doc, from: selection.from, to: selection.to, epoch: this.#userScrollEpoch,
        };
        this.#searchScrollTarget = this.#pendingSearchScroll;
      } else {
        this.#pendingSearchScroll = undefined;
        this.#searchScrollTarget = undefined;
      }
      const hidden = this.#searchSelectionActive && this.#hiddenPresentationRanges.some(range =>
        range.from < selection.to && selection.from < range.to);
      this.#searchSourceReveal = this.#searchSelectionActive &&
        (selection.empty || update.docChanged ||
          (hidden && (!this.#sourceIsConfirmed() || !canPaintRuntimeSearchRange(update.view, selection))));
      if (!selection.empty && !this.#searchSourceReveal) this.#pendingSourceReveal = undefined;
      if (this.#searchSourceReveal && update.state.selection.ranges.length === 1) {
        const from = update.state.selection.main.from;
        this.#pendingSourceReveal = { from, to: from };
        this.#schedule(true);
      }
    }
    if (update.docChanged && !update.transactions.some(transaction => transaction.isUserEvent("input.replace"))) {
      this.#searchSourceReveal = false;
      this.#searchSelectionActive = false;
      this.#pendingSearchScroll = undefined;
      this.#searchScrollTarget = undefined;
    }
    if (panelClosed || !query.valid) {
      if (this.#searchSourceReveal) this.#pendingSourceReveal = undefined;
      this.#searchSourceReveal = false;
      this.#searchSelectionActive = false;
      this.#pendingSearchScroll = undefined;
      this.#searchScrollTarget = undefined;
    }
    if (this.#searchScrollTarget === undefined) this.#finishSearchReveal?.();
    const searchPresentationChanged =
      hadSearchSelection !== this.#searchSelectionActive ||
      hadSearchSourceReveal !== this.#searchSourceReveal ||
      hadPendingSourceReveal !== this.#pendingSourceReveal;
    // 只有搜索引起的预览/源码状态发生翻转（或面板关闭）时才重规划 Live Preview；
    // 纯搜索词变动不改变语义块呈现，高亮由 searchHighlighter 与 LivePreviewSearchHighlights 负责。
    if (panelClosed || searchPresentationChanged) this.#schedule(false);
    if (update.focusChanged && this.#options.pluginRegistry?.hasEnabledCodeBlocks() === true) this.#schedule(false);
    if (update.geometryChanged || update.viewportChanged) this.#onSearchGeometryChanged();
    if (this.#enabled && this.#opened && !this.#disposed && update.geometryChanged && !update.docChanged) {
      this.#checkViewportCoverageAfterMeasure(update.view);
    }
    if (update.docChanged) {
      this.#pendingTableRowInput = undefined;
      const before = update.startState.selection.main;
      const after = update.state.selection.main;
      if (this.#enabled && !this.#composing && before.empty && after.empty &&
          before.head !== after.head && update.state.selection.ranges.length === 1 &&
          update.transactions.some(tr => tr.isUserEvent("input.type") || tr.isUserEvent("delete.backward"))) {
        const line = update.startState.doc.lineAt(before.head);
        const nextLine = update.state.doc.lineAt(after.head);
        if (line.number > 1 && line.from === nextLine.from && before.head === line.to && after.head === nextLine.to &&
            update.state.doc.sliceString(after.head - 1, after.head) === "|" &&
            tableRenderRootAt(this.#visibleNodes, before.head) === undefined) {
          this.#pendingTableRowInput = { doc: update.state.doc, head: after.head, previousFrom: line.from - 1 };
        }
      }
      const tableCommand = update.transactions.some(transaction => [
        "input.table.insert-row-below", "input.table.delete-row",
        "input.table.insert-column-after", "input.table.delete-column",
        "input.insert.table",
      ].includes(transaction.annotation(Transaction.userEvent) ?? ""));
      this.#pendingTableCommandFocus = tableCommand &&
        (this.#tableIme?.focused === true || update.view.hasFocus)
        ? update.state.selection.main.head : undefined;
      // 一次大粘贴可以在旧 refresh 正在等待 sparse projection 时发生。旧任务
      // 捕获的 source / RenderNode 已不再能安全应用到新 CodeMirror 文档，必须
      // 立即失效；否则它会在 worker 返回后提交过期 decoration，表现为渲染
      // 滞后、空白或“再也不恢复”的错乱投影。
      this.#epoch += 1;
      // A reveal scheduled by the preceding click/navigation belongs to the
      // old viewport intent. Once editing starts, it must never move the page
      // after the input transaction; ordinary typing is not typewriter mode.
      this.#cancelTableReveal();
      this.#source = sourceSnapshot(update.view);
      this.#sourceVersion += 1;
      this.#awaitingConfirmation = true;
      this.#refreshAfterConfirmation = true;
      // 视觉 decoration 已由 StateField 按 ChangeSet 映射。Controller 只保留
      // 未触及 replacement 的映射范围，让 Backspace/Delete 仍能先 reveal
      // 那些 atomic widget；触及的块必须退回真实 CodeMirror source。
      this.#replacedRanges = remapUnaffectedReplacementRanges(
        this.#replacedRanges,
        update,
      );
      this.#replacedBlockRanges = remapUnaffectedReplacementRanges(
        this.#replacedBlockRanges,
        update,
      );
      const tableInput = isTableInputUpdate(update);
      this.#tableInputFastPath = tableInput;
      if (tableInput) {
        this.#mappedTableCellElement = update.view.dom.querySelector<HTMLElement>(
          ".jot-live-preview-table-cell--active",
        ) ?? this.#mappedTableCellElement;
      }
      this.#optimisticTableCell = tableInput
        ? remapRange(this.#mappedTableCell ?? this.#optimisticTableCell, update)
        : undefined;
      this.#mappedTableCell = tableInput
        ? remapRange(this.#mappedTableCell, update)
        : undefined;
      if (tableCommand || update.transactions.some(transaction =>
        transaction.annotation(Transaction.userEvent) === "input.table.clear-cell")) {
        // Empty cells retain surrounding Markdown spaces. After clearing text,
        // the semantic insertion point can be one space beyond the mapped
        // old content range. Use the command's new-document cell so CM never
        // attempts to reveal hidden table source against the physical axis.
        const target = tableCellAt(this.#source, update.state.selection.main.head);
        if (target !== undefined) {
          this.#optimisticTableCell = { from: target.from, to: target.to };
          this.#mappedTableCell = this.#optimisticTableCell;
        }
      }
      // 语义节点、table cell 和 interaction policy 属于 confirmed revision。
      // 直到 Rust 确认前一律让 CodeMirror 自然编辑 source，不能把旧 table
      // pipe/cell 范围投射到新文本。
      this.#visibleNodes = [];
      this.#editPolicy.clear();
      this.#pendingSourceReveal = undefined;
      this.#tableSelectionKey = "";
      this.#syncTableCaret(update.view, false);
    }
    if (!this.#enabled || this.#disposed) return;
    if (update.docChanged) {
      this.#schedule(true);
    }
    const selectionOnly = update.selectionSet && !update.docChanged;
    const singleCollapsedSelection = update.state.selection.ranges.length === 1 &&
      update.state.selection.main.empty;
    if (update.viewportChanged && !(selectionOnly && !singleCollapsedSelection)) {
      // CodeMirror 会在 block widget 的真实高度校正时报告 viewportChanged。
      // 只有可见源码窗口跨过投影 bucket 才重新请求 Rust；纯几何校正交给
      // CodeMirror 自己完成，不能形成 `widget -> viewport -> projection` 反馈环。
      const key = livePreviewDetailProjectionKey(visibleSourceWindow(update.view));
      if (key !== this.#lastDetailProjectionKey) {
        this.#lastDetailProjectionKey = key;
        this.#schedule(true);
      }
    }
    if (update.selectionSet) {
      // A document edit keeps the already visible cell in place. A selection
      // only update, on the other hand, is an explicit caret/navigation move
      // and may reveal the new visual target.
      this.#syncTableCaret(update.view, !update.docChanged);
      // 非折叠选区和多选使用 CodeMirror 的原生 selection。只合并一次轻量
      // paint/规划以恢复 active block 和更新范围样式；实际拖选期间延迟到
      // release，不在移动中的指针下替换 DOM，也不额外请求 Rust 投影。
      if (!singleCollapsedSelection) {
        // Selection paint must follow range -> range changes as well. Pointer
        // gestures still coalesce here without changing DOM before release.
        this.#schedule(false);
        return;
      }
      // 表格内 cell 之间的移动只改变投影层的 active paint。RenderRuntime 已经
      // 能在原有根 widget 上局部刷新 selection；不应因为每次方向键都重新
      // 规划整套 decorations。跨出已加载的 cell 或进入尚未投影的区域时，
      // 再请求一次计划，让普通节点/源码边界获得正确的投影。
      const previousTable = tableRenderRootAt(
        this.#visibleNodes,
        update.startState.selection.main.head,
      );
      const currentTable = tableRenderRootAt(
        this.#visibleNodes,
        update.state.selection.main.head,
      );
      const stayedInSameTable = previousTable !== undefined && currentTable !== undefined &&
        previousTable.id === currentTable.id;
      if (!stayedInSameTable) {
        this.#schedule(false);
      }
    }
  }

  #schedule(needsProjection: boolean): void {
    if (!this.#enabled || !this.#opened || this.#disposed || this.#view === undefined) return;
    if (this.#pointerSelecting) {
      this.#refreshAfterPointer = true;
      this.#refreshAfterPointerNeedsProjection ||= needsProjection;
      return;
    }
    this.#refreshRequested = true;
    this.#refreshNeedsProjection ||= needsProjection;
    // 一个 refresh 正在等待 Worker 时，新的输入只合并为“完成后重跑最后一个
    // revision”。不能再在 async tail 后追加一条旧 source refresh。
    if (this.#scheduled || this.#refreshRunning) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#disposed || this.#refreshRunning || !this.#refreshRequested) return;
      const task = this.#drainRefreshes();
      this.#refreshTask = task.catch((error) => this.#options.onError?.(error));
    });
  }

  async #drainRefreshes(): Promise<void> {
    if (this.#refreshRunning || this.#disposed) return;
    this.#refreshRunning = true;
    try {
      while (
        !this.#disposed &&
        this.#enabled &&
        this.#opened &&
        this.#view !== undefined &&
        this.#refreshRequested
      ) {
        const needsProjection = this.#refreshNeedsProjection;
        this.#refreshRequested = false;
        this.#refreshNeedsProjection = false;
        await this.#refresh(needsProjection);
      }
    } finally {
      this.#refreshRunning = false;
      // A session callback can arrive between the loop condition and finally,
      // or after the loop exits because the host was temporarily disabled.
      // Requeue only when this controller can still consume it.
      if (
        this.#refreshRequested &&
        this.#enabled &&
        this.#opened &&
        !this.#disposed &&
        this.#view !== undefined
      ) {
        this.#schedule(false);
      }
    }
  }

  async #refresh(needsProjection: boolean): Promise<void> {
    const view = this.#view;
    const source = this.#source;
    if (
      view === undefined || !this.#enabled || !this.#opened || this.#disposed ||
      !this.#sourceIsConfirmed()
    ) {
      // 输入事务在 CodeMirror 已乐观落地、Rust 尚未确认的这一小段时间会多次
      // 调度 refresh（大粘贴尤其明显）。旧 RenderNode 的 sourceRange 已失效，
      // 不能提交“半旧半新”的 plan；但也绝不能先清空现有 widgets。记录一次
      // confirmed refresh 意图并直接返回。最终 adapter source 对齐时的任意
      // session effect 都会消费该 latch 并合并为最新 plan。
      this.#refreshAfterConfirmation = true;
      return;
    }
    const epoch = ++this.#epoch;
    if (needsProjection) await this.#loadVisibleProjection(view, epoch);
    if (this.#disposed || epoch !== this.#epoch || !this.#enabled) return;

    const startedAt = now();
    let visible = visibleSourceWindow(view);
    let nodes = visibleFoldNodes(this.#options.session, visible, view.state.selection.main.head, this.#options.headingFolds?.visibleRanges ?? []);
    // A HeightMap scroll can land in a sparse root-cache hole without
    // producing a new detail bucket (for example after switching from a
    // Preview virtual axis that ended at document tail). Never commit an
    // empty visual plan over a nonempty document in that case: force the
    // bounded root-slice recovery path once, then read the current viewport
    // again. Otherwise geometry placeholders are the only remaining blocks,
    // `visibleBlocks` becomes zero, and a long-document settle loop cannot
    // recover by itself.
    const missingRoots = visibleSegments(visible, this.#options.headingFolds?.visibleRanges ?? []).flatMap(segment =>
      missingVisibleRootSlices(this.#options.session, segment,
        positiveInteger(this.#options.afterBlocks, 24) + positiveInteger(this.#options.beforeBlocks, 8)))
      .flatMap(slice => subtractFoldedBlocks(slice, this.#options.headingFolds?.visibleRanges ?? []));
    if (
      this.#options.session.adapter.blocks.blocks.length > 0 &&
      (nodes.length === 0 || missingRoots.length > 0)
    ) {
      await this.#loadVisibleProjection(view, epoch);
      if (this.#disposed || epoch !== this.#epoch || !this.#enabled) return;
      visible = visibleSourceWindow(view);
      nodes = visibleFoldNodes(this.#options.session, visible, view.state.selection.main.head, this.#options.headingFolds?.visibleRanges ?? []);
    }
    this.#visibleNodes = nodes;
    if (this.#sourceIsConfirmed()) {
      this.#editPolicy.update(source, nodes);
    }
    const main = view.state.selection.main;
    const selectedOpening = !this.#searchSelectionActive && view.state.selection.ranges.length === 1 &&
      !main.empty && resolveLivePreviewOpeningRange(nodes, main.head) !== undefined
      ? { from: main.head, to: main.head } : undefined;
    const pendingReveal = this.#linkSelectionActive
      ? { from: main.from, to: main.from }
      : this.#pendingSourceReveal ?? selectedOpening;
    const selections = sourcePresentationRanges({
      composing: this.#composing,
      visibleRange: visible,
      selections: view.state.selection.ranges.map((range) => ({
        from: Math.min(range.anchor, range.head),
        to: Math.max(range.anchor, range.head),
      })),
      ...(this.#searchSourceReveal && view.state.selection.ranges.length === 1
        ? { pendingReveal: { from: view.state.selection.main.from, to: view.state.selection.main.from } }
        : pendingReveal === undefined
        ? {}
        : { pendingReveal }),
    });
    const selectionHighlights = view.state.selection.ranges
      .map((range) => ({
        from: Math.min(range.anchor, range.head),
        to: Math.max(range.anchor, range.head),
      }))
      .filter((range) => range.from !== range.to);
    const runtime = this.#renderRuntime;
    if (runtime === undefined) return;
    this.#directScrollbar?.schedule();
    const plan = planLivePreview({
      source,
      nodes,
      quoteLines: visibleQuoteLines(this.#options.session, nodes, visible),
      selections,
      editorFocused: view.hasFocus,
      ...(this.#options.pluginRegistry === undefined ? {} : { pluginRegistry: this.#options.pluginRegistry }),
      ...(selections.length === 0
        ? {}
        : { activeSourceRange: selections[0] }),
      ...(this.#composing || this.#searchSourceReveal ? { forceSource: true } : {}),
      ...(this.#searchSourceReveal ? { revealSyntax: true } : {}),
      ...(selectionHighlights.length === 0 ? {} : { selectionHighlights }),
      geometryGaps: this.#pretext.geometry(view, visible).filter(gap =>
        !(this.#options.headingFolds?.visibleRanges ?? []).some(fold => gap.from < fold.to && fold.from < gap.to)),
      ...(this.#searchSelectionActive ? { geometryExclusions: selectionHighlights.length > 0
        ? selectionHighlights : [{ from: view.state.selection.main.from, to: view.state.selection.main.to }] } : {}),
      visibleRange: visible,
      countSourceLines: (from, to) => view.state.doc.lineAt(Math.max(from, to - 1)).number -
        view.state.doc.lineAt(from).number + 1,
      ...(this.#options.maxDecorations === undefined
        ? {}
        : { maxDecorations: this.#options.maxDecorations }),
      ...(this.#options.maxGeometryDecorations === undefined
        ? {}
        : { maxGeometryDecorations: this.#options.maxGeometryDecorations }),
      estimateBlockHeight: (node) => {
        // A native paragraph may contain a measured inline formula/image.
        // Its already-painted line boxes own activation geometry; an estimate
        // can over-count inline runs and introduce an artificial empty row.
        // Prefer CM's cached height map for fully visible text blocks. A
        // fully mounted quote containing an image may need a DOM measurement
        // before CM's height map has caught up with the decoded image.
        const from = Number(node.sourceRange.from);
        const to = Math.max(from, Number(node.sourceRange.to) - 1);
        const whollyMountedQuote = node.kind === "block-quote" && view.viewport.from <= from && to <= view.viewport.to;
        if (whollyMountedQuote) {
          // Inline image replacements split visibleRanges and may be larger
          // than CM's still-pending height estimate. Measure the two mounted
          // boundary lines, not just the image widget or its stale height map.
          const lineAt = (position: number): HTMLElement | null => {
            const dom = view.domAtPos(position).node;
            const element = dom.nodeType === 1 ? dom as Element : dom.parentElement;
            return element?.closest<HTMLElement>(".cm-line") ?? null;
          };
          const first = lineAt(Math.min(to, from + 1)), last = lineAt(to);
          if (first !== null && last !== null && view.contentDOM.contains(first) && view.contentDOM.contains(last)) {
            let height = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
            // A source shell may already be reserving a decoded image's old
            // height. Replanning for IME must not shrink it to the shorter
            // raw Markdown lines before the image is rendered again.
            const shell = first.closest<HTMLElement>(".jot-live-preview-source-block-shell--block-quote");
            if (shell?.dataset["jotLiveNode"] === node.id && shell.contains(last)) {
              height = Math.max(height, shell.getBoundingClientRect().height);
            }
            if (Number.isFinite(height) && height > 0) return height;
          }
        }
        if (["paragraph", "heading", "block-quote", "list-item"].includes(node.kind) &&
            view.visibleRanges.some((range) => range.from <= from && to <= range.to)) {
          const first = view.lineBlockAt(from);
          const last = view.lineBlockAt(to);
          if (first.type === BlockType.Text && last.type === BlockType.Text) {
            return last.bottom - first.top;
          }
        }
        const measured = measuredLivePreviewSubtreeHeight(runtime, node);
        const estimated = this.#pretext.estimate(node, view);
        if (measured === undefined) return estimated;
        // A rendered diagram's actual height is unrelated to its source line
        // count. Reusing the measured box avoids jumping back to a code-sized
        // estimate each time a virtualized diagram comes back into view.
        if (this.#options.pluginRegistry?.codeBlock(node) !== undefined) return measured;
        return Math.max(measured, estimated ?? 0);
      },
    });
    if (epoch !== this.#epoch || this.#disposed || !this.#enabled) return;
    // A hit can be visible in the current caret's source lines but disappear
    // when a non-collapsed search selection restores Preview. Replan before
    // applying that replacement, so the exact character stays paintable.
    if (this.#searchSelectionActive && !this.#searchSourceReveal &&
        plan.decorations.some(item => item.type === "replace" && item.from < main.to && main.from < item.to) &&
        !canPaintRuntimeSearchRange(view, main)) {
      this.#searchSourceReveal = true;
      this.#schedule(false);
      return;
    }
    this.#applyingPlan = true;
    try {
      preserveLivePreviewViewport(view, () => {
        this.#handle.apply(view, plan, runtime);
      });
    } finally {
      this.#applyingPlan = false;
    }
    const replacedRanges: Array<{ readonly from: number; readonly to: number }> = [];
    const replacedBlockRanges: Array<{ readonly from: number; readonly to: number }> = [];
    for (const item of plan.decorations) {
      if (
        item.type === "replace" && item.to > item.from &&
        item.widget !== undefined &&
        item.widget?.selection !== "mapped"
      ) {
        replacedRanges.push({ from: item.from, to: item.to });
        if (item.widget?.block === true) {
          replacedBlockRanges.push({ from: item.from, to: item.to });
        }
      }
    }
    this.#replacedRanges = replacedRanges;
    this.#replacedBlockRanges = replacedBlockRanges;
    this.#hiddenPresentationRanges = plan.decorations
      .filter(item => item.type === "replace" && item.to > item.from)
      .map(item => ({ from: item.from, to: (item as { readonly to: number }).to }));
    this.#editPolicy.setHiddenSyntax(plan.decorations.filter((item) =>
      item.type === "replace" && item.widget === undefined && item.to > item.from)
      .map((item) => ({ from: item.from, to: (item as { readonly to: number }).to })));
    this.#pendingSourceReveal = undefined;
    // Clear confirmation-only state only after a plan based on the exact
    // current source has actually reached CodeMirror. Clearing it at the
    // beginning of refresh would make an epoch-cancelled projection leave the
    // latest revision permanently in raw source.
    if (this.#sourceIsConfirmed()) {
      this.#awaitingConfirmation = false;
      this.#optimisticTableCell = undefined;
      this.#refreshAfterConfirmation = false;
      this.#tableInputFastPath = false;
    }
    this.#syncTableCaret(view);
    const rowInput = this.#pendingTableRowInput;
    if (rowInput !== undefined && !this.#awaitingConfirmation && this.#sourceIsConfirmed()) {
      const { head, previousFrom, doc } = rowInput;
      if (view.state.doc === doc && view.state.selection.main.empty && view.state.selection.main.head === head &&
          view.hasFocus && !view.state.readOnly && !this.#searchSourceReveal) {
        const line = doc.lineAt(head);
        const table = tableRenderRootAt(nodes, head);
        if (table !== undefined && Number(table.sourceRange.from) <= previousFrom &&
            tableRenderCellAt(nodes, head) === undefined) {
          // A typed endpoint that has just become hidden table syntax must
          // project to editable content on that physical row. Do not apply
          // this to arbitrary selections or infer whether the table exists.
          const cell = tableRowCells(line.text, line.from).at(-1);
          if (cell !== undefined && cell.to < head) {
            view.dispatch({ selection: { anchor: cell.to } });
            this.#activateTableInput(view);
          }
        }
      }
      this.#pendingTableRowInput = undefined;
    }
    if (this.#pendingTableCommandFocus !== undefined) {
      const expected = this.#pendingTableCommandFocus;
      this.#pendingTableCommandFocus = undefined;
      const focused = view.dom.ownerDocument.activeElement;
      if (view.state.selection.main.head === expected &&
          (focused === view.dom.ownerDocument.body || view.dom.contains(focused))) {
        this.#activateTableInput(view);
      }
    }
    const searchTarget = this.#pendingSearchScroll;
    if (searchTarget !== undefined && searchTarget.doc === view.state.doc &&
        searchTarget.epoch === this.#userScrollEpoch &&
        searchTarget.from === view.state.selection.main.from && searchTarget.to === view.state.selection.main.to) {
      this.#pendingSearchScroll = undefined;
      // Search navigation outranks anchor preservation from this and earlier
      // plans. Reveal only after current decorations expose the actual hit.
      this.#userScrollEpoch += 1;
      markLivePreviewUserScroll(view);
      if (!revealRuntimeSearchRange(view, searchTarget)) {
        view.dispatch({ effects: EditorView.scrollIntoView(EditorSelection.range(searchTarget.from, searchTarget.to), { y: "center" }) });
      }
      this.#searchScrollTarget = { ...searchTarget, epoch: this.#userScrollEpoch };
    }
    if (this.#searchScrollTarget !== undefined) this.#revealMeasuredSearchTarget(view, this.#searchScrollTarget);
    const event: LivePreviewCommitEvent = {
      revision: this.#options.session.adapter.revision,
      planDurationMs: now() - startedAt,
      visibleBlocks: nodes.length,
      projectedNodes: plan.visitedNodes,
      decorationCount: plan.visualDecorationCount,
      widgetCount: plan.widgetCount,
      geometryDecorationCount: plan.geometryDecorationCount,
      geometryWidgetCount: plan.geometryWidgetCount,
      geometryTruncated: plan.geometryTruncated,
      activeBlocks: plan.activeBlocks,
      fallbackBlocks: plan.fallbackBlocks,
      truncated: plan.truncated,
      projectionRequests: this.#projectionRequests,
    };
    this.#snapshot = { ...event, enabled: true };
    this.#lastPlanSourceWindow = visible;
    this.#options.onCommit?.(event);
    this.#checkViewportCoverageAfterMeasure(view);
  }

  /**
   * Applying a plan may itself make CodeMirror recalculate its height map and
   * move the actual screen into a different source window. The corresponding
   * update is intentionally ignored while applying decorations to avoid a
   * projection feedback loop, so verify coverage once measurement settles.
   * An unchanged gap gets one recovery attempt; a new revision, viewport or
   * plan can request its own recovery without waiting for another user edit.
   */
  #checkViewportCoverageAfterMeasure(view: EditorView): void {
    view.requestMeasure({
      key: this.#viewportCoverageMeasureKey,
      read: () => ({ document: view.state.doc, screen: screenSourceWindow(view) }),
      write: (measured) => {
        if (this.#disposed || !this.#enabled || !this.#opened || view !== this.#view ||
            measured.document !== view.state.doc || !this.#sourceIsConfirmed()) return;
        const plan = this.#lastPlanSourceWindow;
        const { screen } = measured;
        if (plan !== undefined && plan.from <= screen.from && screen.to <= plan.to) {
          this.#lastViewportCoverageAttempt = "";
          return;
        }
        const key = `${this.#sourceVersion}:${Number(this.#options.session.adapter.revision)}:` +
          `${screen.from}:${screen.to}:${plan?.from}:${plan?.to}`;
        if (key === this.#lastViewportCoverageAttempt) return;
        this.#lastViewportCoverageAttempt = key;
        this.#schedule(true);
      },
    });
  }

  #revealMeasuredSearchTarget(view: EditorView, target: SearchScrollTarget, attempt = 0, finish?: () => void): void {
    const current = () => !this.#disposed && this.#enabled && view === this.#view &&
      !this.#pointerSelecting && this.#searchSelectionActive && this.#sourceIsConfirmed() &&
      (finish === undefined || this.#finishSearchReveal === finish) &&
      this.#searchScrollTarget === target &&
      target.epoch === this.#userScrollEpoch && target.doc === view.state.doc &&
      target.from === view.state.selection.main.from && target.to === view.state.selection.main.to;
    if (!current()) { finish?.(); return; }
    if (attempt === 0) {
      this.#finishSearchReveal?.();
      let resolve!: () => void;
      this.#searchRevealTask = new Promise<void>(done => { resolve = done; });
      const complete = () => {
        if (this.#finishSearchReveal === complete) this.#finishSearchReveal = undefined;
        resolve();
      };
      this.#finishSearchReveal = complete;
      finish = complete;
    }
    const complete = finish!;
    // Revealing a large owner can replace its estimated height with many real
    // source lines. Recheck after CM measures them, rather than trusting the
    // height map used by the first scrollIntoView. A newer gesture wins.
    view.requestMeasure({
      key: this.#searchRevealMeasureKey,
      read: () => {
        if (!current() || canPaintRuntimeSearchRange(view, target)) return { visible: true, native: false, dx: 0, dy: 0 };
        const missing = { visible: false, native: false, dx: 0, dy: 0 };
        if (this.#hiddenPresentationRanges.some(range => range.from < target.to && target.from < range.to)) return missing;
        const from = view.domAtPos(target.from, 1);
        const to = view.domAtPos(target.to, -1);
        const range = view.dom.ownerDocument.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        // DOM tiles can be ready before CM publishes its new visibleRanges.
        // Validate the actual source text instead of rejecting that interval.
        if (range.toString() !== view.state.doc.sliceString(target.from, target.to)) return missing;
        const pane = view.scrollDOM.getBoundingClientRect();
        let bounds = range.getBoundingClientRect();
        // A long multiline hit cannot fit in one viewport. Keep its head in
        // view rather than alternating between the two ends on every plan.
        if (bounds.height > pane.height - 16 || bounds.width > pane.width - 24) {
          range.collapse(false);
          bounds = range.getBoundingClientRect();
        }
        if (bounds.height <= 0) return missing;
        const dx = nearestRevealDelta(bounds.left, bounds.right, pane.left + 8, pane.right - 12);
        const dy = nearestRevealDelta(bounds.top, bounds.bottom, pane.top + 8, pane.bottom - 8);
        return { visible: Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5, native: true, dx, dy };
      },
      write: measured => {
        if (!current()) { complete(); return; }
        // Invalidate any anchor-restoration frame from the measured plan.
        markLivePreviewUserScroll(view);
        if (measured.visible) { complete(); return; }
        queueMicrotask(() => {
          if (!current()) { complete(); return; }
          if (measured.native) {
            // coordsAtPos may use an estimated block box after switching
            // opaque owners. Scroll the mounted text's actual DOM geometry.
            if (Math.abs(measured.dy) > 0.5) view.scrollDOM.scrollTop += measured.dy;
            if (Math.abs(measured.dx) > 0.5) setLogicalScrollLeft(view.scrollDOM, logicalScrollLeft(view.scrollDOM) + measured.dx);
          } else if (!revealRuntimeSearchRange(view, target)) {
            view.dispatch({ effects: EditorView.scrollIntoView(EditorSelection.range(target.from, target.to), { y: "center" }) });
          }
          const window = view.dom.ownerDocument.defaultView;
          if (attempt < 2 && window !== null) window.requestAnimationFrame(() =>
            this.#revealMeasuredSearchTarget(view, target, attempt + 1, complete));
          else complete();
        });
      },
    });
  }

  #onKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    // A keyboard navigation may reveal an offscreen caret before the
    // selection itself changes. It must outrank a recent thumb-to-end gesture.
    this.#endFollowGeneration += 1;
    if (this.#pendingBlankMarkers !== undefined && event.isTrusted &&
        !event.altKey && !event.ctrlKey && !event.metaKey &&
        ["Enter", "Backspace", "Delete", "Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      this.#rememberTrustedLocalGesture(view, { type: "key", key: event.key });
    }
    if (!this.#enabled || !this.#opened || this.#disposed || this.#composing || event.isComposing) {
      return false;
    }
    if (event.key === "Home" && event.isTrusted && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
        view.hasFocus && view.state.selection.ranges.length === 1 && view.state.selection.main.empty) {
      // The closer of a freshly typed empty pair shares the body's zero-width
      // position. Confirmation may hide that physical line before Home is
      // processed, making CM navigate to the following paragraph instead.
      // The bounded pending-marker proof gives the same line start in either
      // timing without guessing ownership from arbitrary Markdown text.
      const head = view.state.selection.main.head;
      const lineStart = view.state.doc.lineAt(head).from;
      const pending = this.#pendingEmptyMarker(view.state.doc, lineStart);
      if (pending !== undefined && head >= lineStart && head <= pending.closingTo) {
        event.preventDefault();
        view.dispatch({
          selection: { anchor: lineStart },
          annotations: Transaction.userEvent.of("select.keyboard"),
        });
        return true;
      }
    }
    if (
      this.#tableIme?.active === true &&
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.altKey && !event.ctrlKey && !event.metaKey &&
      view.state.selection.ranges.length === 1 &&
      view.state.selection.main.empty
    ) {
      const cell = this.#selectionTableCell(view);
      if (cell !== undefined) {
        event.preventDefault();
        // The sink is intentionally empty, so browsers do not reliably emit a
        // beforeinput event for deletion. Commit the same bounded table edit
        // from keydown and consume cell-edge deletion as a structural no-op.
        this.#dispatchTableInput(
          view,
          cell,
          event.key === "Backspace"
            ? "deleteContentBackward"
            : "deleteContentForward",
          undefined,
        );
        return true;
      }
    }
    if (this.#deleteEmptyQuoteLineForward(view, event)) return true;
    if (this.#editQuotedCodeLine(view, event)) return true;
    if (this.#indentQuotedComponents(view, event)) return true;
    if (this.#editQuoteStructure(view, event)) return true;
    if (this.#guardComponentDeletion(view, event)) return true;
    if (this.#guardReplacementDeletion(view, event)) return true;
    // A mapped table input may receive another key before Rust confirms the
    // previous character. Its optimistic cell range is ChangeSet-mapped and
    // table input cannot alter pipes/newlines, so navigation may safely use the
    // current source. Other stale widgets still fall back to CodeMirror.
    const pendingMappedInput = this.#awaitingConfirmation &&
      this.#tableIme?.active === true &&
      this.#selectionTableCell(view) !== undefined;
    if (this.#awaitingConfirmation && !pendingMappedInput) return false;
    if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey &&
        !this.#searchSourceReveal && view.hasFocus &&
        !view.state.readOnly && view.state.selection.ranges.length === 1) {
      const mac = /Mac|iPhone|iPad/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
      const binding = this.#options.commands?.shortcutForEvent(event, mac);
      const selection = view.state.selection.main;
      const item = resolveSourceRootAt(this.#source, this.#visibleNodes, selection.from);
      if (item?.kind === "list-item" &&
          (binding === undefined || binding.id === (event.shiftKey ? "table.previous-row" : "table.next-row"))) {
        const context = {
          source: this.#source,
          selection: { anchor: selection.anchor as Utf16Offset, head: selection.head as Utf16Offset },
          item,
          precedingItems: this.#visibleNodes,
        };
        const result = resolveListEnter({ ...context, shift: event.shiftKey }) ??
          (event.shiftKey ? resolveListEnter(context) : undefined);
        if (result?.edits !== undefined && result.selection !== undefined) {
          event.preventDefault();
          view.dispatch({
            changes: result.edits.map(edit => ({ from: Number(edit.range.from), to: Number(edit.range.to), insert: edit.insert })),
            selection: EditorSelection.range(Number(result.selection.anchor), Number(result.selection.head)),
            userEvent: result.userEvent,
            scrollIntoView: true,
          });
          return true;
        }
      }
    }
    if (this.#exitEmptyPrefix(view, event)) return true;
    if (this.#navigatePresentationBoundary(view, event)) return true;
    const command = this.#tableNavigationCommand(view, event);
    if (command === undefined) return false;
    const direction = interactionDirection(command);
    const active = this.#selectionTableCell(view);
    const surface = pendingMappedInput
      ? tableSurfacePositionAt(this.#source, view.state.selection.main.head)
      : confirmedTableSurfacePosition(
          this.#options.session,
          this.#visibleNodes,
          this.#source,
          view.state.selection.main.head,
        );
    // Enter is contextual row navigation only within an actual table. In a
    // paragraph or quote it must reach Markdown's newline/continuation keymap,
    // including when a projected block happens to be on the following line.
    if (command === TABLE_INTERACTION_COMMAND.beginEdit && surface === undefined) return false;
    if (command === TABLE_INTERACTION_COMMAND.beginEdit && active === undefined && surface !== undefined) {
      // delimiter、pipe 和行边界不是可编辑 cell。若 selection 因原生移动暂时
      // 落到这些位置，先恢复到语义 cell，不能让 Enter 修改隐藏的 Markdown 骨架。
      const recovery = resolveTableSurfaceNavigation(
        this.#source,
        view.state.selection.main.head,
        "right",
      );
      if (recovery?.kind === "cell") {
        event.preventDefault();
        this.#focusTableTarget(view, recovery.target);
        return true;
      }
      event.preventDefault();
      return true;
    }

    if (direction === undefined) return false;
    // 多选没有唯一的视觉 cell。让 CodeMirror 保持原生选择语义，避免用
    // main.head 把多选折叠成一个伪造的表格光标。
    if (view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) {
      return false;
    }
    const projected = tableRenderNavigation(
      this.#visibleNodes,
      view.state.selection.main.head,
      direction,
    );
    if (projected !== undefined) {
      event.preventDefault();
      if (projected.kind === "handled") return true;
      this.#focusTableTarget(view, {
        cell: {
          from: Number(projected.target.cell.sourceRange.from),
          to: Number(projected.target.cell.sourceRange.to),
        },
      });
      return true;
    }
    const resolvedTarget = resolveTableSurfaceNavigation(
      this.#source,
      view.state.selection.main.head,
      direction,
    );
    const target = surface !== undefined ||
        (resolvedTarget?.kind === "cell" && (
          confirmedTableRange(
            this.#visibleNodes,
            resolvedTarget.target.table.from,
            resolvedTarget.target.table.to,
          ) || confirmedTableRangeInProjection(
            this.#options.session,
            resolvedTarget.target.table.from,
            resolvedTarget.target.table.to,
          )))
      ? resolvedTarget
      : undefined;
    if (active !== undefined && target !== undefined && target.kind !== "cell" &&
        (direction === "next" || command === TABLE_INTERACTION_COMMAND.beginEdit) &&
        !view.state.readOnly &&
        this.#options.onTableCommand?.(TABLE_COMMAND.insertRowBelow, view.state.selection.main.head) === true) {
      // Continue at the next row through the same structural command as the
      // toolbar. Tab starts its first cell; Enter preserves the current column.
      if (direction === "next") {
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const first = tableRowCells(line.text, line.from)[0];
        if (first !== undefined) {
          this.#optimisticTableCell = { from: first.from, to: first.to };
          this.#mappedTableCell = this.#optimisticTableCell;
          view.dispatch({ selection: { anchor: first.from }, annotations: Transaction.userEvent.of("select.keyboard") });
          this.#pendingTableCommandFocus = first.from;
        }
      }
      event.preventDefault();
      return true;
    }
    if (target === undefined) {
      // CM's vertical motion reads DOM coordinates. A cursor retained outside
      // the painted viewport can resolve against the current viewport edge.
      // Reveal and measure its original line before running the native keymap.
      if (direction === "up" || direction === "down") {
        const head = view.state.selection.main.head;
        const caret = view.coordsAtPos(head);
        const viewport = view.scrollDOM.getBoundingClientRect();
        if (caret === null || caret.bottom < viewport.top || caret.top > viewport.bottom) {
          const doc = view.state.doc;
          const scrollEpoch = this.#userScrollEpoch;
          event.preventDefault();
          markLivePreviewUserScroll(view);
          view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
          const frame = view.dom.ownerDocument.defaultView?.requestAnimationFrame.bind(view.dom.ownerDocument.defaultView);
          frame?.(() => frame(() => {
            if (this.#disposed || !this.#enabled || this.#userScrollEpoch !== scrollEpoch || view.state.doc !== doc || view.state.selection.main.head !== head) return;
            markLivePreviewUserScroll(view);
            runScopeHandlers(view, event, "editor");
          }));
          return true;
        }
      }
      // Table 无法安全接管时，普通 block 只允许在与 atomic replacement 紧邻的
      // 物理行 seam 上进行垂直进入。它不会按 RenderNode 邻接关系跳跃，因此
      // active 多行源码、两个连续 BlankLine 与普通 CodeMirror 文本仍保持原生
      // ArrowUp/Down 行为。
      if (direction === "up" || direction === "down") {
        const vertical = resolveLivePreviewVerticalNavigation(
          sourceSnapshot(view),
          view.state.selection.main.head,
          this.#replacedBlockRanges,
          direction,
        );
        if (vertical !== undefined) {
          event.preventDefault();
          this.#pendingSourceReveal = vertical.range;
          const opening = resolveLivePreviewOpeningNavigation(
            sourceSnapshot(view), this.#visibleNodes, view.state.selection.main.head,
            vertical.anchor, direction,
          );
          const anchor = opening?.anchor ?? this.#editPolicy.resolveCaret(vertical.anchor, {
            direction: direction === "down" ? "forward" : "backward",
            vertical: true,
          }) ?? vertical.anchor;
          if (opening !== undefined) this.#pendingSourceReveal = { from: anchor, to: anchor };
          this.#focusSource(view, anchor, true);
          return true;
        }
      }
      // 这里只代表普通源码位置。table 内的 cell、语法间隙和 delimiter 都由
      // resolver 返回 handled/cell/source，绝不能以 active cell 是否存在来猜测。
      return false;
    }
    event.preventDefault();
    if (target.kind === "handled") {
      // 当前 cell 已经在同一方向的边界；消费按键但不写入源码，避免 CodeMirror
      // 穿过 atomic widget 后把隐藏的 delimiter 当作普通文本继续移动。
      return true;
    }
    if (target.kind === "cell") {
      this.#focusTableTarget(view, target.target, false);
    } else if (target.kind === "source") {
      // 目标紧邻当前可见 widget。不能根据被替换的 source 几何重新滚动，
      // 否则 CodeMirror 会把隐藏源码位置当成视觉位置，跳到文档首尾。
      this.#focusSource(view, target.offset, true);
    } else {
      if (view.state.readOnly) return true;
      view.dispatch({
        changes: {
          from: safeUtf16Offset(sourceSnapshot(view), target.offset),
          to: safeUtf16Offset(sourceSnapshot(view), target.offset),
          insert: target.insert,
        },
        selection: {
          anchor: safeUtf16Offset(
            sourceSnapshot(view),
            target.offset + target.insert.length,
          ),
        },
        scrollIntoView: true,
      });
      view.focus();
    }
    return true;
  }

  /**
   * A mapped table widget has a semantic CodeMirror selection inside its
   * hidden Markdown cell, but it intentionally has no second contenteditable
   * DOM. Browser text input would otherwise use the replacement widget's
   * visual boundary rather than that semantic selection. Intercept the
   * editable `beforeinput` cases and turn them into normal CodeMirror
   * transactions at the already-confirmed cell range.
   *
   * This keeps text, undo/redo and Rust transactions single-sourced in
   * CodeMirror. It is deliberately narrower than a generic rich-text bridge:
   * only a Rust-confirmed table cell gets this behavior. Platform composition
   * is collected by LivePreviewTableImeSurface and commits through the same
   * helper exactly once.
   */
  #dispatchTableSurfaceInput(
    view: EditorView,
    inputType: string,
    data: string | undefined,
  ): boolean {
    if (
      view !== this.#view || !this.#enabled || !this.#opened || this.#disposed ||
      view.state.selection.ranges.length !== 1
    ) {
      return false;
    }
    const cell = this.#selectionTableCell(view);
    if (cell === undefined) return false;
    const normalized = normalizeTableInputType(inputType);
    return normalized === undefined
      ? false
      : this.#dispatchTableInput(view, cell, normalized, data);
  }

  #onTableSurfaceKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    if (
      view !== this.#view || !this.#enabled || !this.#opened || this.#disposed ||
      this.#tableIme?.active !== true
    ) {
      return false;
    }
    if (this.#onKeyDown(view, event)) {
      const command = this.#tableNavigationCommand(view, event);
      if (command !== undefined && interactionDirection(command) !== undefined) {
        this.#scheduleTableReveal(view);
      }
      return true;
    }
    // Printable text and deletion must reach textarea beforeinput. Running the
    // CodeMirror keymap for those keys would bypass table serialization and can
    // delete a hidden pipe while a Rust confirmation is pending.
    if (usesNativeBeforeInput(event)) return false;

    let handled = false;
    preserveLivePreviewViewport(view, () => {
      handled = runScopeHandlers(view, event, "editor");
    });
    if (!handled) return false;

    const focused = view.dom.ownerDocument.activeElement;
    if (focused !== null && focused !== view.dom.ownerDocument.body &&
        !view.hasFocus && this.#tableIme?.focused !== true) {
      // Find, Go to Line and the command UI own their newly focused control.
      // Do not immediately steal it back to the cell's transient IME sink.
      return true;
    }

    const active = this.#selectionTableCell(view);
    if (active !== undefined) {
      this.#activateTableInput(view);
    } else {
      this.#tableIme?.cancel();
      view.focus();
      if (
        view.state.selection.ranges.length === 1 &&
        view.state.selection.main.empty
      ) {
        view.dispatch({ scrollIntoView: true });
      }
    }
    return true;
  }

  #onBeforeInput(view: EditorView, event: InputEvent): boolean {
    if (view.state.readOnly) {
      event.preventDefault();
      return true;
    }
    if (this.#enabled && this.#opened && !this.#disposed && event.isTrusted &&
        (event.inputType.startsWith("insert") || event.inputType.startsWith("delete"))) {
      const data = event.inputType === "insertFromPaste"
        ? event.dataTransfer?.getData("text/plain") ?? event.data : event.data;
      this.#rememberTrustedLocalGesture(view, { type: "input", inputType: event.inputType, data });
    }
    if (
      !this.#enabled || !this.#opened || this.#disposed || this.#composing ||
      event.isComposing || view.state.selection.ranges.length !== 1
    ) {
      return false;
    }
    const selection = view.state.selection.main;
    if (event.isTrusted && event.cancelable && event.inputType === "insertText" &&
        event.data !== null && /[\r\n]/u.test(event.data) && selection.empty &&
        !/Android/i.test(view.dom.ownerDocument.defaultView?.navigator.userAgent ?? "") &&
        this.#emptyComposition === undefined && !view.composing && !this.#awaitingConfirmation &&
        this.#sourceIsConfirmed() && resolveEmptyClosedContainer(this.#visibleNodes, selection.head) !== undefined) {
      // Chrome can rebuild a hidden closer's DOM while splitting a physical
      // line, then report a native change that includes the closer itself.
      // The confirmed zero-width body is a precise insertion point: submit
      // the original text through CM instead. The regular transaction filter
      // adds its separator and preserves policy, selection and history.
      event.preventDefault();
      view.dispatch({
        ...view.state.replaceSelection(event.data),
        userEvent: "input.type",
        scrollIntoView: true,
      });
      return true;
    }
    const cell = this.#selectionTableCell(view, true);
    if (cell === undefined) {
      const selection = view.state.selection.main;
      if (!selection.empty && !this.#searchSourceReveal &&
          (event.inputType.startsWith("insert") || event.inputType.startsWith("delete"))) {
        const touchesPartialTable = this.#visibleNodes.some((node) => {
          if (node.kind !== "table" || node.mode === "source") return false;
          const from = Number(node.sourceRange.from);
          const to = Number(node.sourceRange.to);
          return selection.from < to && from < selection.to &&
            !(selection.from <= from && to <= selection.to);
        });
        const optimistic = this.#awaitingConfirmation ? this.#optimisticTableCell : undefined;
        const touchesUnconfirmedCell = optimistic !== undefined &&
          selection.from <= optimistic.to && optimistic.from <= selection.to;
        if (touchesPartialTable || touchesUnconfirmedCell) {
          // A replacement widget cannot express this native DOM selection.
          // Never let the browser relocate a cross-cell or stale cell edit to
          // the adjacent source line. Whole-root/document replacements retain
          // the existing CodeMirror path.
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
      }
      const direction = event.inputType === "deleteContentBackward"
        ? "backward"
        : event.inputType === "deleteContentForward"
          ? "forward"
          : undefined;
      const resolved = direction === undefined
        ? undefined
        : this.#resolveComponentDeletion(view, direction);
      if (resolved === undefined) return false;
      event.preventDefault();
      event.stopPropagation();
      if (resolved.kind === "delete-range") {
        this.#dispatchComponentRootDeletion(view, resolved);
      }
      return true;
    }
    const data = tableInputData(event);
    if (!this.#dispatchTableInput(view, cell, event.inputType, data)) {
      const direction = event.inputType === "deleteContentBackward"
        ? "backward"
        : event.inputType === "deleteContentForward"
          ? "forward"
          : undefined;
      const resolved = direction === undefined
        ? undefined
        : this.#resolveComponentDeletion(view, direction);
      if (resolved !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        if (resolved.kind === "delete-range") {
          this.#dispatchComponentRootDeletion(view, resolved);
        }
        return true;
      }
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  #commitTableComposition(view: EditorView, text: string): void {
    if (
      view !== this.#view || !this.#enabled || !this.#opened || this.#disposed ||
      text.length === 0
    ) return;
    const cell = this.#selectionTableCell(view);
    if (cell === undefined) return;
    this.#dispatchTableInput(
      view,
      cell,
      "insertText",
      text,
      "input.table.compose",
    );
  }

  #dispatchTableInput(
    view: EditorView,
    cell: { readonly from: number; readonly to: number },
    inputType: string,
    data: string | undefined,
    userEvent?: string,
  ): boolean {
    if (view.state.readOnly) return false;
    const selection = view.state.selection.main;
    const source = sourceSnapshot(view);
    const change = tableMappedInputChange(
      source,
      {
        from: Math.min(selection.anchor, selection.head),
        to: Math.max(selection.anchor, selection.head),
      },
      cell,
      {
        inputType,
        ...(data === undefined ? {} : { data }),
      },
    );
    if (change === undefined) return false;
    const { cursor, ...changes } = change;
    this.#optimisticTableCell = cell;
    view.dispatch({
      changes,
      selection: { anchor: cursor },
      annotations: Transaction.userEvent.of(
        userEvent ?? tableMappedInputUserEvent(inputType),
      ),
    });
    return true;
  }

  #exitEmptyPrefix(view: EditorView, event: KeyboardEvent): boolean {
    if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        view.state.readOnly || this.#searchSourceReveal || view.state.selection.ranges.length !== 1 ||
        !view.state.selection.main.empty || !this.#editPolicy.isEmptyPrefixLine(view.state.selection.main.head)) return false;
    const mac = /Mac|iPhone|iPad/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
    const binding = this.#options.commands?.shortcutForEvent(event, mac);
    if (binding !== undefined && binding.id !== "table.next-row") return false;
    // Reuse CodeMirror's Markdown transformations, including nested outdents
    // and list renumbering. Empty rendered rows exit one markup level; they
    // never require extra invisible continuation rows before exit is possible.
    const transactions: Transaction[] = [];
    insertNewlineContinueMarkup({ state: view.state, dispatch: (transaction) => transactions.push(transaction) });
    const continuation = transactions[0];
    if (continuation !== undefined && continuation.newDoc.lines <= view.state.doc.lines) {
      view.dispatch(continuation);
    } else if (!deleteMarkupBackward(view)) return false;
    event.preventDefault();
    return true;
  }

  #deleteEmptyQuoteLineForward(view: EditorView, event: KeyboardEvent): boolean {
    if (event.key !== "Delete" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !view.hasFocus || view.state.readOnly || this.#searchSourceReveal ||
        view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false;
    const mac = /Mac|iPhone|iPad/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
    if (this.#options.commands?.shortcutForEvent(event, mac) !== undefined) return false;
    const change = this.#handle.emptyQuoteForwardDelete(view, view.state.selection.main.head);
    if (change === undefined) return false;
    event.preventDefault();
    view.dispatch({ changes: { from: change.from, to: change.to, insert: "" },
      selection: { anchor: change.selection }, userEvent: "input.quote.delete-empty-line", scrollIntoView: true });
    return true;
  }

  #editQuoteStructure(view: EditorView, event: KeyboardEvent): boolean {
    if ((event.key !== "Enter" && event.key !== "Backspace" && event.key !== "Tab") || event.altKey || event.ctrlKey || event.metaKey ||
        (event.key === "Backspace" && event.shiftKey) ||
        !view.hasFocus || view.state.readOnly || this.#searchSourceReveal || view.state.selection.ranges.length !== 1) return false;
    const mac = /Mac|iPhone|iPad/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
    const binding = this.#options.commands?.shortcutForEvent(event, mac);
    const contextualBinding = event.key === "Tab"
      ? (event.shiftKey ? "table.previous-cell" : "table.next-cell")
      : (event.shiftKey ? "table.previous-row" : "table.next-row");
    if (binding !== undefined && (event.key === "Backspace" || binding.id !== contextualBinding)) return false;
    const selection = view.state.selection.main;
    const line = this.#handle.ordinaryQuoteLine(view, selection.from);
    if (line === undefined || selection.to > line.to) return false;
    if (event.key === "Tab" && !event.shiftKey) {
      const at = selection.empty ? selection.head : line.prefixTo;
      // A compact `>>` has no separator yet. Supply one before the body tab
      // so the parser does not consume the tab as quote-prefix whitespace.
      const insert = quoteBodyIndent(line, at);
      event.preventDefault();
      view.dispatch({ changes: { from: at, insert },
        selection: EditorSelection.range(selection.anchor + insert.length, selection.head + insert.length),
        userEvent: "input.quote.indent", scrollIntoView: true });
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && (!selection.empty ||
        !isWhitespaceRange(view.state.doc, line.prefixTo, line.to))) return false;
    if (event.key === "Backspace" || (event.key === "Tab" && event.shiftKey)) {
      if (!selection.empty && event.key !== "Tab") return false;
      if (event.key === "Backspace") {
        if (selection.head !== line.prefixTo) return false;
      }
      const { from, to } = quoteOutdentRange(line);
      event.preventDefault();
      view.dispatch({ changes: { from, to, insert: "" },
        selection: EditorSelection.range(selection.anchor - (to - from), selection.head - (to - from)),
        userEvent: "input.quote.outdent", scrollIntoView: true });
      return true;
    }
    const insert = `\n${line.prefix}`;
    event.preventDefault();
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert },
      selection: { anchor: selection.from + insert.length }, userEvent: "input.quote.continue", scrollIntoView: true });
    return true;
  }

  /** Indent selected quoted rows without moving whitespace before `>`. */
  #indentQuotedComponents(view: EditorView, event: KeyboardEvent): boolean {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || !view.hasFocus ||
        view.state.readOnly || this.#searchSourceReveal) return false;
    const mac = /Mac|iPhone|iPad/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
    const binding = this.#options.commands?.shortcutForEvent(event, mac);
    if (binding !== undefined && binding.id !== (event.shiftKey ? "table.previous-cell" : "table.next-cell")) return false;
    const selection = view.state.selection.main, doc = view.state.doc;
    const first = doc.lineAt(selection.from), last = doc.lineAt(selection.to);
    const lastNumber = !selection.empty && selection.to === last.from ? Math.max(first.number, last.number - 1) : last.number;
    const index = this.#options.session.adapter.blocks;
    const rootAt = (position: number) => {
      if (this.#awaitingConfirmation || !this.#sourceIsConfirmed()) return undefined;
      const at = index.blockAt(position);
      return at === undefined ? undefined : resolveSourceRootAt(this.#source, index.blocks.slice(at, at + 2), position);
    };
    const unresolvedQuote = (from: number, to: number): boolean => {
      const root = rootAt(from);
      return root?.kind === "block-quote" || (root === undefined &&
        /^ {0,3}>/u.test(doc.sliceString(from, Math.min(to, from + 4))));
    };
    const selections = view.state.selection.ranges;
    if (selections.length > 1) {
      // Multiple collapsed carets on ordinary quote bodies are independent
      // source edits; keep the complete CodeMirror selection and history.
      const contexts = selections.map(range => ({ range, physical: doc.lineAt(range.head),
        line: range.empty ? this.#handle.ordinaryQuoteLine(view, range.head) : undefined }));
      let touchesQuote = contexts.some(({ line, physical }) => line !== undefined || unresolvedQuote(physical.from, physical.to));
      if (!touchesQuote) for (const range of selections) {
        if (range.empty) continue;
        const start = doc.lineAt(range.from), end = doc.lineAt(range.to);
        for (let number = start.number; number <= end.number; number++) {
          const physical = doc.line(number);
          if (this.#handle.quoteLine(view, physical.to) !== undefined || unresolvedQuote(physical.from, physical.to)) {
            touchesQuote = true;
            break;
          }
        }
        if (touchesQuote) break;
      }
      if (!touchesQuote) return false;
      if (contexts.some(({ line }) => line === undefined)) {
        // Do not partially edit a mixed or unprojected multi-selection.
        event.preventDefault();
        return true;
      }
      const edits: ChangeSpec[] = [];
      const outdented = new Set<number>();
      for (const { range, line: proven } of contexts) {
        const line = proven!;
        if (!event.shiftKey) {
          edits.push({ from: range.head, insert: quoteBodyIndent(line, range.head) });
        } else if (!outdented.has(line.from)) {
          outdented.add(line.from);
          edits.push(quoteOutdentRange(line));
        }
      }
      event.preventDefault();
      const changes = view.state.changes(edits);
      view.dispatch({ changes, selection: view.state.selection.map(changes, 1),
        userEvent: event.shiftKey ? "input.quote.outdent" : "input.quote.indent", scrollIntoView: true });
      return true;
    }
    if (first.number === lastNumber) {
      const line = this.#handle.quoteLine(view, selection.from);
      if (line === undefined) {
        if (!unresolvedQuote(first.from, first.to)) return false;
        event.preventDefault();
        return true;
      }
      if (line.kind === "ordinary") return false;
      if (line.kind === "other" || (line.kind === "code" && this.#handle.quotedCodeLine(view, selection.from) === undefined)) {
        event.preventDefault();
        return true;
      }
    }
    const rows = [];
    for (let number = first.number; number <= lastNumber; number++) {
      const physical = doc.line(number), line = this.#handle.quoteLine(view, physical.to);
      rows.push({ physical, line });
    }
    // Plain paragraphs and blank lines can participate in a mixed selection,
    // using the same indentation as CodeMirror. Everything else needs an
    // actual quote-row projection; guessing from the first `>` would confuse
    // quoted children with code or an unconfirmed structural change.
    if (rows.every(row => row.line === undefined)) {
      // A known quote outside the materialized projection must not fall
      // through to CodeMirror's indent-before-prefix command.
      if (rows.some(row => unresolvedQuote(row.physical.from, row.physical.to))) {
        event.preventDefault();
        return true;
      }
      return false;
    }
    if (rows.some(row => (row.line === undefined && !["paragraph", "blank-line"].includes(rootAt(row.physical.from)?.kind ?? "")) ||
        row.line?.kind === "other" ||
        (row.line?.kind === "code" && this.#handle.quotedCodeLine(view, row.physical.to) === undefined))) {
      event.preventDefault();
      return true;
    }
    const edits: ChangeSpec[] = [];
    for (const { physical, line: quoted } of rows) {
      if (quoted === undefined) {
        if (!event.shiftKey) edits.push({ from: physical.from, insert: view.state.facet(indentUnit) });
        else {
          const change = removeIndentUnit(view.state, physical.from, physical.to);
          if (change !== undefined) edits.push(change);
        }
        continue;
      }
      const line = quoted;
      if (event.shiftKey && line.kind === "ordinary") {
        edits.push(quoteOutdentRange(line));
      } else if (event.shiftKey) {
        const change = removeIndentUnit(view.state, line.prefixTo, physical.to);
        if (change !== undefined) edits.push(change);
      } else {
        const insert = line.kind === "ordinary" ? quoteBodyIndent(line, line.prefixTo) :
          (line.prefix.endsWith(">") ? " " : "") + view.state.facet(indentUnit);
        edits.push({ from: line.prefixTo, insert });
      }
    }
    event.preventDefault();
    if (edits.length === 0) return true;
    const changes = view.state.changes(edits);
    view.dispatch({ changes, selection: EditorSelection.range(changes.mapPos(selection.anchor, 1), changes.mapPos(selection.head, 1)),
      userEvent: event.shiftKey ? "input.quote.outdent" : "input.quote.indent", scrollIntoView: true });
    return true;
  }

  /** Keep a fenced code body's confirmed quote prefix when splitting/joining. */
  #editQuotedCodeLine(view: EditorView, event: KeyboardEvent): boolean {
    if (!view.hasFocus || view.state.readOnly || this.#searchSourceReveal ||
        event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== "Enter") ||
        !["Enter", "Backspace", "Delete"].includes(event.key) ||
        view.state.selection.ranges.length !== 1 ||
        (!view.state.selection.main.empty && event.key !== "Enter")) return false;
    const mac = /Mac|iPhone|iPad/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
    const binding = this.#options.commands?.shortcutForEvent(event, mac);
    if (binding !== undefined && !(event.key === "Enter" &&
        binding.id === (event.shiftKey ? "table.previous-row" : "table.next-row"))) return false;
    const selection = view.state.selection.main;
    const head = event.key === "Enter" ? selection.from : selection.head;
    const current = this.#handle.quotedCodeLine(view, head);
    if (current === undefined || head < current.prefixTo || head > current.to ||
        (event.key === "Enter" && selection.to > current.to)) return false;

    let from = head, to = event.key === "Enter" ? selection.to : head, insert = "";
    if (event.key === "Enter") {
      // Match the ordinary code editor's indentation continuation while
      // keeping the confirmed quote prefix ahead of that indentation.
      // Read only as far as the actual indentation, even if the code body is
      // a very long single line. Do not silently truncate long indentation.
      let indentationTo = current.prefixTo;
      while (indentationTo < head) {
        const chunk = view.state.doc.sliceString(indentationTo, Math.min(head, indentationTo + 256));
        const whitespace = /^[ \t]*/u.exec(chunk)?.[0].length ?? 0;
        indentationTo += whitespace;
        if (whitespace < chunk.length) break;
      }
      const indentation = view.state.doc.sliceString(current.prefixTo, indentationTo);
      insert = `\n${current.prefix}${indentation}`;
    } else if (event.key === "Backspace" && head === current.prefixTo && current.physicalLine > 1) {
      const previous = this.#handle.quotedCodeLine(view, view.state.doc.line(current.physicalLine - 1).from);
      if (previous === undefined || previous.codeOwner !== current.codeOwner ||
          previous.quoteOwner !== current.quoteOwner || previous.depth !== current.depth) return false;
      from = previous.to;
      to = current.prefixTo;
    } else if (event.key === "Delete" && head === current.to && current.physicalLine < view.state.doc.lines) {
      const next = this.#handle.quotedCodeLine(view, view.state.doc.line(current.physicalLine + 1).from);
      if (next === undefined || next.codeOwner !== current.codeOwner ||
          next.quoteOwner !== current.quoteOwner || next.depth !== current.depth) return false;
      to = next.prefixTo;
    } else return false;
    event.preventDefault();
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length },
      userEvent: "input.code.quoted-line", scrollIntoView: true });
    return true;
  }

  #tableNavigationCommand(view: EditorView, event: KeyboardEvent): TableInteractionCommandId | undefined {
    const commands = this.#options.commands;
    if (commands === undefined) return tableLivePreviewCommand(event);
    const mac = /Mac|iPhone|iPad/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
    const binding = commands.shortcutForEvent(event, mac);
    if (binding !== undefined) {
      switch (binding.command) {
        case TABLE_COMMAND.nextCell: return TABLE_INTERACTION_COMMAND.focusNext;
        case TABLE_COMMAND.previousCell: return TABLE_INTERACTION_COMMAND.focusPrevious;
        case TABLE_COMMAND.cellAbove: return TABLE_INTERACTION_COMMAND.focusAbove;
        case TABLE_COMMAND.cellBelow: return binding.id === "table.next-row"
          ? TABLE_INTERACTION_COMMAND.beginEdit : TABLE_INTERACTION_COMMAND.focusBelow;
        default: return undefined;
      }
    }
    // Native arrows remain the mapped surface's spatial navigation. Configured
    // Tab/Enter bindings belong exclusively to the same public registry as CM.
    return event.key.startsWith("Arrow") ? tableLivePreviewCommand(event) : undefined;
  }

  #navigatePresentationBoundary(view: EditorView, event: KeyboardEvent): boolean {
    if (this.#searchSourceReveal || event.altKey || event.ctrlKey || event.metaKey ||
        view.state.selection.ranges.length !== 1 ||
        (!view.state.selection.main.empty && !event.shiftKey) ||
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
        !this.#editPolicy.hasNavigation) return false;
    const mac = /Mac|iPhone|iPad/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
    if (this.#options.commands?.shortcutForEvent(event, mac) !== undefined) return false;
    const selection = view.state.selection.main;
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "End";
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const lineBoundary = event.key === "Home" || event.key === "End";
    if (vertical) {
      const caret = view.coordsAtPos(selection.head);
      const pane = view.scrollDOM.getBoundingClientRect();
      // Offscreen motion first follows the existing reveal/measure path.
      if (caret === null || caret.bottom < pane.top || caret.top > pane.bottom) return false;
    }
    const moved = vertical ? view.moveVertically(selection, forward) : undefined;
    const opening = vertical ? resolveLivePreviewOpeningNavigation(
      this.#source, this.#visibleNodes, selection.head, moved?.head, forward ? "down" : "up",
    ) : undefined;
    if (opening !== undefined) {
      // Reveal just the destination caret. Passing the whole root as the
      // pending range would hide the opening marker again while the user is
      // trying to edit it.
      this.#pendingSourceReveal = { from: opening.anchor, to: opening.anchor };
      event.preventDefault();
      view.dispatch({
        selection: EditorSelection.create([EditorSelection.range(
          event.shiftKey ? selection.anchor : opening.anchor, opening.anchor, moved?.goalColumn,
        )]),
        scrollIntoView: true,
        annotations: Transaction.userEvent.of("select.keyboard"),
      });
      return true;
    }
    const line = lineBoundary ? view.state.doc.lineAt(selection.head) : undefined;
    const position = moved?.head ?? (line === undefined
      ? selection.head + (forward ? 1 : -1) : forward ? line.to : line.from);
    let target = this.#editPolicy.resolveCaret(position, {
      direction: forward ? "forward" : "backward", lineBoundary, vertical,
    });
    if (target === undefined) return false;
    if (vertical) {
      // Keep the native visual column when skipping a hidden physical row.
      // Source columns cannot model proportional fonts or wrapped text.
      const currentBox = view.coordsAtPos(selection.head);
      const targetBox = view.coordsAtPos(target);
      if (currentBox !== null && targetBox !== null) {
        const aligned = view.posAtCoords({ x: currentBox.left, y: (targetBox.top + targetBox.bottom) / 2 });
        if (aligned !== null && view.state.doc.lineAt(aligned).number === view.state.doc.lineAt(target).number) {
          target = this.#editPolicy.resolveCaret(aligned, { lineBoundary: true }) ?? aligned;
        }
      }
    }
    event.preventDefault();
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(
        event.shiftKey ? selection.anchor : target, target, moved?.goalColumn,
      )]),
      scrollIntoView: true,
      annotations: Transaction.userEvent.of("select.keyboard"),
    });
    return true;
  }

  #onWidgetActivate(view: EditorView, from: number, to: number): void {
    if (this.#disposed || !this.#enabled || !this.#opened || this.#awaitingConfirmation) return;
    this.#pendingSourceReveal = {
      from: Math.max(0, Math.min(view.state.doc.length, from)),
      to: Math.max(0, Math.min(view.state.doc.length, Math.max(from, to))),
    };
    // 激活的是已经挂载的 widget，但其 Rust 根节点可能刚好位于 sparse
    // projection 窗口边界。重新确认投影，避免“点击后只改变 selection，
    // Planner 却没有拿到该节点”而无法显示源码。
    this.#schedule(true);
  }

  #guardReplacementDeletion(view: EditorView, event: KeyboardEvent): boolean {
    if (
      (event.key !== "Backspace" && event.key !== "Delete") ||
      event.altKey || event.ctrlKey || event.metaKey ||
      view.state.selection.ranges.length !== 1
    ) return false;
    const selection = view.state.selection.main;
    // A non-empty selection (especially Cmd/Ctrl+A) is an ordinary document
    // replacement. It must reach CodeMirror's transaction filter, where a
    // fully covered table root is explicitly allowed. Only a collapsed caret
    // adjacent to an atomic Preview widget needs the first-key reveal guard.
    if (!selection.empty) return false;
    // A shared seam belongs to the replacement on the side being deleted:
    // Backspace targets the left range and Delete targets the right range.
    const replacement = this.#replacedRanges.find((range) => event.key === "Backspace"
      ? range.from < selection.from && selection.from <= range.to
      : range.from <= selection.from && selection.from < range.to);
    if (replacement === undefined) return false;
    event.preventDefault();
    // 第一次删除只解除 atomic replacement 并显示源码；下一次按键才进入普通
    // CodeMirror 文本删除路径。这样不会把一整段 block 当成一个字符删除。
    this.#pendingSourceReveal = replacement;
    this.#focusSource(view, selection.from);
    return true;
  }

  #guardComponentDeletion(view: EditorView, event: KeyboardEvent): boolean {
    if (
      (event.key !== "Backspace" && event.key !== "Delete") ||
      event.altKey || event.ctrlKey || event.metaKey ||
      view.state.selection.ranges.length !== 1 ||
      !view.state.selection.main.empty ||
      this.#awaitingConfirmation
    ) {
      return false;
    }
    const direction = event.key === "Backspace" ? "backward" : "forward";
    const resolved = this.#resolveComponentDeletion(view, direction);
    if (resolved === undefined) return false;
    event.preventDefault();
    if (resolved.kind === "delete-range") {
      this.#dispatchComponentRootDeletion(view, resolved);
    } else {
      this.#dispatchComponentBoundaryNoop(view, resolved.anchor);
    }
    return true;
  }

  #resolveComponentDeletion(
    view: EditorView,
    direction: "backward" | "forward",
  ): ReturnType<LivePreviewEditPolicy["resolveDeletion"]> {
    const head = view.state.selection.main.head;
    // When the exposed opening marker is the editable line, Delete at its
    // first character edits the marker rather than deleting the entire root.
    // Both keydown and native beforeinput use this same boundary policy.
    if (direction === "forward" && resolveLivePreviewOpeningRange(this.#visibleNodes, head)?.from === head) {
      return undefined;
    }
    return this.#editPolicy.resolveDeletion({
      position: head,
      direction,
    });
  }

  #dispatchComponentRootDeletion(
    view: EditorView,
    deletion: Extract<
      NonNullable<ReturnType<LivePreviewEditPolicy["resolveDeletion"]>>,
      { readonly kind: "delete-range" }
    >,
  ): void {
    const source = sourceSnapshot(view);
    preserveLivePreviewViewport(view, () => {
      view.dispatch({
        changes: deletion,
        selection: { anchor: safeUtf16Offset(source, deletion.from) },
        annotations: Transaction.userEvent.of("input.component.delete-root"),
      });
      view.focus();
    });
  }

  /**
   * A pipe-table cell edge is visually an intra-table boundary, not a place
   * where the caret may disappear into hidden Markdown syntax. Keep a single
   * collapsed CodeMirror selection in the current cell and perform the
   * expected no-op deletion. This is intentionally a normal zero-length
   * CodeMirror transaction so browser keydown and beforeinput paths agree.
   */
  #dispatchComponentBoundaryNoop(
    view: EditorView,
    anchor: number | undefined,
  ): void {
    if (anchor === undefined) return;
    const source = sourceSnapshot(view);
    preserveLivePreviewViewport(view, () => {
      view.dispatch({
        selection: { anchor: safeUtf16Offset(source, anchor) },
        annotations: Transaction.userEvent.of("input.component.boundary-delete"),
      });
      view.focus();
    });
  }

  #selectionTableCell(
    view: EditorView,
    allowContainedRange = false,
  ): { readonly from: number; readonly to: number } | undefined {
    const selection = view.state.selection.main;
    if (this.#searchSourceReveal || view.state.selection.ranges.length !== 1 ||
        (!selection.empty && (!allowContainedRange || this.#awaitingConfirmation || !this.#sourceIsConfirmed()))) {
      return undefined;
    }
    const head = selection.head;
    const containsSelection = (cell: { readonly from: number; readonly to: number }): boolean =>
      cell.from <= selection.from && selection.to <= cell.to;
    const optimistic = this.#optimisticTableCell;
    if (this.#awaitingConfirmation) {
      return optimistic !== undefined &&
          containsSelection(optimistic)
        ? optimistic
        : undefined;
    }
    const table = tableRenderRootAt(this.#visibleNodes, head);
    const mapped = this.#mappedTableCell;
    if (
      table !== undefined && mapped !== undefined &&
      containsSelection(mapped)
    ) {
      return mapped;
    }
    const projected = tableRenderCellAt(this.#visibleNodes, head);
    if (projected !== undefined) {
      const cell = {
        from: Number(projected.cell.sourceRange.from),
        to: Number(projected.cell.sourceRange.to),
      };
      if (!containsSelection(cell)) return undefined;
      this.#mappedTableCell = cell;
      return cell;
    }
    if (
      table === undefined &&
      confirmedTableSurfacePosition(
        this.#options.session,
        this.#visibleNodes,
        this.#source,
        head,
      ) === undefined
    ) {
      this.#mappedTableCell = undefined;
      return undefined;
    }
    const target = tableCellAt(this.#source, head);
    const cell = target === undefined ? undefined : { from: target.from, to: target.to };
    if (cell !== undefined && !containsSelection(cell)) return undefined;
    this.#mappedTableCell = cell;
    return cell;
  }

  #focusTableTarget(
    view: EditorView,
    target: { readonly cell: { readonly from: number; readonly to: number } },
    _scrollIntoView = false,
  ): void {
    this.#mappedTableCell = {
      from: target.cell.from,
      to: target.cell.to,
    };
    view.dispatch({
      selection: { anchor: safeUtf16Offset(sourceSnapshot(view), target.cell.from) },
    });
    this.#activateTableInput(view);
    this.#schedule(false);
  }

  #focusSource(view: EditorView, offset: number, scrollIntoView = false): void {
    this.#cancelTableReveal();
    this.#tableIme?.cancel();
    const focus = () => {
      view.dispatch({
        selection: { anchor: safeUtf16Offset(sourceSnapshot(view), offset) },
        ...(scrollIntoView ? { scrollIntoView: true } : {}),
      });
      view.focus();
    };
    if (scrollIntoView) focus();
    else preserveLivePreviewViewport(view, focus);
    this.#schedule(false);
  }

  #activateTableInput(view: EditorView, preferred?: HTMLElement): void {
    if (view.state.readOnly) {
      this.#tableIme?.cancel();
      return;
    }
    const active = this.#selectionTableCell(view);
    const surface = this.#tableIme;
    if (active === undefined || surface === undefined) {
      surface?.cancel();
      return;
    }
    // Selection projection is synchronous and intentionally narrower than a
    // document replan. It gives us the exact visual caret before focusing the
    // browser input sink.
    this.#renderRuntime?.refreshSelection();
    const cell = this.#tableCellElement(view, active, preferred);
    if (cell === undefined) {
      this.#scheduleTableReveal(view, true);
      return;
    }
    this.#mappedTableCellElement = cell;
    revealLivePreviewTableCaret(view, cell);
    surface.focus(cell);
    this.#scheduleTableReveal(view);
  }

  #tableCellElement(
    view: EditorView,
    range: { readonly from: number; readonly to: number },
    preferred?: HTMLElement,
  ): HTMLElement | undefined {
    if (
      preferred?.isConnected === true &&
      view.dom.contains(preferred)
    ) {
      return preferred;
    }
    const matches = (candidate: HTMLElement): boolean =>
      Number(candidate.dataset["jotSourceFrom"]) === range.from &&
      Number(candidate.dataset["jotSourceTo"]) === range.to;
    const active = [...view.dom.querySelectorAll<HTMLElement>(
      ".jot-live-preview-table-cell--active[data-jot-source-from][data-jot-source-to]",
    )].find(matches);
    if (active !== undefined) return active;
    const retained = this.#mappedTableCellElement;
    if (
      retained?.isConnected === true && view.dom.contains(retained) &&
      (matches(retained) || this.#awaitingConfirmation)
    ) {
      return retained;
    }
    return [...view.dom.querySelectorAll<HTMLElement>(
      ".jot-table-cell[data-jot-source-from][data-jot-source-to]",
    )].find(matches);
  }

  #scheduleTableReveal(view: EditorView, focus = false, attempt = 0): void {
    this.#cancelTableReveal();
    const expected = this.#selectionTableCell(view);
    if (expected === undefined) return;
    const run = () => {
      this.#tableRevealFrame = undefined;
      if (
        view !== this.#view || this.#disposed || !this.#enabled || !this.#opened
      ) {
        return;
      }
      const active = this.#selectionTableCell(view);
      if (
        active === undefined ||
        active.from !== expected.from ||
        active.to !== expected.to
      ) {
        return;
      }
      const cell = this.#tableCellElement(view, active);
      if (cell === undefined) {
        if (attempt < 3) this.#scheduleTableReveal(view, focus, attempt + 1);
        return;
      }
      this.#mappedTableCellElement = cell;
      revealLivePreviewTableCaret(view, cell);
      if (focus && this.#tableIme?.active !== true) this.#tableIme?.focus(cell);
      else this.#tableIme?.retarget(cell);
      // One second frame observes sticky-header and virtual-row corrections
      // without allowing an old request to override a newer selection.
      if (attempt === 0) this.#scheduleTableReveal(view, false, 1);
    };
    const requestFrame = view.dom.ownerDocument.defaultView?.requestAnimationFrame;
    if (requestFrame === undefined) {
      this.#tableRevealFrame = -1;
      queueMicrotask(run);
    } else {
      this.#tableRevealFrame = requestFrame(run);
    }
  }

  #cancelTableReveal(): void {
    if (this.#tableRevealFrame === undefined) return;
    if (this.#tableRevealFrame >= 0) {
      this.#view?.dom.ownerDocument.defaultView?.cancelAnimationFrame(
        this.#tableRevealFrame,
      );
    }
    this.#tableRevealFrame = undefined;
  }

  #syncTableCaret(view: EditorView | undefined, reveal = false): void {
    const active = view === undefined || !this.#enabled || !this.#opened
      ? undefined
      : this.#selectionTableCell(view);
    // The table caret is a pure projection of the exact CodeMirror selection,
    // not merely of the active cell. Moving left/right inside one cell must
    // refresh the visual caret even though `active.from/to` is unchanged.
    const selection = view?.state.selection.main;
    const selectionKey = selection === undefined
      ? ""
      : [
        selection.anchor,
        selection.head,
        active?.from ?? "",
        active?.to ?? "",
      ].join(":");
    view?.dom.classList.toggle(
      "jot-live-preview-table-focus-active",
      active !== undefined,
    );
    const selectionChanged = selectionKey !== this.#tableSelectionKey;
    if (selectionChanged) {
      this.#tableSelectionKey = selectionKey;
      // During the optimistic table transaction the mounted RenderNode still
      // carries pre-edit cell ranges. Repainting selection against those stale
      // ranges briefly clears the active cell/caret, which looks like a table
      // flash. Keep the already-confirmed visual shell until the matching Rust
      // projection updates its text and ranges in place.
      if (!this.#awaitingConfirmation) {
        this.#renderRuntime?.refreshSelection();
        const projectedCell = view?.dom.querySelector<HTMLElement>(
          ".jot-live-preview-table-cell--active",
        );
        if (projectedCell !== null && projectedCell !== undefined) {
          this.#mappedTableCellElement = projectedCell;
        } else {
          this.#mappedTableCellElement = undefined;
        }
      }
    }
    if (active === undefined || view === undefined) {
      this.#cancelTableReveal();
      this.#tableIme?.cancel();
      return;
    }
    if (this.#tableIme?.active === true) {
      const cell = this.#tableCellElement(view, active);
      if (cell !== undefined) {
        this.#mappedTableCellElement = cell;
        this.#tableIme.retarget(cell);
      }
      if (reveal && selectionChanged) this.#scheduleTableReveal(view);
    }
  }

  async #loadVisibleProjection(view: EditorView, epoch: number): Promise<void> {
    const visible = visibleSourceWindow(view);
    const folds = this.#options.headingFolds?.visibleRanges ?? [];
    const segments = visibleSegments(visible, folds);
    const revision = this.#options.session.adapter.revision;
    const rootKey = `${livePreviewProjectionKey(visible)}:${this.#options.headingFolds?.epoch ?? 0}`;
    this.#lastDetailProjectionKey = livePreviewDetailProjectionKey(visible);
    // ProjectionStore carries unaffected windows across revisions and turns
    // touched slots into holes. The revision does not need to invalidate the
    // viewport bucket itself; missing ranges and the transaction render patch
    // are the precise invalidation signals. Including revision here forced a
    // root round-trip after every table keystroke.
    const key = rootKey;
    const rootWindowChanged = key !== this.#lastProjectionKey;
    if (rootWindowChanged) {
      this.#projectionRequests += 1;
      const effect = await tolerateStaleProjection(() => this.#options.session.projectAround(
        "0",
        "syntax-children",
        livePreviewRange(segments[0]?.from ?? visible.from, segments[0]?.to ?? visible.to),
        positiveInteger(this.#options.beforeBlocks, 8),
        positiveInteger(this.#options.afterBlocks, 24),
        0,
      ));
      // Do not poison the cache key with an aborted stale-revision request.
      // Otherwise the final confirmed refresh can see the same viewport key,
      // skip its root request, and leave the failed sparse window as raw
      // source until the user happens to scroll to a different bucket.
      if (effect === undefined) {
        this.#lastProjectionKey = "";
        this.#refreshAfterConfirmation = true;
        return;
      }
      this.#lastProjectionKey = key;
    }
    if (this.#disposed || epoch !== this.#epoch || revision !== this.#options.session.adapter.revision) {
      return;
    }

    // Root recovery must complete before computing detail. A single batch of
    // root + detail slices can only choose details from the *old* sparse root
    // cache, leaving newly loaded headings/images deferred forever.
    const rootSlices = uniqueProjectionSlices(segments.flatMap(segment => [
      ...(rootWindowChanged ? visibleRootSlices(this.#options.session, segment) : []),
      ...missingVisibleRootSlices(this.#options.session, segment,
        positiveInteger(this.#options.afterBlocks, 24) + positiveInteger(this.#options.beforeBlocks, 8)),
    ]).flatMap(slice => subtractFoldedBlocks(slice, folds)));
    if (rootSlices.length > 0) {
      this.#projectionRequests += 1;
      const effect = await tolerateStaleProjection(() => this.#options.session.project(rootSlices));
      if (effect === undefined) {
        this.#lastProjectionKey = "";
        this.#detailAttemptScope = "";
        this.#detailAttempts.clear();
        this.#refreshAfterConfirmation = true;
        return;
      }
    }
    if (this.#disposed || epoch !== this.#epoch || revision !== this.#options.session.adapter.revision) return;

    const currentVisible = visibleSourceWindow(view);
    if (`${livePreviewProjectionKey(currentVisible)}:${this.#options.headingFolds?.epoch ?? 0}` !== key) {
      // The user scrolled while roots were in flight. The next refresh will
      // fetch the new root window instead of spending this one on stale detail.
      this.#schedule(true);
      return;
    }
    const scope = `${revision}:${livePreviewDetailProjectionKey(currentVisible)}`;
    if (scope !== this.#detailAttemptScope) {
      this.#detailAttemptScope = scope;
      this.#detailAttempts.clear();
    }
    const limit = positiveInteger(this.#options.maxDetailedBlocks, 48);
    const nextDetails = () => uniqueProjectionSlices(visibleSegments(currentVisible, folds).flatMap(segment => visibleDetailSlices(
      this.#options.session, segment, limit, view.state.selection.main.head,
      screenSourceWindow(view), this.#detailAttempts,
    )).flatMap(slice => subtractFoldedBlocks(slice, folds))).slice(0, limit);
    // Keep each protocol request and each refresh bounded. The attempted set
    // also makes an unsupported or non-hydrating node a one-shot attempt for
    // this confirmed viewport instead of an endless Worker/repaint loop.
    for (let batch = 0; batch < 4; batch += 1) {
      const slices = nextDetails();
      if (slices.length === 0) return;
      for (const slice of slices) this.#detailAttempts.add(detailSliceKey(slice));
      this.#projectionRequests += 1;
      const effect = await tolerateStaleProjection(() => this.#options.session.project(slices));
      if (effect === undefined) {
        this.#lastProjectionKey = "";
        this.#detailAttemptScope = "";
        this.#detailAttempts.clear();
        this.#refreshAfterConfirmation = true;
        return;
      }
      if (this.#disposed || epoch !== this.#epoch || revision !== this.#options.session.adapter.revision) return;
    }
    if (nextDetails().length > 0) {
      // More eligible roots remain after this bounded turn. Continue through
      // the normal coalescing scheduler without requiring another edit/scroll.
      this.#schedule(true);
    }
  }

  #sourceIsConfirmed(): boolean {
    const revision = Number(this.#options.session.adapter.revision);
    if (this.#confirmationSourceVersion !== this.#sourceVersion || this.#confirmationRevision !== revision) {
      this.#sourceConfirmed = this.#source === this.#options.session.adapter.text.text;
      this.#confirmationSourceVersion = this.#sourceVersion;
      this.#confirmationRevision = revision;
    }
    return this.#sourceConfirmed;
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("Live Preview controller disposed");
  }

  #applyLayoutMetrics(view: EditorView): void {
    applyPreTextStyleMetrics(view.contentDOM, this.#options.pretext?.metrics);
  }
}

function quoteBodyIndent(line: QuoteLine, position: number): string {
  // A compact prefix needs a separator before the tab, otherwise Rust would
  // consume the tab as prefix padding instead of body indentation.
  return position === line.prefixTo && line.prefix.endsWith(">") ? " \t" : "\t";
}

/** Check an empty quote body without copying a potentially very long line. */
function isWhitespaceRange(doc: Text, from: number, to: number): boolean {
  for (let position = from; position < to; position += 256) {
    if (/[^ \t]/u.test(doc.sliceString(position, Math.min(to, position + 256)))) return false;
  }
  return true;
}

function quoteOutdentRange(line: QuoteLine): { readonly from: number; readonly to: number } {
  // `>>>> text` keeps the final separator; `> > text` already has one on
  // the preceding prefix. All selection shapes share this same rule.
  const previousLength = line.previousPrefixTo - line.from;
  const preserveSeparator = previousLength > 0 && line.prefix[previousLength - 1] === ">" &&
    /[ \t]/u.test(line.prefix[line.prefix.length - 1] ?? "");
  return { from: line.previousPrefixTo, to: line.prefixTo - Number(preserveSeparator) };
}

/** Read only indentation, not a potentially enormous code/paragraph body. */
function removeIndentUnit(state: EditorState, from: number, to: number): ChangeSpec | undefined {
  let end = from;
  while (end < to) {
    const chunk = state.doc.sliceString(end, Math.min(to, end + 256));
    const count = /^[ \t]*/u.exec(chunk)?.[0].length ?? 0;
    end += count;
    if (count < chunk.length) break;
  }
  if (end === from) return undefined;
  const whitespace = state.doc.sliceString(from, end);
  const target = indentString(state, Math.max(0, countColumn(whitespace, state.tabSize) - getIndentUnit(state)));
  let keep = 0;
  while (keep < whitespace.length && keep < target.length && whitespace[keep] === target[keep]) keep++;
  return { from: from + keep, to: end, insert: target.slice(keep) };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function livePreviewContentWidth(view: EditorView): number {
  const viewport = Math.max(
    1,
    view.scrollDOM.clientWidth || Math.floor(view.dom.getBoundingClientRect().width),
  );
  const content = view.contentDOM;
  const styles = view.dom.ownerDocument.defaultView?.getComputedStyle(content);
  const padding = styles === undefined
    ? 0
    : cssPixels(styles.paddingInlineStart) + cssPixels(styles.paddingInlineEnd);
  const contentWidth = Math.floor(content.clientWidth - padding);
  return Math.max(1, Math.min(viewport, contentWidth > 0 ? contentWidth : viewport));
}

function livePreviewProjectionKey(range: { readonly from: number; readonly to: number }): string {
  return `${Math.floor(range.from / 2_048)}:${Math.floor(range.to / 2_048)}`;
}

function livePreviewDetailProjectionKey(range: { readonly from: number; readonly to: number }): string {
  return `${Math.floor(range.from / 512)}:${Math.floor(range.to / 512)}`;
}

function uniqueProjectionSlices(slices: readonly ProjectionSlice[]): readonly ProjectionSlice[] {
  const unique = new Map<string, ProjectionSlice>();
  for (const slice of slices) {
    const window = slice.window.type === "index"
      ? `index:${slice.window.from}:${slice.window.toExclusive}`
      : [
          "range",
          Number(slice.window.range.from),
          Number(slice.window.range.to),
          slice.window.before,
          slice.window.after,
        ].join(":");
    const key = `${slice.parentId}:${slice.axis}:${window}`;
    const current = unique.get(key);
    if (current === undefined || current.maxDepth < slice.maxDepth) unique.set(key, slice);
  }
  return [...unique.values()];
}

function confirmedTableSurfacePosition(
  session: EditorDocumentSession,
  nodes: readonly RenderNode[],
  source: string,
  offset: number,
): ReturnType<typeof tableSurfacePositionAt> {
  const position = tableSurfacePositionAt(source, offset);
  if (position === undefined) return undefined;
  const tableRange = position.kind === "cell" ? position.target.table : position.table;
  return confirmedTableRange(
    nodes,
    tableRange.from,
    tableRange.to,
  ) || confirmedTableRangeInProjection(session, tableRange.from, tableRange.to)
    ? position
    : undefined;
}

function confirmedTableRange(
  nodes: readonly RenderNode[],
  from: number,
  to: number,
): boolean {
  return nodes.some((node) => node.kind === "table" &&
    Number(node.sourceRange.from) === from &&
    Number(node.sourceRange.to) === to);
}

function confirmedTableRangeInProjection(
  session: EditorDocumentSession,
  from: number,
  to: number,
): boolean {
  const index = session.adapter.blocks.blockAt(from);
  if (index === undefined) return false;
  // blockAt includes zero-width seams, so check both immediate neighbors too.
  return session.adapter.projection.entries("0", "syntax-children", Math.max(0, index - 1), index + 2)
    .some(({ node }) => node.kind === "table" &&
      Number(node.sourceRange.from) === from && Number(node.sourceRange.to) === to);
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function transactionChanges(transaction: Transaction): readonly ProjectionEditChange[] {
  const changes: ProjectionEditChange[] = [];
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    // Policy ranges belong to the transaction's start document. Using the new
    // document coordinates here shifts every edit after the first change and can
    // make a protected pipe look like editable cell content.
    changes.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return changes;
}

function remapUnaffectedReplacementRanges<T extends { readonly from: number; readonly to: number }>(
  ranges: readonly T[],
  update: ViewUpdate,
): readonly T[] {
  const changed: Array<{ readonly from: number; readonly to: number }> = [];
  update.changes.iterChangedRanges((fromA, toA) => {
    changed.push({ from: fromA, to: toA });
  });
  return ranges.flatMap((range) => {
    if (changed.some((change) => touchesOriginalChange(range, change))) return [];
    const from = update.changes.mapPos(range.from, 1);
    const to = update.changes.mapPos(range.to, -1);
    return to > from ? [{ ...range, from, to }] : [];
  });
}

function remapRange(
  range: { readonly from: number; readonly to: number } | undefined,
  update: ViewUpdate,
): { readonly from: number; readonly to: number } | undefined {
  if (range === undefined) return undefined;
  // optimistic table cell is an enclosing editable range. Map its endpoints
  // outward so repeated inserts at either edge remain inside the same cell:
  // `A` at 10..11 + insert `X` at 10 must become 10..12, not 11..12.
  const from = update.changes.mapPos(range.from, -1);
  const to = update.changes.mapPos(range.to, 1);
  return to < from ? undefined : { from, to };
}

function touchesOriginalChange(
  range: { readonly from: number; readonly to: number },
  change: { readonly from: number; readonly to: number },
): boolean {
  // Insertion at either replacement boundary can alter the semantic block
  // selected by the widget, so drop that widget from the controller's atomic
  // reveal index as well. The StateField will independently retain or remove
  // its actual decoration according to CodeMirror's mapping rules.
  if (change.from === change.to) {
    return range.from <= change.from && change.from <= range.to;
  }
  return range.from < change.to && change.from < range.to;
}

function isTableInputUpdate(update: ViewUpdate): boolean {
  return update.transactions.some((transaction) =>
    transaction.annotation(Transaction.userEvent)?.startsWith("input.table.") === true);
}

function tableInputData(event: InputEvent): string | undefined {
  if (event.inputType === "insertFromPaste") {
    return event.dataTransfer?.getData("text/plain") ?? event.data ?? undefined;
  }
  return event.data ?? undefined;
}

function normalizeTableInputType(inputType: string): string | undefined {
  switch (inputType) {
    case "insertText":
    case "insertFromPaste":
    case "deleteContentBackward":
    case "deleteContentForward":
    case "deleteByCut":
    case "deleteByDrag":
      return inputType;
    case "insertReplacementText":
    case "insertFromComposition":
      return "insertText";
    default:
      return undefined;
  }
}

function usesNativeBeforeInput(event: KeyboardEvent): boolean {
  if (
    event.key === "Dead" || event.key === "Process" ||
    event.key === "Unidentified"
  ) {
    return true;
  }
  return event.key.length === 1 && (
    (!event.ctrlKey && !event.metaKey) ||
    event.getModifierState("AltGraph")
  );
}

function interactionDirection(
  command: TableInteractionCommandId,
): "left" | "right" | "next" | "previous" | "up" | "down" | undefined {
  switch (command) {
    case TABLE_INTERACTION_COMMAND.focusLeft: return "left";
    case TABLE_INTERACTION_COMMAND.focusRight: return "right";
    case TABLE_INTERACTION_COMMAND.focusPrevious: return "previous";
    case TABLE_INTERACTION_COMMAND.focusNext: return "next";
    case TABLE_INTERACTION_COMMAND.focusAbove: return "up";
    case TABLE_INTERACTION_COMMAND.focusBelow:
    case TABLE_INTERACTION_COMMAND.beginEdit: return "down";
    default: return undefined;
  }
}

function emptySnapshot(revision: Revision): LivePreviewSnapshot {
  return {
    enabled: false,
    revision,
    planDurationMs: 0,
    visibleBlocks: 0,
    projectedNodes: 0,
    decorationCount: 0,
    widgetCount: 0,
    activeBlocks: 0,
    fallbackBlocks: 0,
    truncated: false,
    projectionRequests: 0,
  };
}
