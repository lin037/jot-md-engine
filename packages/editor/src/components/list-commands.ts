import type { RenderNode, TextEdit, Utf16Offset } from "@jot-md/editor-protocol";
import type { EditorCommandResult, EditorCommandContext } from "../core/commands/index.js";
import { range } from "../adapter/text-model.js";
import { numberAttribute, stringAttribute } from "./common/dom-renderer.js";

const listMarkerPrefix = /^([\t ]*)([-+*]|[0-9]{1,9}[.)])(?=[\t ])/u;

export interface ListEnterContext extends EditorCommandContext {
  /** Current-revision Rust ListItem, never a source-prefix classification. */
  readonly item: RenderNode;
  /** Confirmed preceding roots (including non-list barriers), for empty-item exit. */
  readonly precedingItems?: readonly RenderNode[];
  /** Shift+Enter: explicit Markdown hard break within the confirmed item. */
  readonly shift?: boolean;
}

/**
 * Transform a confirmed physical ListItem without consulting CodeMirror's
 * independent Markdown tree. Hosts retain ownership of IME/readOnly/revision
 * guards and dispatch the result through the ordinary source transaction path.
 */
export function resolveListEnter(context: ListEnterContext): EditorCommandResult | undefined {
  if ((context.selectionCount ?? 1) !== 1 || context.item.kind !== "list-item" ||
      context.item.mode === "source") return undefined;
  const { source, item } = context;
  const start = Math.min(context.selection.anchor, context.selection.head);
  const end = Math.max(context.selection.anchor, context.selection.head);
  const from = Number(item.sourceRange.from);
  const rawTo = Number(item.sourceRange.to);
  if (from < 0 || rawTo > source.length || from > start || end > rawTo ||
      (from > 0 && source[from - 1] !== "\n")) return undefined;
  const newline = source.indexOf("\n", from);
  const firstTo = newline < 0 ? source.length : newline;
  if (firstTo > rawTo) return undefined;
  const marker = listPrefix(source, from, firstTo, item);
  if (marker === undefined) return undefined;
  const task = /^\[[ xX]\](?:[\t ]+|$)/u.exec(source.slice(marker.contentFrom, firstTo));
  const firstBodyFrom = marker.contentFrom + (task?.[0].length ?? 0);
  const lineFrom = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
  const nextBodyPrefix = task !== null && (lineFrom !== from || start >= firstBodyFrom) ? "[ ] " : "";
  const nextNewline = source.indexOf("\n", start);
  const to = nextNewline < 0 ? source.length : nextNewline;
  if (end > to || to > rawTo) return undefined;
  const contentFrom = lineFrom === from ? marker.contentFrom
    : continuationContentFrom(source, lineFrom, to, marker.contentIndent);
  if (contentFrom === undefined || start < contentFrom) return undefined;

  if (context.shift) {
    // An empty marker's whitespace is its padding, not a body hard-break.
    // Leave that unsupported case to the host's normal source command.
    if (lineFrom === from && source.slice(firstBodyFrom, firstTo).trim().length === 0) return undefined;
    let replaceFrom = start;
    while (replaceFrom > contentFrom && /[\t ]/u.test(source[replaceFrom - 1]!)) replaceFrom -= 1;
    return listResult(replaceFrom, end, `  \n${" ".repeat(marker.contentIndent)}`, "hard-break");
  }

  if (lineFrom !== from && start === end && source.slice(contentFrom, to).trim().length === 0) {
    // Finish an empty continuation without keeping a phantom blank row in the
    // old item. The next Enter can then exit this new empty marker normally.
    const previousEnd = lineFrom - 1;
    if (source.slice(previousEnd - 2, previousEnd) !== "  ") return undefined;
    return listResult(previousEnd - 2, to, `\n${marker.indent}${marker.nextMarker} ${nextBodyPrefix}`, "continue");
  }

  if (start === end && source.slice(firstBodyFrom, firstTo).trim().length === 0) {
    const indent = numberAttribute(item, "indentColumns") ?? 0;
    let parent: RenderNode | undefined;
    let boundary = from;
    const preceding = [...(context.precedingItems ?? [])]
      .filter((candidate) => Number(candidate.sourceRange.from) < from)
      .sort((left, right) => Number(right.sourceRange.from) - Number(left.sourceRange.from));
    for (const candidate of preceding) {
      const candidateIndent = numberAttribute(candidate, "indentColumns");
      // A missing root, blank separator or paragraph is not a list ancestor.
      // Never outdent into an unrelated list merely because it is nearby.
      if (candidate.kind !== "list-item" || candidate.mode === "source" || candidateIndent === undefined ||
          !/^[\t ]*\n[\t ]*$/u.test(source.slice(Number(candidate.sourceRange.to), boundary))) break;
      if (candidateIndent < indent) { parent = candidate; break; }
      boundary = Number(candidate.sourceRange.from);
    }
    let insert = "";
    if (parent !== undefined) {
      const parentFrom = Number(parent.sourceRange.from);
      const parentNewline = source.indexOf("\n", parentFrom);
      const parentTo = parentNewline < 0 ? source.length : parentNewline;
      const prefix = listPrefix(source, parentFrom, parentTo, parent);
      if (prefix !== undefined) insert = prefix.indent + prefix.nextMarker + " ";
    }
    return listResult(from, to, insert, "exit");
  }

  // Preserve leading content whitespace on the old line. Only whitespace
  // immediately before the caret is consumed when it belongs to the body.
  let replaceFrom = start;
  while (replaceFrom > contentFrom && /[\t ]/u.test(source[replaceFrom - 1]!)) replaceFrom -= 1;
  let replaceTo = end;
  let rightLineTo = to;
  // Whitespace at a split becomes marker padding on the new first line. Trim
  // that boundary whitespace so its content column stays the one used below.
  // If the old line has no right-hand body, promote its next continuation's
  // body onto the new marker line. Leaving a bare marker followed by the old
  // two spaces would turn the hard break into padding and detach that body.
  for (;;) {
    while (replaceTo < rightLineTo && /[\t ]/u.test(source[replaceTo]!)) replaceTo += 1;
    if (replaceTo < rightLineTo || rightLineTo === rawTo) break;
    const nextFrom = rightLineTo + 1;
    const newline = source.indexOf("\n", nextFrom);
    const nextTo = Math.min(rawTo, newline < 0 ? source.length : newline);
    const nextContent = continuationContentFrom(source, nextFrom, nextTo, marker.contentIndent);
    if (nextContent === undefined) return undefined;
    replaceTo = nextContent;
    rightLineTo = nextTo;
  }
  const insert = `\n${marker.indent}${marker.nextMarker} ${nextBodyPrefix}`;
  const following: TextEdit[] = [];
  if (marker.nextContentIndent !== marker.contentIndent && rightLineTo < rawTo) {
    // The promoted physical line is already inside the main replacement.
    // Rebase only subsequent lines, in old-document coordinates, so these
    // edits remain ordered and never overlap the split/promotion edit.
    let offset = rightLineTo + 1;
    while (offset <= rawTo) {
      const newline = source.indexOf("\n", offset);
      const lineEnd = Math.min(rawTo, newline < 0 ? source.length : newline);
      const content = continuationContentFrom(source, offset, lineEnd, marker.contentIndent);
      if (content === undefined) return undefined;
      following.push({ range: range(offset, content), insert: " ".repeat(marker.nextContentIndent) });
      if (lineEnd === rawTo) break;
      offset = lineEnd + 1;
    }
  }
  return listResult(replaceFrom, replaceTo, insert, "continue", following);
}

function listResult(from: number, to: number, insert: string, action: string, following: readonly TextEdit[] = []): EditorCommandResult {
  const anchor = (from + insert.length) as Utf16Offset;
  return {
    edits: [{ range: range(from, to), insert }, ...following],
    selection: { anchor, head: anchor },
    userEvent: `input.list.${action}`,
  };
}

export interface OrderedListLine {
  readonly from: number;
  readonly digitsFrom: number;
  readonly digitsTo: number;
  readonly indent: number;
  readonly number: number;
  readonly delimiter: "." | ")";
}

/** Read a marker from a confirmed list line or the exact output of list Enter. */
export function orderedListLine(source: string, from: number, to: number): OrderedListLine | undefined {
  const prefix = listMarkerPrefix.exec(source.slice(from, Math.min(to, from + 512)));
  const marker = prefix?.[2];
  const delimiter = marker?.at(-1);
  if (prefix === null || marker === undefined || (delimiter !== "." && delimiter !== ")")) return undefined;
  const whitespace = prefix[1]!;
  let indent = 0;
  for (const character of whitespace) indent += character === "\t" ? 4 - indent % 4 : 1;
  const digitsFrom = from + whitespace.length;
  return { from, digitsFrom, digitsTo: digitsFrom + marker.length - 1,
    indent, number: Number(marker.slice(0, -1)), delimiter };
}

/** Number the moved row from its destination siblings, without rewriting other items. */
export function movedOrderedListNumber(
  source: string, line: OrderedListLine, targetIndent: number, preceding: readonly RenderNode[],
): number | undefined {
  if (targetIndent === line.indent) return undefined;
  const deeper = targetIndent > line.indent;
  let boundary = line.from;
  let previousChild: RenderNode | undefined;
  for (let index = preceding.length - 1; index >= 0; index -= 1) {
    const node = preceding[index]!;
    const from = Number(node.sourceRange.from), to = Number(node.sourceRange.to);
    if (from >= line.from) continue;
    const indent = numberAttribute(node, "indentColumns");
    if (node.kind !== "list-item" || node.mode === "source" || indent === undefined ||
        to !== boundary - 1 || source[to] !== "\n" ||
        (node.childCount === 0 && source[to - 1] !== " " && source[to - 1] !== "\t")) return undefined;
    if (deeper) {
      if (indent < line.indent) return undefined;
      if (indent === line.indent) {
        if (previousChild === undefined) return 1;
        const number = numberAttribute(previousChild, "number");
        return number !== undefined && stringAttribute(previousChild, "delimiter") === line.delimiter
          ? Math.min(999_999_999, number + 1) : 1;
      }
      if (indent === targetIndent && previousChild === undefined) previousChild = node;
    } else if (indent < line.indent) {
      if (indent !== targetIndent) return undefined;
      const number = numberAttribute(node, "number");
      return number !== undefined && stringAttribute(node, "delimiter") === line.delimiter
        ? Math.min(999_999_999, number + 1) : 1;
    }
    boundary = from;
  }
  return undefined;
}

/** Read an edit prefix only after Rust has supplied the ListItem identity. */
function listPrefix(source: string, from: number, to: number, item: RenderNode): {
  readonly indent: string;
  readonly nextMarker: string;
  readonly contentFrom: number;
  readonly contentIndent: number;
  readonly nextContentIndent: number;
} | undefined {
  const line = source.slice(from, to);
  const prefix = listMarkerPrefix.exec(line);
  if (prefix === null) return undefined;
  const indent = prefix[1]!;
  const marker = prefix[2]!;
  const bullet = stringAttribute(item, "marker");
  const number = numberAttribute(item, "number");
  let nextMarker: string;
  if (bullet !== undefined) {
    if (marker !== bullet || !["-", "+", "*"].includes(bullet)) return undefined;
    nextMarker = marker;
  } else {
    const delimiter = stringAttribute(item, "delimiter");
    if (number === undefined || !Number.isSafeInteger(number) || number < 0 ||
        number > 999_999_999 || (delimiter !== "." && delimiter !== ")") ||
        marker.at(-1) !== delimiter || Number(marker.slice(0, -1)) !== number) return undefined;
    // Rust's physical marker contract admits at most nine decimal digits.
    nextMarker = `${Math.min(999_999_999, number + 1)}${delimiter}`;
  }
  let markerColumn = 0;
  for (const character of indent) markerColumn += character === "\t" ? 4 - markerColumn % 4 : 1;
  markerColumn += marker.length;
  let contentEnd = prefix[0].length;
  let contentIndent = markerColumn;
  for (; contentEnd < line.length && /[\t ]/u.test(line[contentEnd]!); contentEnd += 1) {
    contentIndent += line[contentEnd] === "\t" ? 4 - contentIndent % 4 : 1;
  }
  if (contentIndent - markerColumn > 4) {
    contentEnd = prefix[0].length + 1;
    contentIndent = markerColumn + (line[prefix[0].length] === "\t" ? 4 - markerColumn % 4 : 1);
  }
  return { indent, nextMarker, contentFrom: from + contentEnd, contentIndent,
    nextContentIndent: markerColumn - marker.length + nextMarker.length + 1 };
}

function continuationContentFrom(source: string, from: number, to: number, contentIndent: number): number | undefined {
  let column = 0;
  let offset = from;
  while (offset < to && column < contentIndent && /[\t ]/u.test(source[offset]!)) {
    column += source[offset] === "\t" ? 4 - column % 4 : 1;
    offset += 1;
  }
  return column >= contentIndent ? offset : undefined;
}
