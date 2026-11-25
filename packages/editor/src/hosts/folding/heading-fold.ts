import { editorI18nAt } from "../../core/i18n.js";
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { ProjectionSlice, RenderNode } from "@jot-md/editor-protocol";
import type { EditorDocumentSession } from "../../adapter/session.js";
import { booleanAttribute, numberAttribute, rangeAttribute } from "../../components/common/dom-renderer.js";

export interface HeadingFoldRange {
  readonly id: string;
  readonly headingFrom: number;
  readonly headingTo: number;
  readonly contentSafeFrom?: number;
  readonly from: number;
  readonly to: number;
  readonly fromBlock: number;
  readonly toBlock: number;
}

/** Per-editor view state; Rust remains the sole authority for section boundaries. */
export class HeadingFoldController {
  readonly #session: EditorDocumentSession;
  readonly #compartment = new Compartment();
  readonly #setRanges = StateEffect.define<readonly HeadingFoldRange[]>();
  readonly #refreshMarkers = StateEffect.define<null>();
  readonly #field: StateField<DecorationSet>;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly extension: Extension;
  #view: EditorView | undefined;
  #enabled = false;
  #folds = new Map<string, HeadingFoldRange>();
  #pending = new Set<string>();
  readonly #inflight = new Set<string>();
  #empty = new Set<string>();
  #epoch = 0;
  #refreshQueued = false;
  #renderedKey = "";
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #blockedKey: string | undefined;
  #pointerSelecting = false;
  #selectionDeferred = false;
  #composing = false;
  #compositionInvalidates = false;
  readonly #pointerEnd = (): void => {
    this.#pointerSelecting = false;
    if (!this.#selectionDeferred) return;
    this.#selectionDeferred = false;
    if (this.#view !== undefined) this.#revealSelection(this.#view);
  };
  readonly #cancelPendingForScroll = (): void => {
    if (this.#pending.size === 0) return;
    this.#pending.clear();
    this.#changed();
  };

  constructor(session: EditorDocumentSession, onError?: (error: unknown) => void) {
    this.#session = session;
    this.#onError = onError;
    this.#field = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update: (value, tr) => {
        let next = tr.docChanged ? value.map(tr.changes) : value;
        for (const effect of tr.effects) if (effect.is(this.#setRanges)) {
          const doc = tr.newDoc;
          const ranges = outermost(effect.value).flatMap(fold => {
            const from = Math.min(doc.length, fold.headingTo);
            let to = Math.min(doc.length, fold.to);
            // Keep the separator before a following heading. At EOF the final
            // LF belongs to the folded body; retaining it creates a phantom
            // empty line which Preview correctly does not render.
            if (to < doc.length && to > from && doc.sliceString(to - 1, to) === "\n") to--;
            return from < to ? [Decoration.replace({ widget: new FoldPlaceholder(this, fold.id), inclusive: false }).range(from, to)] : [];
          });
          next = Decoration.set(ranges, true);
        }
        return next;
      },
      provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
    });
    const foldGutter = gutter({
      class: "jot-heading-fold-gutter",
      initialSpacer: () => new HeadingMarker(this, "", false, false, true),
      lineMarker: (_view, line) => {
        const block = this.#headingAt(line.from);
        if (!this.#enabled || block === undefined || Number(block.sourceRange.from) !== line.from || this.#empty.has(block.id)) return null;
        return new HeadingMarker(this, block.id, this.#folds.has(block.id), this.#pending.has(block.id));
      },
      lineMarkerChange: update => update.docChanged || update.transactions.some(tr => tr.effects.some(effect => effect.is(this.#setRanges) || effect.is(this.#refreshMarkers))),
    });
    this.extension = [
      this.#field,
      this.#compartment.of([]),
      Prec.highest(EditorState.transactionFilter.of(transaction => {
        if (!this.#enabled || !transaction.docChanged || !transaction.isUserEvent("delete") ||
            transaction.startState.selection.ranges.length !== 1 || !transaction.startState.selection.main.empty) return transaction;
        let hit: HeadingFoldRange | undefined;
        transaction.changes.iterChangedRanges((from, to) => {
          hit ??= this.visibleRanges.find(fold => from < fold.to && fold.headingTo < to);
        });
        if (hit === undefined) return transaction;
        this.unfold(hit.id);
        return [];
      })),
      EditorView.updateListener.of(update => this.#update(update)),
      Prec.highest(EditorView.domEventHandlers({
        keydown: (event, view) => this.#onKeyDown(event, view),
        keyup: event => { if (event.key === this.#blockedKey) this.#blockedKey = undefined; return false; },
        beforeinput: (event, view) => this.#onBeforeInput(event as InputEvent, view),
        pointerdown: event => { if (event.button === 0) this.#pointerSelecting = true; return false; },
        compositionstart: () => { this.#composing = true; return false; },
        compositionend: () => {
          this.#composing = false;
          if (this.#compositionInvalidates) {
            this.#compositionInvalidates = false;
            setTimeout(() => { if (this.#folds.size > 0) { this.#folds.clear(); this.#changed(); } }, 0);
          }
          return false;
        },
      })),
    ];
    this.#gutter = foldGutter;
    this.#unsubscribe = session.subscribe(effect => {
      if (!this.#enabled) return;
      if (effect.documentPatch !== undefined) this.#empty.clear();
      const rootsChanged = effect.documentPatch?.syntax !== undefined || effect.analysisUpdate?.syntax !== undefined ||
        effect.renderPatch?.operations.some(operation => operation.parentId === "0" && operation.axis === "syntax-children") === true;
      if (rootsChanged) this.#queueRefresh();
      if (this.#pending.size > 0 && (rootsChanged || effect.analysis !== undefined)) this.#schedulePending();
    });
  }

  readonly #gutter: Extension;
  get enabled(): boolean { return this.#enabled; }
  get epoch(): number { return this.#epoch; }
  get ranges(): readonly HeadingFoldRange[] { return [...this.#folds.values()]; }
  get visibleRanges(): readonly HeadingFoldRange[] { return outermost(this.ranges); }
  isFolded(id: string): boolean { return this.#folds.has(id); }
  attach(view: EditorView): void {
    this.#view = view;
    view.dom.ownerDocument.addEventListener("pointerup", this.#pointerEnd, true);
    view.dom.ownerDocument.addEventListener("pointercancel", this.#pointerEnd, true);
    view.dom.ownerDocument.defaultView?.addEventListener("blur", this.#pointerEnd);
    view.scrollDOM.addEventListener("wheel", this.#cancelPendingForScroll, { passive: true });
    view.scrollDOM.addEventListener("touchstart", this.#cancelPendingForScroll, { passive: true });
  }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#epoch++;
    if (!enabled) { this.#folds.clear(); this.#pending.clear(); this.#empty.clear(); }
    const view = this.#view;
    if (view !== undefined) {
      const ranges = this.ranges;
      this.#renderedKey = foldKey(ranges);
      view.dispatch({ effects: [this.#compartment.reconfigure(enabled ? this.#gutter : []), this.#setRanges.of(ranges)] });
    }
    this.#notify();
  }

  async toggleAt(offset: number): Promise<boolean> {
    const block = this.#headingAt(offset);
    return block === undefined ? false : this.toggle(block.id);
  }

  async toggle(id: string): Promise<boolean> {
    if (!this.#enabled) return false;
    if (this.#folds.has(id)) { this.#folds.delete(id); this.#changed(); return true; }
    if (this.#pending.has(id)) { this.#pending.delete(id); this.#changed(); return false; }
    this.#pending.add(id);
    this.#changed();
    return this.#resolve(id);
  }

  unfold(id: string): boolean {
    const removed = this.#folds.delete(id) || this.#pending.delete(id);
    if (removed) this.#changed();
    return removed;
  }

  unfoldAll(): void {
    if (this.#folds.size === 0 && this.#pending.size === 0) return;
    this.#folds.clear(); this.#pending.clear(); this.#changed();
  }

  /** Reveal all folded ancestors of a source target without changing text. */
  reveal(from: number, to = from): boolean {
    let changed = false;
    for (const [id, fold] of this.#folds) {
      if (from === to ? fold.from <= from && from < fold.to : from < fold.to && fold.from < to) {
        this.#folds.delete(id); changed = true;
      }
    }
    if (changed) this.#changed();
    return changed;
  }

  decorateHeading(element: HTMLElement, node: RenderNode): void {
    const previous = element.querySelector<HTMLButtonElement>(":scope > .jot-heading-fold-button");
    if (!this.#enabled || node.kind !== "heading" || this.#empty.has(node.id)) { previous?.remove(); return; }
    const button = previous ?? element.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "jot-heading-fold-button";
    button.dataset["jotFoldId"] = node.id;
    button.setAttribute("aria-expanded", String(!this.#folds.has(node.id)));
    button.setAttribute("aria-busy", String(this.#pending.has(node.id)));
    editorI18nAt(this.#view?.dom ?? element).bind(button, "aria-label", this.#pending.has(node.id) ? "Checking section bounds, click to cancel" : this.#folds.has(node.id) ? "Expand section" : "Fold section");
    if (previous === null) {
      button.addEventListener("pointerdown", keepEditorSelection);
      button.addEventListener("mousedown", keepEditorSelection);
      button.addEventListener("click", event => {
        event.stopPropagation();
        const id = button.dataset["jotFoldId"];
        if (id !== undefined) void this.toggle(id).catch(this.#onError);
      });
      element.prepend(button);
    }
  }

  dispose(): void {
    this.#unsubscribe();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#view?.dom.ownerDocument.removeEventListener("pointerup", this.#pointerEnd, true);
    this.#view?.dom.ownerDocument.removeEventListener("pointercancel", this.#pointerEnd, true);
    this.#view?.dom.ownerDocument.defaultView?.removeEventListener("blur", this.#pointerEnd);
    this.#view?.scrollDOM.removeEventListener("wheel", this.#cancelPendingForScroll);
    this.#view?.scrollDOM.removeEventListener("touchstart", this.#cancelPendingForScroll);
    this.#listeners.clear(); this.#folds.clear(); this.#pending.clear(); this.#view = undefined;
  }

  async #resolve(id: string): Promise<boolean> {
    const view = this.#view;
    if (view === undefined || !this.#enabled || !this.#pending.has(id) || this.#inflight.has(id)) return false;
    if (view.composing || view.state.doc.toString() !== this.#session.adapter.text.text) { this.#schedulePending(); return false; }
    const revision = this.#session.adapter.revision;
    const doc = view.state.doc;
    const slice: ProjectionSlice = { parentId: id, axis: "heading-section", window: { type: "index", from: 0, toExclusive: 1 }, maxDepth: 0 };
    this.#inflight.add(id);
    try {
      const effect = await this.#session.project([slice]);
      if (!this.#enabled || !this.#pending.has(id) || view.state.doc !== doc || this.#session.adapter.revision !== revision) {
        if (this.#pending.has(id)) this.#schedulePending();
        return false;
      }
      if (effect.renderPatch === undefined) { this.#schedulePending(); return false; }
      const node = effect.renderPatch.operations.find(op => op.axis === "heading-section" && op.parentId === id)?.inserted[0];
      if (node === undefined) {
        if (this.#session.adapter.analysis?.state !== "pending") { this.#pending.delete(id); this.#changed(); }
        return false;
      }
      if (booleanAttribute(node, "confirmed") !== true) {
        if (this.#session.adapter.analysis?.state !== "pending") { this.#pending.delete(id); this.#changed(); }
        return false;
      }
      const range = rangeAttribute(node, "sectionRange");
      const fromBlock = numberAttribute(node, "fromBlock"), toBlock = numberAttribute(node, "toBlock");
      const contentSafeFrom = numberAttribute(node, "contentSafeFrom");
      this.#pending.delete(id);
      if (range === undefined || fromBlock === undefined || toBlock === undefined || Number(range.from) >= Number(range.to)) {
        this.#empty.add(id); this.#changed(); return false;
      }
      const selection = view.state.selection;
      const from = Number(range.from), to = Number(range.to);
      if (selection.ranges.some(item => !item.empty && item.from < to && from < item.to)) {
        view.dispatch({ effects: EditorView.announce.of(editorI18nAt(view.dom).t("Clear the overlapping selection before folding this section")) });
        this.#changed();
        return false;
      }
      if (selection.ranges.some(item => item.empty && from <= item.head && item.head < to)) {
        view.dispatch({ selection: { anchor: Number(node.sourceRange.to) } });
      }
      this.#folds.set(id, { id, headingFrom: Number(node.sourceRange.from), headingTo: Number(node.sourceRange.to), from, to, fromBlock, toBlock,
        ...(contentSafeFrom === undefined ? {} : { contentSafeFrom }) });
      this.#changed();
      return true;
    } catch (error) {
      const stale = view.state.doc !== doc || this.#session.adapter.revision !== revision || !this.#pending.has(id);
      if (stale) {
        if (this.#pending.has(id)) this.#schedulePending();
      } else {
        this.#pending.delete(id);
        this.#changed();
        this.#onError?.(error);
      }
      return false;
    } finally {
      this.#inflight.delete(id);
    }
  }

  #headingAt(offset: number): import("../../adapter/block-index.js").IndexedBlock | undefined {
    const index = this.#session.adapter.blocks.blockAt(offset);
    const block = index === undefined ? undefined : this.#session.adapter.blocks.blocks[index];
    return block?.kind === "heading" && !block.dirty ? block : undefined;
  }

  #update(update: ViewUpdate): void {
    if (!this.#enabled) return;
    if ((update.docChanged || update.selectionSet) && this.#pending.size > 0) {
      this.#pending.clear();
      this.#epoch++;
      this.#queueRefresh();
      this.#notify();
    }
    if (update.docChanged && this.#folds.size > 0) {
      let structural = false;
      for (const transaction of update.transactions) transaction.changes.iterChanges((from, to, _a, _b, inserted) => {
        const removed = transaction.startState.doc.sliceString(from, to);
        const added = inserted.toString();
        const line = transaction.startState.doc.lineAt(from);
        const safeTitle = !/[\n\r]/u.test(removed + added) && [...this.#folds.values()].some(fold =>
          fold.contentSafeFrom !== undefined && fold.contentSafeFrom <= from && to <= fold.headingTo);
        if (!safeTitle && (/[\n\r`$#|\\]/u.test(removed + added) || from <= line.from + 4 || to >= line.to - 2)) structural = true;
      });
      const composing = this.#composing || update.view.composing || update.transactions.some(tr => tr.isUserEvent("input.type.compose"));
      if (structural && !composing) this.#folds.clear();
      else {
        if (structural) this.#compositionInvalidates = true;
        const next = new Map<string, HeadingFoldRange>();
        for (const fold of this.#folds.values()) {
          const overlaps = update.transactions.some(tr => {
            let touched = false;
            tr.changes.iterChangedRanges((from, to) => { if (from < fold.to && fold.from < Math.max(to, from + 1)) touched = true; });
            return touched;
          });
          if (!overlaps) next.set(fold.id, { ...fold,
            headingFrom: update.changes.mapPos(fold.headingFrom, 1), headingTo: update.changes.mapPos(fold.headingTo, 1),
            from: update.changes.mapPos(fold.from, 1), to: update.changes.mapPos(fold.to, -1),
            ...(fold.contentSafeFrom === undefined ? {} : { contentSafeFrom: update.changes.mapPos(fold.contentSafeFrom, -1) }),
          });
        }
        this.#folds = next;
      }
      this.#epoch++;
      if (!composing) { this.#queueRefresh(); this.#notify(); }
    }
    if (update.selectionSet && this.#folds.size > 0) {
      if (this.#pointerSelecting) this.#selectionDeferred = true;
      else this.#revealSelection(update.view);
    }
  }

  #revealSelection(view: EditorView): void {
      const selection = view.state.selection;
      const all = selection.ranges.length === 1 && selection.main.from === 0 && selection.main.to === view.state.doc.length;
      const before = this.#folds.size;
      if (!all) for (const range of selection.ranges) {
        const from = range.from, to = range.to;
        for (const [id, fold] of this.#folds) {
          if (from === to ? fold.from <= from && from < fold.to : from < fold.to && fold.from < to) this.#folds.delete(id);
        }
      }
      if (this.#folds.size !== before) { this.#epoch++; this.#queueRefresh(); this.#notify(); }
  }

  #onKeyDown(event: KeyboardEvent, view: EditorView): boolean {
    if (!this.#enabled || (event.key !== "Backspace" && event.key !== "Delete")) return false;
    if (event.repeat && event.key === this.#blockedKey) { event.preventDefault(); return true; }
    if (this.#revealAtDeletion(view, event.key === "Backspace")) {
      this.#blockedKey = event.key; event.preventDefault(); return true;
    }
    return false;
  }
  #onBeforeInput(event: InputEvent, view: EditorView): boolean {
    if (!this.#enabled || !event.cancelable || event.isComposing || !event.inputType.startsWith("delete")) return false;
    if (this.#revealAtDeletion(view, /Backward$/u.test(event.inputType))) { event.preventDefault(); return true; }
    return false;
  }
  #revealAtDeletion(view: EditorView, backward: boolean): boolean {
    const selection = view.state.selection;
    if (selection.ranges.length !== 1 || !selection.main.empty) return false;
    const head = selection.main.head;
    const fold = this.visibleRanges.find(item => backward ? head === item.to : head === item.headingTo);
    return fold === undefined ? false : this.unfold(fold.id);
  }
  #schedulePending(): void {
    if (this.#retryTimer !== undefined || !this.#enabled || this.#pending.size === 0) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      for (const id of this.#pending) void this.#resolve(id);
    }, 150);
  }
  #changed(): void { this.#epoch++; this.#queueRefresh(); this.#notify(); }
  #notify(): void { for (const listener of this.#listeners) listener(); }
  #queueRefresh(): void {
    if (this.#refreshQueued) return;
    this.#refreshQueued = true;
    queueMicrotask(() => {
      this.#refreshQueued = false;
      if (this.#view !== undefined) {
        const ranges = this.ranges;
        const key = foldKey(ranges);
        const effect = key === this.#renderedKey ? this.#refreshMarkers.of(null) : this.#setRanges.of(ranges);
        this.#renderedKey = key;
        this.#view.dispatch({ effects: effect });
      }
    });
  }
}

function foldKey(folds: readonly HeadingFoldRange[]): string {
  return folds.map(fold => `${fold.id}:${fold.headingTo}:${fold.from}:${fold.to}`).join("|");
}

function outermost(folds: readonly HeadingFoldRange[]): HeadingFoldRange[] {
  const sorted = [...folds].sort((a, b) => a.from - b.from || b.to - a.to);
  const result: HeadingFoldRange[] = [];
  let end = -1;
  for (const fold of sorted) if (fold.from >= end) { result.push(fold); end = fold.to; }
  return result;
}

class FoldPlaceholder extends WidgetType {
  constructor(readonly owner: HeadingFoldController, readonly id: string) { super(); }
  eq(other: FoldPlaceholder): boolean { return this.owner === other.owner && this.id === other.id; }
  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "jot-heading-fold-placeholder";
    span.textContent = " …";
    editorI18nAt(view.dom).bind(span, "aria-label", "Folded section");
    span.addEventListener("mousedown", event => event.preventDefault());
    span.addEventListener("click", () => this.owner.unfold(this.id));
    return span;
  }
}

class HeadingMarker extends GutterMarker {
  constructor(readonly owner: HeadingFoldController, readonly id: string, readonly folded: boolean, readonly pending: boolean, readonly spacer = false) { super(); }
  eq(other: HeadingMarker): boolean { return this.id === other.id && this.folded === other.folded && this.pending === other.pending && this.spacer === other.spacer; }
  toDOM(view: EditorView): HTMLElement {
    const button = view.dom.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "jot-heading-fold-button";
    // CodeMirror hides its gutter subtree from accessibility APIs; keyboard
    // users operate the same action through the registered shortcut instead.
    button.tabIndex = -1;
    if (this.spacer) { button.style.visibility = "hidden"; button.tabIndex = -1; button.setAttribute("aria-hidden", "true"); return button; }
    button.dataset["jotFoldId"] = this.id;
    button.setAttribute("aria-expanded", String(!this.folded));
    button.setAttribute("aria-busy", String(this.pending));
    editorI18nAt(view.dom).bind(button, "aria-label", this.pending ? "Checking section bounds, click to cancel" : this.folded ? "Expand section" : "Fold section");
    button.addEventListener("pointerdown", keepEditorSelection);
    button.addEventListener("mousedown", keepEditorSelection);
    button.addEventListener("click", event => { event.stopPropagation(); void this.owner.toggle(this.id); });
    return button;
  }
}

function keepEditorSelection(event: MouseEvent | PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
}
