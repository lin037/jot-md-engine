import { Annotation, countColumn, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { OrderedListLine } from "../../components/list-commands.js";
import { listDisplayIndentColumns } from "../../layout/list-geometry.js";

export const orderedListRenumber = Annotation.define<{ readonly row: OrderedListLine; readonly digits: string }>();

interface IndentChange {
  readonly from: number;
  readonly to: number;
  readonly inserted: string;
}

interface ListPrefix {
  readonly oldFrom: number;
  readonly oldTo: number;
  readonly owner: string;
  readonly decoration: Decoration;
}

interface ListIndent extends ListPrefix {
  readonly from: number;
  readonly to: number;
  readonly columns: number;
}

function listPrefixAt(decorations: DecorationSet, start: number, end: number, owner?: string): ListPrefix | undefined {
  let prefix: ListPrefix | undefined;
  decorations.between(start, start, (from, to, decoration) => {
    const spec = decoration.spec;
    if (from === start && to > from && to <= end && to - from <= 512 && spec.jotLiveStructural === true &&
        spec.jotLiveQuotePrefix !== true && typeof spec.jotLiveNode === "string" &&
        (owner === undefined || spec.jotLiveNode === owner)) {
      prefix = { oldFrom: from, oldTo: to, owner: spec.jotLiveNode, decoration };
    }
  });
  return prefix;
}

/** Reuse an existing hidden prefix for indentation and its own numbering edit. */
export function rebaseListIndent(
  decorations: DecorationSet, transaction: Transaction, change: IndentChange,
  oldFrom: number, oldLineEnd: number, from: number, lineEnd: number, owner?: string,
): ListIndent | undefined {
  const prefix = listPrefixAt(decorations, oldFrom, oldLineEnd, owner);
  if (prefix === undefined) return undefined;
  const old = transaction.startState.doc.sliceString(oldFrom, prefix.oldTo);
  const oldIndent = /^[ \t]*/u.exec(old)![0];
  const rewrite = transaction.annotation(orderedListRenumber);
  const renumber = rewrite?.row.from === oldFrom && rewrite.row.digitsFrom === oldFrom + oldIndent.length &&
    rewrite.row.digitsTo === change.to && change.from === oldFrom ? rewrite : undefined;
  if (change.from < oldFrom || (renumber === undefined &&
      (change.to > oldFrom + oldIndent.length || /[^ \t]/u.test(change.inserted)))) return undefined;
  const to = transaction.changes.mapPos(prefix.oldTo, 1);
  if (from >= to || to > lineEnd || to - from > 512) return undefined;
  const next = transaction.newDoc.sliceString(from, to);
  const nextIndent = /^[ \t]*/u.exec(next)![0];
  const suffix = old.slice(oldIndent.length);
  const oldDigits = renumber === undefined ? 0 : renumber.row.digitsTo - renumber.row.digitsFrom;
  const expected = renumber === undefined ? suffix : renumber.digits + suffix.slice(oldDigits);
  if (suffix === "" || next.slice(nextIndent.length) !== expected) return undefined;
  const indentColumns = countColumn(nextIndent, 4);
  // Tab stops can move the body boundary, including padding that was too
  // wide for Rust to include in the old hidden prefix.
  const columnDelta = indentColumns - countColumn(oldIndent, 4) + (renumber?.digits.length ?? oldDigits) - oldDigits;
  if (columnDelta % 4 !== 0) {
    const tail = transaction.startState.doc.sliceString(prefix.oldTo, Math.min(oldLineEnd, prefix.oldTo + 4));
    if (suffix.includes("\t") || /^[ \t]*\t/u.test(tail)) return undefined;
  }
  return { ...prefix, from, to, columns: listDisplayIndentColumns(indentColumns) };
}

export function setListIndentStyle(style: string, columns: number): string {
  return setListColumnStyle(style, "--jot-live-list-indent", columns);
}

function setListColumnStyle(style: string, property: string, columns: number): string {
  const rules = style.split(";").filter(rule => rule !== "" && !rule.trimStart().startsWith(property + ":"));
  if (columns > 0) rules.push(`${property}:${columns}ch`);
  return rules.join(";");
}

export function resolveListIndents(decorations: DecorationSet, transaction: Transaction): readonly (ListPrefix & {
  readonly from: number; readonly to: number; readonly row?: Decoration;
})[] {
  if (!transaction.isUserEvent("input.indent") && !transaction.isUserEvent("delete.dedent") &&
      !transaction.isUserEvent("undo") && !transaction.isUserEvent("redo")) return [];
  const { doc } = transaction.startState;
  const renumber = transaction.annotation(orderedListRenumber);
  const changes = new Map<number, IndentChange>();
  let indentationOnly = true;
  transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    if (!indentationOnly) return;
    const line = doc.lineAt(from);
    if (to > line.to || inserted.lines !== 1 || inserted.length > 512 || to - from > 512 || changes.has(line.from)) {
      indentationOnly = false;
      return;
    }
    const text = inserted.toString();
    const rewritesNumber = renumber?.row.from === from && renumber.row.digitsTo === to;
    if (!rewritesNumber && (/[^ \t]/u.test(text) || /[^ \t]/u.test(doc.sliceString(from, to)))) {
      indentationOnly = false;
      return;
    }
    changes.set(line.from, { from, to, inserted: text });
  });
  if (!indentationOnly) return [];

  const result: (ListPrefix & { from: number; to: number; row?: Decoration })[] = [];
  for (const [start, change] of changes) {
    let row: Decoration | undefined;
    decorations.between(start, start, (from, _to, decoration) => {
      const spec = decoration.spec;
      if (from === start && spec.jotLiveSourceLine === true &&
          typeof spec.jotLiveNode === "string" && spec.attributes?.["data-jot-quote-depth"] === undefined &&
          /\bjot-live-preview-list-item\b/u.test(String(spec.class ?? ""))) row = decoration;
    });
    if (row === undefined) continue;
    const oldLine = doc.lineAt(start);
    const line = transaction.newDoc.lineAt(transaction.changes.mapPos(start, -1));
    const owner = row.spec.jotLiveNode as string;
    const marker = row.spec.attributes?.["data-jot-live-list-marker"];
    if (marker === undefined) {
      // On an isolated continuation edit, the required indent still comes
      // from the untouched marker row. Any extra whitespace is visible body.
      // Whitespace-only continuations may gain or lose an explicit hard break.
      const prefix = changes.size === 1 ? listPrefixAt(decorations, start, oldLine.to, owner) : undefined;
      if (prefix === undefined || change.to > prefix.oldTo || /^[ \t]*$/u.test(oldLine.text)) continue;
      const length = prefix.oldTo - start;
      const indentation = " ".repeat(length);
      if (doc.sliceString(start, prefix.oldTo) !== indentation || line.from + length > line.to ||
          transaction.newDoc.sliceString(line.from, line.from + length) !== indentation) continue;
      result.push({ ...prefix, from: line.from, to: line.from + length });
      continue;
    }
    // Changing a multi-row item's indentation can reassign its continuations.
    if (!/\bjot-live-preview-native-block--last\b/u.test(String(row.spec.class ?? "")) ||
        oldLine.text.endsWith("  ")) continue;
    const prefix = rebaseListIndent(decorations, transaction, change, start, oldLine.to, line.from, line.to, owner);
    if (prefix === undefined) continue;
    // A run of bullet punctuation can become a thematic break after outdent.
    if (marker === "•" && /^[ *\t-]+$/u.test(doc.sliceString(prefix.oldTo, Math.min(oldLine.to, prefix.oldTo + 128)))) continue;
    const attributes = row.spec.attributes as Record<string, string>;
    let style = setListIndentStyle(attributes.style ?? "", prefix.columns);
    const newMarker = renumber?.row.from === start ? renumber.digits + renumber.row.delimiter : marker;
    if (newMarker !== marker) style = setListColumnStyle(style, "--jot-live-list-marker-columns", newMarker.length);
    result.push({ ...prefix, row: Decoration.line({
      ...row.spec,
      attributes: { ...attributes, "data-jot-live-list-marker": newMarker, style },
    }) });
  }
  return result;
}
