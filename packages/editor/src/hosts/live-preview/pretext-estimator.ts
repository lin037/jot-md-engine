import { resolveSurfaceImageMetadata } from "../../components/common/render-utils.js";
import type {
  RenderNode,
  TextRange,
  Utf16Offset,
} from "@jot-md/editor-protocol";
import type { EditorView } from "@codemirror/view";
import type { EditorDocumentSession, IndexedBlock, Utf16TextModel } from "../../adapter/index.js";
import {
  mergePreTextStyleMetrics,
  PreTextProjectionFilter,
} from "../../layout/pretext/filter.js";
import { resolveTableLayoutOptions } from "../../components/table/layout.js";
import { PreTextTextLayout } from "../../layout/pretext/text-layout.js";
import { DEFAULT_QUOTE_MIN_CONTENT_WIDTH } from "../../layout/quote-geometry.js";
import { DEFAULT_LIST_MIN_CONTENT_WIDTH } from "../../layout/list-geometry.js";
import { safeUtf16Offset, safeUtf16SliceEnd } from "../../components/common/render-utils.js";
import type {
  LivePreviewGeometryGap,
  LivePreviewOptions,
  LivePreviewSelectionRange,
} from "./types.js";

interface LivePreviewTextStyle {
  readonly font: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
}

/**
 * 将现有 PreText 估算器收敛为 CodeMirror block widget 的初始高度入口。
 *
 * 返回值是 widget 的 border-box 初始高度；段间 gap 由 widget 自己的内层
 * padding 承担，不能使用 block widget 的纵向 margin。
 */
export class LivePreviewPreTextEstimator {
  readonly #session: EditorDocumentSession;
  #options: LivePreviewOptions;
  readonly #filter: PreTextProjectionFilter;
  #layout: PreTextTextLayout | undefined;
  #availableWidth = 1;
  #style: LivePreviewTextStyle | undefined;
  readonly #geometryCache = new Map<string, {
    readonly key: string;
    readonly block: GeometryBlock;
  }>();
  #geometryVersion = -1;
  #geometryBlocks: readonly IndexedBlock[] = [];

  constructor(session: EditorDocumentSession, options: LivePreviewOptions) {
    this.#session = session;
    this.#options = options;
    this.#filter = new PreTextProjectionFilter(options.pretext);
  }

  attach(view: EditorView): void {
    this.#layout = new PreTextTextLayout({
      document: view.dom.ownerDocument,
      fallbackCharacterWidth: this.#options.pretext?.averageCharacterWidth ?? 8,
    });
  }

  resize(width: number): void {
    this.#availableWidth = Math.max(1, width);
    this.#geometryCache.clear();
  }

  invalidateLayout(options: LivePreviewOptions = this.#options): void {
    this.#options = options;
    this.#layout?.clear();
    this.#style = undefined;
    this.#geometryCache.clear();
  }

  estimate(node: RenderNode, view: EditorView): number | undefined {
    const item = this.#estimateItems([node], view, true)[0];
    if (item === undefined) return undefined;
    // Preview Surface 的 block gap 原本由相邻根项各自 margin 平分。CodeMirror
    // block widget 不允许纵向 margin，因此把完整 gap 放进当前 widget 的尾部
    // padding；这使 estimatedHeight 与最终 block geometry 使用同一个口径。
    return item.boxHeight + item.blockGap;
  }

  /**
   * 只为真正会被 block widget 替换的附近节点建立离屏高度占位。
   *
   * 普通 paragraph/heading/list/quote/code 仍是 CodeMirror 的真实物理行，
   * 已经天然贡献 scrollHeight，绝不能再用透明 block replacement 覆盖它们。
   * Table/math/thematic 等不透明组件只在当前窗口附近预估；远处保留源码行高，
   * 避免一次大粘贴同步测量整篇 SyntaxBlockIndex。
   */
  geometry(
    view: EditorView,
    visible: LivePreviewSelectionRange,
    measuredHeight?: (block: GeometryBlock) => number | undefined,
  ): readonly LivePreviewGeometryGap[] {
    const { text, blocks: index } = this.#session.adapter;
    if (this.#geometryVersion !== index.version) {
      this.#geometryBlocks = index.blocks.filter((block) => isBlockWidgetKind(block.kind));
      this.#geometryVersion = index.version;
    }
    const style = this.#textStyle(view);
    const metrics = mergePreTextStyleMetrics(this.#options.pretext?.metrics, style.fontSize);
    const layoutKey = [
      Math.round(this.#availableWidth),
      style.font,
      style.lineHeight,
      style.letterSpacing,
      this.#options.pretext?.typographyVersion ?? "default",
      geometryMetricsKey(metrics),
    ].join(":");
    const maximum = Math.min(
      positiveInteger(this.#options.maxGeometryDecorations, 1_024),
      256,
    );
    const candidates = nearestGeometryCandidates(this.#geometryBlocks, visible, maximum);
    const geometry: GeometryBlock[] = [];
    const misses: Array<{
      readonly id: string;
      readonly key: string;
      readonly node: RenderNode;
    }> = [];
    for (const block of candidates) {
      const key = [
        layoutKey,
        block.id,
        block.kind,
        block.contentVersion,
        Number(block.sourceRange.from),
        Number(block.sourceRange.to),
        // Optimistic text edits can preserve id/contentVersion until Rust
        // confirms a new tree. Dirty entries must therefore re-estimate for
        // the current text revision, while clean blocks retain their cached
        // PreText result across local edits elsewhere in the document.
        block.dirty ? String(this.#session.adapter.revision) : "clean",
      ].join(":");
      const cached = this.#geometryCache.get(block.id);
      if (cached?.key === key) {
        geometry.push(cached.block);
        continue;
      }
      misses.push({ id: block.id, key, node: geometryNode(block, text) });
    }
    if (misses.length > 0) {
      const items = this.#estimateItems(misses.map((miss) => miss.node), view, false);
      for (let index = 0; index < misses.length; index += 1) {
        const miss = misses[index]!;
        const item = items[index];
        if (item === undefined) continue;
        const block: GeometryBlock = {
          id: item.nodeId,
          kind: item.kind,
          sourceRange: item.sourceRange,
          contentVersion: item.contentVersion,
          // BlankLine remains a physical CodeMirror line rather than a padded
          // block widget. Its geometry therefore uses the box itself; all
          // replacement widgets include their own trailing block gap.
          estimatedHeight: item.kind === "blank-line"
            ? item.boxHeight
            // Geometry chunks are transparent HeightMap placeholders. Unlike
            // a real Preview widget they do not render the tail padding and
            // boundary themselves, so keep the full PreText outer estimate
            // here. This makes one logical root block contribute its gap
            // exactly once as chunks are replaced by real widgets.
            : item.estimatedHeight,
        };
        this.#geometryCache.set(miss.id, { key: miss.key, block });
        geometry.push(block);
      }
    }
    this.#trimGeometryCache(candidates.map((block) => block.id));
    return geometry
      .sort((left, right) => Number(left.sourceRange.from) - Number(right.sourceRange.from))
      .map((block) => ({
        id: `pretext-gap:${block.id}`,
        from: Number(block.sourceRange.from),
        to: Number(block.sourceRange.to),
        estimatedHeight: measuredHeight?.(block) ?? block.estimatedHeight,
      }));
  }

  dispose(): void {
    this.#layout?.clear();
    this.#layout = undefined;
    this.#style = undefined;
    this.#geometryCache.clear();
    this.#geometryVersion = -1;
    this.#geometryBlocks = [];
  }

  #textStyle(view: EditorView): LivePreviewTextStyle {
    const cached = this.#style;
    if (cached !== undefined) return cached;
    const computed = view.dom.ownerDocument.defaultView?.getComputedStyle(view.contentDOM);
    const style = {
      font: computed?.font || "14px sans-serif",
      fontSize: cssNumber(computed?.fontSize, 14),
      lineHeight: cssNumber(computed?.lineHeight, 24),
      letterSpacing: cssNumber(computed?.letterSpacing, 0),
    };
    this.#style = style;
    return style;
  }

  #estimateItems(
    nodes: readonly RenderNode[],
    view: EditorView,
    includeFullSource: boolean,
  ) {
    const source = this.#session.adapter.text.text;
    const maximum = positiveInteger(this.#options.pretext?.maxSourcePreviewUtf16, 2_048);
    const style = this.#textStyle(view);
    return this.#filter.filter({
      revision: this.#session.adapter.revision,
      viewRevision: this.#session.adapter.viewRevision,
      items: nodes,
      layout: {
        availableWidth: this.#availableWidth,
        lineHeight: style.lineHeight,
        averageCharacterWidth: this.#options.pretext?.averageCharacterWidth ?? 8,
        tabSize: positiveInteger(this.#options.pretext?.tabSize, 4),
        widthBucketSize: this.#options.pretext?.widthBucketSize ?? 32,
        typographyVersion: this.#options.pretext?.typographyVersion ?? "default",
        wrap: true,
      },
      context: {
        sourceStats: (range) => sourceStats(this.#session.adapter.text, range, maximum),
        ...(includeFullSource
          ? { sourceText: (range: TextRange) => source.slice(Number(range.from), Number(range.to)) }
          : {}),
        metrics: mergePreTextStyleMetrics(this.#options.pretext?.metrics, style.fontSize),
        codeBlockWrap: view.contentDOM.dataset["jotCodeWrap"] === "wrap",
        ...(this.#layout === undefined
          ? {}
          : { textLayout: this.#layout }),
        textStyle: {
          font: style.font,
          whiteSpace: "pre-wrap",
          letterSpacing: style.letterSpacing,
        },
        resolveImageMetadata: (source) => resolveSurfaceImageMetadata(this.#options.resolveImageMetadata, source, view.dom.ownerDocument),
        tableLayout: resolveTableLayoutOptions(this.#options),
        tableHasToolbar: this.#options.onTableCommand !== undefined,
      },
    }).items;
  }

  #trimGeometryCache(currentIds: readonly string[]): void {
    const maximum = Math.max(512, currentIds.length * 2);
    if (this.#geometryCache.size <= maximum) return;
    const current = new Set(currentIds);
    for (const id of this.#geometryCache.keys()) {
      if (!current.has(id)) this.#geometryCache.delete(id);
    }
    while (this.#geometryCache.size > maximum) {
      const oldest = this.#geometryCache.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#geometryCache.delete(oldest);
    }
  }
}

interface GeometryBlock {
  readonly id: string;
  readonly kind: string;
  readonly sourceRange: TextRange;
  readonly contentVersion: number;
  readonly estimatedHeight: number;
}

function sourceStats(text: Utf16TextModel, range: TextRange, maximum: number): {
  readonly preview: string;
  readonly utf16Length: number;
  readonly lineCount: number;
} {
  const source = text.text;
  const from = Math.max(0, Math.min(source.length, Number(range.from)));
  const to = Math.max(from, Math.min(source.length, Number(range.to)));
  const previewEnd = safeUtf16SliceEnd(source, Math.min(to, from + maximum), to);
  return {
    preview: source.slice(from, previewEnd),
    utf16Length: to - from,
    lineCount: physicalLineCount(text, from, to),
  };
}

function cssNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nearestGeometryCandidates<T extends {
  readonly kind: string;
  readonly sourceRange: TextRange;
}>(
  blocks: readonly T[],
  visible: LivePreviewSelectionRange,
  maximum: number,
): readonly T[] {
  if (maximum <= 0) return [];
  // `blocks` is the cached source-ordered index of opaque widget roots.
  // Search both seams instead of visiting every root on each scroll.
  let lower = 0;
  let upper = blocks.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (Number(blocks[middle]!.sourceRange.to) < visible.from) lower = middle + 1;
    else upper = middle;
  }
  const beforeEnd = lower;
  lower = 0;
  upper = blocks.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (Number(blocks[middle]!.sourceRange.from) <= visible.to) lower = middle + 1;
    else upper = middle;
  }
  const afterStart = lower;
  const afterCount = blocks.length - afterStart;
  const beforeBudget = Math.min(beforeEnd, Math.floor(maximum / 2));
  const afterBudget = Math.min(afterCount, maximum - beforeBudget);
  const spare = maximum - beforeBudget - afterBudget;
  const extraBefore = Math.min(beforeEnd - beforeBudget, spare);
  const extraAfter = Math.min(afterCount - afterBudget, spare - extraBefore);
  return [
    ...blocks.slice(beforeEnd - beforeBudget - extraBefore, beforeEnd),
    ...blocks.slice(afterStart, afterStart + afterBudget + extraAfter),
  ];
}

function isBlockWidgetKind(kind: string): boolean {
  return ["math-block", "table", "thematic-break"].includes(kind);
}

function geometryNode(
  block: {
    readonly id: string;
    readonly kind: string;
    readonly sourceRange: TextRange;
    readonly contentVersion: number;
    readonly dirty?: boolean;
  },
  text: Utf16TextModel,
): RenderNode {
  return {
    id: block.id,
    kind: block.kind,
    sourceRange: block.sourceRange,
    contentVersion: block.contentVersion,
    mode: "preview",
    childCount: geometryChildCount(block.kind, text, block.sourceRange),
    attributes: [],
    content: { type: "source" },
  };
}

function geometryChildCount(kind: string, text: Utf16TextModel, range: TextRange): number {
  switch (kind) {
    case "table":
    case "block-quote":
      return Math.max(1, physicalLineCount(text, Number(range.from), Number(range.to)));
    default:
      return 0;
  }
}

function physicalLineCount(text: Utf16TextModel, from: number, to: number): number {
  // Dirty metadata can temporarily outlive a large deletion. Geometry is only
  // an estimate; clamp its endpoints before using the strict source index.
  const start = safeUtf16Offset(text.text, from);
  const end = Math.max(start, safeUtf16Offset(text.text, to));
  if (end <= start) return 0;
  // lineAt(to) includes a trailing LF, preserving the existing estimate at
  // half-open block boundaries without rescanning a multi-megabyte container.
  return text.lineAt(end as Utf16Offset) - text.lineAt(start as Utf16Offset) + 1;
}

function geometryMetricsKey(metrics: ReturnType<typeof mergePreTextStyleMetrics>): string {
  return [
    metrics.blockGap,
    metrics.boundaryWidth,
    metrics.paragraphLineHeight,
    metrics.paragraphPaddingX,
    ...metrics.headingLineHeights,
    metrics.quotePaddingY,
    metrics.quotePaddingX,
    metrics.quoteMinContentWidth ?? DEFAULT_QUOTE_MIN_CONTENT_WIDTH,
    metrics.listIndent,
    metrics.listMinContentWidth ?? DEFAULT_LIST_MIN_CONTENT_WIDTH,
    metrics.codeLineHeight,
    metrics.codePaddingY,
    metrics.tableHeaderHeight,
    metrics.tableRowHeight,
    metrics.tableToolbarHeight,
    metrics.tableFrame,
    metrics.mathLineHeight,
    metrics.mathPaddingY,
    metrics.imageFallbackHeight,
    metrics.imageMaxHeight,
    metrics.thematicHeight,
    metrics.blankLineHeight,
  ].join(",");
}
