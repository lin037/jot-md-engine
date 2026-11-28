import {
  VirtualAxis,
  type VirtualSplice,
  type VirtualWindow,
} from "./virtual-axis.js";

export interface VirtualCommitMetrics {
  readonly createdItems: number;
  readonly updatedItems: number;
  readonly removedItems: number;
  readonly mountedItems: number;
  readonly commitDurationMs: number;
  /** 本次提交前由 DOM 首次确认尺寸的条目数。 */
  readonly measuredItems: number;
  /** 实测外部高度 - 提交前估算高度，正数表示低估。 */
  readonly estimatedHeightErrorPx: number;
  /** 高度误差的绝对值之和，用于观察总体偏差。 */
  readonly estimatedHeightAbsErrorPx: number;
  /** 单个条目的最大绝对高度误差。 */
  readonly estimatedHeightMaxErrorPx: number;
}

export interface DomVirtualListOptions<T> {
  readonly host: HTMLElement;
  readonly scrollElement: HTMLElement;
  readonly estimatedItemHeight: number;
  readonly axis?: VirtualAxis | undefined;
  readonly overscanPixels?: number | undefined;
  readonly getItem: (index: number) => T | undefined;
  readonly itemKey: (item: T, index: number) => string;
  readonly itemLayoutKey?: ((item: T, index: number) => string) | undefined;
  readonly estimateItemHeight?: ((item: T, index: number) => number) | undefined;
  readonly measurementContextKey?: (() => string) | undefined;
  readonly loadRange: (from: number, toExclusive: number) => Promise<void>;
  readonly loadContextKey?: (() => string) | undefined;
  readonly renderItem: (item: T, index: number) => HTMLElement;
  /**
   * 更新已经挂载的 keyed item。回调必须保留该元素本身；如果需要改变 DOM 标签，
   * 应体现在 `itemKey` 中。
   */
  readonly updateItem?: ((element: HTMLElement, item: T, index: number) => void) | undefined;
  readonly placeholder?: ((index: number) => HTMLElement) | undefined;
  readonly disposeElement?: ((element: HTMLElement) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly onCommit?: ((window: VirtualWindow, metrics: VirtualCommitMetrics) => void) | undefined;
  readonly spacerTag?: keyof HTMLElementTagNameMap | undefined;
}

/**
 * DOM 虚拟列表，保留实测尺寸和 keyed 元素，只向数据源请求缺失的可见窗口。
 */
export class DomVirtualList<T> {
  readonly axis: VirtualAxis;
  readonly #options: DomVirtualListOptions<T>;
  readonly #elements = new Map<string, {
    key: string;
    index: number;
    element: HTMLElement;
    layoutKey?: string;
  }>();
  readonly #loads = new Map<string, Promise<void>>();
  readonly #resizeObserver: ResizeObserver | undefined;
  readonly #beforeSpacer: HTMLElement;
  readonly #afterSpacer: HTMLElement;
  readonly #onScroll = () => {
    rememberScrollPosition(this.#options.scrollElement);
    this.#scrollGeneration += 1;
    this.schedule();
  };
  #scheduled = false;
  #disposed = false;
  #lastWindow: VirtualWindow | undefined;
  #requestedWindowKey: string | undefined;
  #measurementContextKey: string | undefined;
  #scheduledPromise: Promise<void> | undefined;
  #windowGeneration = 0;
  #scrollGeneration = 0;
  #measuredItems = 0;
  #estimatedHeightErrorPx = 0;
  #estimatedHeightAbsErrorPx = 0;
  #estimatedHeightMaxErrorPx = 0;

  constructor(options: DomVirtualListOptions<T>) {
    this.#options = options;
    this.axis = options.axis ?? new VirtualAxis(options.estimatedItemHeight);
    this.#beforeSpacer = this.#spacer("before");
    this.#afterSpacer = this.#spacer("after");
    options.host.replaceChildren(this.#beforeSpacer, this.#afterSpacer);
    const ResizeObserverConstructor = options.host.ownerDocument.defaultView?.ResizeObserver;
    this.#resizeObserver = ResizeObserverConstructor === undefined
      ? undefined
      : new ResizeObserverConstructor((entries) => {
          let changed = false;
          let anchorAdjustment = 0;
          const localTop = localScrollTop(options.host, options.scrollElement);
          const anchorIndex = this.axis.indexAt(localTop);
          const preserveEnd = preservesScrollEnd(options.scrollElement);
          const scrollGeneration = this.#scrollGeneration;
          for (const entry of entries) {
            if (entry.target === options.host || entry.target === options.scrollElement) {
              this.schedule();
              continue;
            }
            const element = entry.target as HTMLElement;
            const index = Number(element.dataset["jotVirtualIndex"]);
            if (Number.isSafeInteger(index) && index >= 0 && index < this.axis.count) {
              // A fold or structural splice may have remapped this slot since
              // the observer queued its entry. Never apply an old element's
              // measurement to the new item occupying the same view index.
              const item = options.getItem(index);
              if (item === undefined || this.#elements.get(options.itemKey(item, index))?.element !== element) continue;
              const wasMeasured = this.axis.isMeasured(index);
              const before = this.axis.sizeAt(index);
              const borderBoxSize = entry.borderBoxSize[0]?.blockSize ??
                entry.contentRect.height;
              const after = outerBlockSize(element, borderBoxSize);
              const sizeChanged = this.axis.setSize(index, after);
              if (!wasMeasured) {
                this.#recordMeasurement(before, after);
                changed = true;
              }
              if (sizeChanged) {
                changed = true;
                anchorAdjustment += scrollAnchorAdjustment(
                  anchorIndex,
                  index,
                  before,
                  after,
                );
              }
            }
          }
          if (!changed) return;
          if (!preserveEnd && anchorAdjustment !== 0) {
            options.scrollElement.scrollTop += anchorAdjustment;
          }
          this.#syncTrack(this.#lastWindow ?? this.axis.window(
            localScrollTop(options.host, options.scrollElement),
            options.scrollElement.clientHeight,
            options.overscanPixels ?? options.scrollElement.clientHeight,
          ));
          if (preserveEnd) {
            scrollElementToEnd(options.scrollElement);
            this.#scheduleEndCorrection(options.scrollElement, scrollGeneration);
          }
          this.schedule();
        });
    this.#resizeObserver?.observe(options.host);
    if (options.scrollElement !== options.host) {
      this.#resizeObserver?.observe(options.scrollElement);
    }
    options.scrollElement.addEventListener("scroll", this.#onScroll, { passive: true });
  }

  get window(): VirtualWindow | undefined {
    return this.#lastWindow;
  }

  setCount(count: number): void {
    this.axis.resize(count);
    // A remounted list already knows its row heights. Publish its extent before
    // the first async row window so the containing editor never measures an empty body.
    if (!this.#lastWindow) this.#setSpacerHeight(this.#afterSpacer, this.axis.totalSize);
    // 不要在下一次 keyed commit 之前移除旧尾部槽位。结构 splice 可能减少数量，
    // 同时把未变化的后缀项从旧尾部移动到更低的索引。提前移除会在 `#commit`
    // 按 key 匹配前销毁该项的 DOM 外壳。已调度的 commit 会移除所有真正不再保留的
    // 元素，包括新数量为零时的全部元素。
    this.schedule();
  }

  /**
   * 在不改变当前虚拟窗口、顺序或轴尺寸的前提下，局部协调已挂载的 keyed item。
   *
   * 这条路径用于“数据内容变了，但容器结构没有变”的组件更新，例如表格中一个
   * cell 改动后只更新对应的 row DOM。它不会扫描未挂载项，也不会重建 spacer；
   * 如果发现当前挂载槽位已经缺数据、key 改变或布局身份改变，则退回下一帧的
   * 常规 `schedule()` commit，由该路径安全处理增删、重排和 placeholder。
   */
  refreshMounted(
    shouldUpdate: (element: HTMLElement, item: T, index: number) => boolean = () => true,
  ): void {
    if (this.#disposed) return;
    let requiresCommit = false;
    for (const entry of this.#elements.values()) {
      const item = this.#options.getItem(entry.index);
      if (item === undefined || this.#options.itemKey(item, entry.index) !== entry.key) {
        requiresCommit = true;
        continue;
      }
      const layoutKey = this.#options.itemLayoutKey?.(item, entry.index);
      if (layoutKey !== entry.layoutKey) {
        requiresCommit = true;
        continue;
      }
      if (shouldUpdate(entry.element, item, entry.index)) {
        this.#options.updateItem?.(entry.element, item, entry.index);
      }
    }
    if (requiresCommit) this.schedule();
  }

  /**
   * 访问当前已经挂载且仍与数据源兼容的 keyed item，不触发 `updateItem`。
   *
   * 适合 selection/hover 等纯视觉投影：调用方可以更新 item 内部的轻量状态，
   * 但不会把每一次方向键移动升级成所有可见 item 的数据协调。若当前槽位已经
   * 稀疏缺失、key 改变或 layout identity 改变，仍安排常规 commit 恢复一致性。
   */
  forEachMounted(
    visit: (element: HTMLElement, item: T, index: number) => void,
  ): void {
    if (this.#disposed) return;
    let requiresCommit = false;
    for (const entry of this.#elements.values()) {
      const item = this.#options.getItem(entry.index);
      if (item === undefined || this.#options.itemKey(item, entry.index) !== entry.key) {
        requiresCommit = true;
        continue;
      }
      const layoutKey = this.#options.itemLayoutKey?.(item, entry.index);
      if (layoutKey !== entry.layoutKey) {
        requiresCommit = true;
        continue;
      }
      visit(entry.element, item, entry.index);
    }
    if (requiresCommit) this.schedule();
  }

  splice(changes: readonly VirtualSplice[]): void {
    if (changes.length === 0) return;
    for (const change of changes) {
      this.axis.splice(change.from, change.removeCount, change.insertCount);
    }
    const remapped = new Map<string, {
      key: string;
      index: number;
      element: HTMLElement;
      layoutKey?: string;
    }>();
    for (const entry of this.#elements.values()) {
      const index = mapIndexThroughSplices(entry.index, changes);
      if (index === undefined || index < 0 || index >= this.axis.count) {
        this.#remove(entry.element);
        continue;
      }
      // 通过 splice 保留语义身份。替换可能把不同项放到这个数字槽位；保留旧 key
      // 让下一次 commit 创建新外壳，并在顺序稳定后释放不再保留的旧外壳。
      // 占位外壳没有语义身份，可以直接跟随重新映射后的槽位。
      const key = entry.key.startsWith("placeholder:")
        ? `placeholder:${index}`
        : entry.key;
      if (remapped.has(key)) {
        this.#remove(entry.element);
        continue;
      }
      entry.index = index;
      entry.key = key;
      entry.element.dataset["jotVirtualIndex"] = String(index);
      remapped.set(key, entry);
    }
    this.#elements.clear();
    for (const [key, entry] of remapped) this.#elements.set(key, entry);
    this.schedule();
  }

  invalidateMeasurements(): void {
    this.axis.invalidate();
    this.#measurementContextKey = undefined;
    for (const entry of this.#elements.values()) {
      delete entry.layoutKey;
      this.#resizeObserver?.unobserve(entry.element);
      this.#resizeObserver?.observe(entry.element);
    }
    this.schedule();
  }

  schedule(): void {
    if (this.#disposed || this.#scheduled) return;
    this.#scheduled = true;
    const view = this.#options.host.ownerDocument.defaultView;
    let resolveScheduled!: () => void;
    const scheduledPromise = new Promise<void>((resolve) => {
      resolveScheduled = resolve;
    });
    this.#scheduledPromise = scheduledPromise;
    const run = () => {
      this.#scheduled = false;
      void this.refresh()
        .catch((error) => this.#options.onError?.(error))
        .finally(() => {
          if (this.#scheduledPromise === scheduledPromise) {
            this.#scheduledPromise = undefined;
          }
          resolveScheduled();
        });
    };
    if (view === null || view === undefined) {
      queueMicrotask(run);
    } else {
      view.requestAnimationFrame(run);
    }
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return;
    const measurementContextKey = this.#options.measurementContextKey?.();
    if (
      measurementContextKey !== undefined &&
      this.#measurementContextKey !== undefined &&
      measurementContextKey !== this.#measurementContextKey
    ) {
      this.axis.invalidate();
      for (const entry of this.#elements.values()) delete entry.layoutKey;
    }
    this.#measurementContextKey = measurementContextKey;
    const localTop = localScrollTop(this.#options.host, this.#options.scrollElement);
    const window = this.axis.window(
      localTop,
      this.#options.scrollElement.clientHeight,
      this.#options.overscanPixels ?? this.#options.scrollElement.clientHeight,
    );
    const scrollGeneration = this.#scrollGeneration;
    // #lastWindow 只描述已经挂载到 DOM 的范围，不能提前写入仍在等待投影数据的异步请求。
    const loadKey = `${window.from}:${window.toExclusive}:${this.#options.loadContextKey?.() ?? ""}`;
    if (loadKey !== this.#requestedWindowKey) {
      this.#requestedWindowKey = loadKey;
      this.#windowGeneration += 1;
    }
    const generation = this.#windowGeneration;
    if (window.toExclusive > window.from) {
      let load = this.#loads.get(loadKey);
      if (load === undefined) {
        load = this.#options.loadRange(window.from, window.toExclusive)
          .catch((error) => this.#options.onError?.(error))
          .finally(() => {
            this.#loads.delete(loadKey);
          });
        this.#loads.set(loadKey, load);
      }
      await load;
      // 较慢的旧滚动窗口请求绝不能覆盖新窗口已经提交的 DOM。
      // 同一窗口的请求共享一个 Promise，并且只有缓存成为权威数据后才提交。
      // 用户在请求期间滚动时，即使窗口 key 恰好相同，也必须重新读取当前
      // scrollTop；否则旧的 spacer 和旧窗口会把点击后的绝对位置拉回去。
      if (
        this.#disposed ||
        generation !== this.#windowGeneration ||
        scrollGeneration !== this.#scrollGeneration
      ) {
        this.schedule();
        return;
      }
    }
    this.#commit(window);
  }

  async settled(): Promise<void> {
    while (this.#scheduledPromise !== undefined) {
      await this.#scheduledPromise;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#options.scrollElement.removeEventListener("scroll", this.#onScroll);
    this.#resizeObserver?.disconnect();
    for (const entry of this.#elements.values()) this.#remove(entry.element);
    this.#elements.clear();
    this.#beforeSpacer.remove();
    this.#afterSpacer.remove();
  }

  #commit(window: VirtualWindow): void {
    const startedAt = monotonicNow();
    let createdItems = 0;
    let updatedItems = 0;
    let removedItems = 0;
    let estimateChanged = false;
    let anchorAdjustment = 0;
    const localTop = localScrollTop(this.#options.host, this.#options.scrollElement);
    const anchorIndex = this.axis.indexAt(localTop);
    const preserveEnd = preservesScrollEnd(this.#options.scrollElement);
    const scrollGeneration = this.#scrollGeneration;
    const retained = new Set<string>();
    // 以本次 commit 已确认的最后一个节点为基准定位每项。updateItem 可能同步协调
    // 后代并使更新前保存的游标失效；前一个根级兄弟仍是稳定锚点。
    let previous: ChildNode = this.#beforeSpacer;
    for (let index = window.from; index < window.toExclusive; index += 1) {
      const item = this.#options.getItem(index);
      // 稀疏 projection 空洞表示未知，不表示删除。在权威窗口到达前保留该槽位
      // 已确认的元素；每次分析使缓存 descriptor 失效时都替换成占位符，会造成
      // 明显闪烁。
      const confirmedAtIndex = item === undefined
        ? [...this.#elements.values()].find((candidate) =>
            candidate.index === index && !candidate.key.startsWith("placeholder:"))
        : undefined;
      const key = confirmedAtIndex?.key ??
        (item === undefined ? `placeholder:${index}` : this.#options.itemKey(item, index));
      let entry = this.#elements.get(key);
      const layoutKey = item === undefined
        ? undefined
        : this.#options.itemLayoutKey?.(item, index);
      const estimatedHeight = item === undefined
        ? undefined
        : this.#options.estimateItemHeight?.(item, index);
      if (entry === undefined) {
        const element = item === undefined
          ? this.#placeholder(index)
          : this.#options.renderItem(item, index);
        entry = {
          key,
          index,
          element,
          ...(layoutKey === undefined ? {} : { layoutKey }),
        };
        this.#elements.set(key, entry);
        createdItems += 1;
      } else if (item !== undefined) {
        if (layoutKey !== undefined && entry.layoutKey !== layoutKey) {
          const before = this.axis.sizeAt(index);
          const resetChanged = this.axis.resetSize(index, estimatedHeight);
          const after = this.axis.sizeAt(index);
          estimateChanged = resetChanged || estimateChanged;
          if (resetChanged) {
            anchorAdjustment += scrollAnchorAdjustment(
              anchorIndex,
              index,
              before,
              after,
            );
          }
          entry.layoutKey = layoutKey;
        }
        this.#options.updateItem?.(entry.element, item, index);
        updatedItems += 1;
      }
      if (estimatedHeight !== undefined) {
        const before = this.axis.sizeAt(index);
        const setChanged = this.axis.setEstimate(index, estimatedHeight);
        const after = this.axis.sizeAt(index);
        estimateChanged = setChanged || estimateChanged;
        if (setChanged) {
          anchorAdjustment += scrollAnchorAdjustment(
            anchorIndex,
            index,
            before,
            after,
          );
        }
      }
      entry.index = index;
      entry.element.dataset["jotVirtualIndex"] = String(index);
      retained.add(key);
      const reference = previous.nextSibling;
      if (entry.element !== reference) {
        this.#options.host.insertBefore(entry.element, reference);
      }
      previous = entry.element;
      this.#resizeObserver?.observe(entry.element);
      if (this.#resizeObserver === undefined) {
        const wasMeasured = this.axis.isMeasured(index);
        const before = this.axis.sizeAt(index);
        const height = outerBlockSize(
          entry.element,
          entry.element.getBoundingClientRect().height,
        );
        if (height > 0) {
          const sizeChanged = this.axis.setSize(index, height);
          if (!wasMeasured) {
            this.#recordMeasurement(before, height);
            estimateChanged = true;
          }
          if (sizeChanged) {
            estimateChanged = true;
            anchorAdjustment += scrollAnchorAdjustment(
              anchorIndex,
              index,
              before,
              height,
            );
          }
        }
      }
    }
    const afterReference = previous.nextSibling;
    if (afterReference !== this.#afterSpacer) {
      this.#options.host.insertBefore(this.#afterSpacer, afterReference);
    }
    for (const [key, entry] of this.#elements) {
      if (!retained.has(key)) {
        this.#remove(entry.element);
        this.#elements.delete(key);
        removedItems += 1;
      }
    }
    if (!preserveEnd && anchorAdjustment !== 0) {
      this.#options.scrollElement.scrollTop += anchorAdjustment;
    }
    // 先把轴更新后的总高度写回上下 spacer，再进行“滚到底部”修正。否则浏览器会
    // 先看到旧 scrollHeight，再在下一帧看到新 scrollHeight，原生滚动条就会跳动。
    const committedWindow = this.#syncTrack(window);
    if (preserveEnd) {
      scrollElementToEnd(this.#options.scrollElement);
      this.#scheduleEndCorrection(this.#options.scrollElement, scrollGeneration);
    }
    this.#options.onCommit?.(committedWindow, {
      createdItems,
      updatedItems,
      removedItems,
      mountedItems: this.#elements.size,
      commitDurationMs: monotonicNow() - startedAt,
      ...this.#takeMeasurementMetrics(),
    });
    if (estimateChanged) this.schedule();
  }

  #recordMeasurement(before: number, after: number): void {
    const error = after - before;
    this.#measuredItems += 1;
    this.#estimatedHeightErrorPx += error;
    this.#estimatedHeightAbsErrorPx += Math.abs(error);
    this.#estimatedHeightMaxErrorPx = Math.max(
      this.#estimatedHeightMaxErrorPx,
      Math.abs(error),
    );
  }

  #takeMeasurementMetrics(): Pick<
    VirtualCommitMetrics,
    "measuredItems" | "estimatedHeightErrorPx" | "estimatedHeightAbsErrorPx" |
    "estimatedHeightMaxErrorPx"
  > {
    const metrics = {
      measuredItems: this.#measuredItems,
      estimatedHeightErrorPx: this.#estimatedHeightErrorPx,
      estimatedHeightAbsErrorPx: this.#estimatedHeightAbsErrorPx,
      estimatedHeightMaxErrorPx: this.#estimatedHeightMaxErrorPx,
    };
    this.#measuredItems = 0;
    this.#estimatedHeightErrorPx = 0;
    this.#estimatedHeightAbsErrorPx = 0;
    this.#estimatedHeightMaxErrorPx = 0;
    return metrics;
  }

  #scheduleEndCorrection(element: HTMLElement, generation: number, attempt = 0): void {
    const view = element.ownerDocument.defaultView;
    if (view === null || view === undefined || attempt >= 3) return;
    view.requestAnimationFrame(() => {
      if (this.#disposed) return;
      // 用户在回调之间主动离开底部时，不能把它强行拉回去。程序化修正产生
      // 的 scroll 事件则仍然允许继续，因为此时元素本身依旧位于当前底部。
      if (this.#scrollGeneration !== generation && !preservesScrollEnd(element)) return;
      scrollElementToEnd(element);
      if (!isAtScrollEnd(element)) {
        this.#scheduleEndCorrection(element, this.#scrollGeneration, attempt + 1);
      }
    });
  }

  #spacer(position: "before" | "after"): HTMLElement {
    const element = this.#options.host.ownerDocument.createElement(
      this.#options.spacerTag ?? "div",
    );
    element.className = `jot-virtual-spacer jot-virtual-spacer-${position}`;
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("role", "presentation");
    this.#setSpacerHeight(element, 0);
    element.style.pointerEvents = "none";
    return element;
  }

  #setSpacerHeight(element: HTMLElement, height: number): void {
    const value = `${Math.max(0, height)}px`;
    if (element.style.height !== value) element.style.height = value;
    if (element.style.minHeight !== value) element.style.minHeight = value;
  }

  #syncTrack(window: VirtualWindow): VirtualWindow {
    const from = Math.min(this.axis.count, Math.max(0, window.from));
    const toExclusive = Math.max(
      from,
      Math.min(this.axis.count, window.toExclusive),
    );
    const renderedEnd = this.axis.offsetAt(toExclusive);
    const syncedWindow: VirtualWindow = {
      from,
      toExclusive,
      beforePixels: this.axis.offsetAt(from),
      afterPixels: Math.max(0, this.axis.totalSize - renderedEnd),
      totalPixels: this.axis.totalSize,
    };
    this.#setSpacerHeight(this.#beforeSpacer, syncedWindow.beforePixels);
    this.#setSpacerHeight(this.#afterSpacer, syncedWindow.afterPixels);
    this.#lastWindow = syncedWindow;
    return syncedWindow;
  }

  #placeholder(index: number): HTMLElement {
    if (this.#options.placeholder !== undefined) return this.#options.placeholder(index);
    const element = this.#options.host.ownerDocument.createElement("div");
    element.className = "jot-virtual-placeholder";
    element.setAttribute("aria-busy", "true");
    element.style.minHeight = `${this.axis.sizeAt(index)}px`;
    return element;
  }

  #remove(element: HTMLElement): void {
    this.#resizeObserver?.unobserve(element);
    this.#options.disposeElement?.(element);
    element.remove();
  }
}

function mapIndexThroughSplices(
  original: number,
  changes: readonly VirtualSplice[],
): number | undefined {
  let index = original;
  for (const change of changes) {
    const removeTo = change.from + change.removeCount;
    if (index < change.from) continue;
    if (index >= removeTo) {
      index += change.insertCount - change.removeCount;
      continue;
    }
    const relative = index - change.from;
    if (relative >= change.insertCount) return undefined;
    index = change.from + relative;
  }
  return index;
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/**
 * 当上方测量值替换估算值时，保持同一逻辑项位于 viewport 顶部。
 * 锚点位置及其下方的变化不能移动滚动位置。
 */
export function scrollAnchorAdjustment(
  anchorIndex: number,
  measuredIndex: number,
  before: number,
  after: number,
): number {
  return measuredIndex < anchorIndex ? after - before : 0;
}

function localScrollTop(host: HTMLElement, scrollElement: HTMLElement): number {
  const hostRect = host.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  const hostTopInContent = hostRect.top - scrollRect.top + scrollElement.scrollTop;
  return Math.max(0, scrollElement.scrollTop - hostTopInContent);
}

function isAtScrollEnd(element: HTMLElement, tolerance = 2): boolean {
  const maximum = element.scrollHeight - element.clientHeight;
  return maximum > tolerance && maximum - element.scrollTop <= tolerance;
}

// Root and nested virtual lists share one physical scroll port. Remember an
// explicit end anchor before async cells/images increase its scrollHeight.
// Recomputing only inside ResizeObserver is too late: layout has already grown.
const scrollAnchors = new WeakMap<HTMLElement, { top: number; end: boolean }>();

function rememberScrollPosition(element: HTMLElement): void {
  const previous = scrollAnchors.get(element);
  const top = element.scrollTop;
  const atEnd = isAtScrollEnd(element);
  scrollAnchors.set(element, {
    top,
    end: atEnd || (previous?.end === true && Math.abs(previous.top - top) <= 2),
  });
}

function preservesScrollEnd(element: HTMLElement): boolean {
  const anchor = scrollAnchors.get(element);
  return isAtScrollEnd(element) ||
    (anchor?.end === true && Math.abs(anchor.top - element.scrollTop) <= 2);
}

function scrollElementToEnd(element: HTMLElement): void {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  scrollAnchors.set(element, { top: element.scrollTop, end: true });
}

function outerBlockSize(element: HTMLElement, borderBoxSize: number): number {
  const view = element.ownerDocument.defaultView;
  if (view === null || view === undefined) return borderBoxSize;
  const style = view.getComputedStyle(element);
  return borderBoxSize + cssPixels(style.marginBlockStart) + cssPixels(style.marginBlockEnd);
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
