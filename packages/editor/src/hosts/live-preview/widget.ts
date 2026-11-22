import type { RenderAttribute, RenderContent, RenderNode, RenderValue } from "@jot-md/editor-protocol";
import { EditorView, WidgetType } from "@codemirror/view";
import { sourceOffsetAtPoint } from "../../components/common/dom-position.js";
import { rangeAttribute } from "../../components/common/dom-renderer.js";
import { safeUtf16Offset } from "../../components/common/render-utils.js";
import type { RenderRuntime } from "../../render/runtime/dom-runtime.js";
import type { LivePreviewWidgetDescriptor } from "./types.js";
import { sourceSnapshot } from "../shared/source-snapshot.js";
import {
  beginLivePreviewPointerSelection,
  cancelLivePreviewPointerSelection,
} from "./pointer-selection.js";

/**
 * CodeMirror 的唯一 widget 桥接。
 *
 * widget 只负责把 Rust RenderNode 交给共享 Runtime，并在 CodeMirror 保留该
 * widget 时调用 Runtime.update/dispose；它不拼装 table DOM，也不保存 cell 的
 * 第二份输入值。所有语义节点都必须通过同一个 Runtime renderer。
 */
export class LivePreviewWidget extends WidgetType {
  readonly #from: number;
  readonly #to: number;
  readonly #descriptor: LivePreviewWidgetDescriptor;
  readonly #runtime: RenderRuntime;
  readonly #onActivate: (view: EditorView, from: number, to: number) => void;
  #mounted = false;
  #element: HTMLElement | undefined;
  #view: EditorView | undefined;

  constructor(
    from: number,
    to: number,
    descriptor: LivePreviewWidgetDescriptor,
    runtime: RenderRuntime,
    onActivate: (view: EditorView, from: number, to: number) => void,
  ) {
    super();
    this.#from = from;
    this.#to = to;
    this.#descriptor = descriptor;
    this.#runtime = runtime;
    this.#onActivate = onActivate;
  }

  eq(other: LivePreviewWidget): boolean {
    const sameIdentity = this.#runtime === other.#runtime &&
      this.#from === other.#from &&
      this.#descriptor.kind === other.#descriptor.kind &&
      // DOM 外壳的身份必须与 RenderRuntime 完全一致。仅比较 id 和
      // contentVersion 会漏掉 heading level、list type 等会改变元素形状的
      // RenderNode 属性，导致 CodeMirror 复用旧 shell 后再触发 Runtime 错误。
      this.#runtime.key(this.#descriptor.node) ===
        other.#runtime.key(other.#descriptor.node) &&
      this.#descriptor.block === other.#descriptor.block &&
      this.#descriptor.selection === other.#descriptor.selection &&
      this.#descriptor.geometry === other.#descriptor.geometry &&
      this.#descriptor.sourceCompanion === other.#descriptor.sourceCompanion &&
      this.#descriptor.inPlaceUpdate === other.#descriptor.inPlaceUpdate;
    if (!sameIdentity) return false;
    // A mounted component with an explicit in-place boundary (currently the
    // shared table root) must not turn every content edit into a CodeMirror
    // HeightMap replacement merely because its PreText prediction changed.
    // The extension forwards the new RenderNode to RenderRuntime separately;
    // ResizeObserver remains the authority for an already mounted DOM height.
    if (this.#descriptor.inPlaceUpdate === true) {
      if (this.#mounted) {
        // CodeMirror transfers the DOM tile to `other` after `eq()` succeeds.
        // Carry the mounted fact as well: a later descriptor update must keep
        // using the in-place path, while an offscreen widget still needs its
        // newest descriptor/PreText estimate written into the HeightMap.
        this.#transferDOM(other);
        return true;
      }
      return this.#descriptor.node.contentVersion === other.#descriptor.node.contentVersion &&
        Number(this.#descriptor.node.sourceRange.from) ===
          Number(other.#descriptor.node.sourceRange.from) &&
        Number(this.#descriptor.node.sourceRange.to) ===
          Number(other.#descriptor.node.sourceRange.to) &&
        this.#descriptor.node.childCount === other.#descriptor.node.childCount &&
        this.#descriptor.selected === other.#descriptor.selected &&
        this.#descriptor.estimatedHeight === other.#descriptor.estimatedHeight;
    }
    const before = this.#descriptor.node;
    const after = other.#descriptor.node;
    const equal = this.#to === other.#to &&
      this.#descriptor.selected === other.#descriptor.selected &&
      this.#descriptor.estimatedHeight === other.#descriptor.estimatedHeight &&
      (before === after || (
        before.contentVersion === after.contentVersion &&
        before.sourceRange.from === after.sourceRange.from &&
        before.sourceRange.to === after.sourceRange.to &&
        before.childCount === after.childCount &&
        sameRenderAttributes(before.attributes, after.attributes) &&
        sameRenderContent(before.content, after.content)
      ));
    if (equal) this.#transferDOM(other);
    return equal;
  }

  #transferDOM(other: LivePreviewWidget): void {
    other.#mounted = this.#mounted;
    other.#element = this.#element;
    other.#view = this.#view;
    if (this.#element !== undefined) widgetOwners.set(this.#element, other);
  }

  get estimatedHeight(): number {
    if (!this.#descriptor.block) return -1;
    if (this.#descriptor.inPlaceUpdate === true) {
      const measured = inPlaceMeasuredHeights.get(this.#runtime)?.get(inPlaceGeometryKey(this.#descriptor));
      if (measured !== undefined) return measured;
    }
    return this.#descriptor.estimatedHeight ?? -1;
  }

  /**
   * 普通 Preview block 是 CodeMirror 的可视投影，而不是可编辑 DOM。交互由
   * widget 自己的 mousedown bridge 映射回唯一 source selection；若让 CM
   * 继续处理该事件，它会把 replacement 的任意坐标折算成 block 边界，随后
   * 输入会落到 table/table 后的错误源码位置。
   *
   * mapped table 仍允许内部 TableGrid 接收原生 pointer 事件，但 CM 本身不能
   * 以 widget 边界覆盖它，所以这里也返回 true。
   */
  ignoreEvent(event: Event): boolean {
    // Keep keyboard/input events owned by CodeMirror. Only mouse/drag
    // selection must be isolated from a replacement widget's opaque range.
    return event.type === "mousedown" ||
      event.type === "mouseup" ||
      event.type === "click" ||
      event.type === "pointerdown" ||
      event.type === "pointerup" ||
      event.type === "pointermove" ||
      event.type === "dragstart" ||
      event.type === "selectstart";
  }

  toDOM(view: EditorView): HTMLElement {
    if (this.#descriptor.geometry === true) return this.#geometryDOM(view);
    const element = this.#runtime.mount(this.#descriptor.node);
    this.#mounted = true;
    this.#element = element;
    this.#view = view;
    widgetOwners.set(element, this);
    element.dataset["jotSourceFrom"] = String(this.#descriptor.node.sourceRange.from);
    element.dataset["jotSourceTo"] = String(this.#descriptor.node.sourceRange.to);
    if (this.#descriptor.inPlaceUpdate === true) {
      element.dataset["jotLiveInPlaceKey"] = inPlaceWidgetKey(
        this.#from,
        this.#to,
        this.#descriptor,
      );
      element.dataset["jotLiveInPlaceId"] = this.#descriptor.node.id;
    }
    element.classList.add(
      "jot-live-preview-widget",
      `jot-live-preview-widget--${this.#descriptor.kind}`,
      ...(this.#descriptor.block ? ["jot-live-preview-widget--block"] : []),
      ...(this.#descriptor.sourceCompanion === true
        ? ["jot-live-preview-widget--source-companion"]
        : []),
      ...(this.#descriptor.selected === true ? ["jot-live-preview-widget--selected"] : []),
    );
    if (this.#descriptor.block) {
      element.style.setProperty(
        "--jot-live-preview-block-gap",
        `${blockGapPixels(view)}px`,
      );
    }
    if (
      this.#descriptor.block ||
      this.#descriptor.kind === "image" ||
      this.#descriptor.kind === "inline-math"
    ) this.#observeGeometry(element, view);
    element.addEventListener("mousedown", (event) => {
      const current = widgetOwners.get(element);
      if (current === undefined) return;
      if (event.button !== 0 || isComponentInteractiveTarget(event.target)) return;
      if (current.#descriptor.block && !isInsideBlockActivationArea(element, event)) {
        // Tail gap / bottom boundary is document separation, not content of
        // either adjacent block. Never infer a neighbor from a naked cm-line
        // click here; that was the source of blank-line → code-block errors.
        // Consume the pointer so CodeMirror cannot resolve this non-content
        // pixel to an adjacent replacement boundary either.
        event.preventDefault();
        event.stopPropagation();
        view.focus();
        return;
      }
      event.preventDefault();
      // 非 mapped widget 的源码区间被 CodeMirror 视为 atomic。先阻止外层
      // CM mouse selection 把它改成 widget 边界，再用同一源区间激活源码。
      // table 是 mapped，由它自己的 cell adapter 继续接收冒泡事件。
      if (current.#descriptor.selection !== "mapped") event.stopPropagation();
      const sourceFrom = Number(current.#descriptor.node.sourceRange.from);
      const sourceTo = Number(current.#descriptor.node.sourceRange.to);
      const contentRange = rangeAttribute(current.#descriptor.node, "contentRange");
      // 数学块的可见 DOM（尤其是 KaTeX）不是源码字符的同形文本，不能把
      // 渲染后的字形索引当成 Markdown 偏移。激活公式时进入 contentRange
      // 的起点，保证 ArrowUp/Down 首先沿公式源码的物理行移动，而不是
      // 从 `$$`/`\[ ` 的块首直接跳到上一个普通块。
      const visualRange = contentRange === undefined
        ? { from: sourceFrom, to: sourceTo }
        : { from: Number(contentRange.from), to: Number(contentRange.to) };
      // CodeMirror 没有替换 widget 内部的文本 DOM，posAtCoords 只能得到
      // widget 边界，不能把 Preview 的视觉字符映射回源码。优先在共享
      // RenderRuntime 生成的 source anchor 内计算局部偏移，失败时回到块起点。
      const fallback = activationFallbackOffset(
        element,
        event.clientX,
        visualRange,
      );
      const offset = current.#descriptor.kind === "math-block" ||
        current.#descriptor.kind === "inline-math" ||
        current.#descriptor.kind === "plugin-block"
        ? safeUtf16Offset(sourceSnapshot(view), visualRange.from)
        : safeUtf16Offset(sourceSnapshot(view), sourceOffsetAtPoint(
          element,
          event.clientX,
          event.clientY,
          visualRange,
          fallback.from,
        ));
      beginLivePreviewPointerSelection(view, event, {
        element,
        range: visualRange,
        offset,
        ...(["math-block", "inline-math", "image", "thematic-break", "plugin-block"].includes(current.#descriptor.kind)
          ? { opaque: { from: sourceFrom, to: sourceTo } }
          : {}),
        ...(current.#descriptor.selection === "mapped"
          ? {}
          : { onActivate: () => {
            const owner = widgetOwners.get(element);
            if (owner !== undefined) owner.#onActivate(view, sourceFrom, sourceTo);
          } }),
      });
    }, { capture: true });
    // Mapped widgets (currently table-root) delegate cell pointer mapping to
    // their component DOM. CodeMirror still sees replacement widgets as one
    // opaque position unless the widget explicitly stops its own bubbling
    // event after the component's listener has selected the precise cell.
    // Listen in bubble phase so TableGrid's listener runs first.
    if (this.#descriptor.selection === "mapped") {
      element.addEventListener("mousedown", (event) => {
        const owner = widgetOwners.get(element);
        if (owner === undefined || owner.#descriptor.selection !== "mapped") return;
        if (event.defaultPrevented) return;
        event.stopPropagation();
      });
    }
    return element;
  }

  updateDOM(dom: HTMLElement): boolean {
    if (this.#descriptor.geometry === true) {
      if (!dom.classList.contains("jot-live-preview-widget--geometry")) return false;
      this.#updateGeometryDOM(dom);
      return true;
    }
    if (dom.classList.contains("jot-live-preview-widget--geometry")) return false;
    // CodeMirror 可能在异步 decoration 更新与 widget 生命周期交错时短暂保留
    // stale DOM。返回 false 会让它按新的 descriptor 重建，而不是把不兼容的
    // shell 强行交给 Runtime.update。
    if (dom.dataset["jotRenderKey"] !== this.#runtime.key(this.#descriptor.node)) {
      return false;
    }
    this.#mounted = true;
    this.#element = dom;
    widgetOwners.set(dom, this);
    this.#runtime.update(dom, this.#descriptor.node);
    dom.dataset["jotSourceFrom"] = String(this.#descriptor.node.sourceRange.from);
    dom.dataset["jotSourceTo"] = String(this.#descriptor.node.sourceRange.to);
    if (this.#descriptor.inPlaceUpdate === true) {
      dom.dataset["jotLiveInPlaceKey"] = inPlaceWidgetKey(
        this.#from,
        this.#to,
        this.#descriptor,
      );
      dom.dataset["jotLiveInPlaceId"] = this.#descriptor.node.id;
    }
    dom.classList.toggle("jot-live-preview-widget--selected", this.#descriptor.selected === true);
    dom.classList.toggle(
      "jot-live-preview-widget--source-companion",
      this.#descriptor.sourceCompanion === true,
    );
    return true;
  }

  destroy(dom: HTMLElement): void {
    if (this.#view !== undefined) cancelLivePreviewPointerSelection(this.#view, dom);
    this.#view = undefined;
    this.#mounted = false;
    this.#element = undefined;
    widgetOwners.delete(dom);
    geometryObservers.get(dom)?.disconnect();
    geometryObservers.delete(dom);
    measuredHeights.delete(dom);
    if (this.#descriptor.inPlaceUpdate === true) {
      inPlaceMeasuredHeights.get(this.#runtime)?.delete(inPlaceGeometryKey(this.#descriptor));
    }
    if (this.#descriptor.geometry !== true) this.#runtime.disposeSubtree(dom);
  }

  #geometryDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement("div");
    element.className = [
      "jot-live-preview-widget",
      `jot-live-preview-widget--${this.#descriptor.kind}`,
      "jot-live-preview-widget--block",
      "jot-live-preview-widget--geometry",
    ].join(" ");
    this.#updateGeometryDOM(element);
    return element;
  }

  #updateGeometryDOM(element: HTMLElement): void {
    const height = Math.max(1, this.#descriptor.estimatedHeight ?? 1);
    element.dataset["jotRenderKey"] = this.#runtime.key(this.#descriptor.node);
    element.dataset["jotGeometry"] = "true";
    element.setAttribute("aria-hidden", "true");
    element.style.height = `${height}px`;
    element.style.minHeight = `${height}px`;
  }

  #observeGeometry(element: HTMLElement, view: EditorView): void {
    const ResizeObserverType = element.ownerDocument.defaultView?.ResizeObserver;
    const requestMeasure = () => {
      const current = widgetOwners.get(element);
      if (current === undefined) return;
      // Inline image/math widgets replace source inside a real CodeMirror line.
      // The line shell also owns its root-block padding/boundary, so caching only
      // the child element under-reserves the active source shell (5px with the
      // default metrics). Block widgets already own their complete border box.
      const measured = current.#descriptor.block
        ? element
        : element.closest<HTMLElement>(".cm-line") ?? element;
      const height = Math.round(measured.getBoundingClientRect().height * 100) / 100;
      const previous = measuredHeights.get(element) ?? -1;
      if (height <= 0) return;
      measuredHeights.set(element, height);
      rememberRenderedHeight(current.#runtime, current.#descriptor.node, height);
      if (current.#descriptor.inPlaceUpdate === true) {
        const heights = inPlaceMeasuredHeights.get(current.#runtime) ?? new Map<string, number>();
        heights.set(inPlaceGeometryKey(current.#descriptor), height);
        inPlaceMeasuredHeights.set(current.#runtime, heights);
      }
      if (Math.abs(height - previous) < 0.25) return;
      // requestMeasure 而不是同步 dispatch：CodeMirror 会在自己的 measurement
      // phase 重算 block widget 的垂直布局，避免图片、KaTeX、TableGrid 等异步
      // 高度变化和 viewport/projection 形成反馈环。
      view.requestMeasure({
        key: element,
        read: () => undefined,
      });
    };
    if (ResizeObserverType === undefined) {
      queueMicrotask(requestMeasure);
      return;
    }
    geometryObservers.get(element)?.disconnect();
    const observer = new ResizeObserverType(requestMeasure);
    geometryObservers.set(element, observer);
    observer.observe(element);
    queueMicrotask(requestMeasure);
  }
}

/**
 * CodeMirror may transfer a widget DOM tile to a fresh WidgetType instance
 * after `eq()`/`updateDOM()`. Geometry observers therefore belong to the DOM
 * shell, not a particular transient widget descriptor instance.
 */
const geometryObservers = new WeakMap<HTMLElement, ResizeObserver>();
const widgetOwners = new WeakMap<HTMLElement, LivePreviewWidget>();
const measuredHeights = new WeakMap<HTMLElement, number>();
/**
 * A mounted component may survive a CodeMirror document change while its
 * replacement range is remapped. Reuse its last browser-measured height as
 * the next HeightMap estimate, rather than dropping back to a fresh PreText
 * guess for every cell keystroke.
 */
const inPlaceMeasuredHeights = new WeakMap<RenderRuntime, Map<string, number>>();
const renderedHeights = new WeakMap<RenderRuntime, Map<string, number>>();

/** Last mounted browser geometry used only for the immediate source reveal. */
export function measuredLivePreviewSubtreeHeight(
  runtime: RenderRuntime,
  node: RenderNode,
): number | undefined {
  const measurements = renderedHeights.get(runtime);
  if (measurements === undefined) return undefined;
  let maximum = measurements.get(renderedHeightKey(node));
  if (node.content.type === "structured") {
    for (const child of node.content.children) {
      const measured = measuredLivePreviewSubtreeHeight(runtime, child);
      if (measured !== undefined) maximum = Math.max(maximum ?? 0, measured);
    }
  }
  return maximum;
}

export function clearMeasuredLivePreviewHeights(runtime: RenderRuntime): void {
  renderedHeights.delete(runtime);
  inPlaceMeasuredHeights.delete(runtime);
}

function rememberRenderedHeight(
  runtime: RenderRuntime,
  node: RenderNode,
  height: number,
): void {
  const measurements = renderedHeights.get(runtime) ?? new Map<string, number>();
  measurements.delete(renderedHeightKey(node));
  measurements.set(renderedHeightKey(node), height);
  renderedHeights.set(runtime, measurements);
  while (measurements.size > 2_048) {
    const oldest = measurements.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    measurements.delete(oldest);
  }
}

function renderedHeightKey(node: RenderNode): string {
  return `${node.id}:${node.kind}:${node.contentVersion}`;
}

function isComponentInteractiveTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === "function" &&
    element.closest(
      "[data-jot-interaction], a, button, [role=button], .jot-table-toolbar, .jot-table-column-resize",
    ) !== null;
}

function activationFallbackOffset(
  element: HTMLElement,
  clientX: number,
  range: { readonly from: number; readonly to: number },
): { readonly from: number; readonly to: number } {
  // Browser caret-at-point APIs occasionally resolve a click in a block
  // widget's empty right content area to its wrapper rather than to a semantic
  // text child. Preserve the user's horizontal intent in that fallback:
  // right half -> source end, left half -> source start. When the browser can
  // resolve a real semantic text anchor, `sourceOffsetAtPoint` ignores this
  // fallback and returns the precise UTF-16 offset instead.
  const rect = element.getBoundingClientRect();
  const end = clientX >= rect.left + rect.width / 2;
  const offset = end ? range.to : range.from;
  return { from: offset, to: offset };
}

function isInsideBlockActivationArea(element: HTMLElement, event: MouseEvent): boolean {
  const rect = element.getBoundingClientRect();
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element);
  const gap = cssPixels(styles?.getPropertyValue("--jot-live-preview-block-gap"));
  const boundary = cssPixels(styles?.borderBlockEndWidth);
  // `padding-block-end` includes both semantic end padding (quote/code/math)
  // and the shared block gap. Removing only the latter keeps clicks inside
  // semantic padding editable while excluding the document separator.
  const contentBottom = rect.bottom - gap - boundary;
  return event.clientY >= rect.top && event.clientY <= contentBottom;
}

function blockGapPixels(view: EditorView): number {
  const value = view.dom.ownerDocument.defaultView?.getComputedStyle(view.contentDOM)
    .getPropertyValue("--jot-live-preview-block-gap");
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 12;
}

function inPlaceWidgetKey(
  from: number,
  to: number,
  descriptor: LivePreviewWidgetDescriptor,
): string {
  return `${from}:${to}:${descriptor.kind}:${descriptor.node.id}`;
}

function inPlaceGeometryKey(descriptor: LivePreviewWidgetDescriptor): string {
  return `${descriptor.kind}:${descriptor.node.id}`;
}

function cssPixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function sameRenderNode(left: RenderNode, right: RenderNode): boolean {
  if (left === right) return true;
  return left.id === right.id &&
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.contentVersion === right.contentVersion &&
    left.sourceRange.from === right.sourceRange.from &&
    left.sourceRange.to === right.sourceRange.to &&
    left.childCount === right.childCount &&
    sameRenderAttributes(left.attributes, right.attributes) &&
    sameRenderContent(left.content, right.content);
}

function sameRenderAttributes(
  left: readonly RenderAttribute[],
  right: readonly RenderAttribute[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.name !== b.name || !sameRenderValue(a.value, b.value)) return false;
  }
  return true;
}

function sameRenderValue(left: RenderValue, right: RenderValue): boolean {
  if (left === right) return true;
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "string":
    case "number":
    case "boolean":
      return Object.is(left.value, (right as typeof left).value);
    case "range": {
      const other = (right as typeof left).value;
      return left.value.from === other.from && left.value.to === other.to;
    }
    case "strings": {
      const other = (right as typeof left).value;
      if (left.value.length !== other.length) return false;
      for (let index = 0; index < left.value.length; index += 1) {
        if (left.value[index] !== other[index]) return false;
      }
      return true;
    }
    case "numbers": {
      const other = (right as typeof left).value;
      if (left.value.length !== other.length) return false;
      for (let index = 0; index < left.value.length; index += 1) {
        if (left.value[index] !== other[index]) return false;
      }
      return true;
    }
  }
}

function sameRenderContent(left: RenderContent, right: RenderContent): boolean {
  if (left === right) return true;
  if (left.type !== right.type) return false;
  if (left.type !== "structured" || right.type !== "structured") return true;
  if (left.children.length !== right.children.length) return false;
  for (let index = 0; index < left.children.length; index += 1) {
    if (!sameRenderNode(left.children[index]!, right.children[index]!)) return false;
  }
  return true;
}
