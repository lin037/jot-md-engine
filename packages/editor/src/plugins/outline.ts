import type { RenderNode, Revision } from "@jot-md/editor-protocol";
import type { MarkdownEditor } from "../component/markdown-editor.js";
import { booleanAttribute, numberAttribute, numbersAttribute } from "../components/common/dom-renderer.js";
import { safeUtf16Offset } from "../components/common/render-utils.js";
import { DirectScrollbar, type EditorScrollbarMode } from "../layout/direct-scrollbar.js";
import type { MarkdownEditorPlugin } from "./registry.js";

export interface OutlineOptions {
  readonly label?: string;
  readonly onError?: (error: unknown) => void;
  /** Fixed row height in CSS pixels, including padding. Defaults to 32. */
  readonly rowHeight?: number;
  readonly scrollbar?: EditorScrollbarMode;
}

let nextOutlineId = 0;
const styles = `
.jot-outline-host { position: relative; display: grid; grid-template-rows: minmax(0, 1fr);
  min-inline-size: 0; max-block-size: var(--jot-outline-max-height, 24rem); }
.jot-outline { overflow: auto; min-block-size: 0;
  min-inline-size: 0; overscroll-behavior: contain; overflow-anchor: none; color: inherit; font: inherit; }
.jot-outline__track { position: relative; }
.jot-outline__rows { position: absolute; inset: 0 0 auto; }
.jot-outline__row { box-sizing: border-box; display: flex; align-items: center; inline-size: 100%; block-size: var(--jot-outline-row-height);
  padding: 0 .6em; padding-inline-start: calc(.6em + (var(--jot-outline-level) - 1) * var(--jot-outline-indent, .85em));
  border: 0; border-radius: .3em; background: transparent; color: inherit; font: inherit; text-align: start;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
.jot-outline__label { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; }
.jot-outline__toggle { flex: 0 0 1.3em; align-self: stretch; display: grid; place-items: center; }
.jot-outline__row[aria-expanded="true"] .jot-outline__toggle::before { content: var(--jot-heading-fold-expanded-icon, "⌄"); }
.jot-outline__row[aria-expanded="false"] .jot-outline__toggle::before { content: var(--jot-heading-fold-collapsed-icon, "›"); }
.jot-outline__row:hover, .jot-outline__row[aria-current] { background: var(--jot-outline-highlight, color-mix(in srgb, currentColor 9%, transparent)); }
.jot-outline__row[aria-current] { color: var(--jot-outline-accent, var(--jot-link-color, inherit)); font-weight: 600; }
.jot-outline__row:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
.jot-outline__status { padding: .4em .6em; }`;

function headingLabel(node: RenderNode, source: string): string {
  const ranges = numbersAttribute(node, "labelRanges");
  let label = "";
  for (let index = 0; index < ranges.length; index += 2) {
    const from = ranges[index]!;
    const to = ranges[index + 1]!;
    const end = safeUtf16Offset(source, Math.min(to, from + 160 - label.length), -1);
    label += source.slice(from, end);
    if (end < to) return label.trimEnd() + "…";
  }
  return (label.trim() + (booleanAttribute(node, "truncated") ? "…" : "")) || "无标题";
}

/** Bind an external container to one editor. Dispose when the host closes or binds a different editor. */
export function mountOutline(container: HTMLElement, editor: MarkdownEditor, options: OutlineOptions = {}): { dispose(): void } {
  const lifetime = editor.disposeSignal;
  if (lifetime.aborted) throw new Error("cannot bind an outline to a disposed editor");
  const rowHeight = options.rowHeight ?? 32;
  if (!Number.isFinite(rowHeight) || rowHeight < 1) throw new RangeError("outline rowHeight must be positive");
  const document = container.ownerDocument;
  const wrapper = document.createElement("div");
  wrapper.className = "jot-outline-host";
  const nav = document.createElement("nav");
  nav.id = "jot-outline-" + ++nextOutlineId;
  nav.className = "jot-outline";
  nav.setAttribute("aria-label", options.label ?? "文档大纲");
  nav.style.setProperty("--jot-outline-row-height", rowHeight + "px");
  const style = document.createElement("style");
  style.textContent = styles;
  const status = document.createElement("div");
  status.className = "jot-outline__status";
  status.setAttribute("role", "status");
  status.textContent = "正在读取大纲…";
  const track = document.createElement("div");
  track.className = "jot-outline__track";
  const rows = document.createElement("div");
  rows.className = "jot-outline__rows";
  rows.setAttribute("role", "tree");
  rows.setAttribute("aria-label", options.label ?? "文档大纲");
  track.append(rows);
  nav.append(style, status, track);
  wrapper.append(nav);
  container.append(wrapper);
  const scrollbar = (options.scrollbar ?? "direct") === "direct" ? new DirectScrollbar({
    scrollElement: nav, contentElement: track, trackHost: wrapper, label: (options.label ?? "文档大纲") + "滚动条",
  }) : undefined;

  const view = editor.input.view;
  const listeners = new AbortController();
  const { signal } = listeners;
  const buttons = new Map<string, HTMLButtonElement>();
  const collapsed = new Set<string>();
  let foldVersion = 0;
  let documentLength = editor.confirmedValue.length;
  let tabId: string | undefined;
  let page: { revision: Revision; folds: number; complete: boolean; from: number; nodes: readonly RenderNode[]; total: number } | undefined;
  let disposed = false;
  let pending: { key: string } | undefined;
  let frame = 0;
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  let focusIndex: number | undefined;
  let navSequence = 0;
  const currentOffset = () => editor.inputPane.hidden ? editor.surface.captureScrollAnchor().sourceOffset : view.state.selection.main.head;
  let activeOffset = currentOffset();

  function markCurrent(button: HTMLButtonElement, node: RenderNode): void {
    const next = numberAttribute(node, "nextHeadingFrom") ?? Infinity;
    const active = node.sourceRange.from <= activeOffset && activeOffset < next;
    if (active === button.hasAttribute("aria-current")) return;
    if (active) button.setAttribute("aria-current", "location");
    else button.removeAttribute("aria-current");
  }

  function setActive(offset: number): void {
    if (offset === activeOffset) return;
    activeOffset = offset;
    if (!page) return;
    for (const node of page.nodes) markCurrent(buttons.get(node.id)!, node);
  }

  function draw(): void {
    if (!page) return;
    const { from, nodes, total } = page;
    // While parsing, only the first confirmed page is navigable.
    track.style.height = (page.complete ? total : from + nodes.length) * rowHeight + "px";
    rows.style.top = from * rowHeight + "px";
    const retained = new Set(nodes.map(node => node.id));
    for (const [id, button] of buttons) {
      if (!retained.has(id)) { button.remove(); buttons.delete(id); }
    }
    if (!tabId || !retained.has(tabId)) tabId = nodes[0]?.id;
    const source = editor.confirmedValue;
    for (const [slot, node] of nodes.entries()) {
      const index = from + slot;
      let button = buttons.get(node.id);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "jot-outline__row";
        button.setAttribute("role", "treeitem");
        const toggle = document.createElement("span");
        toggle.className = "jot-outline__toggle";
        toggle.setAttribute("aria-hidden", "true");
        const title = document.createElement("span");
        title.className = "jot-outline__label";
        button.append(toggle, title);
        buttons.set(node.id, button);
      }
      const level = numberAttribute(node, "level")!;
      const depth = numberAttribute(node, "depth") ?? level;
      const label = headingLabel(node, source);
      button.dataset["index"] = String(index);
      button.tabIndex = node.id === tabId ? 0 : -1;
      button.style.setProperty("--jot-outline-level", String(depth));
      button.setAttribute("aria-level", String(depth));
      if (booleanAttribute(node, "hasChildren")) button.setAttribute("aria-expanded", String(!collapsed.has(node.id)));
      else button.removeAttribute("aria-expanded");
      const title = button.lastElementChild!;
      if (title.textContent !== label) title.textContent = label;
      button.setAttribute("aria-label", "H" + level + " " + label);
      markCurrent(button, node);
      const atSlot = rows.children.item(slot);
      if (atSlot !== button) rows.insertBefore(button, atSlot);
    }
    status.hidden = total > 0;
    if (!total) status.textContent = page.complete ? "暂无标题" : "正在读取大纲…";
    nav.setAttribute("aria-busy", String(!page.complete));
  }

  function schedule(): void {
    if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; void refresh(); });
  }

  async function refresh(): Promise<void> {
    const analysis = editor.session.adapter.analysis;
    if (editTimer !== undefined || !analysis || !nav.getClientRects().length) return;
    const complete = analysis.state === "complete";
    // Publish an early confirmed prefix once on open. Subsequent analysis ticks
    // can extend it many times. Wait for completion before querying it again.
    if (!complete && (analysis.state !== "pending" || (page && page.folds === foldVersion) || !analysis.confirmedRanges.length)) return;
    const revision = editor.revision;
    // Group nearby scroll positions so moving one row rarely needs another Worker request.
    const stride = 12;
    const from = Math.max(0, Math.floor((nav.scrollTop / rowHeight - 3) / stride) * stride);
    const end = (Math.ceil((nav.scrollTop + nav.clientHeight) / rowHeight / stride) + 1) * stride;
    if (page?.revision === revision && page.folds === foldVersion && page.complete && page.from <= from &&
        page.from + page.nodes.length >= Math.min(end, page.total)) {
      if (focusIndex !== undefined) {
        const target = page.nodes[focusIndex - page.from];
        if (target) buttons.get(target.id)?.focus({ preventScroll: true });
        focusIndex = undefined;
      }
      return;
    }
    const viewRevision = editor.session.adapter.viewRevision;
    const folds = foldVersion;
    const key = `${revision}:${viewRevision}:${complete}:${folds}:${from}:${end}`;
    if (pending?.key === key) return;
    // A distant track click can request its own window while a previous one is in flight.
    const request = pending = { key };
    try {
      const effect = await editor.session.project([{ parentId: "0", axis: "heading-outline",
        window: { type: "index", from, toExclusive: end }, maxDepth: 0,
        ...(collapsed.size ? { collapsedHeadings: [...collapsed] } : {}) }]);
      if (disposed || pending !== request) return;
      if (editor.revision !== revision || folds !== foldVersion || viewRevision !== editor.session.adapter.viewRevision) {
        schedule();
        return;
      }
      const op = effect.renderPatch?.operations.find(op => op.axis === "heading-outline");
      if (!op) return;
      const firstVisible = Math.floor(nav.scrollTop / rowHeight);
      if (firstVisible < op.totalChildren && (firstVisible < from || firstVisible >= end)) { schedule(); return; }
      if (page?.revision !== revision) activeOffset = currentOffset();
      page = { revision, folds, complete, from: op.from, nodes: op.inserted, total: op.totalChildren };
      draw();
      schedule(); // Rows can change the available height or clamp scrollTop after an edit.
    } catch (error) {
      if (disposed || pending !== request) return;
      if (editor.revision !== revision) schedule();
      else {
        status.textContent = "大纲加载失败";
        status.hidden = false;
        nav.setAttribute("aria-busy", "false");
        options.onError?.(error);
      }
    } finally { if (pending === request) pending = undefined; }
  }

  async function navigate(index: number): Promise<void> {
    if (disposed || !page || page.folds !== foldVersion || view.composing) return;
    const clicked = page;
    const node = clicked.nodes[index - clicked.from];
    if (!node) return;
    const sequence = ++navSequence;
    const mode = editor.mode;
    await editor.input.settled();
    if (disposed || sequence !== navSequence || editor.mode !== mode) return;
    const revision = editor.revision;
    const doc = view.state.doc;
    const current = () => !disposed && sequence === navSequence && editor.revision === revision && view.state.doc === doc && editor.mode === mode;
    let offset = Number(node.sourceRange.from);
    let blockIndex = numberAttribute(node, "blockIndex")!;
    if (clicked.revision !== revision) {
      // Typing immediately before a click can shift all subsequent offsets. Ask
      // for the same heading by semantic ID so a moved or deleted row is safe.
      const effect = await editor.session.project([{ parentId: node.id, axis: "heading-section",
        window: { type: "index", from: 0, toExclusive: 1 }, maxDepth: 0 }]);
      const heading = effect.renderPatch?.operations[0]?.inserted[0];
      const followingBlock = heading && numberAttribute(heading, "fromBlock");
      if (!current() || !heading || followingBlock === undefined) return;
      offset = Number(heading.sourceRange.from);
      blockIndex = followingBlock - 1;
    }
    const revealed = editor.headingFolds.reveal(offset);
    if (!editor.inputPane.hidden) {
      editor.input.setSelection(offset);
      view.focus();
    }
    if (!editor.surfacePane.hidden) {
      if (revealed) await editor.surface.settled();
      if (!current()) return;
      editor.surface.applyScrollAnchor({ sourceOffset: offset, blockIndex, progress: 0 });
    }
    setActive(offset);
  }

  function toggle(node: RenderNode): void {
    if (!booleanAttribute(node, "hasChildren")) return;
    // A click can precede the debounced refresh after an edit. The Worker
    // resolves this stable ID against the new revision, even if the row moved.
    clearTimeout(editTimer);
    editTimer = undefined;
    if (!collapsed.delete(node.id)) collapsed.add(node.id);
    foldVersion++;
    navSequence++;
    buttons.get(node.id)?.setAttribute("aria-expanded", String(!collapsed.has(node.id)));
    schedule();
  }
  rows.addEventListener("focusin", event => {
    const index = Number((event.target as HTMLElement).dataset["index"]);
    const node = page?.nodes[index - page.from];
    if (!node || tabId === node.id) return;
    const previous = tabId && buttons.get(tabId);
    if (previous) previous.tabIndex = -1;
    tabId = node.id;
    buttons.get(tabId)!.tabIndex = 0;
  }, { signal });
  rows.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const index = Number(target.closest<HTMLButtonElement>(".jot-outline__row")?.dataset["index"]);
    const node = page?.nodes[index - page.from];
    if (!node) return;
    if (target.closest(".jot-outline__toggle") && booleanAttribute(node, "hasChildren")) toggle(node);
    else void navigate(index).catch(error => { if (!disposed) options.onError?.(error); });
  }, { signal });
  rows.addEventListener("keydown", event => {
    const index = Number((event.target as HTMLElement).dataset["index"]);
    if (!page?.nodes.length || !Number.isInteger(index)) return;
    const last = (page.complete ? page.total : page.from + page.nodes.length) - 1;
    const node = page.nodes[index - page.from];
    if (!node) return;
    const branch = booleanAttribute(node, "hasChildren");
    let target;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        if (branch && !collapsed.has(node.id)) { toggle(node); return; }
        target = numberAttribute(node, "parentIndex");
        if (target === undefined) return;
        break;
      case "ArrowRight":
        event.preventDefault();
        if (!branch) return;
        if (collapsed.has(node.id)) { toggle(node); return; }
        target = index + 1;
        break;
      case "ArrowDown": target = index + 1; break;
      case "ArrowUp": target = index - 1; break;
      case "Home": target = 0; break;
      case "End": target = last; break;
      default: return;
    }
    event.preventDefault();
    focusIndex = Math.max(0, Math.min(last, target));
    if (!page.complete) {
      const target = page.nodes[focusIndex - page.from];
      if (target) buttons.get(target.id)?.focus();
      focusIndex = undefined;
      return;
    }
    const top = focusIndex * rowHeight;
    if (top < nav.scrollTop) nav.scrollTop = top;
    else if (top + rowHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = top + rowHeight - nav.clientHeight;
    schedule();
  }, { signal });
  const unsubscribe = editor.subscribe(effect => {
    if (effect.documentPatch) {
      if (collapsed.size && effect.appliedEdits?.some(edit => edit.range.from === 0 && edit.range.to === documentLength)) {
        collapsed.clear();
        foldVersion++;
      }
      documentLength = editor.confirmedValue.length;
    }
    if (!effect.analysis) return;
    if (effect.analysis.state !== "complete" || page?.revision !== editor.revision) nav.setAttribute("aria-busy", "true");
    if (editTimer !== undefined) clearTimeout(editTimer);
    editTimer = undefined;
    if (effect.analysis.state === "failed") {
      status.textContent = "大纲加载失败";
      status.hidden = false;
      nav.setAttribute("aria-busy", "false");
      return;
    }
    if (effect.analysis.state !== "complete") {
      if (!page && effect.analysis.state === "pending" && effect.analysis.confirmedRanges.length) schedule();
      return;
    }
    if (page && page.revision !== editor.revision) {
      editTimer = setTimeout(() => { editTimer = undefined; schedule(); }, 80);
    } else schedule();
  });
  const selectionChanged = () => { if (view.hasFocus && !editor.inputPane.hidden) setActive(view.state.selection.main.head); };
  function inputScrolled(): void {
    if (editor.inputPane.hidden) return;
    const top = Math.max(0, view.scrollDOM.getBoundingClientRect().top - view.documentTop);
    const head = view.state.selection.main.head;
    const caret = view.lineBlockAt(head);
    setActive(caret.bottom >= top && caret.top < top + view.scrollDOM.clientHeight
      ? head : view.lineBlockAtHeight(top).from);
  }
  const previewScrolled = () => { if (editor.inputPane.hidden) setActive(editor.surface.captureScrollAnchor().sourceOffset); };
  view.dom.ownerDocument.addEventListener("selectionchange", selectionChanged, { signal });
  view.scrollDOM.addEventListener("scroll", inputScrolled, { passive: true, signal });
  editor.surfacePane.addEventListener("scroll", previewScrolled, { passive: true, signal });
  const modeObserver = new MutationObserver(() => { setActive(currentOffset()); schedule(); });
  modeObserver.observe(editor.inputPane, { attributes: true, attributeFilter: ["hidden"] });
  nav.addEventListener("scroll", () => { void refresh(); }, { passive: true, signal });
  const resize = new ResizeObserver(schedule);
  resize.observe(nav);
  nav.setAttribute("aria-busy", "true");
  schedule();
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    listeners.abort();
    modeObserver.disconnect();
    resize.disconnect();
    scrollbar?.dispose();
    clearTimeout(editTimer);
    cancelAnimationFrame(frame);
    buttons.clear();
    page = undefined;
    wrapper.remove();
  }
  lifetime.addEventListener("abort", dispose, { once: true, signal });
  return { dispose };
}

/** Let the editor own the binding's lifetime and toggle it with setPluginEnabled("outline", enabled). */
export function createOutlinePlugin(options: OutlineOptions & { readonly container: HTMLElement; readonly enabled?: boolean }): MarkdownEditorPlugin {
  return {
    id: "outline",
    enabled: options.enabled ?? true,
    affectsEditorLayout: false,
    activate(editor) { return mountOutline(options.container, editor, options).dispose; },
  };
}
