import type { RenderNode, Revision } from "@jot-md/editor-protocol";
import type { MarkdownEditor } from "../component/markdown-editor.js";
import { booleanAttribute, numberAttribute, numbersAttribute } from "../components/common/dom-renderer.js";
import { safeUtf16Offset } from "../components/common/render-utils.js";
import type { MarkdownEditorPlugin } from "./registry.js";

export interface OutlineOptions {
  readonly label?: string;
  readonly onError?: (error: unknown) => void;
  /** Fixed row height in CSS pixels, including padding. Defaults to 32. */
  readonly rowHeight?: number;
}

const styles = `
.jot-outline { overflow: auto; max-block-size: var(--jot-outline-max-height, 24rem);
  min-inline-size: 0; overscroll-behavior: contain; overflow-anchor: none; color: inherit; font: inherit; }
.jot-outline__track { position: relative; }
.jot-outline__rows { position: absolute; inset: 0 0 auto; }
.jot-outline__row { box-sizing: border-box; display: block; inline-size: 100%; block-size: var(--jot-outline-row-height);
  padding: 0 .6em; padding-inline-start: calc(.6em + (var(--jot-outline-level) - 1) * var(--jot-outline-indent, .85em));
  border: 0; border-radius: .3em; background: transparent; color: inherit; font: inherit; text-align: start;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
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
  const nav = document.createElement("nav");
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
  track.append(rows);
  nav.append(style, status, track);
  container.append(nav);

  const view = editor.input.view;
  const listeners = new AbortController();
  const { signal } = listeners;
  const buttons = new Map<number, HTMLButtonElement>();
  let page: { revision: Revision; complete: boolean; from: number; nodes: readonly RenderNode[]; total: number } | undefined;
  let disposed = false;
  let loading = false;
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
    for (const [index, button] of buttons) {
      const node = page.nodes[index - page.from];
      if (node) markCurrent(button, node);
    }
  }

  function draw(): void {
    if (!page) return;
    const { from, nodes, total } = page;
    // While parsing, only the first confirmed page is navigable.
    track.style.height = (page.complete ? total : from + nodes.length) * rowHeight + "px";
    rows.style.top = from * rowHeight + "px";
    for (const [index, button] of buttons) {
      if (index < from || index >= from + nodes.length) { button.remove(); buttons.delete(index); }
    }
    const source = editor.confirmedValue;
    for (const [slot, node] of nodes.entries()) {
      const index = from + slot;
      let button = buttons.get(index);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "jot-outline__row";
        button.dataset["index"] = String(index);
        buttons.set(index, button);
      }
      const level = numberAttribute(node, "level")!;
      const label = headingLabel(node, source);
      button.style.setProperty("--jot-outline-level", String(level));
      button.textContent = label;
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
    if (loading || editTimer !== undefined || !analysis || !nav.getClientRects().length) return;
    const complete = analysis.state === "complete";
    // Publish an early confirmed prefix once on open. Subsequent analysis ticks
    // can extend it many times. Wait for completion before querying it again.
    if (!complete && (analysis.state !== "pending" || page || !analysis.confirmedRanges.length)) return;
    const revision = editor.revision;
    // Group nearby scroll positions so moving one row rarely needs another Worker request.
    const stride = 12;
    const from = Math.max(0, Math.floor((nav.scrollTop / rowHeight - 3) / stride) * stride);
    const end = (Math.ceil((nav.scrollTop + nav.clientHeight) / rowHeight / stride) + 1) * stride;
    if (page?.revision === revision && page.complete && page.from <= from &&
        page.from + page.nodes.length >= Math.min(end, page.total)) {
      if (focusIndex !== undefined) {
        buttons.get(focusIndex)?.focus({ preventScroll: true });
        focusIndex = undefined;
      }
      return;
    }
    loading = true;
    const viewRevision = editor.session.adapter.viewRevision;
    try {
      const effect = await editor.session.project([{ parentId: "0", axis: "heading-outline",
        window: { type: "index", from, toExclusive: end }, maxDepth: 0 }]);
      if (disposed || editor.revision !== revision || viewRevision !== editor.session.adapter.viewRevision) {
        schedule();
        return;
      }
      const op = effect.renderPatch?.operations.find(op => op.axis === "heading-outline");
      if (!op) return;
      if (page?.revision !== revision) activeOffset = currentOffset();
      page = { revision, complete, from: op.from, nodes: op.inserted, total: op.totalChildren };
      draw();
      schedule(); // Rows can change the available height or clamp scrollTop after an edit.
    } catch (error) {
      if (disposed) return;
      if (editor.revision !== revision) schedule();
      else {
        status.textContent = "大纲加载失败";
        status.hidden = false;
        nav.setAttribute("aria-busy", "false");
        options.onError?.(error);
      }
    } finally { loading = false; }
  }

  async function navigate(index: number): Promise<void> {
    if (disposed || !page || view.composing) return;
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

  rows.addEventListener("click", event => {
    const index = (event.target as HTMLElement).closest<HTMLButtonElement>(".jot-outline__row")?.dataset["index"];
    if (index !== undefined) void navigate(Number(index)).catch(error => { if (!disposed) options.onError?.(error); });
  }, { signal });
  rows.addEventListener("keydown", event => {
    const index = Number((event.target as HTMLElement).dataset["index"]);
    if (!page?.nodes.length || !Number.isInteger(index)) return;
    const last = (page.complete ? page.total : page.from + page.nodes.length) - 1;
    let target;
    switch (event.key) {
      case "ArrowDown": target = index + 1; break;
      case "ArrowUp": target = index - 1; break;
      case "Home": target = 0; break;
      case "End": target = last; break;
      default: return;
    }
    event.preventDefault();
    focusIndex = Math.max(0, Math.min(last, target));
    if (!page.complete) { buttons.get(focusIndex)?.focus(); focusIndex = undefined; return; }
    const top = focusIndex * rowHeight;
    if (top < nav.scrollTop) nav.scrollTop = top;
    else if (top + rowHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = top + rowHeight - nav.clientHeight;
    schedule();
  }, { signal });
  const unsubscribe = editor.subscribe(effect => {
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
  nav.addEventListener("scroll", schedule, { passive: true, signal });
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
    clearTimeout(editTimer);
    cancelAnimationFrame(frame);
    buttons.clear();
    page = undefined;
    nav.remove();
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
