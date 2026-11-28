import { EditorView } from "@codemirror/view";
import {
  logicalScrollLeft,
  setLogicalScrollLeft,
} from "../../components/common/render-utils.js";

interface SourceLineAnchor {
  from: number | undefined;
  readonly align: () => void;
  readonly observer: ResizeObserver;
}
const sourceLines = new WeakMap<EditorView, SourceLineAnchor>();

export function sourceLineDestination(view: EditorView): number | undefined {
  return sourceLines.get(view)?.from;
}

/** Once the destination is laid out, include preceding content if EOF prevents top alignment. */
export function expandSourceLineWindowAtEnd(view: EditorView, firstVisible: number): boolean {
  const anchor = sourceLines.get(view);
  const scroll = view.scrollDOM;
  if (anchor?.from === undefined || firstVisible >= anchor.from ||
      scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 1) return false;
  anchor.from = undefined;
  return true;
}

/** Keep an explicit source destination through pending Markdown projections and widget measurements. */
export function revealSourceLine(view: EditorView, offset: number, livePreview: boolean): (() => void) | undefined {
  markLivePreviewUserScroll(view);
  const scroll = view.scrollDOM;
  const margin = view.documentPadding.top;
  view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: "start", yMargin: margin }) });
  if (!livePreview) return;
  const align = () => {
    if (sourceLines.get(view)?.align !== align) return;
    const { node } = view.domAtPos(offset, 1);
    const row = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest(".cm-line");
    const y = row && view.posAtDOM(row) === offset ? row.getBoundingClientRect().top :
      view.documentTop + view.lineBlockAt(offset).top;
    const delta = (y - scroll.getBoundingClientRect().top) / view.scaleY - scroll.clientTop - margin;
    const top = Math.max(0, Math.min(scroll.scrollTop + delta, scroll.scrollHeight - scroll.clientHeight));
    if (Math.abs(scroll.scrollTop - top) > 1) scroll.scrollTop = top;
  };
  const observer = new ResizeObserver(align);
  const anchor: SourceLineAnchor = { from: offset, align, observer };
  sourceLines.set(view, anchor);
  observer.observe(view.contentDOM);
  return () => {
    // An older navigation can finish after a newer one has installed its anchor.
    if (sourceLines.get(view) === anchor) releaseSourceLine(view);
  };
}

export function releaseSourceLine(view: EditorView): void {
  sourceLines.get(view)?.observer.disconnect();
  sourceLines.delete(view);
}

const userScrollEpochs = new WeakMap<EditorView, number>();

/** Invalidate delayed anchor restoration before a newer scroll or navigation. */
export function markLivePreviewUserScroll(view: EditorView): void {
  releaseSourceLine(view);
  userScrollEpochs.set(view, (userScrollEpochs.get(view) ?? 0) + 1);
}

/**
 * Live Preview 的滚动几何仍由 CodeMirror 持有。
 *
 * 源码行和 Preview widget 切换时，CodeMirror 会重建 line block；直接保存
 * `scrollTop` 会把用户当前看到的内容推开，直接依赖隐藏源码位置又可能被
 * CM 的原生 selection scroll 拉到首尾。这里保存可见 line block 的源码锚点
 * 和其局部偏移，在 decoration/layout 更新后把同一视觉锚点放回去。它不是
 * 第二套虚拟高度轴，也不接管正常滚动。
 */
export interface LivePreviewViewportAnchor {
  readonly sourceOffset: number;
  readonly blockOffset: number;
  readonly scrollLeft: number;
}

export function captureLivePreviewViewport(view: EditorView): LivePreviewViewportAnchor {
  let documentTop = view.scrollDOM.scrollTop + view.documentPadding.top;
  let block = view.lineBlockAtHeight(documentTop);
  // lineBlockAtHeight may synchronously flush CodeMirror's pending measure,
  // including an explicit scrollIntoView. Capture the *new* viewport if that
  // happened; combining the old scrollTop with the new height map would later
  // restore an obsolete anchor and undo the requested navigation.
  const measuredTop = view.scrollDOM.scrollTop + view.documentPadding.top;
  if (Math.abs(measuredTop - documentTop) > 0.5) {
    documentTop = measuredTop;
    block = view.lineBlockAtHeight(documentTop);
  }
  return {
    sourceOffset: block.from,
    blockOffset: documentTop - block.top,
    scrollLeft: view.scrollDOM.scrollLeft,
  };
}

export function restoreLivePreviewViewport(
  view: EditorView,
  anchor: LivePreviewViewportAnchor,
): void {
  const block = view.lineBlockAt(anchor.sourceOffset);
  const requestedTop = block.top + anchor.blockOffset - view.documentPadding.top;
  const maximumTop = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
  const targetTop = clamp(requestedTop, 0, maximumTop);
  // Setting scrollTop/scrollLeft even when the value is unchanged is observable
  // in some browser/IME combinations and can feed the direct scrollbar back
  // into the editor. Keep viewport preservation idempotent.
  if (Math.abs(view.scrollDOM.scrollTop - targetTop) > 0.5) {
    view.scrollDOM.scrollTop = targetTop;
  }
  if (Math.abs(view.scrollDOM.scrollLeft - anchor.scrollLeft) > 0.5) {
    view.scrollDOM.scrollLeft = anchor.scrollLeft;
  }
}

/** 在同步更新后立即恢复一次，并在浏览器完成下一轮布局后再确认一次。 */
export function preserveLivePreviewViewport(
  view: EditorView,
  action: () => void,
): void {
  const line = sourceLines.get(view);
  if (line) {
    action();
    line.align();
    return;
  }
  const userScrollEpoch = userScrollEpochs.get(view) ?? 0;
  const anchor = captureLivePreviewViewport(view);
  action();
  // The action may itself be an explicit navigation (for example Find Next).
  // Its new scroll intent takes precedence over this older captured anchor.
  if ((userScrollEpochs.get(view) ?? 0) !== userScrollEpoch) return;
  restoreLivePreviewViewport(view, anchor);
  const firstTop = view.scrollDOM.scrollTop;
  const requestFrame = view.dom.ownerDocument.defaultView?.requestAnimationFrame;
  requestFrame?.(() => {
    // 用户如果在这一个 frame 内主动滚动，不覆盖他的输入；否则修正由
    // widget 高度、字体或图片加载引起的二次布局偏移。
    if (
      (userScrollEpochs.get(view) ?? 0) === userScrollEpoch &&
      Math.abs(view.scrollDOM.scrollTop - firstTop) < 2 &&
      // A layout pass may move CM to a different virtual viewport while the
      // physical scrollTop remains unchanged. The old source anchor is no
      // longer supported by the current height map in that case; leave the
      // correction to CM instead of jumping to its stale estimated position.
      view.viewport.from <= anchor.sourceOffset && anchor.sourceOffset <= view.viewport.to
    ) {
      restoreLivePreviewViewport(view, anchor);
    }
  });
}

/**
 * Reveal the projected caret, not the hidden Markdown range represented by the
 * table widget. CodeMirror cannot derive this geometry from a mapped block
 * replacement, especially for a virtualized table whose active row may be near
 * the end of a very tall widget.
 */
export function revealLivePreviewTableCaret(
  view: EditorView,
  cell: HTMLElement,
  margin = 8,
): boolean {
  if (!cell.isConnected || !view.dom.contains(cell)) return false;
  const scroll = view.scrollDOM;
  const viewport = scroll.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const caretTop = cellRect.top + cssPixels(
    cell.style.getPropertyValue("--jot-live-table-caret-block-start"),
  );
  const caretHeight = Math.max(
    1,
    cssPixels(cell.style.getPropertyValue("--jot-live-table-caret-height")) ||
      Math.min(cellRect.height, 16),
  );
  const caretBottom = caretTop + caretHeight;
  let visibleTop = viewport.top + scroll.clientTop + Math.max(0, margin);
  const visibleBottom = viewport.bottom - Math.max(0, margin);
  const table = cell.closest<HTMLElement>(".jot-table");
  const header = table?.querySelector<HTMLElement>(".jot-table-grid-header");
  if (header !== null && header !== undefined && !header.contains(cell)) {
    const headerRect = header.getBoundingClientRect();
    if (headerRect.top <= visibleTop + 1 && headerRect.bottom > visibleTop) {
      visibleTop = Math.min(visibleBottom, headerRect.bottom + Math.max(0, margin));
    }
  }
  const verticalDelta = nearestRevealDelta(
    caretTop,
    caretBottom,
    visibleTop,
    visibleBottom,
  );
  if (verticalDelta !== 0) {
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    scroll.scrollTop = clamp(scroll.scrollTop + verticalDelta, 0, maximum);
  }

  let horizontalChanged = false;
  if (table !== null && table !== undefined && table.scrollWidth > table.clientWidth) {
    const tableRect = table.getBoundingClientRect();
    const caretLeft = cellRect.left + cssPixels(
      cell.style.getPropertyValue("--jot-live-table-caret-inline-start"),
    );
    const horizontalMargin = Math.max(4, margin);
    const visibleLeft = Math.max(
      viewport.left + horizontalMargin,
      tableRect.left + table.clientLeft + horizontalMargin,
    );
    const visibleRight = Math.min(
      viewport.right - horizontalMargin,
      tableRect.right - horizontalMargin,
    );
    const horizontalDelta = nearestRevealDelta(
      caretLeft,
      caretLeft + 1,
      visibleLeft,
      visibleRight,
    );
    if (horizontalDelta !== 0) {
      const before = logicalScrollLeft(table);
      setLogicalScrollLeft(table, before + horizontalDelta);
      horizontalChanged = Math.abs(logicalScrollLeft(table) - before) >= 0.5;
    }
  }
  return verticalDelta !== 0 || horizontalChanged;
}

/** Minimal delta that reveals a target interval inside a viewport interval. */
export function nearestRevealDelta(
  targetStart: number,
  targetEnd: number,
  viewportStart: number,
  viewportEnd: number,
): number {
  if (
    !Number.isFinite(targetStart) || !Number.isFinite(targetEnd) ||
    !Number.isFinite(viewportStart) || !Number.isFinite(viewportEnd) ||
    viewportEnd <= viewportStart
  ) {
    return 0;
  }
  if (targetStart < viewportStart) return targetStart - viewportStart;
  if (targetEnd > viewportEnd) return targetEnd - viewportEnd;
  return 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cssPixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
