import type {
  ProjectionSlice,
  RenderNode,
  Utf16Offset,
} from "@jot-md/editor-protocol";
import type { EditorView } from "@codemirror/view";

import type { EditorDocumentSession } from "../../adapter/index.js";
import { componentProjectionDepth } from "../../components/projection.js";
import { safeUtf16Offset } from "../../components/common/render-utils.js";
import { sourceLineDestination } from "./viewport.js";

export interface LivePreviewSourceWindow {
  readonly from: number;
  readonly to: number;
}

export function visibleSourceWindow(view: EditorView): LivePreviewSourceWindow {
  const first = view.visibleRanges[0] ?? { from: view.viewport.from, to: view.viewport.to };
  const last = view.visibleRanges.at(-1) ?? first;
  const destination = sourceLineDestination(view);
  // A long jump can still report the departing viewport until CodeMirror measures.
  // Only project the destination section while tables on either side acquire their heights.
  const end = destination !== undefined && (destination < view.viewport.from || destination > view.viewport.to)
    ? destination : last.to;
  return {
    // 只为可见源码及其邻近范围拉取 RenderNode。离屏高度使用几何估算，
    // 扩大预取范围会让短段落密集的文档一次挂载过多节点。
    from: destination ?? Math.max(0, first.from - 384),
    to: Math.min(view.state.doc.length, Math.max(end, destination ?? 0) + 768),
  };
}

/** 取屏幕实际相交的源码范围，排除 CodeMirror 为滚动提前挂载的行。 */
export function screenSourceWindow(view: EditorView): LivePreviewSourceWindow {
  const rect = view.scrollDOM.getBoundingClientRect();
  const top = (rect.top + view.scrollDOM.clientTop * view.scaleY - view.documentTop) / view.scaleY;
  const bottom = top + view.scrollDOM.clientHeight;
  // 读取 CodeMirror 已发布的行盒位置，避免每次投影请求都触发同步测量。
  // 测量可能改变滚动位置，继而触发下一次投影请求。
  const visible = view.viewportLineBlocks.filter((block) => block.bottom > top && block.top < bottom);
  const first = visible[0], last = visible.at(-1);
  return first === undefined || last === undefined
    ? { from: view.viewport.from, to: view.viewport.to }
    : { from: Math.min(first.from, last.from), to: Math.max(first.to, last.to) };
}

export function visibleRootNodes(
  session: EditorDocumentSession,
  range: LivePreviewSourceWindow,
): readonly RenderNode[] {
  return visibleRootEntries(session, range).map(({ node }) => node);
}

/**
 * 根 projection 是稀疏缓存：可视源码范围可以落在已经知道总 childCount、但尚未
 * 加载具体 RenderNode 的空洞内。SyntaxBlockIndex 保存 Rust 已确认的根 block
 * sourceRange，因此可将当前 CodeMirror 可视 offset 映射为精确 root index，再
 * 请求对应的有界 index slice。不能仅凭 `loaded` 列表猜洞的位置，否则长文档
 * 滚动到新 bucket 会得到“visibleBlocks = 0”的假空视口。
 */
export function missingVisibleRootSlices(
  session: EditorDocumentSession,
  range: LivePreviewSourceWindow,
  maximum: number,
): readonly ProjectionSlice[] {
  const total = session.adapter.projection.totalChildren("0", "syntax-children") ||
    session.adapter.blocks.blocks.length;
  if (total === 0 || maximum <= 0) return [];
  const bounds = visibleRootIndexBounds(session, range, total);
  if (bounds === undefined) return [];

  // `ProjectionWindow::AroundRange` in the protocol is anchored at
  // `range.from`; it does not materialize every root intersecting range.to.
  // Treat the full current source window as mandatory instead. This is the
  // difference between recovering an empty viewport and recovering the more
  // dangerous partial hole where the first 24 blocks render but later visible
  // blocks stay raw forever after a rapid paste.
  const requiredFrom = bounds.from;
  const requiredToExclusive = bounds.toExclusive;
  const requiredCount = requiredToExclusive - requiredFrom;
  // `maximum` remains a surrounding-cache budget, not a cap on roots that
  // are currently visible. Correctness of the live window wins over a small
  // prefetch budget; before/after only consume remaining capacity.
  const surrounding = Math.max(0, maximum - requiredCount);
  const before = Math.min(requiredFrom, Math.floor(surrounding / 3));
  const after = Math.min(
    total - requiredToExclusive,
    Math.max(0, surrounding - before),
  );
  const from = requiredFrom - before;
  const toExclusive = requiredToExclusive + after;
  const missing = session.adapter.projection.missingRanges(
    "0",
    "syntax-children",
    from,
    toExclusive,
  );
  return missing.map((slice) => rootIndexSlice(slice.from, slice.toExclusive));
}

/**
 * 当前 source window 所跨越的精确 root index span。与 `projectAround` 不同，
 * 这个 slice 的右边界确实覆盖 `range.to`；在输入批次/分析拓扑改变后用于强制
 * 覆盖已有但陈旧的 cached RenderNode，而不仅是填 undefined hole。
 */
export function visibleRootSlices(
  session: EditorDocumentSession,
  range: LivePreviewSourceWindow,
): readonly ProjectionSlice[] {
  const total = session.adapter.projection.totalChildren("0", "syntax-children") ||
    session.adapter.blocks.blocks.length;
  if (total === 0) return [];
  const bounds = visibleRootIndexBounds(session, range, total);
  return bounds === undefined ? [] : [rootIndexSlice(bounds.from, bounds.toExclusive)];
}

/**
 * 在根块范围不扩张的前提下，为 controller 的 table 交互策略合并一个有界的
 * row/cell 窗口。完整二维显示仍由共享 TableGrid 直接消费 sparse store；这里
 * 不触发投影，也不按已经滚过的总行数扩大 Live Preview 计划。
 */
export function visibleLivePreviewNodes(
  session: EditorDocumentSession,
  range: LivePreviewSourceWindow,
  focusOffset?: number,
): readonly RenderNode[] {
  return visibleRootEntries(session, range).map(({ node }) =>
    node.kind === "table" ? hydrateTableNode(session, node, range, focusOffset) : node);
}

/** 根块已知后，只为当前可见内容请求仍缺失的子结构，优先处理光标和视口附近。 */
export function visibleDetailSlices(
  session: EditorDocumentSession,
  range: LivePreviewSourceWindow,
  maximum: number,
  focusOffset?: number,
  priorityRange: LivePreviewSourceWindow = range,
  attempted: ReadonlySet<string> = new Set(),
): readonly ProjectionSlice[] {
  const entries = visibleRootEntries(session, range);
  const generic = entries
    .filter(({ node }) => node.content.type === "deferred")
    .flatMap(({ index, node }) => {
      const depth = detailDepth(node);
      return depth === 0 ? [] : [{ node, slice: {
        parentId: "0",
        axis: "syntax-children" as const,
        window: { type: "index" as const, from: index, toExclusive: index + 1 },
        maxDepth: depth,
      } }];
    });
  const tableRows = entries
    .filter(({ node }) => node.kind === "table" && node.mode !== "source")
    .map(({ node }): { readonly node: RenderNode; readonly slice: ProjectionSlice } => {
      const tableRange = focusOffset !== undefined &&
          Number(node.sourceRange.from) <= focusOffset &&
          focusOffset <= Number(node.sourceRange.to)
        ? {
          from: focusOffset as import("@jot-md/editor-protocol").Utf16Offset,
          to: focusOffset as import("@jot-md/editor-protocol").Utf16Offset,
        }
        : {
          from: range.from as import("@jot-md/editor-protocol").Utf16Offset,
          to: range.to as import("@jot-md/editor-protocol").Utf16Offset,
        };
      return { node, slice: {
        parentId: node.id,
        axis: "syntax-children",
        window: {
          type: "around-range",
          range: tableRange,
          before: 4,
          after: 12,
        },
        // table -> row -> cell；窗口只覆盖当前可见附近的行，而不是整表。
        maxDepth: 2,
      } };
    });
  const quoteLines = entries
    .filter(({ node }) => node.kind === "block-quote")
    .flatMap(({ node }) => missingQuoteLineSlices(session, node, range)
      .map(slice => ({ node, slice })));
  // CodeMirror's viewport includes overscan. Spend a bounded request on the
  // actual screen first; otherwise an early cluster of short offscreen roots
  // can permanently starve the heading or image the user is looking at.
  return [...generic, ...tableRows, ...quoteLines]
    .filter(({ slice }) => !attempted.has(detailSliceKey(slice)))
    .sort((left, right) =>
      rangeDistance(left.node, priorityRange) - rangeDistance(right.node, priorityRange) ||
      Number(left.node.sourceRange.from) - Number(right.node.sourceRange.from))
    .slice(0, Math.max(0, maximum))
    .map(({ slice }) => slice);
}

/** Only visible physical rows are projected, even for a very large quote. */
export function visibleQuoteLines(
  session: EditorDocumentSession,
  nodes: readonly RenderNode[],
  range: LivePreviewSourceWindow,
): readonly RenderNode[] {
  const revision = Number(session.adapter.revision);
  const result: RenderNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "block-quote") continue;
    const bounds = quoteLineBounds(session, node, range);
    if (bounds === undefined) continue;
    for (let index = bounds.from; index < bounds.toExclusive; index += 1) {
      const line = session.adapter.projection.nodeAt(node.id, "quote-lines", index);
      if (line?.contentVersion === revision) result.push(line);
    }
  }
  return result;
}

function missingQuoteLineSlices(
  session: EditorDocumentSession,
  node: RenderNode,
  range: LivePreviewSourceWindow,
): readonly ProjectionSlice[] {
  const bounds = quoteLineBounds(session, node, range);
  if (bounds === undefined) return [];
  const revision = Number(session.adapter.revision);
  const result: ProjectionSlice[] = [];
  let start: number | undefined;
  // Keep every individual Worker request bounded, including extreme zoom-out.
  const flush = (end: number): void => {
    if (start === undefined) return;
    result.push({ parentId: node.id, axis: "quote-lines", window: { type: "index", from: start, toExclusive: end }, maxDepth: 4 });
    start = undefined;
  };
  for (let index = bounds.from; index < bounds.toExclusive; index += 1) {
    const line = session.adapter.projection.nodeAt(node.id, "quote-lines", index);
    if (line?.contentVersion === revision) { flush(index); continue; }
    start ??= index;
    if (index + 1 - start >= 256) flush(index + 1);
  }
  flush(bounds.toExclusive);
  return result;
}

function quoteLineBounds(
  session: EditorDocumentSession,
  node: RenderNode,
  range: LivePreviewSourceWindow,
): { readonly from: number; readonly toExclusive: number } | undefined {
  const text = session.adapter.text;
  const rootFrom = Number(node.sourceRange.from), rootTo = Number(node.sourceRange.to);
  const from = Math.max(rootFrom, range.from), to = Math.min(rootTo, range.to);
  if (to < from) return undefined;
  const line = (offset: number): number => text.lineAt(safeUtf16Offset(text.text, offset, -1) as Utf16Offset);
  const rootLine = line(rootFrom);
  return { from: Math.max(0, line(from) - rootLine), toExclusive: line(to) - rootLine + 1 };
}

/** Stable within one confirmed viewport; includes table row-window identity. */
export function detailSliceKey(slice: ProjectionSlice): string {
  const window = slice.window.type === "index"
    ? `index:${slice.window.from}:${slice.window.toExclusive}`
    : `range:${slice.window.range.from}:${slice.window.range.to}:${slice.window.before}:${slice.window.after}`;
  return `${slice.parentId}:${slice.axis}:${window}:${slice.maxDepth}`;
}

function rangeDistance(node: RenderNode, target: LivePreviewSourceWindow): number {
  const from = Number(node.sourceRange.from), to = Number(node.sourceRange.to);
  return to < target.from ? target.from - to : from > target.to ? from - target.to : 0;
}

function visibleRootEntries(
  session: EditorDocumentSession,
  range: LivePreviewSourceWindow,
): readonly { readonly index: number; readonly node: RenderNode }[] {
  const total = session.adapter.projection.totalChildren("0", "syntax-children") ||
    session.adapter.blocks.blocks.length;
  if (total === 0) return [];
  const bounds = visibleRootIndexBounds(session, range, total);
  if (bounds === undefined) return [];
  // Root metadata already gives the exact viewport index span. Reading that
  // span preserves sparse slot indices without snapshotting every table/row
  // window ever visited in this document.
  const loaded = session.adapter.projection.entries(
    "0", "syntax-children", bounds.from, bounds.toExclusive,
  );
  const sourceMatches = loaded
    .filter(({ node }) =>
      Number(node.sourceRange.from) <= range.to && range.from <= Number(node.sourceRange.to));
  if (sourceMatches.length > 0) return sourceMatches;

  // HeightMap replacement widgets can make CodeMirror report a source viewport
  // exactly at a root seam while the cached RenderNode range is temporarily
  // mapped across an optimistic edit. In that short interval source-range
  // intersection produces a false empty viewport. SyntaxBlockIndex is the
  // authoritative root-order metadata, so use it as a bounded fallback rather
  // than dropping all visual widgets and leaving a geometry-only hole.
  const from = session.adapter.blocks.blockAt(range.from) ??
    nearestRootBlockIndex(session, range.from, total);
  const to = session.adapter.blocks.blockAt(range.to) ??
    nearestRootBlockIndex(session, range.to, total);
  if (from === undefined && to === undefined) return [];
  const lower = Math.max(0, Math.min(from ?? to!, to ?? from!) - 1);
  const upper = Math.min(total - 1, Math.max(from ?? to!, to ?? from!) + 1);
  return loaded
    .filter((entry) => entry.index >= lower && entry.index <= upper)
    .sort((left, right) => left.index - right.index);
}

function rootIndexSlice(from: number, toExclusive: number): ProjectionSlice {
  return {
    parentId: "0",
    axis: "syntax-children",
    window: { type: "index", from, toExclusive },
    maxDepth: 0,
  };
}

function visibleRootIndexBounds(
  session: EditorDocumentSession,
  range: LivePreviewSourceWindow,
  total: number,
): { readonly from: number; readonly toExclusive: number } | undefined {
  const first = session.adapter.blocks.blockAt(range.from) ??
    nearestRootBlockIndex(session, range.from, total);
  const last = session.adapter.blocks.blockAt(range.to) ??
    nearestRootBlockIndex(session, range.to, total);
  if (first === undefined && last === undefined) return undefined;
  const rawFrom = Math.min(first ?? last!, last ?? first!);
  const rawToExclusive = Math.max(first ?? last!, last ?? first!) + 1;
  return {
    // SyntaxBlockIndex intentionally treats root `sourceRange.to` as
    // inclusive so zero-width BlankLine can be found at a seam. Add one
    // neighbor on both sides here: a viewport endpoint exactly on a newline
    // must not omit the block that begins immediately after it.
    from: Math.max(0, rawFrom - 1),
    toExclusive: Math.min(total, rawToExclusive + 1),
  };
}

function nearestRootBlockIndex(
  session: EditorDocumentSession,
  offset: number,
  total: number,
): number | undefined {
  const blocks = session.adapter.blocks.blocks;
  if (blocks.length === 0) return undefined;
  let nearest: { readonly index: number; readonly distance: number } | undefined;
  for (let index = 0; index < Math.min(total, blocks.length); index += 1) {
    const block = blocks[index];
    if (block === undefined || block.kind === "unloaded") continue;
    const from = Number(block.sourceRange.from);
    const to = Number(block.sourceRange.to);
    const distance = offset < from ? from - offset : offset > to ? offset - to : 0;
    if (nearest === undefined || distance < nearest.distance) {
      nearest = { index, distance };
      if (distance === 0) break;
    }
  }
  return nearest?.index;
}

function detailDepth(node: RenderNode): number {
  const componentDepth = componentProjectionDepth(node, "live-preview");
  if (componentDepth !== undefined) return componentDepth;
  if (node.childCount === 0) return 0;
  if (["paragraph", "heading", "list-item"].includes(node.kind) && node.childCount <= 64) {
    return 4;
  }
  if (node.kind === "block-quote" && node.childCount <= 16) {
    return 4;
  }
  return 0;
}

function hydrateTableNode(
  session: EditorDocumentSession,
  table: RenderNode,
  range: LivePreviewSourceWindow,
  focusOffset: number | undefined,
): RenderNode {
  const store = session.adapter.projection;
  // Only the selected table and its nearby rows participate in interaction.
  // Do not materialize all cached windows to build a global cells-by-parent
  // map; the store already indexes them by parent ID.
  const loadedRows = store.entries(table.id, "syntax-children")
    .map(({ node }) => node)
    .filter((row) => row.kind === "table-row")
    .filter((row) => Number(row.sourceRange.from) <= range.to && range.from <= Number(row.sourceRange.to));
  const rows = new Map<number, RenderNode>();
  if (table.content.type === "structured") {
    for (const row of table.content.children) {
      if (row.kind === "table-row") rows.set(Number(row.sourceRange.from), row);
    }
  }
  for (const row of loadedRows) rows.set(Number(row.sourceRange.from), row);
  if (rows.size === 0) return table;

  const anchor = focusOffset === undefined
    ? Math.floor((range.from + range.to) / 2)
    : focusOffset;
  const selectedRows = nearestTableRows([...rows.values()], anchor, 48);
  return {
    ...table,
    content: {
      type: "structured",
      children: selectedRows.map((row) => hydrateTableRow(session, row)),
    },
  };
}

function hydrateTableRow(
  session: EditorDocumentSession,
  row: RenderNode,
): RenderNode {
  if (row.content.type === "structured") return row;
  const cells = session.adapter.projection.entries(row.id, "syntax-children")
    .map(({ node }) => node)
    .filter((node) => node.kind === "table-cell");
  return cells.length === 0
    ? row
    : {
        ...row,
        content: {
          type: "structured",
          children: [...cells].sort((left, right) =>
            Number(left.sourceRange.from) - Number(right.sourceRange.from)),
        },
      };
}

function nearestTableRows(
  rows: readonly RenderNode[],
  anchor: number,
  maximum: number,
): readonly RenderNode[] {
  const ordered = [...rows].sort((left, right) =>
    Number(left.sourceRange.from) - Number(right.sourceRange.from));
  if (ordered.length <= maximum) return ordered;
  const header = ordered[0];
  const nearest = ordered
    .map((row) => ({
      row,
      distance: sourceRangeDistance(row, anchor),
    }))
    .sort((left, right) => left.distance - right.distance ||
      Number(left.row.sourceRange.from) - Number(right.row.sourceRange.from))
    .slice(0, maximum);
  // Header navigation and table command recovery benefit from retaining the
  // first semantic row even while the nested visual axis is deep in the body.
  if (header !== undefined && !nearest.some(({ row }) => row.id === header.id)) {
    nearest[nearest.length - 1] = { row: header, distance: sourceRangeDistance(header, anchor) };
  }
  return nearest
    .map(({ row }) => row)
    .sort((left, right) => Number(left.sourceRange.from) - Number(right.sourceRange.from));
}

function sourceRangeDistance(node: RenderNode, offset: number): number {
  const from = Number(node.sourceRange.from);
  const to = Number(node.sourceRange.to);
  return offset < from ? from - offset : offset > to ? offset - to : 0;
}
