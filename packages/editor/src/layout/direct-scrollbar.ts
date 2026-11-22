export type EditorScrollbarMode = "native" | "direct";

export interface DirectScrollbarOptions {
  readonly scrollElement: HTMLElement;
  readonly contentElement: HTMLElement;
  /** A positioned wrapper can keep the track inside an external panel or a shadow root. */
  readonly trackHost?: HTMLElement;
  readonly label?: string;
  readonly minThumbSize?: number;
  readonly installStyles?: boolean;
  /** 通知宿主并标明手势是否明确指向文末，随后写入 scrollTop。 */
  readonly onUserScroll?: (atEnd: boolean) => void;
}

interface ScrollMetrics {
  readonly track: DOMRect;
  readonly trackStart: number;
  readonly thumbSize: number;
  readonly maxThumbOffset: number;
  readonly maxScroll: number;
  readonly scrollOffset: number;
  readonly viewportSize: number;
}

interface DragState {
  readonly pointerId: number;
  readonly offset: number;
}

/**
 * 为任意单一滚动轴宿主提供按比例定位的垂直滚动条。
 *
 * 原生滚动条的轨道点击由浏览器和操作系统决定，不能可靠地统一为“跳到
 * 点击比例”。这个控件只接管轨道和拖拽手势，实际 scrollTop 仍由浏览器维护，
 * 因而不会复制虚拟轴或改变上下 spacer 的职责。
 */
export class DirectScrollbar {
  readonly #scrollElement: HTMLElement;
  readonly #track: HTMLDivElement;
  readonly #thumb: HTMLDivElement;
  readonly #view: Window | undefined;
  readonly #resizeObserver: ResizeObserver | undefined;
  readonly #minThumbSize: number;
  readonly #local: boolean;
  readonly #onUserScroll: DirectScrollbarOptions["onUserScroll"];
  readonly #onScroll = () => this.schedule();
  readonly #onResize = () => this.schedule();
  readonly #onPointerDown = (event: PointerEvent) => this.#pointerDown(event);
  readonly #onPointerMove = (event: PointerEvent) => this.#pointerMove(event);
  readonly #onPointerEnd = (event: PointerEvent) => this.#pointerEnd(event);
  readonly #onKeyDown = (event: KeyboardEvent) => this.#keyDown(event);
  #drag: DragState | undefined;
  #frame: number | undefined;
  #enabled = true;
  #disposed = false;

  constructor(options: DirectScrollbarOptions) {
    this.#scrollElement = options.scrollElement;
    this.#onUserScroll = options.onUserScroll;
    this.#view = options.scrollElement.ownerDocument.defaultView ?? undefined;
    this.#minThumbSize = positive(options.minThumbSize, 30);
    this.#local = options.trackHost !== undefined;
    if (options.installStyles !== false) {
      const root = options.trackHost?.getRootNode();
      installDirectScrollbarStyles(root && "host" in root ? root as ShadowRoot : options.scrollElement.ownerDocument);
    }
    this.#track = options.scrollElement.ownerDocument.createElement("div");
    this.#track.className = this.#local ? "jot-direct-scrollbar jot-direct-scrollbar--local" : "jot-direct-scrollbar";
    this.#track.setAttribute("role", "scrollbar");
    this.#track.setAttribute("aria-orientation", "vertical");
    this.#track.setAttribute("aria-label", options.label ?? "垂直滚动条");
    this.#track.tabIndex = 0;
    if (options.scrollElement.id !== "") {
      this.#track.setAttribute("aria-controls", options.scrollElement.id);
    }
    this.#thumb = options.scrollElement.ownerDocument.createElement("div");
    this.#thumb.className = "jot-direct-scrollbar__thumb";
    this.#thumb.setAttribute("role", "presentation");
    this.#track.append(this.#thumb);
    (options.trackHost ?? options.scrollElement.ownerDocument.body ?? options.scrollElement.ownerDocument.documentElement)
      .append(this.#track);
    options.scrollElement.classList.add("jot-direct-scrollbar-host");
    options.scrollElement.addEventListener("scroll", this.#onScroll, { passive: true });
    this.#track.addEventListener("pointerdown", this.#onPointerDown);
    this.#track.addEventListener("pointermove", this.#onPointerMove);
    this.#track.addEventListener("pointerup", this.#onPointerEnd);
    this.#track.addEventListener("pointercancel", this.#onPointerEnd);
    this.#track.addEventListener("keydown", this.#onKeyDown);
    this.#view?.addEventListener("resize", this.#onResize, { passive: true });
    this.#view?.addEventListener("scroll", this.#onResize, { passive: true });
    const ResizeObserverConstructor = options.scrollElement.ownerDocument.defaultView?.ResizeObserver;
    this.#resizeObserver = ResizeObserverConstructor === undefined
      ? undefined
      // ResizeObserver runs after layout, before paint. The fixed track is
      // outside the observed content, so it can adopt this geometry now.
      : new ResizeObserverConstructor(() => this.#update());
    this.#resizeObserver?.observe(options.scrollElement);
    this.#resizeObserver?.observe(options.contentElement);
    this.#update();
  }

  schedule(): void {
    if (this.#disposed || this.#frame !== undefined) return;
    if (this.#view === undefined) {
      this.#update();
      return;
    }
    this.#frame = this.#view.requestAnimationFrame(() => {
      this.#frame = undefined;
      this.#update();
    });
  }

  /**
   * Preview 与 Live Preview 可以分别拥有自己的 scrollDOM，但同一时刻只能
   * 有一个宿主可见。隐藏宿主时保留控件实例和观察器、仅撤下 fixed track，
   * 避免切换模式后在 body 上遗留两条重叠的直接滚动条。
   */
  setEnabled(enabled: boolean): void {
    if (this.#disposed || enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) {
      this.#drag = undefined;
      this.#track.style.display = "none";
      // A disabled host must fall back to its platform scrollbar. Live
      // Preview is attached even while split/source mode is visible, so merely
      // hiding the custom track would otherwise leave that CodeMirror pane
      // with no scrollbar at all.
      this.#scrollElement.classList.remove("jot-direct-scrollbar-host");
      return;
    }
    this.#scrollElement.classList.add("jot-direct-scrollbar-host");
    this.schedule();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#frame !== undefined) this.#view?.cancelAnimationFrame(this.#frame);
    this.#scrollElement.removeEventListener("scroll", this.#onScroll);
    this.#track.removeEventListener("pointerdown", this.#onPointerDown);
    this.#track.removeEventListener("pointermove", this.#onPointerMove);
    this.#track.removeEventListener("pointerup", this.#onPointerEnd);
    this.#track.removeEventListener("pointercancel", this.#onPointerEnd);
    this.#track.removeEventListener("keydown", this.#onKeyDown);
    this.#view?.removeEventListener("resize", this.#onResize);
    this.#view?.removeEventListener("scroll", this.#onResize);
    this.#resizeObserver?.disconnect();
    this.#track.remove();
    this.#scrollElement.classList.remove("jot-direct-scrollbar-host");
  }

  #pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.#disposed) return;
    const metrics = this.#metrics();
    if (metrics.maxScroll <= 0 || metrics.track.height <= 0) return;
    event.preventDefault();
    if (event.target === this.#thumb) {
      this.#onUserScroll?.(false);
      const thumbTop = this.#thumb.getBoundingClientRect().top;
      this.#drag = {
        pointerId: event.pointerId,
        offset: event.clientY - thumbTop,
      };
      this.#track.setPointerCapture?.(event.pointerId);
      return;
    }
    this.#setFromClientY(event.clientY, metrics.thumbSize / 2, metrics);
  }

  #pointerMove(event: PointerEvent): void {
    if (this.#drag?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.#setFromClientY(event.clientY, this.#drag.offset, this.#metrics());
  }

  #pointerEnd(event: PointerEvent): void {
    if (this.#drag?.pointerId !== event.pointerId) return;
    this.#drag = undefined;
    if (this.#track.hasPointerCapture?.(event.pointerId)) {
      this.#track.releasePointerCapture?.(event.pointerId);
    }
  }

  #keyDown(event: KeyboardEvent): void {
    const metrics = this.#metrics();
    const maximum = metrics.maxScroll;
    const page = Math.max(1, metrics.viewportSize * 0.9);
    let target: number | undefined;
    switch (event.key) {
      case "Home": target = 0; break;
      case "End": target = maximum; break;
      case "ArrowUp": target = metrics.scrollOffset - 40; break;
      case "ArrowDown": target = metrics.scrollOffset + 40; break;
      case "PageUp": target = metrics.scrollOffset - page; break;
      case "PageDown": target = metrics.scrollOffset + page; break;
      default: return;
    }
    event.preventDefault();
    const next = clamp(target, 0, maximum);
    this.#setScrollOffset(next, metrics);
    this.schedule();
  }

  #setFromClientY(clientY: number, offset: number, metrics: ScrollMetrics): void {
    const position = clamp(
      clientY - metrics.trackStart - offset,
      0,
      metrics.maxThumbOffset,
    );
    const ratio = metrics.maxThumbOffset === 0 ? 0 : position / metrics.maxThumbOffset;
    const next = ratio * metrics.maxScroll;
    this.#setScrollOffset(next, metrics);
    this.schedule();
  }

  #setScrollOffset(offset: number, metrics: ScrollMetrics): void {
    const atEnd = metrics.maxScroll > 0 && offset === metrics.maxScroll;
    if (offset === metrics.scrollOffset && !atEnd) return;
    this.#onUserScroll?.(atEnd);
    this.#scrollElement.scrollTop = offset;
  }

  #metrics(): ScrollMetrics {
    const track = this.#track.getBoundingClientRect();
    const style = this.#view?.getComputedStyle(this.#track);
    // 外框尺寸包含 border/padding，而 thumb 的布局起点在轨道内容区；两者不能共用同一条轴。
    const leadingInset = cssPixels(style?.borderTopWidth) + cssPixels(style?.paddingTop);
    const trailingInset = cssPixels(style?.borderBottomWidth) + cssPixels(style?.paddingBottom);
    const trackLength = Math.max(0, track.height - leadingInset - trailingInset);
    const viewport = this.#scrollElement.clientHeight;
    const content = Math.max(viewport, this.#scrollElement.scrollHeight);
    const maxScroll = Math.max(0, content - viewport);
    const scrollOffset = clamp(this.#scrollElement.scrollTop, 0, maxScroll);
    const thumbSize = Math.min(
      Math.max(this.#minThumbSize, trackLength * viewport / Math.max(1, content)),
      trackLength,
    );
    return {
      track,
      trackStart: track.top + leadingInset,
      thumbSize,
      maxThumbOffset: Math.max(0, trackLength - thumbSize),
      maxScroll,
      scrollOffset,
      viewportSize: viewport,
    };
  }

  #update(): void {
    if (this.#disposed) return;
    if (!this.#enabled) {
      this.#track.style.display = "none";
      return;
    }
    if (this.#scrollElement.clientHeight <= 8 || this.#scrollElement.scrollHeight - this.#scrollElement.clientHeight <= 1) {
      this.#track.style.display = "none";
      return;
    }
    // Measure the current track, not its previous frame (or a hidden zero
    // box). A viewport resize can change the visible track without resizing
    // the scroll element, so no later ResizeObserver callback is guaranteed.
    if (!this.#local) {
      const root = this.#scrollElement.getBoundingClientRect();
      const top = Math.max(0, root.top + 4);
      const bottom = Math.min(this.#view?.innerHeight ?? root.bottom, root.bottom - 4);
      if (bottom <= top) { this.#track.style.display = "none"; return; }
      this.#track.style.top = `${top}px`;
      this.#track.style.left = `${Math.max(0, root.right - 16)}px`;
      this.#track.style.height = `${bottom - top}px`;
      this.#track.style.width = "12px";
    }
    this.#track.style.display = "block";
    const metrics = this.#metrics();
    const position = metrics.maxScroll === 0
      ? 0
      : metrics.scrollOffset / metrics.maxScroll * metrics.maxThumbOffset;
    this.#thumb.style.height = `${metrics.thumbSize}px`;
    this.#thumb.style.transform = `translateY(${clamp(position, 0, metrics.maxThumbOffset)}px)`;
    const ratio = metrics.maxScroll === 0 ? 0 : metrics.scrollOffset / metrics.maxScroll;
    this.#track.setAttribute("aria-valuemin", "0");
    this.#track.setAttribute("aria-valuemax", String(Math.round(metrics.maxScroll)));
    this.#track.setAttribute("aria-valuenow", String(metrics.scrollOffset));
    this.#track.setAttribute("aria-valuetext", `${Math.round(ratio * 100)}%`);
  }
}

export function installDirectScrollbarStyles(root: Document | ShadowRoot): HTMLStyleElement {
  const existing = root.querySelector<HTMLStyleElement>("style[data-jot-direct-scrollbar]");
  if (existing !== null) return existing;
  const document = "host" in root ? root.ownerDocument : root;
  const style = document.createElement("style");
  style.dataset["jotDirectScrollbar"] = "true";
  style.textContent = DIRECT_SCROLLBAR_CSS;
  ("host" in root ? root : document.head ?? document.documentElement).append(style);
  return style;
}

export const DIRECT_SCROLLBAR_CSS = `
/* Reserve the track's 12px width and 4px inset in layout. An overlay without
   this gutter hides text and formulas that legitimately fit the content box. */
.jot-direct-scrollbar-host{scrollbar-width:none;scrollbar-gutter:auto;box-sizing:border-box;border-right:16px solid transparent}
.jot-direct-scrollbar-host::-webkit-scrollbar{width:0;height:0}
.jot-direct-scrollbar{position:fixed;z-index:30;box-sizing:border-box;display:none;padding:2px;
  overflow:hidden;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:0;
  background:color-mix(in srgb,Canvas 70%,transparent);touch-action:none;user-select:none}
.jot-direct-scrollbar--local{position:absolute;inset:4px 4px 4px auto;width:12px}
.jot-direct-scrollbar__thumb{box-sizing:border-box;width:100%;min-height:1px;border:1px solid currentColor;border-radius:0;
  background:color-mix(in srgb,currentColor 45%,transparent);cursor:grab;will-change:transform}
.jot-direct-scrollbar__thumb:active{cursor:grabbing}
`;

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cssPixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
