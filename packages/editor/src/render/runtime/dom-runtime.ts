import { editorI18nAt, type EditorI18n } from "../../core/i18n.js";
import type {
  RenderNode,
  TextRange,
} from "@jot-md/editor-protocol";
import type { RenderRuntimeOptions } from "./types.js";
import {
  defaultMarkdownComponentRegistry,
  type ComponentPreviewAdapter,
  type MarkdownComponentModel,
} from "../../components/index.js";
import {
  listLevelFromIndentColumns,
  numberAttribute,
  rangeAttribute,
  RenderNodeTranslator,
  stringsAttribute,
  type DomRenderContext,
} from "../../components/common/dom-renderer.js";
import {
  resolveTableLayoutOptions,
  TableLayoutController,
  type TableLayoutSnapshot,
} from "../../components/table/layout.js";
import {
  isInlineOwner,
  renderNodeKey,
  resolveSurfaceImageMetadata,
  stamp,
} from "../../components/common/render-utils.js";
import { preTextLabel, type PreTextSurfaceItem } from "../../layout/pretext/filter.js";
import { listDisplayIndentCss } from "../../layout/list-geometry.js";
import { VirtualAxis } from "../../core/virtual/virtual-axis.js";
import {
  InlineChildren,
  ProjectedChildren,
  ProjectedLines,
} from "./projected-components.js";
import { PluginCodeBlock } from "./plugin-code-block.js";

export interface RenderComponent {
  update(node: RenderNode): void;
  updateSelection?(): void;
  invalidateLayout?(): void;
  dispose(): void;
}

/**
 * Preview DOM 的内部运行时。它只管理 DOM 外壳、嵌套组件和局部布局缓存，
 * 不拥有 Surface 的滚动刷新状态，也不直接处理编辑事务。
 */
export class RenderRuntime {
  readonly #options: RenderRuntimeOptions;
  readonly i18n: EditorI18n;
  readonly #translator = new RenderNodeTranslator();
  readonly #components = new WeakMap<HTMLElement, RenderComponent>();
  readonly #pendingNodes = new WeakMap<HTMLElement, RenderNode>();
  readonly #axes = new Map<string, VirtualAxis>();
  readonly #tableLayouts = new Map<string, TableLayoutController>();
  readonly #pendingTableWidths = new Map<string, Map<number, number>>();

  constructor(options: RenderRuntimeOptions) {
    this.i18n = editorI18nAt(options.root);
    this.#options = options;
  }

  get options(): RenderRuntimeOptions {
    return this.#options;
  }

  key(node: RenderNode): string {
    const plugin = this.#options.pluginRegistry?.codeBlock(node);
    return renderNodeKey(node) + (plugin === undefined ? "" :
      `:plugin:${JSON.stringify([plugin.pluginId, plugin.language])}`);
  }

  axis(key: string, estimatedSize: number): VirtualAxis {
    const existing = this.#axes.get(key);
    if (existing?.estimatedSize === estimatedSize) {
      this.#axes.delete(key);
      this.#axes.set(key, existing);
      return existing;
    }
    const axis = new VirtualAxis(estimatedSize);
    this.#axes.set(key, axis);
    if (this.#axes.size > 512) {
      const oldest = this.#axes.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#axes.delete(oldest);
    }
    return axis;
  }

  tableLayout(node: RenderNode, columnCount: number): TableLayoutController {
    const key = `table-layout:${node.id}`;
    const existing = this.#tableLayouts.get(key);
    const tableOptions = resolveTableLayoutOptions(this.#options);
    const resolvedTableKey = tableOptions.resolveTableKey?.({
      runtimeId: node.id,
      sourceRange: node.sourceRange,
      columnCount,
    });
    const tableId = resolvedTableKey?.trim() || node.id;
    const layout = existing ?? new TableLayoutController(
      tableId,
      tableOptions,
    );
    if (existing === undefined) {
      this.#tableLayouts.set(key, layout);
      if (this.#tableLayouts.size > 256) {
        const oldest = this.#tableLayouts.keys().next().value as string | undefined;
        if (oldest !== undefined) this.#tableLayouts.delete(oldest);
      }
    }
    layout.configure(
      columnCount,
      stringsAttribute(node, "alignments").join("\u0000"),
    );
    if (existing === undefined) {
      const pending = this.#pendingTableWidths.get(tableId) ??
        this.#pendingTableWidths.get(node.id);
      if (pending !== undefined) {
        for (const [index, width] of pending) {
          if (index < layout.count) layout.setUserWidth(index, width);
        }
        this.#pendingTableWidths.delete(tableId);
        this.#pendingTableWidths.delete(node.id);
      }
    }
    return layout;
  }

  tableLayoutSnapshot(tableId: string): TableLayoutSnapshot | undefined {
    const direct = this.#tableLayouts.get(`table-layout:${tableId}`);
    if (direct !== undefined) return direct.snapshot();
    return [...this.#tableLayouts.values()]
      .find((layout) => layout.tableId === tableId)?.snapshot();
  }

  setTableColumnWidth(tableId: string, column: number, width: number): boolean {
    const layout = this.#tableLayouts.get(`table-layout:${tableId}`) ??
      [...this.#tableLayouts.values()].find((candidate) => candidate.tableId === tableId);
    if (layout !== undefined) return layout.setUserWidth(column, width);
    if (!Number.isSafeInteger(column) || column < 0 || !Number.isFinite(width) || width <= 0) {
      return false;
    }
    const pending = this.#pendingTableWidths.get(tableId) ?? new Map<number, number>();
    pending.set(column, width);
    this.#pendingTableWidths.set(tableId, pending);
    return true;
  }

  resetTableLayout(tableId: string): boolean {
    const layout = this.#tableLayouts.get(`table-layout:${tableId}`) ??
      [...this.#tableLayouts.values()].find((candidate) => candidate.tableId === tableId);
    if (layout !== undefined) return layout.resetAutoWidths();
    return this.#pendingTableWidths.delete(tableId);
  }

  clearLayoutCache(): void {
    this.#axes.clear();
    this.#tableLayouts.clear();
    this.#pendingTableWidths.clear();
  }

  /** Keep mounted shells and user column widths; discard stale geometry only. */
  invalidateLayout(): void {
    for (const axis of this.#axes.values()) axis.invalidate();
    for (const layout of this.#tableLayouts.values()) layout.resetAutoWidths(false);
    const roots = [this.#options.root,
      ...this.#options.root.querySelectorAll<HTMLElement>("[data-jot-component]")];
    for (const root of roots) this.#components.get(root)?.invalidateLayout?.();
  }

  /**
   * Selection 是宿主事实，不会改变 RenderNode/contentVersion。宿主在 selection
   * 变化时调用这个窄入口，让拥有 selection-sensitive DOM 的组件局部刷新，
   * 而不重新规划整个 Live Preview 文档。
   */
  refreshSelection(): void {
    const roots: HTMLElement[] = [];
    if (this.#options.root.dataset["jotComponent"] !== undefined) {
      roots.push(this.#options.root);
    }
    roots.push(...this.#options.root.querySelectorAll<HTMLElement>("[data-jot-component]"));
    for (const root of roots) this.#components.get(root)?.updateSelection?.();
  }

  mount(node: RenderNode): HTMLElement {
    const plugin = this.#options.pluginRegistry?.codeBlock(node);
    if (plugin !== undefined) {
      const element = this.#options.root.ownerDocument.createElement("div");
      element.className = "jot-plugin-block jot-md-fenced-code";
      element.dataset["jotPluginBlock"] = plugin.pluginId;
      element.dataset["jotComponent"] = `plugin:${plugin.pluginId}`;
      element.dataset["jotRenderKey"] = this.key(node);
      stamp(element, node.id, node.kind, node.sourceRange);
      element.dataset["jotContentVersion"] = String(node.contentVersion);
      element.dataset["jotMode"] = "preview";
      this.#components.set(element, new PluginCodeBlock(node, element, this, plugin));
      return element;
    }
    const managed = this.#managedPreview(node);
    const ownsChildren = managed?.adapter.manages?.(managed.model) === true;
    // 被接管的组件拥有自己的子节点窗口（当前首先是 TableGrid）。先给通用翻译器
    // 一个空外壳，避免组件适配器接管前通用路径提前挂载同一批 row/cell。
    const shell = ownsChildren
      ? { ...node, content: { type: "deferred" as const } }
      : node;
    const element = this.#translator.mount(shell, this.#context());
    element.dataset["jotRenderKey"] = this.key(node);
    managed?.adapter.prepareShell?.(managed.model, element, this);
    // 被接管的组件可以有意从 deferred RenderNode 开始。详情投影由组件自己负责，
    // 因此挂载不能等待通用翻译器先收到 structured children。
    if (ownsChildren) {
      this.#pendingNodes.set(element, node);
      queueMicrotask(() => this.#attachDeferred(node, element));
    }
    return element;
  }

  update(element: HTMLElement, node: RenderNode): void {
    if (element.dataset["jotRenderKey"] !== this.key(node)) {
      throw new Error("attempted to update a render node with an incompatible DOM shell");
    }
    if (element.dataset["jotPluginBlock"] !== undefined) {
      stamp(element, node.id, node.kind, node.sourceRange);
      element.dataset["jotContentVersion"] = String(node.contentVersion);
      this.#components.get(element)?.update(node);
      return;
    }
    this.#pendingNodes.set(element, node);
    const managed = this.#managedPreview(node);
    managed?.adapter.prepareShell?.(managed.model, element, this);
    const managedComponent = managed?.adapter.manages?.(managed.model) === true &&
      this.#components.has(element);
    const ownsChildren = managed?.adapter.manages?.(managed.model) === true;
    const translatorNode = ownsChildren && !managedComponent
      ? { ...node, content: { type: "deferred" as const } }
      : node;
    this.#translator.update(
      element,
      translatorNode,
      this.#context(),
      (children) => {
        // 组件 adapter 接管后拥有自己的内部 DOM；通用 Translator 不能再把
        // 其内部节点当作 RenderNode structured children 进行协调。
        if (managedComponent) return;
        this.reconcileChildren(element, children);
      },
    );
    const component = this.#components.get(element);
    if (managed?.adapter.manages?.(managed.model) === true && component === undefined) {
      queueMicrotask(() => this.#attachDeferred(node, element));
    }
    component?.update(node);
  }

  reconcileChildren(host: HTMLElement, children: readonly RenderNode[]): void {
    const available = new Map<string, HTMLElement>();
    for (const child of Array.from(host.children)) {
      const element = child as HTMLElement;
      const key = element.dataset["jotRenderKey"];
      if (key !== undefined) available.set(key, element);
    }
    const retained = new Set<HTMLElement>();
    // projection 数据到达时，子节点更新可能替换自己的后代。
    // 每次更新后都根据前一个子节点重新计算插入点，不保留可能已脱离文档的游标。
    let previous: HTMLElement | null = null;
    for (const child of children) {
      const key = this.key(child);
      let element = available.get(key);
      if (element === undefined) {
        element = this.mount(child);
      } else {
        this.update(element, child);
      }
      retained.add(element);
      const reference: ChildNode | null = previous === null
        ? host.firstChild
        : previous.nextSibling;
      if (element !== reference) host.insertBefore(element, reference);
      previous = element;
    }
    for (const child of Array.from(host.children)) {
      const element = child as HTMLElement;
      if (retained.has(element)) continue;
      this.disposeSubtree(element);
      element.remove();
    }
  }

  mountPreTextBlock(item: PreTextSurfaceItem): HTMLElement {
    const element = this.#options.root.ownerDocument.createElement("div");
    element.className = "jot-pretext-block";
    const header = this.#options.root.ownerDocument.createElement("div");
    header.className = "jot-pretext-block__header";
    const label = this.#options.root.ownerDocument.createElement("strong");
    label.dataset["jotPretextRole"] = "label";
    const estimate = this.#options.root.ownerDocument.createElement("code");
    estimate.dataset["jotPretextRole"] = "estimate";
    header.append(label, estimate);
    const preview = this.#options.root.ownerDocument.createElement("div");
    preview.className = "jot-pretext-block__preview";
    preview.dataset["jotPretextRole"] = "preview";
    const evidence = this.#options.root.ownerDocument.createElement("small");
    evidence.className = "jot-pretext-block__evidence";
    evidence.dataset["jotPretextRole"] = "evidence";
    element.append(header, preview, evidence);
    this.updatePreTextBlock(element, item);
    return element;
  }

  updatePreTextBlock(element: HTMLElement, item: PreTextSurfaceItem): void {
    const label = element.querySelector<HTMLElement>('[data-jot-pretext-role="label"]');
    const estimate = element.querySelector<HTMLElement>('[data-jot-pretext-role="estimate"]');
    const preview = element.querySelector<HTMLElement>('[data-jot-pretext-role="preview"]');
    const evidence = element.querySelector<HTMLElement>('[data-jot-pretext-role="evidence"]');
    const t = this.i18n.t.bind(this.i18n);
    // Advanced render hosts may supply their own label for a projected item.
    const blockLabel = item.label === preTextLabel(item.node)
      ? () => preTextLabel(item.node, t)
      : () => item.label;
    if (label) this.i18n.bind(label, "textContent", blockLabel);
    const estimatedLabel = `${Math.round(item.boxHeight)} + ${Math.round(item.blockGap)} px`;
    if (estimate !== null && estimate.textContent !== estimatedLabel) {
      estimate.textContent = estimatedLabel;
    }
    if (preview !== null && preview.textContent !== item.contentText) {
      preview.textContent = item.contentText;
    }
    if (preview !== null) preview.title = item.sourcePreview;
    if (evidence) this.i18n.bind(evidence, "textContent", () => {
      const e = item.evidence;
      const details = [e.strategy];
      if (e.textLayout !== undefined) details.push(t("layout $1", e.textLayout));
      details.push(t("$1 source line(s)", e.sourceLines), t("$1 visual line(s)", e.visualLines));
      if (e.leadingWhitespaceColumns) details.push(t("leading $1 col(s)", e.leadingWhitespaceColumns));
      if (e.inlineMathCount !== undefined) details.push(t("$1 inline math", e.inlineMathCount));
      if (e.rows !== undefined) details.push(t("$1 row(s)", e.rows));
      if (e.columns !== undefined) details.push(t("$1 col(s)", e.columns));
      if (e.aspectRatio !== undefined) details.push(t("ratio $1", e.aspectRatio.toFixed(2)));
      return details.join(" · ");
    });
    element.className = [
      "jot-pretext-block",
      `jot-pretext-block--${item.component}`,
      `jot-pretext-strategy--${item.evidence.strategy}`,
      ...(item.boxHeight < 56 ? ["jot-pretext-block--compact"] : []),
    ].join(" ");
    element.style.height = `${Math.max(1, item.boxHeight)}px`;
    if (item.evidence.quoteDepth === undefined) {
      element.style.removeProperty("--jot-pretext-quote-depth");
    } else {
      element.style.setProperty("--jot-pretext-quote-depth", String(item.evidence.quoteDepth));
    }
    stamp(element, item.nodeId, item.kind, item.sourceRange);
    element.dataset["jotContentVersion"] = String(item.contentVersion);
    element.dataset["jotLayoutKey"] = item.layoutKey;
    element.dataset["jotPretextComponent"] = item.component;
    element.dataset["jotPretextStrategy"] = item.evidence.strategy;
    if (item.evidence.textLayout === undefined) {
      delete element.dataset["jotPretextLayout"];
    } else {
      element.dataset["jotPretextLayout"] = item.evidence.textLayout;
    }
    element.dataset["jotEstimatedHeight"] = String(item.estimatedHeight);
    element.dataset["jotBoxHeight"] = String(item.boxHeight);
    element.dataset["jotBlockGap"] = String(item.blockGap);
    element.dataset["jotMode"] = "pretext";
    if (item.kind === "list-item") {
      const indentColumns = Math.max(0, numberAttribute(item.node, "indentColumns") ?? 0);
      const number = numberAttribute(item.node, "number");
      const boundedIndent = listDisplayIndentCss(indentColumns, number === undefined ? 0 : String(number).length + 1);
      element.style.marginInlineStart = indentColumns === 0 ? "0ch" : boundedIndent;
      element.style.width = indentColumns === 0
        ? "100%"
        : `calc(100% - ${boundedIndent})`;
      element.style.maxWidth = "100%";
      element.style.boxSizing = "border-box";
      element.dataset["jotListIndent"] = String(indentColumns);
      element.dataset["jotListLevel"] = String(listLevelFromIndentColumns(indentColumns));
    } else {
      element.style.removeProperty("margin-inline-start");
      element.style.removeProperty("width");
      element.style.removeProperty("max-width");
      element.style.removeProperty("box-sizing");
      delete element.dataset["jotListIndent"];
      delete element.dataset["jotListLevel"];
    }
    this.i18n.bind(element, "aria-label", () => t("$1, estimated $2", blockLabel(), estimatedLabel));
  }

  /**
   * 不透明 source-line 的身份属于虚拟行槽位，而不是合成的基于范围的 RenderNode
   * ID。行拆分可能把不同 source-line 节点放入同一槽位，同时保留同一个 DIV 外壳。
   */
  updateProjectedSourceLine(element: HTMLElement, node: RenderNode): void {
    if (node.kind !== "source-line") {
      throw new Error("projected source-line slot received a non-line node");
    }
    const text = this.#source(node.sourceRange).replace(/\n$/u, "");
    if (element.textContent !== text) element.textContent = text;
    element.dataset["jotNodeId"] = node.id;
    element.dataset["jotKind"] = node.kind;
    element.dataset["jotSourceFrom"] = String(node.sourceRange.from);
    element.dataset["jotSourceTo"] = String(node.sourceRange.to);
    element.dataset["jotContentVersion"] = String(node.contentVersion);
    element.dataset["jotMode"] = "preview";
    element.dataset["jotRenderKey"] = this.key(node);
  }

  disposeSubtree(root: HTMLElement): void {
    const elements = [root, ...root.querySelectorAll<HTMLElement>("[data-jot-component]")];
    for (const element of elements) {
      this.#components.get(element)?.dispose();
      this.#components.delete(element);
    }
  }

  renderMathBlock(node: RenderNode): Node {
    const range = rangeAttribute(node, "contentRange") ?? node.sourceRange;
    const source = this.#source(range);
    if (this.#options.renderMath !== undefined) {
      return this.#options.renderMath(source, true, this.#options.root.ownerDocument);
    }
    const code = this.#options.root.ownerDocument.createElement("code");
    code.textContent = source;
    return code;
  }

  #context(): DomRenderContext {
    return {
      document: this.#options.root.ownerDocument,
      mode: "preview",
      i18n: this.i18n,
      sourceForRange: (range) => this.#source(range),
      onDeferred: (deferred, host) => {
        this.#pendingNodes.set(host, deferred);
        queueMicrotask(() => this.#attachDeferred(deferred, host));
      },
      mountChild: (child) => this.mount(child),
      resolveImageMetadata: (source) => resolveSurfaceImageMetadata(
        this.#options.resolveImageMetadata, source, this.#options.root.ownerDocument,
      ),
      ...(this.#options.resolveImageSrc === undefined ? {} : { resolveImageSrc: this.#options.resolveImageSrc }),
      ...(this.#options.renderMath === undefined
        ? {}
        : { renderMath: this.#options.renderMath }),
      ...(this.#options.onLink === undefined ? {} : { onLink: this.#options.onLink }),
    };
  }

  #attachDeferred(node: RenderNode, host: HTMLElement): void {
    if (
      this.#components.has(host) ||
      !this.#options.root.contains(host)
    ) {
      return;
    }
    try {
      const latest = this.#pendingNodes.get(host) ?? node;
      const managed = this.#managedPreview(latest);
      if (managed !== undefined && managed.adapter.manages?.(managed.model) === true) {
        const managedComponent = managed.adapter.mount?.(managed.model, host, this);
        if (managedComponent !== undefined) {
          host.dataset["jotComponent"] = managed.definition.id;
          this.#components.set(host, managedComponent);
          return;
        }
      }
      let component: RenderComponent;
      if (latest.kind === "fenced-code" || latest.kind === "math-block") {
        component = new ProjectedLines(latest, host, this);
      } else if (isInlineOwner(latest.kind)) {
        component = new InlineChildren(latest, host, this);
      } else {
        component = new ProjectedChildren(latest, host, this);
      }
      host.dataset["jotComponent"] = latest.kind;
      this.#components.set(host, component);
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  #managedPreview(node: RenderNode): {
    readonly definition: import("../../components/contracts.js").MarkdownComponentDefinition<MarkdownComponentModel>;
    readonly model: MarkdownComponentModel;
    readonly adapter: ComponentPreviewAdapter<MarkdownComponentModel>;
  } | undefined {
    const definition = defaultMarkdownComponentRegistry.resolve(node);
    const model = definition?.createModel(node);
    const adapter = definition?.capabilities.preview;
    if (definition === undefined || model === undefined || adapter === undefined) return undefined;
    return { definition, model, adapter };
  }

  #source(range: TextRange): string {
    return this.#options.session.adapter.text.text.slice(
      Number(range.from),
      Number(range.to),
    );
  }
}
