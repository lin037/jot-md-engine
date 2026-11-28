import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  readDomSourceRange,
  sourceOffsetAtPoint,
  type DomSourceRange,
} from "../../components/common/dom-position.js";
import { safeUtf16Offset } from "../../components/common/render-utils.js";
import { sourceSnapshot } from "../shared/source-snapshot.js";
import { preserveLivePreviewViewport } from "./viewport.js";

export interface PreviewPointerTarget {
  readonly element: HTMLElement;
  readonly range: DomSourceRange;
  readonly offset: number;
  /** Non-isomorphic renderers can select their semantic source as one unit. */
  readonly opaque?: DomSourceRange;
  /** A table triple-click selects its cell, without the neighboring pipes. */
  readonly lineRange?: DomSourceRange;
  readonly onActivate?: () => void;
  readonly onCaret?: () => void;
  readonly onRangeEnd?: () => void;
}

interface ActiveGesture {
  readonly element: HTMLElement;
  readonly cancel: () => void;
}

interface RecentOpaqueClick {
  readonly doc: EditorState["doc"];
  readonly target: PreviewPointerTarget;
  readonly x: number;
  readonly y: number;
  readonly time: number;
}

const gestures = new WeakMap<EditorView, ActiveGesture>();
const recentOpaqueClicks = new WeakMap<EditorView, RecentOpaqueClick>();

/** Preserve a visible blank line when CM maps its row to an adjacent block. */
export function captureEmptyLinePointerSelection(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || event.detail !== 1 || event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = event.target as Element | null;
  if (typeof target?.closest !== "function") return false;
  const line = target.closest<HTMLElement>(".cm-line.jot-live-preview-blank-line");
  if (line === null || !view.contentDOM.contains(line) || line.closest(".jot-live-preview-widget") !== null) return false;
  const offset = view.posAtDOM(line, 0);
  const physical = view.state.doc.lineAt(offset);
  if (physical.from !== offset || (physical.length !== 0 && !/^[ \t]+$/u.test(physical.text))) return false;
  let targetOffset = offset;
  if (physical.length !== 0) {
    const mapped = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    // Keep CM's normal character-level behavior whenever it hits this line.
    if (mapped !== null && mapped >= physical.from && mapped <= physical.to) return false;
    targetOffset = blankLineOffsetAtPoint(view, line, physical, event.clientX, event.clientY);
  }
  beginLivePreviewPointerSelection(view, event, {
    element: line,
    range: { from: physical.from, to: physical.to },
    offset: targetOffset,
  });
  return true;
}

function blankLineOffsetAtPoint(
  view: EditorView,
  line: HTMLElement,
  physical: { readonly from: number; readonly to: number },
  x: number,
  y: number,
): number {
  const document = view.dom.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { readonly offsetNode: Node; readonly offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = document.caretPositionFromPoint?.(x, y);
  const range = caret === null || caret === undefined ? document.caretRangeFromPoint?.(x, y) : undefined;
  const node = caret?.offsetNode ?? range?.startContainer;
  const domOffset = caret?.offset ?? range?.startOffset;
  if (node !== undefined && domOffset !== undefined && line.contains(node)) {
    const sourceOffset = view.posAtDOM(node, domOffset);
    if (sourceOffset >= physical.from && sourceOffset <= physical.to) return sourceOffset;
  }

  // If a browser does not expose a native caret point, use CM's character
  // boundaries. This is only needed after its row hit test missed the line.
  let low = physical.from;
  let high = physical.to;
  const first = view.coordsAtPos(low);
  const last = view.coordsAtPos(high);
  const ascending = first === null || last === null || first.left <= last.left;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const before = view.coordsAtPos(middle);
    const after = view.coordsAtPos(middle + 1);
    if (before === null || after === null) break;
    if ((x < (before.left + after.left) / 2) === ascending) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** One source-selection gesture shared by ordinary widgets and mapped cells. */
export function beginLivePreviewPointerSelection(
  view: EditorView,
  event: MouseEvent,
  target: PreviewPointerTarget,
): void {
  if (event.button !== 0) return;
  cancelLivePreviewPointerSelection(view);
  event.preventDefault();
  event.stopPropagation();
  const source = sourceSnapshot(view);
  const doc = view.state.doc;
  const clicks = Math.max(1, event.detail || 1);
  const offset = safeUtf16Offset(source, clamp(target.offset, target.range.from, target.range.to));
  const initial = previewPointerRange(view.state, offset, clicks, target);
  const anchor = event.shiftKey ? view.state.selection.main.anchor : initial.from;
  const head = event.shiftKey || clicks === 1 ? offset : initial.to;
  const initialAnchor = anchor;
  const initialHead = head;
  if (target.opaque !== undefined) {
    recentOpaqueClicks.set(view, {
      doc, target, x: event.clientX, y: event.clientY, time: event.timeStamp,
    });
  }
  preserveLivePreviewViewport(view, () => {
    dispatchSelection(view, anchor, head);
    view.focus();
  });
  if (anchor === head) {
    target.onActivate?.();
    target.onCaret?.();
  }

  const document = view.dom.ownerDocument;
  const window = document.defaultView;
  let ended = false;
  let moved = false;
  let lastX = event.clientX;
  let lastY = event.clientY;
  const cancel = () => {
    if (ended) return;
    ended = true;
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("mouseup", end, true);
    document.removeEventListener("pointercancel", cancel, true);
    window?.removeEventListener("blur", cancel);
    if (gestures.get(view)?.cancel === cancel) gestures.delete(view);
  };
  const move = (next: MouseEvent) => {
    if (ended) return;
    if (view.state.doc !== doc || next.buttons === 0) {
      cancel();
      return;
    }
    if (!moved && Math.abs(next.clientX - lastX) + Math.abs(next.clientY - lastY) < 3) return;
    moved = true;
    lastX = next.clientX;
    lastY = next.clientY;
    next.preventDefault();
    const point = previewOffsetAtPoint(view, next.clientX, next.clientY);
    if (point === undefined) return;
    let nextAnchor = initialAnchor;
    let nextHead = point.offset;
    if (!event.shiftKey && clicks > 1) {
      const extent = previewPointerRange(view.state, point.offset, clicks, point);
      const backwards = point.offset < Math.min(initialAnchor, initialHead);
      nextAnchor = backwards ? Math.max(initialAnchor, initialHead) : Math.min(initialAnchor, initialHead);
      nextHead = backwards ? extent.from : extent.to;
    }
    dispatchSelection(view, nextAnchor, nextHead);
    // Leave focus in the editor until the pointer gesture finishes.
    if (!view.state.selection.main.empty) view.focus();
  };
  const end = () => {
    cancel();
    if (view.state.doc === doc && !view.state.selection.main.empty) target.onRangeEnd?.();
  };
  gestures.set(view, { element: target.element, cancel });
  document.addEventListener("mousemove", move, true);
  document.addEventListener("mouseup", end, true);
  document.addEventListener("pointercancel", cancel, true);
  window?.addEventListener("blur", cancel);
}

/** Handle a second/third click after the first opaque widget revealed source. */
export function captureRepeatedPreviewPointerSelection(view: EditorView, event: MouseEvent): boolean {
  const recent = recentOpaqueClicks.get(view);
  const element = event.target as Element | null;
  if (event.button !== 0 || event.detail < 2) {
    recentOpaqueClicks.delete(view);
    return false;
  }
  if (recent === undefined || recent.doc !== view.state.doc ||
      event.timeStamp - recent.time > 1_000 ||
      Math.abs(event.clientX - recent.x) + Math.abs(event.clientY - recent.y) > 8 ||
      (typeof element?.closest === "function" && element.closest(".jot-live-preview-widget") !== null)) {
    return false;
  }
  beginLivePreviewPointerSelection(view, event, { ...recent.target, element: view.contentDOM });
  return true;
}

export function cancelLivePreviewPointerSelection(view: EditorView, element?: HTMLElement): void {
  const gesture = gestures.get(view);
  if (element === undefined || gesture !== undefined &&
      (gesture.element === element || element.contains(gesture.element))) gesture?.cancel();
  if (element === undefined) recentOpaqueClicks.delete(view);
}

/** Pure selection extent used by pointer gestures and Unicode regressions. */
export function previewPointerRange(
  state: EditorState,
  offset: number,
  clicks: number,
  target: Pick<PreviewPointerTarget, "opaque" | "lineRange"> = {},
): DomSourceRange {
  if (clicks >= 3) {
    if (target.lineRange !== undefined) return target.lineRange;
    const line = state.doc.lineAt(offset);
    return { from: line.from, to: line.to + (line.number < state.doc.lines ? 1 : 0) };
  }
  if (clicks === 2) {
    if (target.opaque !== undefined) return target.opaque;
    const word = state.wordAt(offset) ?? (offset > 0 ? state.wordAt(offset - 1) : null);
    if (word !== null) return { from: word.from, to: word.to };
  }
  return { from: offset, to: offset };
}

function dispatchSelection(view: EditorView, anchor: number, head: number): void {
  const source = sourceSnapshot(view);
  const safeAnchor = safeUtf16Offset(source, anchor, anchor <= head ? -1 : 1);
  const safeHead = safeUtf16Offset(source, head, anchor <= head ? 1 : -1);
  const current = view.state.selection.main;
  if (view.state.selection.ranges.length === 1 &&
      current.anchor === safeAnchor && current.head === safeHead) return;
  view.dispatch({
    selection: EditorSelection.single(safeAnchor, safeHead),
    userEvent: "select.pointer",
  });
}

function previewOffsetAtPoint(view: EditorView, x: number, y: number): {
  readonly offset: number;
  readonly opaque?: DomSourceRange;
  readonly lineRange?: DomSourceRange;
} | undefined {
  const document = view.dom.ownerDocument;
  const hit = document.elementFromPoint(x, y);
  if (hit !== null && view.dom.contains(hit)) {
    const blank = hit.closest<HTMLElement>(".cm-line.jot-live-preview-blank-line");
    if (blank !== null && view.contentDOM.contains(blank)) {
      const start = view.posAtDOM(blank, 0);
      const physical = view.state.doc.lineAt(start);
      if (physical.from === start && (physical.length === 0 || /^[ \t]+$/u.test(physical.text))) {
        const mapped = view.posAtCoords({ x, y }, false);
        if (mapped === null || mapped < physical.from || mapped > physical.to) {
          return { offset: physical.length === 0 ? start : blankLineOffsetAtPoint(view, blank, physical, x, y) };
        }
      }
    }
    const cell = hit.closest<HTMLElement>(".jot-table-cell[data-jot-source-from]");
    const widget = hit.closest<HTMLElement>(".jot-live-preview-widget[data-jot-source-from]");
    const element = cell ?? widget;
    const range = element === null ? undefined : readDomSourceRange(element);
    if (element !== null && range !== undefined) {
      const opaqueElement = hit.closest<HTMLElement>(
        '[data-jot-kind="inline-math"], [data-jot-kind="math-block"], [data-jot-kind="image"]',
      );
      const opaque = opaqueElement === null ? undefined : readDomSourceRange(opaqueElement);
      return {
        offset: sourceOffsetAtPoint(element, x, y, range),
        ...(opaque === undefined ? {} : { opaque }),
        ...(cell === null ? {} : { lineRange: range }),
      };
    }
  }
  const offset = view.posAtCoords({ x, y }, false);
  return offset === null ? undefined : { offset };
}

function clamp(value: number, from: number, to: number): number {
  return Math.max(from, Math.min(to, value));
}
