import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { readDomSourceRange, type DomSourceRange } from "../../components/common/dom-position.js";
import { logicalScrollLeft, setLogicalScrollLeft } from "../../components/common/render-utils.js";
import {
  chunkMayContainMatch,
  isKnownSearchMiss,
  selectionMatchesSearchQuery,
} from "../shared/search-engine.js";
import { sourceSnapshot } from "../shared/source-snapshot.js";
import { nearestRevealDelta } from "./viewport.js";

interface Paint { readonly matches: Range[]; readonly current: Range[]; readonly selection: Range[] }
interface SearchAnchor {
  readonly element: HTMLElement;
  readonly range: DomSourceRange;
  readonly text: boolean;
}
interface AnchorIndex {
  readonly doc: Text;
  readonly anchors: readonly SearchAnchor[];
  readonly maxPrefixTo: readonly number[];
  readonly windows: readonly DomSourceRange[];
}
const documentPaints = new WeakMap<Document, Map<object, Paint>>();
const MATCH = "jot-search-match";
const CURRENT = "jot-search-current";
const SELECTION = "jot-preview-selection";
const MAX_MATCHES = 1_000;
const MAX_SOURCE_UNITS = 262_144;

/** An already visible same-text widget hit needs paint, not a source-mode swap. */
export function canPaintRuntimeSearchRange(view: EditorView, match: DomSourceRange): boolean {
  const range = runtimeSearchRange(view, match);
  if (range === undefined) return false;
  const pane = view.scrollDOM.getBoundingClientRect();
  const rect = range.getBoundingClientRect();
  const table = range.startContainer.parentElement?.closest<HTMLElement>(".jot-table");
  const clip = table?.getBoundingClientRect();
  const left = Math.max(pane.left, clip?.left ?? pane.left);
  const right = Math.min(pane.right, clip?.right ?? pane.right);
  return rect.width > 0 && rect.height > 0 && rect.top >= pane.top && rect.bottom <= pane.bottom &&
    rect.left >= left && rect.right <= right;
}

/** Prefer actual component text geometry to an opaque replacement's boundary. */
export function revealRuntimeSearchRange(view: EditorView, match: DomSourceRange): boolean {
  const range = runtimeSearchRange(view, match);
  if (range === undefined) return false;
  const rect = range.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const pane = view.scrollDOM.getBoundingClientRect();
  const table = range.startContainer.parentElement?.closest<HTMLElement>(".jot-table");
  if (table !== null && table !== undefined && table.scrollWidth > table.clientWidth) {
    const bounds = table.getBoundingClientRect();
    const dx = nearestRevealDelta(rect.left, rect.right, Math.max(pane.left, bounds.left) + 8,
      Math.min(pane.right, bounds.right) - 8);
    if (dx !== 0) setLogicalScrollLeft(table, logicalScrollLeft(table) + dx);
  }
  const dy = nearestRevealDelta(rect.top, rect.bottom, pane.top + 8, pane.bottom - 8);
  if (dy !== 0) view.scrollDOM.scrollTop += dy;
  return true;
}

function runtimeSearchRange(view: EditorView, match: DomSourceRange): Range | undefined {
  if (match.to <= match.from) return undefined;
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>(
    '.jot-live-preview-widget [data-jot-kind="text"],.jot-live-preview-widget [data-jot-kind="inline-code"]',
  )) {
    const source = readDomSourceRange(element);
    if (source === undefined) continue;
    const rawFrom = element.getAttribute("data-jot-source-content-from");
    const rawTo = element.getAttribute("data-jot-source-content-to");
    const from = rawFrom !== null && /^\d+$/u.test(rawFrom) ? Number(rawFrom) : source.from;
    const to = rawTo !== null && /^\d+$/u.test(rawTo) ? Number(rawTo) : source.to;
    if (source.from > from || from > match.from || match.to > to || to > source.to || to > view.state.doc.length) continue;
    if (element.textContent !== view.state.doc.sliceString(from, to)) continue;
    return textRange(element, match.from - from, match.to - from);
  }
  return undefined;
}

/** Paint source search and selection in mounted semantic DOM without wrapping text. */
export class LivePreviewSearchHighlights {
  readonly #view: EditorView;
  readonly #isCurrent: () => boolean;
  readonly #isSearching: () => boolean;
  readonly #onError: (error: unknown) => void;
  readonly #observer: MutationObserver;
  readonly #marked = new Set<HTMLElement>();
  readonly #onScroll = (): void => {
    this.#anchorsDirty = true;
    this.schedule();
  };
  #anchorIndex: AnchorIndex | undefined;
  #anchorsDirty = true;
  #frame: number | undefined;
  #disposed = false;

  constructor(view: EditorView, isCurrent: () => boolean, isSearching: () => boolean,
    onError: (error: unknown) => void) {
    this.#view = view;
    this.#isCurrent = isCurrent;
    this.#isSearching = isSearching;
    this.#onError = onError;
    this.#observer = new MutationObserver((records) => {
      if (!hasWidgetMutation(records)) return;
      this.#anchorsDirty = true;
      this.schedule();
    });
    this.#observer.observe(view.contentDOM, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["data-jot-source-from", "data-jot-source-to", "data-jot-source-content-from", "data-jot-source-content-to"],
    });
    view.scrollDOM.addEventListener("scroll", this.#onScroll, true);
  }

  readonly schedule = (): void => {
    if (this.#disposed || this.#frame !== undefined) return;
    this.#frame = this.#view.dom.ownerDocument.defaultView?.requestAnimationFrame(() => {
      this.#frame = undefined;
      try { this.#paint(); } catch (error) { this.#onError(error); }
    });
  };

  clear(): void {
    for (const element of this.#marked) element.classList.remove("jot-search-match-node", "jot-search-current-node", "jot-preview-selection-node");
    this.#marked.clear();
    publish(this.#view.dom.ownerDocument, this);
  }

  dispose(): void {
    this.#disposed = true;
    this.#anchorIndex = undefined;
    if (this.#frame !== undefined) this.#view.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
    this.#observer.disconnect();
    this.#view.scrollDOM.removeEventListener("scroll", this.#onScroll, true);
    this.clear();
  }

  #collectAnchors(state: EditorView["state"], contentDOM: HTMLElement): AnchorIndex {
    const cached = this.#anchorIndex;
    if (!this.#anchorsDirty && cached !== undefined && cached.doc === state.doc) {
      return cached;
    }
    const anchors: SearchAnchor[] = [];
    const seen = new Set<Element>();
    for (const widget of contentDOM.querySelectorAll<HTMLElement>(".jot-live-preview-widget:not(.jot-live-preview-widget--geometry-gap)")) {
      const elements = [widget, ...widget.querySelectorAll<HTMLElement>(
        '[data-jot-kind="text"],[data-jot-kind="inline-code"],[data-jot-kind="inline-math"],[data-jot-kind="math-block"],[data-jot-kind="image"],.jot-table-cell',
      )];
      for (const element of elements) {
        if (seen.has(element)) continue;
        seen.add(element);
        const source = readDomSourceRange(element);
        if (source === undefined || source.from < 0 || source.to > state.doc.length) continue;
        const contentFrom = element.getAttribute("data-jot-source-content-from");
        const contentTo = element.getAttribute("data-jot-source-content-to");
        const inner = contentFrom !== null && contentTo !== null && /^\d+$/u.test(contentFrom) && /^\d+$/u.test(contentTo)
          ? { from: Number(contentFrom), to: Number(contentTo) } : source;
        const validInner = Number.isSafeInteger(inner.from) && Number.isSafeInteger(inner.to) &&
          source.from <= inner.from && inner.from <= inner.to && inner.to <= source.to;
        const range = validInner ? inner : source;
        const length = range.to - range.from;
        // Large sparse table roots are not search windows. Their mounted cell
        // anchors are bounded by the existing row/column virtualization.
        if (element.dataset["jotKind"] === "table" || length > MAX_SOURCE_UNITS) continue;
        const content = length > 0 ? element.textContent : null;
        const text = content !== null && content.length === length &&
          state.doc.sliceString(range.from, range.to) === content;
        anchors.push({ element, range, text });
      }
    }
    anchors.sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to);
    const maxPrefixTo = new Array<number>(anchors.length);
    let maxTo = -1;
    for (let index = 0; index < anchors.length; index += 1) {
      maxTo = Math.max(maxTo, anchors[index]!.range.to);
      maxPrefixTo[index] = maxTo;
    }
    const lineWindows = anchors.map(({ range }) => ({
      from: state.doc.lineAt(range.from).from,
      to: state.doc.lineAt(range.to).to,
    })).sort((a, b) => a.from - b.from);
    const windows: DomSourceRange[] = [];
    for (const window of lineWindows) {
      const last = windows.at(-1);
      if (last !== undefined && window.from <= last.to) {
        windows[windows.length - 1] = { from: last.from, to: Math.max(last.to, window.to) };
      } else windows.push(window);
    }
    const index: AnchorIndex = { doc: state.doc, anchors, maxPrefixTo, windows };
    this.#anchorIndex = index;
    this.#anchorsDirty = false;
    return index;
  }

  #paint(): void {
    this.clear();
    const { state, contentDOM } = this.#view;
    const query = getSearchQuery(state);
    const searching = query.valid && (searchPanelOpen(state) || this.#isSearching());
    const selecting = this.#view.hasFocus && !this.#isSearching() && state.selection.ranges.some(range => !range.empty);
    if (!this.#isCurrent() || (!searching && !selecting)) return;
    if (searching && !selecting && isKnownSearchMiss(state.doc, query)) return;
    const { anchors, maxPrefixTo, windows } = this.#collectAnchors(state, contentDOM);
    if (anchors.length === 0) return;
    const paint: Paint = { matches: [], current: [], selection: [] };
    const precise = supportsHighlights(this.#view.dom.ownerDocument);
    if (selecting) {
      for (const anchor of anchors) {
        if (paint.selection.length >= MAX_MATCHES) break;
        for (const selection of state.selection.ranges) {
          if (paint.selection.length >= MAX_MATCHES) break;
          const from = Math.max(selection.from, anchor.range.from);
          const to = Math.min(selection.to, anchor.range.to);
          if (to <= from) continue;
          const range = anchor.text && precise
            ? textRange(anchor.element, from - anchor.range.from, to - anchor.range.from) : undefined;
          if (range !== undefined) {
            paint.selection.push(range);
          } else if (["inline-math", "math-block", "image"].includes(anchor.element.dataset["jotKind"] ?? "")) {
            anchor.element.classList.add("jot-preview-selection-node");
            this.#marked.add(anchor.element);
          }
        }
      }
    }
    if (!searching || isKnownSearchMiss(state.doc, query)) {
      publish(this.#view.dom.ownerDocument, this, paint);
      return;
    }
    const selection = state.selection.main;
    const paintMatch = (match: DomSourceRange, current: boolean): void => {
      const anchor = findBestAnchor(anchors, maxPrefixTo, match);
      if (anchor === undefined) return;
      const range = anchor.text && precise
        ? textRange(anchor.element, match.from - anchor.range.from, match.to - anchor.range.from)
        : undefined;
      if (range !== undefined) {
        paint.matches.push(range);
        if (current) paint.current.push(range);
      } else {
        anchor.element.classList.add("jot-search-match-node");
        if (current) anchor.element.classList.add("jot-search-current-node");
        this.#marked.add(anchor.element);
      }
    };
    // Background paint is bounded, but the selected hit must remain visible
    // even in a very long physical line or beyond the first 1,000 matches.
    const paintedCurrent = !selection.empty && this.#isSearching() &&
      selectionMatchesSearchQuery(state, query, selection.from, selection.to);
    if (paintedCurrent) paintMatch(selection, true);
    const source = sourceSnapshot(this.#view);
    let remaining = MAX_SOURCE_UNITS, hits = 0;
    for (const window of windows) {
      if (remaining <= 0 || hits >= MAX_MATCHES) break;
      const to = Math.min(window.to, window.from + remaining);
      remaining -= to - window.from;
      if (!chunkMayContainMatch(source, window.from, to, query)) continue;
      const cursor = query.getCursor(state, window.from, to);
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        const match = next.value;
        if (++hits > MAX_MATCHES) break;
        if (match.to <= match.from) continue;
        const current = selection.from === match.from && selection.to === match.to;
        if (!current || !paintedCurrent) paintMatch(match, current);
      }
    }
    publish(this.#view.dom.ownerDocument, this, paint);
  }
}

function findBestAnchor(
  anchors: readonly SearchAnchor[],
  maxPrefixTo: readonly number[],
  match: DomSourceRange,
): SearchAnchor | undefined {
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (anchors[mid]!.range.from <= match.from) low = mid + 1;
    else high = mid;
  }
  let best: SearchAnchor | undefined;
  let bestLength = Number.POSITIVE_INFINITY;
  for (let index = low - 1; index >= 0; index -= 1) {
    if (maxPrefixTo[index]! < match.to) break;
    const candidate = anchors[index]!;
    if (candidate.range.to < match.to) continue;
    const length = candidate.range.to - candidate.range.from;
    if (best === undefined ||
        (candidate.text !== best.text ? candidate.text : length < bestLength)) {
      best = candidate;
      bestLength = length;
    }
  }
  return best;
}

function hasWidgetMutation(records: readonly MutationRecord[]): boolean {
  for (const record of records) {
    if (isInsideWidget(record.target)) return true;
    for (const node of record.addedNodes) if (containsWidget(node)) return true;
    for (const node of record.removedNodes) if (containsWidget(node)) return true;
  }
  return false;
}

function isInsideWidget(node: Node | null): boolean {
  if (node === null) return false;
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return element?.closest?.(".jot-live-preview-widget") != null;
}

function containsWidget(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  return element.classList.contains("jot-live-preview-widget") ||
    element.querySelector(".jot-live-preview-widget") !== null;
}

function textRange(element: HTMLElement, from: number, to: number): Range | undefined {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = element.ownerDocument.createRange();
  let offset = 0, started = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && from <= offset + length) {
      range.setStart(node, Math.max(0, from - offset));
      started = true;
    }
    if (started && to <= offset + length) {
      range.setEnd(node, Math.max(0, to - offset));
      return range;
    }
    offset += length;
  }
  return undefined;
}

function supportsHighlights(document: Document): boolean {
  const environment = document.defaultView as (Window & { CSS?: typeof CSS; Highlight?: typeof Highlight }) | null;
  return environment?.CSS?.highlights !== undefined && environment.Highlight !== undefined;
}

function publish(document: Document, owner: object, paint?: Paint): void {
  let owners = documentPaints.get(document);
  if (owners === undefined) { owners = new Map(); documentPaints.set(document, owners); }
  if (paint === undefined) owners.delete(owner); else owners.set(owner, paint);
  const environment = document.defaultView as (Window & { CSS?: typeof CSS; Highlight?: typeof Highlight }) | null;
  const registry = environment?.CSS?.highlights, HighlightType = environment?.Highlight;
  if (registry === undefined || HighlightType === undefined) return;
  if (owners.size === 0) { registry.delete(MATCH); registry.delete(CURRENT); registry.delete(SELECTION); return; }
  const all = [...owners.values()];
  registry.set(MATCH, new HighlightType(...all.flatMap(value => value.matches)));
  const current = new HighlightType(...all.flatMap(value => value.current));
  current.priority = 1;
  registry.set(CURRENT, current);
  const selection = new HighlightType(...all.flatMap(value => value.selection));
  selection.priority = 2;
  registry.set(SELECTION, selection);
}
