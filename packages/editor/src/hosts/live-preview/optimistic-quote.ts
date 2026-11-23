import type { Text, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { quotePrefix } from "../../components/common/quote-prefix.js";
import { rebaseListIndent, setListIndentStyle } from "./list-indent.js";

// The same invisible marker is used by confirmed and local presentations.
class LeadingQuoteMarkerWidget extends WidgetType {
  override toDOM(view: EditorView): HTMLElement {
    const marker = view.dom.ownerDocument.createElement("span");
    marker.className = "jot-live-preview-leading-quote-marker";
    return marker;
  }
}
export const leadingQuoteMarkerWidget = new LeadingQuoteMarkerWidget();

export interface QuoteLine {
  readonly from: number;
  readonly to: number;
  readonly prefixTo: number;
  readonly previousPrefixTo: number;
  readonly prefix: string;
  readonly kind: "ordinary" | "list" | "code" | "other";
}

/** A native quote row whose prefix was confirmed or locally mapped. */
export function quoteLineAt(
  decorations: DecorationSet,
  doc: Text,
  position: number,
): QuoteLine | undefined {
  const line = doc.lineAt(position);
  const row = quoteRowAt(decorations, line.from);
  if (row === undefined) return undefined;
  const marker = quoteMarkerAt(decorations, line.from, row.owner);
  if (marker === undefined || marker.to > line.to || marker.to - line.from > 512 || position < marker.to) return undefined;
  const prefix = doc.sliceString(line.from, marker.to);
  const parsed = quotePrefix(prefix, 0, row.depth);
  if (parsed?.depth !== row.depth || parsed.to !== prefix.length) return undefined;
  const previous = row.depth === 1 ? 0 : quotePrefix(prefix, 0, row.depth - 1)?.to;
  if (previous === undefined) return undefined;
  const classes = String(row.decoration.spec.class ?? "");
  const kind = /\bjot-live-preview-list-item\b/u.test(classes) ? "list" :
    /\bjot-live-preview-source-fenced-code\b/u.test(classes) && !/\bjot-live-preview-code-boundary\b/u.test(classes) ? "code" :
    ordinaryQuoteRow(row) ? "ordinary" : "other";
  return { from: line.from, to: line.to, prefixTo: marker.to, previousPrefixTo: line.from + previous, prefix, kind };
}

export function ordinaryQuoteLineAt(decorations: DecorationSet, doc: Text, position: number): QuoteLine | undefined {
  const line = quoteLineAt(decorations, doc, position);
  return line?.kind === "ordinary" ? line : undefined;
}

interface QuoteRow {
  readonly from: number;
  readonly decoration: Decoration;
  readonly owner: string;
  readonly depth: number;
  readonly open: number;
  readonly close: number;
}

interface QuoteRowUpdate {
  readonly row: QuoteRow;
  readonly from: number;
  readonly depth: number;
  readonly open: number;
  readonly close: number;
  readonly markerOnly?: boolean;
  readonly paragraph?: boolean;
  readonly rootLast?: boolean;
  readonly listIndent?: number;
}

interface QuoteMarker {
  readonly from: number;
  readonly to: number;
  readonly decoration: Decoration;
}

/** Query only the physical row's boundary, never the whole projection. */
function quoteRowAt(decorations: DecorationSet, position: number): QuoteRow | undefined {
  let row: QuoteRow | undefined;
  decorations.between(position, position, (from, _to, decoration) => {
    const spec = decoration.spec;
    if (from !== position || spec.jotLiveSourceLine !== true) return;
    const attributes = spec.attributes as Record<string, string> | undefined;
    const depth = Number(attributes?.["data-jot-quote-depth"]);
    const open = Number(attributes?.["data-jot-quote-open"]);
    const close = Number(attributes?.["data-jot-quote-close"]);
    if (!Number.isInteger(depth) || depth < 1 || !Number.isInteger(open) ||
        !Number.isInteger(close) || typeof spec.jotLiveNode !== "string") return;
    row = { from, decoration, owner: spec.jotLiveNode, depth, open, close };
  });
  return row;
}

function quoteMarkerAt(decorations: DecorationSet, position: number, owner: string, end?: number): QuoteMarker | undefined {
  let marker: QuoteMarker | undefined;
  decorations.between(position, position, (from, to, decoration) => {
    if (from === position && to > from && (end === undefined || to === end) &&
        decoration.spec.jotLiveQuotePrefix === true && decoration.spec.jotLiveNode === owner) {
      marker = { from, to, decoration };
    }
  });
  return marker;
}

function ordinaryQuoteRow(row: QuoteRow): boolean {
  return !/\bjot-live-preview-(?:source-fenced-code|source-math-block|source-heading|list-item|structural-line|code-boundary)\b/u
    .test(String(row.decoration.spec.class ?? ""));
}

function ordinaryMarkerOnly(row: QuoteRow): boolean {
  return (row.decoration.spec.attributes as Record<string, string> | undefined)?.["data-jot-quote-marker-only"] === "true" &&
    ordinaryQuoteRow(row);
}

/** A narrowly proven, temporary presentation until Rust confirms the edit. */
export interface OptimisticQuoteEdit {
  readonly owner: string;
  readonly oldMarkerFrom: number;
  readonly oldMarkerTo: number;
  readonly markerFrom: number;
  readonly markerTo: number;
  readonly marker: Decoration;
  readonly extraMarkers?: readonly { readonly from: number; readonly to: number; readonly decoration: Decoration }[];
  readonly structuralMarkers?: readonly { readonly oldFrom: number; readonly oldTo: number; readonly owner: string;
    readonly from: number; readonly to: number; readonly decoration: Decoration }[];
  readonly rows: readonly QuoteRowUpdate[];
}

/** Forward Delete on an empty quote removes that physical row, not both prefixes. */
export function emptyQuoteForwardDeleteAt(
  decorations: DecorationSet,
  doc: Text,
  position: number,
): { readonly from: number; readonly to: number; readonly selection: number } | undefined {
  const line = doc.lineAt(position);
  if (position !== line.to || line.length > 512 || line.number >= doc.lines) return undefined;
  const prefix = quotePrefix(line.text, 0, Number.POSITIVE_INFINITY);
  if (prefix === undefined || prefix.to !== line.length) return undefined;
  const next = doc.line(line.number + 1);
  const current = quoteRowAt(decorations, line.from);
  if (current === undefined || !ordinaryMarkerOnly(current) ||
      quoteMarkerAt(decorations, line.from, current.owner, line.to) === undefined) return undefined;
  const nextMarker = quoteMarkerAt(decorations, next.from, current.owner);
  if (nextMarker === undefined || nextMarker.to > next.to) return undefined;
  return { from: line.from, to: next.from, selection: line.from + nextMarker.to - next.from };
}

function resolveQuoteRowDeletion(
  decorations: DecorationSet,
  transaction: Transaction,
  oldLine: ReturnType<Text["lineAt"]>,
): OptimisticQuoteEdit | undefined {
  if (oldLine.number >= transaction.startState.doc.lines) return undefined;
  const nextLine = transaction.startState.doc.line(oldLine.number + 1);
  const current = quoteRowAt(decorations, oldLine.from), next = quoteRowAt(decorations, nextLine.from);
  if (current === undefined || next === undefined || current.owner !== next.owner || !ordinaryMarkerOnly(current)) return undefined;
  const marker = quoteMarkerAt(decorations, oldLine.from, current.owner, oldLine.to);
  const nextMarker = quoteMarkerAt(decorations, nextLine.from, current.owner);
  if (marker === undefined || nextMarker === undefined) return undefined;
  const previousLine = oldLine.number > 1 ? transaction.startState.doc.line(oldLine.number - 1) : undefined;
  const previous = previousLine === undefined ? undefined : quoteRowAt(decorations, previousLine.from);
  const prev = previous?.owner === current.owner ? previous : undefined;
  if (prev === undefined && current.open !== current.depth) return undefined;
  const prevDepth = prev?.depth ?? 0;
  if (current.open !== Math.max(0, current.depth - prevDepth) ||
      current.close !== Math.max(0, current.depth - next.depth) ||
      next.open !== Math.max(0, next.depth - current.depth) ||
      (prev !== undefined && prev.close !== Math.max(0, prev.depth - current.depth))) return undefined;
  const updates: QuoteRowUpdate[] = [];
  if (prev !== undefined) updates.push({ row: prev, from: transaction.changes.mapPos(prev.from, -1),
    depth: prev.depth, open: prev.open, close: Math.max(0, prev.depth - next.depth) });
  const from = transaction.changes.mapPos(nextLine.from, -1);
  updates.push({ row: next, from, depth: next.depth, open: Math.max(0, next.depth - prevDepth), close: next.close });
  return { owner: current.owner, oldMarkerFrom: marker.from, oldMarkerTo: marker.to,
    markerFrom: from, markerTo: from + nextMarker.to - nextMarker.from, marker: nextMarker.decoration, rows: updates };
}

/** Restore a deleted marker-only row without exposing the whole quote on Undo. */
function resolveQuoteRowUndo(
  decorations: DecorationSet,
  transaction: Transaction,
  from: number,
  inserted: string,
): OptimisticQuoteEdit | undefined {
  if (!transaction.isUserEvent("undo") || !inserted.endsWith("\n") || inserted.indexOf("\n") !== inserted.length - 1) return undefined;
  const text = inserted.slice(0, -1);
  const prefix = quotePrefix(text, 0, Number.POSITIVE_INFINITY);
  if (prefix === undefined || prefix.to !== text.length) return undefined;
  const nextLine = transaction.startState.doc.lineAt(from);
  if (nextLine.from !== from) return undefined;
  const next = quoteRowAt(decorations, nextLine.from);
  if (next === undefined || /\bjot-live-preview-(?:source-fenced-code|source-math-block|source-heading|list-item|structural-line|code-boundary)\b/u
      .test(String(next.decoration.spec.class ?? ""))) return undefined;
  const marker = quoteMarkerAt(decorations, nextLine.from, next.owner);
  if (marker === undefined) return undefined;
  const previousLine = nextLine.number > 1 ? transaction.startState.doc.line(nextLine.number - 1) : undefined;
  const previous = previousLine === undefined ? undefined : quoteRowAt(decorations, previousLine.from);
  const prev = previous?.owner === next.owner ? previous : undefined;
  if (prev === undefined && next.open !== next.depth) return undefined;
  const prevDepth = prev?.depth ?? 0;
  if (next.open !== Math.max(0, next.depth - prevDepth) ||
      (prev !== undefined && prev.close !== Math.max(0, prev.depth - next.depth))) return undefined;
  const insertedRow: QuoteRow = {
    from,
    owner: next.owner,
    depth: prefix.depth,
    open: 0,
    close: 0,
    decoration: Decoration.line({
      class: "jot-live-preview-line jot-live-preview-native-block jot-live-preview-native-block--block-quote jot-md-block-quote jot-live-preview-active-line",
      jotLiveNode: next.owner,
      jotLiveSourceLine: true,
      attributes: { "data-jot-live-node": next.owner, "data-jot-quote-marker-hidden": "true" },
    }),
  };
  const updates: QuoteRowUpdate[] = [];
  if (prev !== undefined) updates.push({ row: prev, from: transaction.changes.mapPos(prev.from, -1),
    depth: prev.depth, open: prev.open, close: Math.max(0, prev.depth - prefix.depth) });
  updates.push({ row: insertedRow, from, depth: prefix.depth, open: Math.max(0, prefix.depth - prevDepth),
    close: Math.max(0, prefix.depth - next.depth), markerOnly: true });
  const nextFrom = transaction.changes.mapPos(nextLine.from, 1);
  updates.push({ row: next, from: nextFrom, depth: next.depth,
    open: Math.max(0, next.depth - prefix.depth), close: next.close });
  return { owner: next.owner, oldMarkerFrom: marker.from, oldMarkerTo: marker.to,
    markerFrom: from, markerTo: from + text.length, marker: marker.decoration,
    extraMarkers: [{ from: nextFrom, to: nextFrom + marker.to - marker.from, decoration: marker.decoration }], rows: updates };
}

/** Map a plain paragraph becoming a quote when adjacent quote edges are known. */
function resolveQuotePromotion(
  decorations: DecorationSet,
  transaction: Transaction,
  line: ReturnType<Text["lineAt"]>,
  change: { readonly from: number; readonly to: number; readonly inserted: string },
): OptimisticQuoteEdit | undefined {
  if (change.from !== line.from || change.to !== line.from || change.inserted === "") return undefined;
  const newLine = transaction.newDoc.lineAt(line.from);
  const head = transaction.newDoc.sliceString(newLine.from, Math.min(newLine.to, newLine.from + 512));
  const prefix = quotePrefix(head, 0, Number.POSITIVE_INFINITY);
  const bodyFrom = transaction.changes.mapPos(line.from, 1);
  if (prefix === undefined || newLine.from + prefix.to !== bodyFrom) return undefined;
  const body = transaction.startState.doc.sliceString(line.from, Math.min(line.to, line.from + 64));
  if (/^[ \t]*(?:[#>`$*+\-|~\[]|\d+[.)][ \t])/u.test(body)) return undefined;
  const previous = line.number > 1 ? transaction.startState.doc.line(line.number - 1) : undefined;
  const next = line.number < transaction.startState.doc.lines ? transaction.startState.doc.line(line.number + 1) : undefined;
  const previousQuote = previous === undefined ? undefined : quoteRowAt(decorations, previous.from);
  const nextQuote = next === undefined ? undefined : quoteRowAt(decorations, next.from);
  // A neighbouring quote must be a complete root edge, not a clipped window
  // or an opaque component whose structure could change when the roots join.
  if ((previousQuote !== undefined && (!ordinaryQuoteRow(previousQuote) || previousQuote.close !== previousQuote.depth)) ||
      (nextQuote !== undefined && (!ordinaryQuoteRow(nextQuote) || nextQuote.open !== nextQuote.depth))) return undefined;
  let plain: Decoration | undefined;
  decorations.between(line.from, line.from, (from, _to, decoration) => {
    const classes = String(decoration.spec.class ?? "");
    if (from === line.from && decoration.spec.jotLiveSourceLine === true &&
        /\bjot-live-preview-(?:native-block--paragraph|blank-line)\b/u.test(classes) &&
        !/\bjot-live-preview-(?:list-item|source-heading|source-fenced-code|source-math-block)\b/u.test(classes)) plain = decoration;
  });
  if (plain === undefined || typeof plain.spec.jotLiveNode !== "string") return undefined;
  const owner = plain.spec.jotLiveNode;
  const active = /\bjot-live-preview-active-line\b/u.test(String(plain.spec.class ?? ""));
  const row: QuoteRow = { from: line.from, owner, depth: prefix.depth, open: prefix.depth, close: prefix.depth,
    decoration: Decoration.line({ ...plain.spec,
      class: `jot-live-preview-line jot-live-preview-native-block jot-live-preview-native-block--block-quote jot-live-preview-block-quote jot-live-preview-source-block-quote jot-md-block-quote jot-live-preview-native-block--last${active ? " jot-live-preview-active-line" : ""}`,
      attributes: { "data-jot-live-node": owner, "data-jot-quote-marker-hidden": "true" },
    }) };
  const marker = Decoration.replace({ widget: leadingQuoteMarkerWidget, inclusive: false, jotLiveNode: owner,
    jotLiveStructural: true, jotLiveQuotePrefix: true, jotLiveSelection: "atomic" });
  const updates: QuoteRowUpdate[] = [];
  if (previousQuote !== undefined) updates.push({ row: previousQuote,
    from: transaction.changes.mapPos(previousQuote.from, -1), depth: previousQuote.depth, open: previousQuote.open,
    close: Math.max(0, previousQuote.depth - prefix.depth), rootLast: false });
  updates.push({ row, from: line.from, depth: prefix.depth,
    open: Math.max(0, prefix.depth - (previousQuote?.depth ?? 0)),
    close: Math.max(0, prefix.depth - (nextQuote?.depth ?? 0)),
    markerOnly: bodyFrom === newLine.to, rootLast: nextQuote === undefined });
  if (nextQuote !== undefined) updates.push({ row: nextQuote,
    from: transaction.changes.mapPos(nextQuote.from, -1), depth: nextQuote.depth,
    open: Math.max(0, nextQuote.depth - prefix.depth), close: nextQuote.close });
  return { owner, oldMarkerFrom: line.from, oldMarkerTo: line.from, markerFrom: line.from,
    markerTo: bodyFrom, marker, rows: updates };
}

function couldStartBlock(text: string): boolean {
  return /^[ \t]{0,3}(?:>|#{1,6}(?:[ \t]|$)|`{3}|\${2}|[+*\-](?:[ \t]|$)|\d+[.)][ \t]|\|)/u.test(text);
}

/** Preserve a confirmed list marker while only its indentation changes. */
function resolveQuoteListIndent(
  decorations: DecorationSet,
  transaction: Transaction,
  oldLine: ReturnType<Text["lineAt"]>,
  change: { readonly from: number; readonly to: number; readonly inserted: string },
): OptimisticQuoteEdit | undefined {
  const row = quoteRowAt(decorations, oldLine.from);
  if (row?.decoration.spec.attributes?.["data-jot-live-list-marker"] === undefined) return undefined;
  const quote = quoteMarkerAt(decorations, oldLine.from, row.owner);
  if (quote === undefined || quote.to - oldLine.from > 512) return undefined;
  const line = transaction.newDoc.lineAt(transaction.changes.mapPos(oldLine.from, -1));
  const head = transaction.newDoc.sliceString(line.from, Math.min(line.to, line.from + 512));
  const prefix = quotePrefix(head, 0, Number.POSITIVE_INFINITY);
  if (prefix?.depth !== row.depth) return undefined;
  const quoteTo = line.from + prefix.to;
  const list = rebaseListIndent(decorations, transaction, change, quote.to, oldLine.to, quoteTo, line.to);
  if (list === undefined) return undefined;
  return { owner: row.owner, oldMarkerFrom: quote.from, oldMarkerTo: quote.to,
    markerFrom: line.from, markerTo: quoteTo, marker: quote.decoration,
    structuralMarkers: [list],
    rows: [{ row, from: line.from, depth: row.depth, open: row.open, close: row.close,
      listIndent: list.columns }] };
}

/** Keep the confirmed quote geometry while a body becomes empty or nonempty. */
function resolveQuoteBodyTransition(
  decorations: DecorationSet,
  transaction: Transaction,
  oldLine: ReturnType<Text["lineAt"]>,
  change: { readonly from: number; readonly to: number },
): OptimisticQuoteEdit | undefined {
  const row = quoteRowAt(decorations, oldLine.from);
  if (row === undefined || !ordinaryQuoteRow(row)) return undefined;
  const marker = quoteMarkerAt(decorations, oldLine.from, row.owner);
  if (marker === undefined || marker.to - oldLine.from > 512 || change.to > oldLine.to) return undefined;
  const removesSeparator = change.from === marker.to - 1 && change.to >= marker.to &&
    /^[ \t]$/u.test(transaction.startState.doc.sliceString(change.from, marker.to));
  if (change.from < marker.to && !removesSeparator) return undefined;
  const line = transaction.newDoc.lineAt(transaction.changes.mapPos(oldLine.from, -1));
  const oldBoundary = transaction.changes.mapPos(marker.to, -1);
  const head = transaction.newDoc.sliceString(line.from, Math.min(line.to, line.from + 512));
  const prefix = quotePrefix(head, 0, Number.POSITIVE_INFINITY);
  if (prefix?.depth !== row.depth) return undefined;
  const markerTo = line.from + prefix.to;
  // Inserting body whitespace after a compact `>>` may first supply the
  // optional separator. It remains safe only when the same quote depth owns
  // that one new separator and the edit starts at the confirmed boundary.
  if (markerTo !== oldBoundary && !(markerTo === oldBoundary + 1 && change.from === marker.to &&
      transaction.startState.doc.sliceString(marker.to - 1, marker.to) === ">" &&
      /^[ \t]$/u.test(transaction.newDoc.sliceString(oldBoundary, markerTo)))) return undefined;
  const wasEmpty = marker.to === oldLine.to, isEmpty = markerTo === line.to;
  if ((wasEmpty === isEmpty && markerTo === oldBoundary) ||
      couldStartBlock(transaction.newDoc.sliceString(markerTo, Math.min(line.to, markerTo + 64))) ||
      couldStartBlock(transaction.startState.doc.sliceString(marker.to, Math.min(oldLine.to, marker.to + 64)))) return undefined;
  return { owner: row.owner, oldMarkerFrom: marker.from, oldMarkerTo: marker.to,
    markerFrom: line.from, markerTo, marker: marker.decoration,
    rows: [{ row, from: line.from, depth: row.depth, open: row.open, close: row.close, markerOnly: isEmpty }] };
}

/** Split one ordinary quote row while keeping its confirmed prefix on both. */
function resolveQuoteLineSplit(
  decorations: DecorationSet,
  transaction: Transaction,
  change: { readonly from: number; readonly to: number; readonly inserted: string },
): OptimisticQuoteEdit | undefined {
  if (!change.inserted.startsWith("\n") || change.inserted.slice(1).includes("\n")) return undefined;
  const oldLine = transaction.startState.doc.lineAt(change.from);
  if (transaction.startState.doc.lineAt(change.to).number !== oldLine.number) return undefined;
  const row = quoteRowAt(decorations, oldLine.from);
  if (row === undefined || !ordinaryQuoteRow(row)) return undefined;
  const marker = quoteMarkerAt(decorations, oldLine.from, row.owner);
  if (marker === undefined || marker.to - marker.from > 512 || change.from < marker.to ||
      change.inserted.slice(1) !== transaction.startState.doc.sliceString(marker.from, marker.to)) return undefined;
  const first = transaction.newDoc.lineAt(change.from), second = transaction.newDoc.lineAt(change.from + 1);
  const secondMarkerTo = second.from + marker.to - marker.from;
  if (secondMarkerTo > second.to || [first, second].some((line, index) => {
    const from = index === 0 ? first.from + marker.to - marker.from : secondMarkerTo;
    return couldStartBlock(transaction.newDoc.sliceString(from, Math.min(line.to, from + 64)));
  })) return undefined;
  const rootLast = /\bjot-live-preview-native-block--last\b/u.test(String(row.decoration.spec.class ?? ""));
  return { owner: row.owner, oldMarkerFrom: marker.from, oldMarkerTo: marker.to,
    markerFrom: first.from, markerTo: first.from + marker.to - marker.from, marker: marker.decoration,
    extraMarkers: [{ from: second.from, to: secondMarkerTo, decoration: marker.decoration }],
    rows: [
      { row, from: first.from, depth: row.depth, open: row.open, close: 0,
        markerOnly: first.from + marker.to - marker.from === first.to, rootLast: false },
      { row, from: second.from, depth: row.depth, open: 0, close: row.close,
        markerOnly: secondMarkerTo === second.to, rootLast },
    ] };
}

/** Join two ordinary quote rows without keeping a second source prefix. */
function resolveQuoteLineJoin(
  decorations: DecorationSet,
  transaction: Transaction,
  change: { readonly from: number; readonly to: number; readonly inserted: string },
): OptimisticQuoteEdit | undefined {
  if (change.inserted !== "" || change.to <= change.from) return undefined;
  const firstLine = transaction.startState.doc.lineAt(change.from), nextLine = transaction.startState.doc.lineAt(change.to);
  if (change.from !== firstLine.to || nextLine.number !== firstLine.number + 1) return undefined;
  const first = quoteRowAt(decorations, firstLine.from), next = quoteRowAt(decorations, nextLine.from);
  if (first === undefined || next === undefined || first.owner !== next.owner || first.depth !== next.depth ||
      first.close !== 0 || next.open !== 0 || !ordinaryQuoteRow(first) || !ordinaryQuoteRow(next)) return undefined;
  const firstMarker = quoteMarkerAt(decorations, firstLine.from, first.owner);
  const nextMarker = quoteMarkerAt(decorations, nextLine.from, first.owner, change.to);
  if (firstMarker === undefined || nextMarker === undefined || nextMarker.to - nextMarker.from > 512) return undefined;
  const line = transaction.newDoc.lineAt(change.from);
  const markerTo = line.from + firstMarker.to - firstMarker.from;
  if (couldStartBlock(transaction.newDoc.sliceString(markerTo, Math.min(line.to, markerTo + 64)))) return undefined;
  const rootLast = /\bjot-live-preview-native-block--last\b/u.test(String(next.decoration.spec.class ?? ""));
  return { owner: first.owner, oldMarkerFrom: nextMarker.from, oldMarkerTo: nextMarker.to,
    markerFrom: line.from, markerTo, marker: firstMarker.decoration,
    rows: [{ row: first, from: line.from, depth: first.depth, open: first.open, close: next.close,
      markerOnly: markerTo === line.to, rootLast }] };
}

/** A confirmed ordinary quote row whose body contains only indentation. */
function emptyQuoteMarker(
  decorations: DecorationSet,
  doc: Text,
  line: ReturnType<Text["lineAt"]>,
  row: QuoteRow,
): QuoteMarker | undefined {
  if (!ordinaryQuoteRow(row)) return undefined;
  const marker = quoteMarkerAt(decorations, line.from, row.owner);
  if (marker === undefined || marker.to > line.to || marker.to - marker.from > 512 || line.to - marker.to > 4096) return undefined;
  return /[^ \t]/u.test(doc.sliceString(marker.to, line.to)) ? undefined : marker;
}

/** Prove a bounded run of already-projected quote rows has no body content. */
function emptyQuoteToRootEdge(
  decorations: DecorationSet,
  doc: Text,
  firstLine: ReturnType<Text["lineAt"]>,
  firstRow: QuoteRow,
  direction: -1 | 1,
): boolean {
  let line = firstLine, row = firstRow;
  for (let checked = 0; checked < 256; checked++) {
    if (row.owner !== firstRow.owner || emptyQuoteMarker(decorations, doc, line, row) === undefined) return false;
    if (direction < 0 ? row.open === row.depth : row.close === row.depth) return true;
    const number = line.number + direction;
    if (number < 1 || number > doc.lines) return false;
    const adjacentLine = doc.line(number), adjacent = quoteRowAt(decorations, adjacentLine.from);
    if (adjacent === undefined || adjacent.owner !== row.owner) return false;
    const before = direction < 0 ? adjacent : row, after = direction < 0 ? row : adjacent;
    if (before.close !== Math.max(0, before.depth - after.depth) ||
        after.open !== Math.max(0, after.depth - before.depth)) return false;
    line = adjacentLine;
    row = adjacent;
  }
  return false;
}

/**
 * Adding/removing the completely empty physical line after a confirmed empty
 * quote does not change the quote itself. Preserve its line and the following
 * source line until Rust confirms the new block seam. If the other side is
 * another quote, only reconcile the two roots when both are proven empty.
 */
function resolveQuoteBlankBoundary(
  decorations: DecorationSet,
  transaction: Transaction,
  change: { readonly from: number; readonly to: number; readonly inserted: string },
): OptimisticQuoteEdit | undefined {
  const doc = transaction.startState.doc, first = doc.lineAt(change.from);
  if (change.from !== first.to) return undefined;
  const deleting = change.inserted === "" && change.to === change.from + 1;
  const inserting = change.inserted === "\n" && change.to === change.from;
  if (!deleting && !inserting) return undefined;
  const next = first.number < doc.lines ? doc.line(first.number + 1) : undefined;
  if (deleting && (next === undefined || next.from !== change.to || next.length !== 0)) return undefined;
  const row = quoteRowAt(decorations, first.from);
  if (row === undefined) return undefined;
  const marker = emptyQuoteMarker(decorations, doc, first, row);
  if (marker === undefined) return undefined;
  const followingNumber = first.number + (deleting ? 2 : 1);
  let followingRow: QuoteRow | undefined;
  let followingLine: ReturnType<Text["lineAt"]> | undefined;
  if (followingNumber <= doc.lines) {
    followingLine = doc.line(followingNumber);
    const head = doc.sliceString(followingLine.from, Math.min(followingLine.to, followingLine.from + 512));
    if (quotePrefix(head, 0, Number.POSITIVE_INFINITY) !== undefined) {
      followingRow = quoteRowAt(decorations, followingLine.from);
      if (followingRow === undefined || emptyQuoteMarker(decorations, doc, followingLine, followingRow) === undefined ||
          !emptyQuoteToRootEdge(decorations, doc, first, row, -1) ||
          !emptyQuoteToRootEdge(decorations, doc, followingLine, followingRow, 1)) return undefined;
      if (deleting ? row.close !== row.depth || followingRow.open !== followingRow.depth || row.owner === followingRow.owner :
          row.owner !== followingRow.owner || row.close !== Math.max(0, row.depth - followingRow.depth) ||
          followingRow.open !== Math.max(0, followingRow.depth - row.depth)) return undefined;
    }
  }
  if (followingRow === undefined && row.close !== row.depth) return undefined;
  const mappedFrom = transaction.changes.mapPos(first.from, -1);
  const updates: QuoteRowUpdate[] = [{ row, from: mappedFrom, depth: row.depth, open: row.open,
    close: followingRow === undefined ? row.close : deleting ? Math.max(0, row.depth - followingRow.depth) : row.depth,
    ...(followingRow === undefined ? {} : { rootLast: inserting }) }];
  if (followingRow !== undefined && followingLine !== undefined) updates.push({ row: followingRow,
    from: transaction.changes.mapPos(followingLine.from, 1), depth: followingRow.depth,
    open: deleting ? Math.max(0, followingRow.depth - row.depth) : followingRow.depth, close: followingRow.close });
  if (inserting) {
    // The inserted line is a real top-level blank, with its own configurable
    // geometry even while it has not yet received a Rust node identity.
    const blank: QuoteRow = { from: change.from, owner: row.owner, depth: 0, open: 0, close: 0,
      decoration: Decoration.line({ class: "jot-live-preview-blank-line jot-md-blank-line",
        jotLiveNode: row.owner, jotLiveSourceLine: true, attributes: { "data-jot-live-node": row.owner } }) };
    updates.push({ row: blank, from: change.from + 1, depth: 0, open: 0, close: 0 });
  }
  return { owner: row.owner, oldMarkerFrom: marker.from, oldMarkerTo: marker.to,
    markerFrom: mappedFrom, markerTo: mappedFrom + marker.to - marker.from, marker: marker.decoration, rows: updates };
}

/**
 * A confirmed ordinary quote line can change depth while its body stays the
 * same. Only map a single prefix edit when the unchanged body boundary and
 * confirmed adjacent depths prove the local quote geometry. The Rust parse
 * remains authoritative for block and inline semantics.
 */
export function resolveOptimisticQuoteEdit(
  decorations: DecorationSet,
  transaction: Transaction,
): OptimisticQuoteEdit | undefined {
  const changes: Array<{ from: number; to: number; inserted: string }> = [];
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    if (inserted.lines > 2 || inserted.length > 513) {
      changes.push({ from, to, inserted: "\n" });
    } else changes.push({ from, to, inserted: inserted.toString() });
  });
  const change = changes.length === 1 ? changes[0] : undefined;
  if (change === undefined) return undefined;
  const blankBoundary = resolveQuoteBlankBoundary(decorations, transaction, change);
  if (blankBoundary !== undefined) return blankBoundary;
  if (change.inserted.includes("\n")) {
    return resolveQuoteLineSplit(decorations, transaction, change) ??
      (change.from === change.to ? resolveQuoteRowUndo(decorations, transaction, change.from, change.inserted) : undefined);
  }
  if (change.to > change.from && transaction.startState.doc.lineAt(change.from).number !==
      transaction.startState.doc.lineAt(change.to).number) {
    const join = resolveQuoteLineJoin(decorations, transaction, change);
    if (join !== undefined) return join;
  }
  const oldLine = transaction.startState.doc.lineAt(change.from);
  const oldHead = transaction.startState.doc.sliceString(oldLine.from, Math.min(oldLine.to, oldLine.from + 512));
  const oldPrefix = quotePrefix(oldHead, 0, Number.POSITIVE_INFINITY);
  if (oldPrefix === undefined) return resolveQuotePromotion(decorations, transaction, oldLine, change);
  if (change.inserted === "" && change.from === oldLine.from && change.to === oldLine.to + 1) {
    return resolveQuoteRowDeletion(decorations, transaction, oldLine);
  }
  const listIndent = resolveQuoteListIndent(decorations, transaction, oldLine, change);
  if (listIndent !== undefined) return listIndent;
  const bodyTransition = resolveQuoteBodyTransition(decorations, transaction, oldLine, change);
  if (bodyTransition !== undefined) return bodyTransition;
  if (change.to > oldLine.to || change.from < oldLine.from || change.to > oldLine.from + oldPrefix.to) return undefined;
  const newLine = transaction.newDoc.lineAt(transaction.changes.mapPos(oldLine.from, -1));
  const newHead = transaction.newDoc.sliceString(newLine.from, Math.min(newLine.to, newLine.from + 512));
  const prefix = quotePrefix(newHead, 0, Number.POSITIVE_INFINITY);
  const depth = prefix?.depth ?? 0;

  const current = quoteRowAt(decorations, oldLine.from);
  if (current === undefined || !ordinaryQuoteRow(current)) return undefined;
  const marker = quoteMarkerAt(decorations, oldLine.from, current.owner, oldLine.from + oldPrefix.to);
  if (marker === undefined || change.from < marker.from || change.to > marker.to) return undefined;
  const bodyFrom = transaction.changes.mapPos(marker.to, 1);
  const newMarkerTo = newLine.from + (prefix?.to ?? 0);
  // Do not guess if the edit changes which bytes are content: that can turn a
  // quote into a nested block or consume literal `>` in a code body.
  if (newMarkerTo !== bodyFrom) return undefined;
  const paragraph = depth === 0 && bodyFrom < newLine.to;
  if (paragraph && /^[ \t]*(?:[#>`$*+\-|~\[]|\d+[.)][ \t])/u.test(
    transaction.newDoc.sliceString(bodyFrom, Math.min(newLine.to, bodyFrom + 64)))) return undefined;

  const previousLine = oldLine.number > 1 ? transaction.startState.doc.line(oldLine.number - 1) : undefined;
  const nextLine = oldLine.number < transaction.startState.doc.lines
    ? transaction.startState.doc.line(oldLine.number + 1) : undefined;
  const previous = previousLine === undefined ? undefined : quoteRowAt(decorations, previousLine.from);
  const next = nextLine === undefined ? undefined : quoteRowAt(decorations, nextLine.from);
  const prev = previous?.owner === current.owner ? previous : undefined;
  const following = next?.owner === current.owner ? next : undefined;
  if (depth === 0 && [prev, following].some(row => row !== undefined &&
      /\bjot-live-preview-(?:source-fenced-code|source-math-block|code-boundary|structural-line)\b/u
        .test(String(row.decoration.spec.class ?? "")))) return undefined;
  // A missing neighbour is safe only when this row itself proves the edge of
  // its quote root; otherwise it may merely be outside the visible window.
  if ((prev === undefined && current.open !== current.depth) ||
      (following === undefined && current.close !== current.depth)) return undefined;
  const prevDepth = prev?.depth ?? 0, nextDepth = following?.depth ?? 0;
  if (current.open !== Math.max(0, current.depth - prevDepth) ||
      current.close !== Math.max(0, current.depth - nextDepth) ||
      (prev !== undefined && prev.close !== Math.max(0, prev.depth - current.depth)) ||
      (following !== undefined && following.open !== Math.max(0, following.depth - current.depth))) return undefined;

  const mapped = (row: QuoteRow): number => transaction.changes.mapPos(row.from, -1);
  const updates: QuoteRowUpdate[] = [];
  if (prev !== undefined) updates.push({
    row: prev, from: mapped(prev), depth: prev.depth, open: prev.open,
    close: Math.max(0, prev.depth - depth), ...(depth === 0 ? { rootLast: true } : {}),
  });
  updates.push({
    row: current, from: newLine.from, depth,
    open: Math.max(0, depth - prevDepth),
    close: Math.max(0, depth - nextDepth),
    markerOnly: newMarkerTo === newLine.to,
    ...(paragraph ? { paragraph: true } : {}),
  });
  if (following !== undefined) updates.push({
    row: following, from: mapped(following), depth: following.depth,
    open: Math.max(0, following.depth - depth), close: following.close,
  });
  return {
    owner: current.owner,
    oldMarkerFrom: marker.from,
    oldMarkerTo: marker.to,
    markerFrom: newLine.from,
    markerTo: newMarkerTo,
    marker: marker.decoration,
    rows: updates,
  };
}

/** Reconcile selected ordinary quote prefixes against their adjacent rows. */
function resolveBatchQuoteDepthEdits(
  decorations: DecorationSet,
  transaction: Transaction,
  changes: readonly { readonly from: number; readonly to: number; readonly inserted: string }[],
): readonly OptimisticQuoteEdit[] | undefined {
  type ChangedRow = { readonly row: QuoteRow; readonly depth: number; readonly paragraph: boolean; readonly edit: OptimisticQuoteEdit };
  const changedRows = new Map<number, ChangedRow>();
  for (const change of changes) {
    const oldLine = transaction.startState.doc.lineAt(change.from);
    if (changedRows.has(oldLine.number) || change.to > oldLine.to || /[^ >\t]/u.test(change.inserted) ||
        /[^ >\t]/u.test(transaction.startState.doc.sliceString(change.from, change.to))) return undefined;
    const newLine = transaction.newDoc.lineAt(transaction.changes.mapPos(oldLine.from, -1));
    const prefix = quotePrefix(transaction.newDoc.sliceString(newLine.from, Math.min(newLine.to, newLine.from + 512)), 0, Number.POSITIVE_INFINITY);
    const depth = prefix?.depth ?? 0, newMarkerTo = newLine.from + (prefix?.to ?? 0);
    let row = quoteRowAt(decorations, oldLine.from), marker: QuoteMarker | undefined;
    let bodyFrom: number;
    if (row !== undefined) {
      if (!ordinaryQuoteRow(row)) return undefined;
      marker = quoteMarkerAt(decorations, oldLine.from, row.owner);
      if (marker === undefined || marker.to - marker.from > 512 || change.from < marker.from || change.to > marker.to) return undefined;
      bodyFrom = transaction.changes.mapPos(marker.to, 1);
    } else {
      // Undo can promote an ordinary row back into a quote. Reuse its
      // confirmed line owner, just as for a single-row promotion.
      if (change.from !== oldLine.from || change.to !== oldLine.from || depth === 0) return undefined;
      let plain: Decoration | undefined;
      decorations.between(oldLine.from, oldLine.from, (from, _to, decoration) => {
        const classes = String(decoration.spec.class ?? "");
        if (from === oldLine.from && decoration.spec.jotLiveSourceLine === true &&
            /\bjot-live-preview-(?:native-block--paragraph|blank-line)\b/u.test(classes) &&
            !/\bjot-live-preview-(?:list-item|source-heading|source-fenced-code|source-math-block)\b/u.test(classes)) plain = decoration;
      });
      if (plain === undefined || typeof plain.spec.jotLiveNode !== "string") return undefined;
      const owner = plain.spec.jotLiveNode;
      const active = /\bjot-live-preview-active-line\b/u.test(String(plain.spec.class ?? ""));
      row = { from: oldLine.from, owner, depth: 0, open: 0, close: 0,
        decoration: Decoration.line({ ...plain.spec,
          class: `jot-live-preview-line jot-live-preview-native-block jot-live-preview-native-block--block-quote jot-live-preview-block-quote jot-live-preview-source-block-quote jot-md-block-quote${active ? " jot-live-preview-active-line" : ""}`,
          attributes: { "data-jot-live-node": owner, "data-jot-quote-marker-hidden": "true" },
        }) };
      marker = { from: oldLine.from, to: oldLine.from, decoration: Decoration.replace({
        widget: leadingQuoteMarkerWidget, inclusive: false, jotLiveNode: owner,
        jotLiveStructural: true, jotLiveQuotePrefix: true, jotLiveSelection: "atomic",
      }) };
      bodyFrom = transaction.changes.mapPos(oldLine.from, 1);
    }
    if (newMarkerTo !== bodyFrom) return undefined;
    const paragraph = depth === 0 && bodyFrom < newLine.to;
    if (paragraph && /^[ \t]*(?:[#>`$*+\-|~\[]|\d+[.)][ \t])/u.test(
      transaction.newDoc.sliceString(bodyFrom, Math.min(newLine.to, bodyFrom + 64)))) return undefined;
    const edit: OptimisticQuoteEdit = { owner: row.owner, oldMarkerFrom: marker.from, oldMarkerTo: marker.to,
      markerFrom: newLine.from, markerTo: newMarkerTo, marker: marker.decoration, rows: [] };
    changedRows.set(oldLine.number, { row, depth, paragraph, edit });
  }
  const relevant = new Map<number, QuoteRow>();
  for (const [number, changed] of changedRows) {
    relevant.set(number, changed.row);
    for (const adjacent of [number - 1, number + 1]) {
      if (adjacent < 1 || adjacent > transaction.startState.doc.lines || changedRows.has(adjacent)) continue;
      const row = quoteRowAt(decorations, transaction.startState.doc.line(adjacent).from);
      if (row !== undefined) relevant.set(adjacent, row);
    }
  }
  // Missing neighbours are safe only at a confirmed outer quote edge.
  for (const [number, changed] of changedRows) {
    const row = changed.row;
    if (row.depth === 0) continue;
    const previous = relevant.get(number - 1), next = relevant.get(number + 1);
    if ((previous === undefined && row.open !== row.depth) || (next === undefined && row.close !== row.depth) ||
        (previous !== undefined && row.open !== Math.max(0, row.depth - previous.depth)) ||
        (next !== undefined && row.close !== Math.max(0, row.depth - next.depth)) ||
        (previous !== undefined && previous.depth > 0 && previous.close !== Math.max(0, previous.depth - row.depth)) ||
        (next !== undefined && next.depth > 0 && next.open !== Math.max(0, next.depth - row.depth))) return undefined;
  }
  const updates: QuoteRowUpdate[] = [];
  for (const [number, row] of relevant) {
    const changed = changedRows.get(number), depth = changed?.depth ?? row.depth;
    const previous = changedRows.get(number - 1)?.depth ?? relevant.get(number - 1)?.depth ?? 0;
    const next = changedRows.get(number + 1)?.depth ?? relevant.get(number + 1)?.depth ?? 0;
    const from = transaction.changes.mapPos(row.from, -1);
    updates.push({ row, from, depth,
      open: changed === undefined && !relevant.has(number - 1) ? row.open : Math.max(0, depth - previous),
      close: changed === undefined && !relevant.has(number + 1) ? row.close : Math.max(0, depth - next),
      ...(changed === undefined ? {} : { markerOnly: changed.edit.markerTo === transaction.newDoc.lineAt(from).to,
        ...(changed.paragraph ? { paragraph: true } : {}) }),
      ...(depth > 0 && (changed !== undefined || relevant.has(number + 1)) ? { rootLast: next === 0 } : {}) });
  }
  const result = [...changedRows.values()].map(value => value.edit);
  if (result.length === 0) return undefined;
  result[0] = { ...result[0]!, rows: updates };
  return result;
}

/** Several selected lines may be indented by one CodeMirror transaction. */
export function resolveOptimisticQuoteEdits(decorations: DecorationSet, transaction: Transaction): readonly OptimisticQuoteEdit[] {
  const single = resolveOptimisticQuoteEdit(decorations, transaction);
  if (single !== undefined) return [single];
  if (!transaction.isUserEvent("input.quote.indent") && !transaction.isUserEvent("input.quote.outdent") &&
      !transaction.isUserEvent("undo") && !transaction.isUserEvent("redo")) return [];
  const changes: Array<{ from: number; to: number; inserted: string }> = [];
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    if (inserted.lines === 1 && inserted.length <= 513) changes.push({ from, to, inserted: inserted.toString() });
  });
  if (changes.length < 2) return [];
  if (!transaction.isUserEvent("input.quote.indent")) {
    const depth = resolveBatchQuoteDepthEdits(decorations, transaction, changes);
    if (depth !== undefined) return depth;
  }
  const result: OptimisticQuoteEdit[] = [];
  for (const change of changes) {
    const line = transaction.startState.doc.lineAt(change.from);
    if (change.to > line.to || /[^ \t]/u.test(change.inserted)) continue;
    const resolved = resolveQuoteListIndent(decorations, transaction, line, change) ??
      resolveQuoteBodyTransition(decorations, transaction, line, change);
    if (resolved !== undefined) result.push(resolved);
  }
  return result;
}

export function applyOptimisticQuoteEdits(
  decorations: DecorationSet,
  atomic: DecorationSet,
  edits: readonly OptimisticQuoteEdit[],
): { readonly decorations: DecorationSet; readonly atomic: DecorationSet } {
  const rowOwners = new Map<number, Set<string>>();
  const updates = edits.flatMap(edit => edit.rows);
  for (const update of updates) {
    const owners = rowOwners.get(update.from) ?? new Set<string>();
    owners.add(update.row.owner);
    rowOwners.set(update.from, owners);
  }
  const markerOwners = new Map<number, Set<string>>();
  const structuralMarkers = new Set<Decoration>();
  for (const edit of edits) {
    for (const from of [edit.markerFrom, ...(edit.extraMarkers ?? []).map(marker => marker.from)]) {
      const owners = markerOwners.get(from) ?? new Set<string>();
      owners.add(edit.owner);
      markerOwners.set(from, owners);
    }
    for (const marker of edit.structuralMarkers ?? []) structuralMarkers.add(marker.decoration);
  }
  const remove = (from: number, _to: number, decoration: Decoration): boolean => {
    const spec = decoration.spec;
    if (structuralMarkers.has(decoration)) return false;
    if (spec.jotLiveSourceLine === true && typeof spec.jotLiveNode === "string" && rowOwners.get(from)?.has(spec.jotLiveNode)) return false;
    return !(spec.jotLiveQuotePrefix === true && typeof spec.jotLiveNode === "string" && markerOwners.get(from)?.has(spec.jotLiveNode));
  };
  const add = updates.map(update => {
    const spec = update.row.decoration.spec;
    const attributes = { ...(spec.attributes as Record<string, string>) };
    if (update.depth === 0) {
      delete attributes["data-jot-quote-depth"];
      delete attributes["data-jot-quote-open"];
      delete attributes["data-jot-quote-close"];
      delete attributes["data-jot-quote-marker-hidden"];
      delete attributes["data-jot-quote-marker-only"];
      delete attributes["style"];
      const active = /\bjot-live-preview-active-line\b/u.test(String(spec.class ?? ""));
      return Decoration.line({ ...spec,
        class: update.paragraph
          ? `jot-live-preview-line jot-live-preview-native-block jot-live-preview-native-block--paragraph jot-live-preview-paragraph jot-md-paragraph jot-live-preview-native-block--last${active ? " jot-live-preview-active-line" : ""}`
          : `jot-live-preview-line jot-live-preview-native-block jot-live-preview-native-block--blank-line jot-live-preview-native-block--last jot-live-preview-blank-line jot-md-blank-line${active ? " jot-live-preview-active-line" : ""}`,
        attributes,
      }).range(update.from);
    }
    attributes["data-jot-quote-depth"] = String(update.depth);
    attributes["data-jot-quote-open"] = String(update.open);
    attributes["data-jot-quote-close"] = String(update.close);
    if (update.markerOnly === true) attributes["data-jot-quote-marker-only"] = "true";
    else if (update.markerOnly === false) delete attributes["data-jot-quote-marker-only"];
    const style = attributes["style"] ?? "";
    const styles = (update.listIndent === undefined ? style : setListIndentStyle(style, update.listIndent))
      .split(";").filter(value => value.length > 0 && !/^--jot-live-quote-(?:depth|open|close):/u.test(value.trim()));
    styles.push(`--jot-live-quote-depth:${update.depth}`,
      `--jot-live-quote-open:${update.open}`, `--jot-live-quote-close:${update.close}`);
    attributes["style"] = styles.join(";");
    let className = String(spec.class ?? "");
    if (update.rootLast === false) className = className.split(/\s+/u)
      .filter(value => value !== "jot-live-preview-native-block--last").join(" ");
    return Decoration.line({ ...spec,
      class: update.rootLast && !className.split(/\s+/u).includes("jot-live-preview-native-block--last")
        ? `${className} jot-live-preview-native-block--last` : className,
      attributes,
    }).range(update.from);
  });
  const markers = edits.flatMap(edit => [
    ...(edit.markerFrom < edit.markerTo ? [edit.marker.range(edit.markerFrom, edit.markerTo)] : []),
    ...(edit.extraMarkers ?? []).map(value => value.decoration.range(value.from, value.to)),
    ...(edit.structuralMarkers ?? []).map(value => value.decoration.range(value.from, value.to)),
  ]);
  return {
    decorations: decorations.update({ filter: remove, add: [...add, ...markers], sort: true }),
    atomic: atomic.update({ filter: remove, add: markers, sort: true }),
  };
}
