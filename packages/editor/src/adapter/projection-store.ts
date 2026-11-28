import type {
  ProjectionAxis,
  ProjectionSlice,
  RenderAttribute,
  RenderNode,
  RenderPatch,
  RenderValue,
  Revision,
  SyntaxPatchSummary,
  TextEdit,
} from "@jot-md/editor-protocol";
import { EditRangeIndex } from "./edit-batch.js";
import { spliceSlots } from "./array-splice.js";

interface ProjectionWindow {
  readonly parentId: string;
  readonly axis: ProjectionAxis;
  readonly nodes: Array<RenderNode | undefined>;
}

const QUOTE_LINE_CACHE_LIMIT = 4096;

export interface ProjectionWindowSnapshot {
  readonly parentId: string;
  readonly axis: ProjectionAxis;
  readonly totalChildren: number;
  readonly loaded: readonly {
    readonly index: number;
    readonly node: RenderNode;
  }[];
}

/** 以父节点和 projection axis 为键的稀疏渲染缓存。 */
export class ProjectionStore {
  #revision: Revision | undefined;
  #viewRevision = 0;
  #windows = new Map<string, ProjectionWindow>();
  // A quote can cover hundreds of thousands of physical lines. Keep only
  // requested rows rather than allocating or scanning a slot per source line.
  #quoteWindows = new Map<string, { total: number; nodes: Map<number, RenderNode> }>();
  #quoteRowOrder = new Map<string, { parentId: string; index: number }>();

  #clearQuotes(): void {
    this.#quoteWindows.clear();
    this.#quoteRowOrder.clear();
  }

  #forgetQuoteWindow(parentId: string): void {
    const window = this.#quoteWindows.get(parentId);
    if (window === undefined) return;
    for (const index of window.nodes.keys()) this.#quoteRowOrder.delete(quoteRowKey(parentId, index));
    this.#quoteWindows.delete(parentId);
  }

  #touchQuoteRow(parentId: string, index: number): void {
    const key = quoteRowKey(parentId, index);
    this.#quoteRowOrder.delete(key);
    this.#quoteRowOrder.set(key, { parentId, index });
  }

  get totalBlocks(): number {
    return this.totalChildren("0", "syntax-children");
  }

  get viewRevision(): number {
    return this.#viewRevision;
  }

  /**
   * 在文本 revision 之间携带未受影响的稀疏窗口。触及编辑的节点变为空洞并重新
   * 请求；其后的节点只需在本地映射 UTF-16 范围。
   */
  advanceRevision(
    revision: Revision,
    edits: readonly TextEdit[] = [],
    syntax?: SyntaxPatchSummary,
    options: { readonly reset?: boolean } = {},
  ): void {
    if (this.#revision === undefined || Number(revision) > Number(this.#revision)) {
      this.#clearQuotes();
      if (options.reset === true) {
        // 大范围替换没有可以继承的稳定节点身份。这里保留旧嵌套窗口不仅会在
        // 数字 ID 被复用时产生错误，也会让整表滚动后的成本不必要地增加。
        this.#windows.clear();
      } else if (this.#revision !== undefined && edits.length > 0) {
        this.#carryAcrossEdits(edits);
      }
      this.#revision = revision;
      if (syntax !== undefined) this.#applyRootBlockChanges(syntax);
    }
  }

  applySyntaxPatch(syntax: SyntaxPatchSummary): void {
    this.#clearQuotes();
    this.#applyRootBlockChanges(syntax);
  }

  apply(patch: RenderPatch): boolean {
    if (
      patch.viewRevision < this.#viewRevision ||
      (this.#revision !== undefined && Number(patch.documentRevision) < Number(this.#revision))
    ) {
      return false;
    }
    if (this.#revision === undefined || patch.documentRevision !== this.#revision) {
      this.#windows.clear();
      this.#clearQuotes();
    }
    this.#revision = patch.documentRevision;
    this.#viewRevision = patch.viewRevision;
    for (const operation of patch.operations) {
      if (operation.axis === "heading-section" || operation.axis === "heading-outline") continue;
      if (operation.axis === "quote-lines") {
        let window = this.#quoteWindows.get(operation.parentId);
        if (window === undefined || window.total !== operation.totalChildren) {
          this.#forgetQuoteWindow(operation.parentId);
          window = { total: operation.totalChildren, nodes: new Map() };
          this.#quoteWindows.set(operation.parentId, window);
        }
        for (let index = operation.from; index < operation.from + operation.removeCount; index += 1) {
          window.nodes.delete(index);
          this.#quoteRowOrder.delete(quoteRowKey(operation.parentId, index));
        }
        operation.inserted.forEach((node, offset) => {
          const index = operation.from + offset;
          window!.nodes.set(index, node);
          this.#touchQuoteRow(operation.parentId, index);
        });
        while (this.#quoteRowOrder.size > QUOTE_LINE_CACHE_LIMIT) {
          const oldest = this.#quoteRowOrder.entries().next().value;
          if (oldest === undefined) break;
          this.#quoteRowOrder.delete(oldest[0]);
          const previous = this.#quoteWindows.get(oldest[1].parentId);
          previous?.nodes.delete(oldest[1].index);
          if (previous?.nodes.size === 0) this.#quoteWindows.delete(oldest[1].parentId);
        }
        continue;
      }
      const key = sliceKey(operation.parentId, operation.axis);
      let nodes = this.#windows.get(key)?.nodes;
      if (nodes === undefined) nodes = [];
      for (const node of operation.inserted) {
        const syntaxWindow = this.#windows.get(
          sliceKey(node.id, "syntax-children"),
        );
        // Only a node with a cached child window can need child-count
        // invalidation. Looking up every ordinary paragraph in every sparse
        // window makes a bounded projection scan the full root capacity once
        // per inserted node (Array.find also visits empty slots).
        if (syntaxWindow === undefined) continue;
        const previous = this.#findNode(node.id);
        if (
          previous !== undefined &&
          previous.childCount !== node.childCount &&
          syntaxWindow.nodes.length !== node.childCount
        ) {
          this.#windows.delete(sliceKey(node.id, "syntax-children"));
          this.#windows.delete(sliceKey(node.id, "source-lines"));
        }
      }
      if (nodes.length !== 0 && nodes.length !== operation.totalChildren) {
        nodes = [];
      }
      nodes.length = operation.totalChildren;
      const inserted = operation.inserted.map((node, offset) =>
        retainProjectionDetail(nodes![operation.from + offset], node));
      const removeTo = Math.min(nodes.length, operation.from + operation.removeCount);
      for (let index = operation.from; index < removeTo; index += 1) {
        nodes[index] = undefined;
      }
      inserted.forEach((node, offset) => {
        nodes![operation.from + offset] = node;
      });
      this.#windows.set(key, {
        parentId: operation.parentId,
        axis: operation.axis,
        nodes,
      });
    }
    return true;
  }

  totalChildren(parentId: string, axis: ProjectionAxis): number {
    if (axis === "quote-lines") return this.#quoteWindows.get(parentId)?.total ?? 0;
    return this.#windows.get(sliceKey(parentId, axis))?.nodes.length ?? 0;
  }

  nodes(
    parentId: string,
    axis: ProjectionAxis,
    from: number,
    toExclusive: number,
  ): readonly RenderNode[] {
    if (axis === "quote-lines") return this.entries(parentId, axis, from, toExclusive).map(entry => entry.node);
    return (this.#windows.get(sliceKey(parentId, axis))?.nodes ?? [])
      .slice(Math.max(0, from), Math.max(from, toExclusive))
      .filter((node): node is RenderNode => node !== undefined);
  }

  nodeAt(parentId: string, axis: ProjectionAxis, index: number): RenderNode | undefined {
    if (axis === "quote-lines") {
      const node = this.#quoteWindows.get(parentId)?.nodes.get(index);
      if (node !== undefined) this.#touchQuoteRow(parentId, index);
      return node;
    }
    return this.#windows.get(sliceKey(parentId, axis))?.nodes[index];
  }

  /** Read one parent window without copying unrelated nested projections. */
  entries(
    parentId: string,
    axis: ProjectionAxis,
    from = 0,
    toExclusive = this.totalChildren(parentId, axis),
  ): ProjectionWindowSnapshot["loaded"] {
    if (axis === "quote-lines") return [...(this.#quoteWindows.get(parentId)?.nodes ?? [])]
      .filter(([index]) => index >= from && index < toExclusive)
      .sort((left, right) => left[0] - right[0])
      .map(([index, node]) => ({ index, node }));
    const nodes = this.#windows.get(sliceKey(parentId, axis))?.nodes;
    if (nodes === undefined) return [];
    const entries: Array<{ readonly index: number; readonly node: RenderNode }> = [];
    const end = Math.min(nodes.length, toExclusive);
    for (let index = Math.max(0, from); index < end; index += 1) {
      const node = nodes[index];
      if (node !== undefined) entries.push({ index, node });
    }
    return entries;
  }

  missingRanges(
    parentId: string,
    axis: ProjectionAxis,
    from: number,
    toExclusive: number,
  ): readonly { readonly from: number; readonly toExclusive: number }[] {
    if (axis === "quote-lines") {
      const nodes = this.#quoteWindows.get(parentId)?.nodes;
      const ranges: Array<{ from: number; toExclusive: number }> = [];
      let start: number | undefined;
      for (let index = Math.max(0, from); index < toExclusive; index += 1) {
        if (!nodes?.has(index)) start ??= index;
        else if (start !== undefined) { ranges.push({ from: start, toExclusive: index }); start = undefined; }
      }
      if (start !== undefined) ranges.push({ from: start, toExclusive });
      return ranges;
    }
    const nodes = this.#windows.get(sliceKey(parentId, axis))?.nodes ?? [];
    const to = Math.max(from, toExclusive);
    const ranges: Array<{ from: number; toExclusive: number }> = [];
    let start: number | undefined;
    for (let index = Math.max(0, from); index < to; index += 1) {
      if (nodes[index] === undefined) {
        start ??= index;
      } else if (start !== undefined) {
        ranges.push({ from: start, toExclusive: index });
        start = undefined;
      }
    }
    if (start !== undefined) ranges.push({ from: start, toExclusive: to });
    return ranges;
  }

  blocks(from: number, toExclusive: number): readonly RenderNode[] {
    return this.nodes("0", "syntax-children", from, toExclusive);
  }

  /**
   * 稀疏缓存的诊断视图。有意只暴露已加载节点，因此检查百万行 List/Table 不会
   * 将其完整物化。
   */
  snapshot(): readonly ProjectionWindowSnapshot[] {
    return [...this.#windows.values()]
      .map((window): ProjectionWindowSnapshot => ({
        parentId: window.parentId,
        axis: window.axis,
        totalChildren: window.nodes.length,
        loaded: window.nodes.flatMap((node, index) =>
          node === undefined ? [] : [{ index, node }]),
      }))
      .concat([...this.#quoteWindows].map(([parentId, window]): ProjectionWindowSnapshot => ({
        parentId, axis: "quote-lines", totalChildren: window.total,
        loaded: [...window.nodes].sort((a, b) => a[0] - b[0]).map(([index, node]) => ({ index, node })),
      })))
      .sort((left, right) =>
        left.parentId.localeCompare(right.parentId) ||
        left.axis.localeCompare(right.axis));
  }

  /**
   * 只返回当前缓存中、旧 revision 节点触及编辑的子槽位。请求可以附加到事务上，
   * 由 Rust 在提交后计算，从而消除后续的 projection 往返。
   */
  slicesTouchingEdits(edits: readonly TextEdit[]): readonly ProjectionSlice[] {
    if (this.#windows.size === 0 || edits.length === 0) return [];
    const changes = new EditRangeIndex(edits);
    const slices: ProjectionSlice[] = [];
    for (const window of this.#windows.values()) {
      const touched: number[] = [];
      window.nodes.forEach((node, index) => {
        if (
          node !== undefined &&
          changes.touches(node.sourceRange)
        ) {
          touched.push(index);
        }
      });
      if (touched.length === 0) continue;
      const parent = this.#findNode(window.parentId);
      const maxDepth = parent !== undefined && [
          "paragraph",
          "heading",
          "table-cell",
          "emphasis",
          "strong",
          "strikethrough",
          "link",
          "image",
        ].includes(parent.kind)
        ? 2
        : parent?.kind === "table-row"
        ? 1
        : 0;
      let from = touched[0]!;
      let previous = from;
      for (const index of touched.slice(1)) {
        if (index === previous + 1) {
          previous = index;
          continue;
        }
        slices.push(indexSlice(window, from, previous + 1, maxDepth));
        from = index;
        previous = index;
      }
      slices.push(indexSlice(window, from, previous + 1, maxDepth));
    }
    return slices;
  }

  #carryAcrossEdits(edits: readonly TextEdit[]): void {
    if (this.#windows.size === 0) return;
    const changes = new EditRangeIndex(edits);
    for (const window of this.#windows.values()) {
      for (let index = 0; index < window.nodes.length; index += 1) {
        const node = window.nodes[index];
        if (node === undefined) continue;
        if (changes.touches(node.sourceRange)) {
          window.nodes[index] = undefined;
        } else {
          window.nodes[index] = mapRenderNode(node, changes);
        }
      }
    }
  }

  #applyRootBlockChanges(syntax: SyntaxPatchSummary): void {
    const root = this.#windows.get(sliceKey("0", "syntax-children"));
    if (root !== undefined) {
      for (const change of [...syntax.blockChanges].reverse()) {
        spliceSlots(root.nodes, change.fromBlock, change.removeCount, change.inserted.length);
      }
      root.nodes.length = syntax.totalBlocks;
    }
    for (const change of syntax.projectionChanges ?? []) {
      const window = this.#windows.get(sliceKey(change.parentId, change.axis));
      if (window === undefined) continue;
      spliceSlots(window.nodes, change.from, change.removeCount, change.insertCount);
      window.nodes.length = change.totalChildren;
    }
  }

  #findNode(id: string): RenderNode | undefined {
    for (const window of this.#windows.values()) {
      const found = window.nodes.find((node) => node?.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

function quoteRowKey(parentId: string, index: number): string {
  return `${parentId}\0${index}`;
}

function sliceKey(parentId: string, axis: ProjectionAxis): string {
  return `${axis}\u0000${parentId}`;
}

function indexSlice(
  window: ProjectionWindow,
  from: number,
  toExclusive: number,
  maxDepth: number,
): ProjectionSlice {
  return {
    parentId: window.parentId,
    axis: window.axis,
    window: { type: "index", from, toExclusive },
    maxDepth,
  };
}

function mapRenderNode(node: RenderNode, changes: EditRangeIndex): RenderNode {
  return {
    ...node,
    sourceRange: changes.mapRange(node.sourceRange),
    attributes: node.attributes.map((attribute): RenderAttribute => ({
      ...attribute,
      value: mapRenderValue(attribute.value, changes),
    })),
    content: node.content.type === "structured"
      ? {
          type: "structured",
          children: node.content.children.map((child) => mapRenderNode(child, changes)),
        }
      : node.content,
  };
}

function mapRenderValue(value: RenderValue, changes: EditRangeIndex): RenderValue {
  return value.type === "range"
    ? { type: "range", value: changes.mapRange(value.value) }
    : value;
}

/** Shallow requests from one host must not erase another host's confirmed detail. */
function retainProjectionDetail(previous: RenderNode | undefined, next: RenderNode): RenderNode {
  if (previous === undefined || previous.id !== next.id || previous.kind !== next.kind ||
      previous.mode !== next.mode || previous.contentVersion !== next.contentVersion ||
      previous.childCount !== next.childCount || previous.sourceRange.from !== next.sourceRange.from ||
      previous.sourceRange.to !== next.sourceRange.to || previous.content.type !== "structured") return next;
  if (next.content.type === "deferred") return { ...next, content: previous.content };
  if (next.content.type !== "structured") return next;
  const children = previous.content.children;
  return { ...next, content: { type: "structured", children: next.content.children.map((child, index) =>
    retainProjectionDetail(children[index], child)) } };
}
