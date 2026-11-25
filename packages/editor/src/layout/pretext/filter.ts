import type {
  RenderNode,
  TextRange,
} from "@jot-md/editor-protocol";
import {
  bucketWidth,
  type ProjectionFilter,
  type ProjectionFilterInput,
  type ProjectionFilterResult,
  type SurfaceItem,
} from "../../core/projection/projection-filter.js";
import {
  booleanAttribute,
  imageAspectRatioFromMetadata,
  imageDimensionsFromMetadata,
  numberAttribute,
  rangeAttribute,
  stringAttribute,
  stringsAttribute,
  type ImageMetadataResolver,
} from "../../components/common/dom-renderer.js";
import { formatPhrase } from "../../core/phrases.js";
import { defaultMarkdownComponentRegistry } from "../../components/registry.js";
import { quotePrefix } from "../../components/common/quote-prefix.js";
import { DEFAULT_QUOTE_MIN_CONTENT_WIDTH, quoteContentWidth } from "../quote-geometry.js";
import { DEFAULT_LIST_MIN_CONTENT_WIDTH, listDisplayIndentColumns } from "../list-geometry.js";
import {
  type TableLayoutOptions,
} from "../../components/table/layout.js";
import type { TablePreTextContext, TablePreTextEstimate } from "../../components/table/pretext.js";
import type { PreTextTextLayout, PreTextTextStyle } from "./text-layout.js";

export interface PreTextStyleMetrics {
  readonly blockGap: number;
  readonly boundaryWidth: number;
  readonly paragraphLineHeight: number;
  readonly paragraphPaddingX: number;
  readonly headingLineHeights: readonly [number, number, number, number, number, number];
  readonly quotePaddingY: number;
  readonly quotePaddingX: number;
  /** Preserve a usable text column when quotes are deeply nested. */
  readonly quoteMinContentWidth?: number;
  readonly listIndent: number;
  /** Preserve a usable text column when list indentation is very deep. */
  readonly listMinContentWidth?: number;
  readonly codeLineHeight: number;
  readonly codePaddingY: number;
  readonly tableHeaderHeight: number;
  readonly tableRowHeight: number;
  /** 表格工具条存在时的外部高度；没有 command port 时不计入。 */
  readonly tableToolbarHeight: number;
  readonly tableFrame: number;
  readonly mathLineHeight: number;
  readonly mathPaddingY: number;
  readonly imageFallbackHeight: number;
  readonly imageMaxHeight: number;
  readonly thematicHeight: number;
  readonly blankLineHeight: number;
}

export const DEFAULT_PRETEXT_STYLE_METRICS: PreTextStyleMetrics = {
  blockGap: 0,
  boundaryWidth: 0,
  paragraphLineHeight: 22,
  paragraphPaddingX: 0,
  headingLineHeights: [30, 28, 26, 24, 22, 22],
  quotePaddingY: 6,
  quotePaddingX: 12,
  quoteMinContentWidth: DEFAULT_QUOTE_MIN_CONTENT_WIDTH,
  listIndent: 22,
  listMinContentWidth: DEFAULT_LIST_MIN_CONTENT_WIDTH,
  codeLineHeight: 20,
  codePaddingY: 16,
  tableHeaderHeight: 34,
  tableRowHeight: 32,
  tableToolbarHeight: 28,
  tableFrame: 2,
  mathLineHeight: 28,
  mathPaddingY: 16,
  imageFallbackHeight: 220,
  imageMaxHeight: 480,
  thematicHeight: 22,
  blankLineHeight: 22,
};

export interface PreTextSourceStats {
  readonly preview: string;
  /** 完整源码范围长度；`preview` 只是有界前缀，二者不能混用。 */
  readonly utf16Length: number;
  readonly lineCount: number;
}

export interface PreTextProjectionContext {
  readonly sourceStats: (range: TextRange) => PreTextSourceStats;
  /** 完整源码读取；`sourceStats.preview` 仅用于诊断和无运行时布局器时的回退。 */
  readonly sourceText?: (range: TextRange) => string;
  readonly metrics: PreTextStyleMetrics;
  /** Code lines may be soft-wrapped independently of ordinary paragraphs. */
  readonly codeBlockWrap?: boolean;
  /** PreText 的 prepare/layout 核心，不读取 DOM。 */
  readonly textLayout?: PreTextTextLayout;
  readonly textStyle?: PreTextTextStyle;
  /** 大表格估算时使用的有界代表性行数。 */
  readonly tableSampleRows?: number;
  /** Preview 与 PreText 共用的表格列宽策略。 */
  readonly tableLayout?: Pick<
    TableLayoutOptions,
    "mode" | "fillRatio" | "minColumnWidth" | "maxColumnWidth" | "estimatedColumnWidth"
  >;
  /** Preview/Live Preview 是否会为 table 挂载统一 command 工具条。 */
  readonly tableHasToolbar?: boolean;
  /** 图片尚未加载且宿主未提供尺寸时，使用 imageFallbackHeight 占位。 */
  readonly resolveImageMetadata?: ImageMetadataResolver;
}

export interface PreTextEstimateEvidence {
  readonly strategy: string;
  /** 实际使用的布局路径；prepared 表示走了 PreText prepare/layout。 */
  readonly textLayout?: "prepared" | "heuristic" | "table-sampled";
  readonly sourceLines: number;
  readonly visualLines: number;
  /** First confirmed quote line's depth, used as a bounded layout hint. */
  readonly quoteDepth?: number;
  /** 语义源码投影保留的段首空格/Tab 列数。 */
  readonly leadingWhitespaceColumns?: number;
  /** 参与宽度估算的行内公式数量。 */
  readonly inlineMathCount?: number;
  readonly rows?: number;
  readonly columns?: number;
  readonly sampledRows?: number;
  readonly aspectRatio?: number;
}

export interface PreTextSurfaceItem extends SurfaceItem {
  readonly node: RenderNode;
  readonly nodeId: string;
  readonly component: string;
  readonly label: string;
  /** 语义 Preview 节点实际渲染的文本；为诊断用途设置长度上限。 */
  readonly contentText: string;
  readonly sourcePreview: string;
  readonly sourcePreviewTruncated: boolean;
  /** border-box 高度；`estimatedHeight` 还会包含 blockGap。 */
  readonly boxHeight: number;
  readonly blockGap: number;
  readonly evidence: PreTextEstimateEvidence;
}

export interface PreTextProjectionFilterOptions {
  readonly minimumHeight?: number;
  readonly tableSampleRows?: number;
}

/**
 * 语义预布局。Rust 持有节点类型和源码范围；这个纯前端过滤器持有依赖浏览器
 * 环境的盒子估算。
 */
export class PreTextProjectionFilter
  implements ProjectionFilter<RenderNode, PreTextSurfaceItem, PreTextProjectionContext>
{
  readonly #minimumHeight: number;
  readonly #tableSampleRows: number;

  constructor(options: PreTextProjectionFilterOptions = {}) {
    this.#minimumHeight = positive(options.minimumHeight, 12);
    this.#tableSampleRows = positiveInteger(options.tableSampleRows, 24);
  }

  filter(
    input: ProjectionFilterInput<RenderNode, PreTextProjectionContext>,
  ): ProjectionFilterResult<PreTextSurfaceItem> {
    return {
      revision: input.revision,
      viewRevision: input.viewRevision,
      items: input.items.map((node) => {
        const context = input.context.tableSampleRows === undefined
          ? { ...input.context, tableSampleRows: this.#tableSampleRows }
          : input.context;
        const stats = context.sourceStats(node.sourceRange);
        // Code can contain a single multi-megabyte line. A bounded sample is
        // sufficient for its layout estimate; never segment the entire block
        // into graphemes just to prepare a scrollbar prediction.
        const semantic = node.kind === "fenced-code"
          ? context.sourceStats(rangeAttribute(node, "contentRange") ?? node.sourceRange).preview
          : semanticText(node, context);
        const contentText = boundedText(semantic);
        const estimate = estimateNode(
          node,
          stats,
          { ...input, context },
          stats,
          semantic,
        );
        const boxHeight = Math.max(
          this.#minimumHeight,
          estimate.height + input.context.metrics.boundaryWidth,
        );
        const width = bucketWidth(
          input.layout.availableWidth,
          input.layout.widthBucketSize,
        );
        return {
          key: semanticShellKey(node),
          kind: node.kind,
          component: componentFamily(node.kind, estimate.evidence.strategy),
          node,
          nodeId: node.id,
          sourceRange: node.sourceRange,
          contentVersion: node.contentVersion,
          layoutKey: [
            "pretext",
            semanticShellKey(node),
            node.contentVersion,
            contentShapeKey(node),
            width,
            input.layout.typographyVersion,
            input.context.codeBlockWrap === true ? "code-wrap" : "code-scroll",
            metricsKey(input.context.metrics),
          ].join(":"),
          estimatedHeight: boxHeight + input.context.metrics.blockGap,
          boxHeight,
          blockGap: input.context.metrics.blockGap,
          label: preTextLabel(node),
          contentText,
          sourcePreview: collapsePreview(stats.preview),
          sourcePreviewTruncated: stats.preview.length < stats.utf16Length,
          evidence: estimate.evidence,
        };
      }),
    };
  }
}

export function mergePreTextStyleMetrics(
  overrides: Partial<PreTextStyleMetrics> | undefined,
  fontSize = 14,
): PreTextStyleMetrics {
  // Defaults describe the 14px component typography. Derive font-dependent
  // geometry once per layout so the estimate and rendered CSS use identical
  // values at other font sizes. Explicit metrics remain absolute pixels.
  const scale = Number.isFinite(fontSize) && fontSize > 0 ? fontSize / 14 : 1;
  const base = DEFAULT_PRETEXT_STYLE_METRICS;
  const headingLineHeights: PreTextStyleMetrics["headingLineHeights"] = [
    base.headingLineHeights[0] * scale, base.headingLineHeights[1] * scale,
    base.headingLineHeights[2] * scale, base.headingLineHeights[3] * scale,
    base.headingLineHeights[4] * scale, base.headingLineHeights[5] * scale,
  ];
  return {
    ...base,
    paragraphLineHeight: base.paragraphLineHeight * scale,
    listIndent: base.listIndent * scale,
    codeLineHeight: base.codeLineHeight * scale,
    tableHeaderHeight: base.tableHeaderHeight * scale,
    tableRowHeight: base.tableRowHeight * scale,
    mathLineHeight: base.mathLineHeight * scale,
    thematicHeight: base.thematicHeight * scale,
    blankLineHeight: base.blankLineHeight * scale,
    ...overrides,
    headingLineHeights: overrides?.headingLineHeights ?? headingLineHeights,
  };
}

interface Estimate {
  readonly height: number;
  readonly evidence: PreTextEstimateEvidence;
}

function estimateNode(
  node: RenderNode,
  stats: PreTextSourceStats,
  input: ProjectionFilterInput<RenderNode, PreTextProjectionContext>,
  sourceStats: PreTextSourceStats = stats,
  semanticPreview = stats.preview,
): Estimate {
  const metrics = input.context.metrics;
  const availableWidth = Math.max(1, input.layout.availableWidth);
  const paragraphWidth = Math.max(
    1,
    availableWidth - metrics.paragraphPaddingX * 2,
  );
  const inlineMathCount = countDescendants(node, "inline-math");
  const textLayout = inlineMathCount === 0 ? input.context.textLayout : undefined;
  const semanticLength = input.context.sourceText === undefined
    ? stats.utf16Length
    : semanticPreview.length;
  const visualLines = estimateVisualLines(
    semanticPreview,
    semanticLength,
    node.kind === "paragraph" ? paragraphWidth : availableWidth,
    input.layout.averageCharacterWidth,
    input.layout.tabSize,
    textLayout === undefined
      ? semanticVisualColumns(node, input.context, input.layout.tabSize)
      : undefined,
    stats.lineCount,
    textLayout,
    input.context.textStyle,
  );
  const preparedLayout = textLayout !== undefined && input.context.textStyle !== undefined;
  const baseEvidence = {
    sourceLines: stats.lineCount,
    visualLines,
    ...(preparedLayout ? { textLayout: "prepared" as const } : { textLayout: "heuristic" as const }),
    leadingWhitespaceColumns: leadingWhitespaceColumns(
      sourceStats.preview,
      input.layout.tabSize,
    ),
    ...(inlineMathCount === 0 ? {} : { inlineMathCount }),
  };

  switch (node.kind) {
    case "blank-line":
      return fixed(metrics.blankLineHeight, "blank-line", baseEvidence);
    case "heading": {
      const level = Math.max(1, Math.min(6, numberAttribute(node, "level") ?? 1));
      return {
        height: visualLines * metrics.headingLineHeights[level - 1]!,
        evidence: { ...baseEvidence, strategy: `heading-${level}` },
      };
    }
    case "paragraph": {
      const images = countDescendants(node, "image");
      if (images > 0) {
        // Images occupy a full-width visual row. Count every image and the
        // text runs between them; max(text, firstImage) under-reserved mixed
        // paragraphs and made their virtual geometry change on every visit.
        let height = 0;
        let text = "";
        let aspectRatio = availableWidth / metrics.imageFallbackHeight;
        const flushText = () => {
          const value = text.trim();
          text = "";
          if (value === "") return;
          height += estimateVisualLines(value, value.length, paragraphWidth,
            input.layout.averageCharacterWidth, input.layout.tabSize, undefined,
            value.split("\n").length, textLayout, input.context.textStyle) * metrics.paragraphLineHeight;
        };
        const visit = (child: RenderNode): void => {
          if (child.kind === "image") {
            flushText();
            const image = estimateImage(input.context, child, availableWidth);
            aspectRatio = image.aspectRatio;
            height += image.height;
          } else if (child.content.type === "structured") {
            child.content.children.forEach(visit);
          } else {
            text += semanticText(child, input.context);
          }
        };
        if (node.content.type === "structured") node.content.children.forEach(visit);
        flushText();
        return {
          height,
          evidence: { ...baseEvidence, strategy: "paragraph-with-image", aspectRatio },
        };
      }
      return textBlock(
        visualLines * metrics.paragraphLineHeight,
        "paragraph-wrap",
        baseEvidence,
      );
    }
    case "block-quote": {
      // This is a bounded sizing hint for the first physical line of a
      // confirmed quote, not a semantic parser or a scan of the full block.
      const quoteDepth = quotePrefix(stats.preview, 0, Number.POSITIVE_INFINITY)?.depth ?? 1;
      const quoteWidth = quoteContentWidth(availableWidth, metrics.quotePaddingX,
        metrics.quoteMinContentWidth ?? DEFAULT_QUOTE_MIN_CONTENT_WIDTH, quoteDepth);
      const quoteLines = estimateVisualLines(
        semanticPreview,
        semanticLength,
        quoteWidth,
        input.layout.averageCharacterWidth,
        input.layout.tabSize,
        textLayout === undefined
          ? semanticVisualColumns(node, input.context, input.layout.tabSize)
          : undefined,
        stats.lineCount,
        textLayout,
        input.context.textStyle,
      );
      return textBlock(
        quoteLines * metrics.paragraphLineHeight + metrics.quotePaddingY * 2,
        "blockquote-wrap",
        { ...baseEvidence, visualLines: quoteLines, quoteDepth },
      );
    }
    case "list-item": {
      // Live Preview reserves an expanding marker column for ordered lists.
      // Keep the offscreen estimate close to it and to the documented 48ch
      // display cap; the measured visible line remains authoritative.
      const indent = listDisplayIndentColumns(numberAttribute(node, "indentColumns") ?? 0);
      const number = numberAttribute(node, "number");
      const markerWidth = number === undefined ? metrics.listIndent : Math.max(
        metrics.listIndent,
        (String(number).length + 2) * input.layout.averageCharacterWidth,
      );
      const minimum = Math.max(0, metrics.listMinContentWidth ?? DEFAULT_LIST_MIN_CONTENT_WIDTH);
      const visibleIndent = Math.min(indent * input.layout.averageCharacterWidth,
        Math.max(0, availableWidth - markerWidth - minimum));
      const listWidth = Math.max(1, availableWidth - markerWidth - visibleIndent);
      const listLines = estimateVisualLines(
        semanticPreview,
        semanticLength,
        listWidth,
        input.layout.averageCharacterWidth,
        input.layout.tabSize,
        textLayout === undefined
          ? semanticVisualColumns(node, input.context, input.layout.tabSize)
          : undefined,
        stats.lineCount,
        textLayout,
        input.context.textStyle,
      );
      return {
        height: listLines * metrics.paragraphLineHeight,
        evidence: {
          ...baseEvidence,
          visualLines: listLines,
          strategy: "list-item-wrap",
        },
      };
    }
    case "fenced-code": {
      const contentStats = input.context.sourceStats(
        rangeAttribute(node, "contentRange") ?? node.sourceRange,
      );
      const wrapped = input.context.codeBlockWrap === true;
      const gutterColumns = Math.max(4, String(Math.max(1, contentStats.lineCount)).length) + 1;
      const codeWidth = Math.max(1, availableWidth - gutterColumns * input.layout.averageCharacterWidth);
      const codeLines = wrapped ? estimateVisualLines(
        contentStats.preview,
        contentStats.utf16Length,
        codeWidth,
        input.layout.averageCharacterWidth,
        input.layout.tabSize,
        undefined,
        contentStats.lineCount,
      ) : Math.max(1, contentStats.lineCount);
      return {
        height: codeLines * metrics.codeLineHeight + metrics.codePaddingY,
        evidence: {
          sourceLines: contentStats.lineCount,
          visualLines: codeLines,
          strategy: wrapped ? "code-wrapped-lines" : "code-physical-lines",
          rows: contentStats.lineCount,
        },
      };
    }
    case "math-block": {
      const contentStats = input.context.sourceStats(
        rangeAttribute(node, "contentRange") ?? node.sourceRange,
      );
      return {
        height: Math.max(1, contentStats.lineCount) * metrics.mathLineHeight +
          metrics.mathPaddingY,
        evidence: {
          sourceLines: contentStats.lineCount,
          visualLines: Math.max(1, contentStats.lineCount),
          strategy: "math-lines",
          rows: contentStats.lineCount,
        },
      };
    }
    case "table": {
      const table = estimateRegisteredTable(node, {
        sourceStats,
        availableWidth,
        averageCharacterWidth: input.layout.averageCharacterWidth,
        tabSize: input.layout.tabSize,
        semanticText: (cell, maximum) => semanticText(cell, input.context, maximum),
        metrics,
        ...(input.context.tableSampleRows === undefined
          ? {}
          : { sampleRows: input.context.tableSampleRows }),
        ...(input.context.tableLayout === undefined
          ? {}
          : { tableLayout: input.context.tableLayout }),
        ...(input.context.tableHasToolbar === undefined
          ? {}
          : { hasToolbar: input.context.tableHasToolbar }),
      });
      return {
        height: table.height,
        evidence: {
          ...baseEvidence,
          strategy: table.strategy,
          textLayout: "table-sampled",
          rows: table.rows,
          columns: table.columns,
          sampledRows: table.sampledRows,
          visualLines: table.visualLines,
        },
      };
    }
    case "table-row":
      return fixed(
        metrics.tableRowHeight,
        "table-row",
        { ...baseEvidence, columns: node.childCount },
      );
    case "table-cell":
      return textBlock(
        visualLines * metrics.paragraphLineHeight,
        "table-cell-wrap",
        baseEvidence,
      );
    case "image": {
      const { height, aspectRatio } = estimateImage(input.context, node, availableWidth);
      return {
        height,
        evidence: { ...baseEvidence, strategy: "image-aspect", aspectRatio },
      };
    }
    case "thematic-break":
      return fixed(metrics.thematicHeight, "thematic-break", baseEvidence);
    case "dirty-source":
      return textBlock(
        Math.max(stats.lineCount, visualLines) * metrics.codeLineHeight + metrics.codePaddingY,
        "dirty-source-lines",
        baseEvidence,
      );
    case "document":
      return fixed(metrics.paragraphLineHeight, "document", baseEvidence);
    default:
      return textBlock(
        visualLines * metrics.paragraphLineHeight,
        "inline-or-unknown",
        baseEvidence,
      );
  }
}

function estimateRegisteredTable(
  node: RenderNode,
  context: TablePreTextContext,
): TablePreTextEstimate {
  const definition = defaultMarkdownComponentRegistry.resolve(node);
  const model = definition?.createModel(node);
  const estimate = model === undefined
    ? undefined
    : definition?.capabilities.pretext?.estimate(model, context);
  if (estimate === undefined) {
    throw new Error("table RenderNode has no registered PreText adapter");
  }
  return estimate as TablePreTextEstimate;
}

// Segmenting every grapheme of a huge physical line can block the browser.
// Estimate from a bounded sample; mounted content is remeasured.
const MAX_PREPARED_TEXT_UTF16 = 8_192;

function estimateVisualLines(
  preview: string,
  fullUtf16Length: number,
  width: number,
  averageCharacterWidth: number,
  tabSize = 4,
  sampledColumns?: number,
  sourceLineCount = physicalLineCount(preview),
  textLayout?: PreTextTextLayout,
  textStyle?: PreTextTextStyle,
): number {
  if (preview.length > MAX_PREPARED_TEXT_UTF16) {
    let end = MAX_PREPARED_TEXT_UTF16;
    const previous = preview.charCodeAt(end - 1), next = preview.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    const sample = preview.slice(0, end);
    const sampleLines = estimateVisualLines(
      sample, sample.length, width, averageCharacterWidth, tabSize, undefined,
      physicalLineCount(sample), textLayout, textStyle,
    );
    return Math.max(sourceLineCount, Math.ceil(sampleLines * Math.max(1, fullUtf16Length / sample.length)));
  }
  if (textLayout !== undefined && textStyle !== undefined && preview.length > 0) {
    const prepared = textLayout.prepare(preview, textStyle);
    const lines = textLayout.layout(prepared, width, 1).lineCount;
    // Offline geometry may have only a bounded source preview even when a
    // text measurer exists. Scale exceptionally long ranges to avoid a
    // scrollbar sized for just the first few thousand units.
    const scale = fullUtf16Length > MAX_PREPARED_TEXT_UTF16
      ? Math.max(1, fullUtf16Length / preview.length) : 1;
    return Math.max(
      sourceLineCount,
      Math.ceil(lines * scale),
    );
  }
  const columnsPerLine = Math.max(1, Math.floor(width / positive(averageCharacterWidth, 8)));
  if (preview.length === 0) {
    return Math.max(
      1,
      Math.ceil(Math.max(1, fullUtf16Length) / columnsPerLine),
      sourceLineCount,
    );
  }
  const sampledVisualLines = preview.split("\n").reduce(
    (total, line) => total + Math.max(1, Math.ceil(displayColumns(line, tabSize) / columnsPerLine)),
    0,
  );
  const sampleColumns = Math.max(1, displayColumns(preview, tabSize));
  const semanticWidthRatio = Math.max(1, (sampledColumns ?? sampleColumns) / sampleColumns);
  const textScale = Math.max(
    1,
    fullUtf16Length / preview.length,
  );
  // 预览可能只是源码前缀。先按前缀中真实的物理换行和软换行估算，再按完整
  // 源码长度外推；这比把所有字符列数合并成一条长行更不容易被段首长行带偏。
  return Math.max(
    1,
    sourceLineCount,
    Math.ceil(sampledVisualLines * textScale * semanticWidthRatio),
  );
}

function physicalLineCount(value: string): number {
  return Math.max(1, value.split("\n").length);
}

function displayColumns(value: string, tabSize = 4): number {
  let columns = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (character === "\t") {
      columns += tabSize - (columns % tabSize || 0);
    } else {
      columns += point >= 0x1100 ? 2 : 1;
    }
  }
  return columns;
}

function leadingWhitespaceColumns(value: string, tabSize = 4): number {
  let columns = 0;
  for (const character of value) {
    if (character === " ") {
      columns += 1;
      continue;
    }
    if (character === "\t") {
      columns += tabSize - (columns % tabSize || 0);
      continue;
    }
    break;
  }
  return columns;
}

/**
 * PreText 有意不调用 KaTeX，也不测量 DOM。这个稳定启发式把行内公式的源码宽度
 * 替换为排版宽度估算，同时保留精确源码供 Preview renderer 和诊断使用。
 */
function semanticVisualColumns(
  node: RenderNode,
  context: PreTextProjectionContext,
  tabSize = 4,
): number | undefined {
  if (node.kind === "inline-math") {
    const source = context.sourceStats(
      rangeAttribute(node, "contentRange") ?? node.sourceRange,
    ).preview;
    return Math.max(2, Math.ceil(displayColumns(source, tabSize) * 0.78) + 2);
  }
  if (node.content.type !== "structured") return undefined;
  if (["table", "table-row"].includes(node.kind)) return undefined;
  let columns = 0;
  for (const child of node.content.children) {
    const childColumns = semanticVisualColumns(child, context, tabSize);
    if (childColumns !== undefined) {
      columns += childColumns;
      continue;
    }
    const childText = semanticText(child, context);
    columns += displayColumns(childText, tabSize);
  }
  return columns;
}

function countDescendants(node: RenderNode, kind: string): number {
  let count = node.kind === kind ? 1 : 0;
  if (node.content.type === "structured") {
    for (const child of node.content.children) count += countDescendants(child, kind);
  }
  return count;
}

function semanticShellKey(node: RenderNode): string {
  if (node.kind === "heading") {
    return `${node.id}:heading:h${numberAttribute(node, "level") ?? 1}`;
  }
  return `${node.id}:${node.kind}`;
}

function estimateImage(
  context: PreTextProjectionContext,
  node: RenderNode,
  availableWidth: number,
): { height: number; aspectRatio: number } {
  const metadata = context.resolveImageMetadata?.(stringAttribute(node, "destination") ?? "");
  const width = Math.min(availableWidth, imageDimensionsFromMetadata(metadata)?.width ?? availableWidth);
  const aspectRatio = positive(imageAspectRatioFromMetadata(metadata), width / context.metrics.imageFallbackHeight);
  return { height: Math.min(context.metrics.imageMaxHeight, width / aspectRatio), aspectRatio };
}

function semanticText(
  node: RenderNode,
  context: PreTextProjectionContext,
  limit = Number.POSITIVE_INFINITY,
): string {
  if (node.kind === "soft-break" || node.kind === "hard-break") return "\n";
  if (node.kind === "thematic-break" || node.kind === "blank-line") return "";
  if (node.kind === "task-marker") return booleanAttribute(node, "checked") === true ? "☑" : "☐";
  if (node.kind === "image") {
    const title = stringAttribute(node, "title");
    // A data URL can contain megabytes. It is resource metadata, never text
    // for glyph measurement or the readable PreText placeholder.
    return title ?? stringAttribute(node, "alt") ?? "Image";
  }
  if (["fenced-code", "math-block", "inline-code", "inline-math", "escaped-text"].includes(node.kind)) {
    return limitText(sourceForRange(context,
      rangeAttribute(node, "contentRange") ?? node.sourceRange,
    ), limit);
  }
  if (node.kind === "block-quote" && node.content.type !== "structured") {
    // A bounded projection can end inside a deeply nested, confirmed quote.
    // For a single physical line, remove only the confirmed container prefix
    // from its sizing/placeholder text; do not reinterpret a multiline body
    // where `>` may be literal code or another block's content.
    const stats = context.sourceStats(node.sourceRange);
    const prefix = quotePrefix(stats.preview, 0, Number.POSITIVE_INFINITY);
    if (stats.lineCount <= 1 && prefix !== undefined &&
        (prefix.to < stats.preview.length || stats.preview.length >= stats.utf16Length)) {
      return limitText(sourceForRange(context, node.sourceRange).slice(prefix.to), limit);
    }
  }
  if (node.content.type === "structured") {
    if (node.kind === "table") {
      return limitText(node.content.children.map((child) =>
        semanticText(child, context, Math.min(limit, 2_048))).join("\n"), limit);
    }
    if (node.kind === "table-row") {
      return limitText(node.content.children.map((child) =>
        semanticText(child, context, Math.min(limit, 2_048)).trim()).join("  |  "), limit);
    }
    const content = node.content.children.map((child) =>
      semanticText(child, context, limit)).join("");
    if (node.kind !== "list-item" || countDescendants(node, "task-marker") > 0) return limitText(content, limit);
    const number = numberAttribute(node, "number");
    const marker = number === undefined
      ? (stringAttribute(node, "marker") ?? "-")
      : `${number}${stringAttribute(node, "delimiter") ?? "."}`;
    return limitText(`${marker} ${content}`, limit);
  }
  return limitText(sourceForRange(context, node.sourceRange), limit);
}

function sourceForRange(context: PreTextProjectionContext, range: TextRange): string {
  return context.sourceText?.(range) ?? context.sourceStats(range).preview;
}

function limitText(value: string, limit: number): string {
  return Number.isFinite(limit) ? value.slice(0, Math.max(0, limit)) : value;
}

function contentShapeKey(node: RenderNode): string {
  let hash = 0x811c9dc5;
  const update = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  const visit = (current: RenderNode) => {
    update(`${current.id}/${current.kind}/${current.contentVersion}/${current.content.type};`);
    if (current.content.type === "structured") {
      for (const child of current.content.children) visit(child);
    }
  };
  visit(node);
  return (hash >>> 0).toString(36);
}

function boundedText(value: string): string {
  return value.length <= 4_096 ? value : `${value.slice(0, 4_096)}…`;
}

function componentFamily(kind: string, strategy: string): string {
  if (strategy === "paragraph-with-image") return "image";
  if (["paragraph", "text", "escaped-text", "emphasis", "strong", "strikethrough", "task-marker", "link"].includes(kind)) return "text";
  if (kind === "list-item") return "list";
  if (["table", "table-row", "table-cell"].includes(kind)) return "table";
  if (["fenced-code", "inline-code"].includes(kind)) return "code";
  if (["math-block", "inline-math"].includes(kind)) return "math";
  return kind;
}

export function preTextLabel(node: RenderNode, t = formatPhrase): string {
  if (node.kind === "heading") return t(`Heading ${numberAttribute(node, "level") ?? 1}`);
  if (node.kind === "table") {
    return t("Table · $1 rows × $2 cols", node.childCount, stringsAttribute(node, "alignments").length);
  }
  if (node.kind === "fenced-code") {
    const language = stringAttribute(node, "language");
    return language === undefined ? t("Code block") : t("Code block · $1", language);
  }
  return t(node.kind.replaceAll("-", " "));
}

function collapsePreview(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 180);
}

function metricsKey(metrics: PreTextStyleMetrics): string {
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function fixed(
  height: number,
  strategy: string,
  evidence: Omit<PreTextEstimateEvidence, "strategy">,
): Estimate {
  return { height, evidence: { ...evidence, strategy } };
}

function textBlock(
  height: number,
  strategy: string,
  evidence: Omit<PreTextEstimateEvidence, "strategy">,
): Estimate {
  return { height, evidence: { ...evidence, strategy } };
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
