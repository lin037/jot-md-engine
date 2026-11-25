import type { TextEdit } from "@jot-md/editor-protocol";
import { range } from "../adapter/text-model.js";
import type { EditorCommandContext, EditorCommandResult } from "../core/commands/index.js";
import { quotePrefix } from "./common/quote-prefix.js";

function physicalStart(source: string, position: number): number {
  return position === 0 ? 0 : source.lastIndexOf("\n", position - 1) + 1;
}

function rowAt(source: string, from: number) {
  const newline = source.indexOf("\n", from);
  const to = newline < 0 ? source.length : newline;
  const quote = quotePrefix(source, from, Infinity);
  const body = quote?.to ?? from;
  return { from, to, body, depth: quote?.depth ?? 0, text: source.slice(body, to) };
}
type Row = ReturnType<typeof rowAt>;

function columns(spaces: string, start = 0): number {
  let column = start;
  for (const ch of spaces) column += ch === "\t" ? 4 - column % 4 : 1;
  return column;
}

function markerPadding(whitespace: string, markerEnd: number): string {
  return columns(whitespace, markerEnd) - markerEnd > 4 ? whitespace.slice(0, 1) : whitespace;
}

function marker(row: Row) {
  const match = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/u.exec(row.text);
  if (!match) return undefined;
  if (!row.text.startsWith("    ") && /^[ \t]*([-*])(?:[ \t]*\1){2,}[ \t]*$/u.test(row.text)) return undefined;
  const indent = columns(match[1]!);
  const token = match[2]!;
  const end = indent + token.length;
  const ws = match[3]!;
  const padding = markerPadding(ws, end);
  const digits = row.body + match[1]!.length;
  return { row, indent, token, digits, whitespace: ws, body: digits + token.length + padding.length,
    contentColumn: columns(padding || " ", end) };
}
type Item = NonNullable<ReturnType<typeof marker>>;

function ownedContinuation(previous: Row, next: Row, item: Item): boolean {
  return previous.text.endsWith("  ") && next.depth === item.row.depth && !marker(next) &&
    columns(/^[ \t]*/u.exec(next.text)![0]) >= item.contentColumn;
}

function owner(source: string, row: Row): Item | undefined {
  const lines: Row[] = [];
  let candidate = row;
  for (;;) {
    const item = marker(candidate);
    if (item) {
      for (const next of lines.reverse()) {
        if (!ownedContinuation(candidate, next, item)) return undefined;
        candidate = next;
      }
      return item;
    }
    if (!candidate.from) return undefined;
    lines.push(candidate);
    candidate = rowAt(source, physicalStart(source, candidate.from - 1));
    if (!candidate.text.endsWith("  ") || candidate.depth !== row.depth) return undefined;
  }
}

function selectedItem(context: EditorCommandContext): Item | undefined {
  if ((context.selectionCount ?? 1) !== 1) return undefined;
  const { source, selection } = context;
  const row = rowAt(source, physicalStart(source, selection.head));
  const item = owner(source, row);
  if (!item) return undefined;
  const block = context.blockAt?.(selection.head) ?? context.block;
  if (block?.kind === "list-item") {
    return block.sourceRange.from >= item.row.from && block.sourceRange.from <= item.row.body ? item : undefined;
  }
  if (block !== undefined && block.kind !== "block-quote") return undefined;
  // A source-only host may have no nested quote projection yet. With no opaque
  // block/table delimiters in the containing text, the physical marker is unambiguous.
  const from = block?.sourceRange.from ?? 0, to = block?.sourceRange.to ?? source.length;
  const region = source.slice(from, to);
  if (!region.includes("|") && (item.row.from === from || row.to === to)) return item;
  if (region.includes("|") || /^[ \t>]*(?:`{3}|~{3}|\$\$|\\\[)/mu.test(region)) return undefined;
  return item;
}

export function toggleTaskMarker(source: string, from: number): EditorCommandResult | undefined {
  const marker = source.slice(from, from + 3);
  if (!/^\[[ xX\t]\]$/u.test(marker)) return undefined;
  return { edits: [{ range: range(from + 1, from + 2), insert: /[xX]/u.test(marker) ? " " : "x" }],
    userEvent: "input.task.toggle-checked" };
}

export function toggleChecked(context: EditorCommandContext): EditorCommandResult | undefined {
  if (context.taskMarkerFrom !== undefined) return toggleTaskMarker(context.source, context.taskMarkerFrom);
  const item = selectedItem(context);
  if (!item || !/^\[[ xX\t]\](?:[ \t]|$)/u.test(context.source.slice(item.body, item.row.to))) return undefined;
  return toggleTaskMarker(context.source, item.body);
}

/** Renumber one contiguous run of siblings. Each list item and its continuation
 * lines are read from the source, including items outside the mounted viewport. */
export function renumberList(context: EditorCommandContext): EditorCommandResult | undefined {
  const active = selectedItem(context);
  if (!active || !/^\d/u.test(active.token)) return undefined;
  const { source } = context;
  const delimiter = active.token.at(-1);
  const within = (item: Item) => {
    if (item.row.depth !== active.row.depth || item.indent < active.indent ||
        item.indent === active.indent && item.token.at(-1) !== delimiter) return false;
    // A pipe-table body can begin with digits and look exactly like a list item.
    if (item.row.text.includes("|")) {
      const kind = context.blockAt?.(item.body)?.kind;
      if (kind && kind !== "list-item" && kind !== "block-quote") return false;
    }
    return true;
  };
  let first = active;
  for (let from = active.row.from; from > 0;) {
    const previous = owner(source, rowAt(source, physicalStart(source, from - 1)));
    if (!previous || !within(previous)) break;
    if (previous.indent === active.indent) first = previous;
    from = previous.row.from;
  }
  let number = Number(first.token.slice(0, -1));
  const edits: TextEdit[] = [];
  let item: Item | undefined = first;
  while (item && within(item)) {
    const row: Row = item.row;
    let nextColumn = item.contentColumn;
    if (item.indent === active.indent) {
      if (number > 999_999_999) return undefined;
      const digits = String(number++);
      if (item !== first && digits !== item.token.slice(0, -1)) {
        edits.push({ range: range(item.digits, item.digits + item.token.length - 1), insert: digits });
        const end = item.indent + digits.length + 1;
        nextColumn = columns(markerPadding(item.whitespace, end) || " ", end);
      }
    }
    let last: Row = row;
    while (last.to < source.length) {
      const next = rowAt(source, last.to + 1);
      if (!ownedContinuation(last, next, item)) break;
      if (nextColumn !== item.contentColumn) {
        let gap = 0, column = 0;
        while (column < item.contentColumn) column = columns(next.text[gap++]!, column);
        edits.push({ range: range(next.body, next.body + gap), insert: " ".repeat(nextColumn) });
      }
      last = next;
    }
    item = last.to < source.length ? marker(rowAt(source, last.to + 1)) : undefined;
  }
  return edits.length ? { edits, userEvent: "input.list.renumber" } : undefined;
}
