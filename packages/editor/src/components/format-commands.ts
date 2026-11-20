import type { EditorCommand, EditorCommandContext, EditorCommandResult, EditorShortcut } from "../core/commands/index.js";
import { range } from "../adapter/text-model.js";
import type { Utf16Offset } from "@jot-md/editor-protocol";
import { markdownLanguage } from "@codemirror/lang-markdown";

function linkDestination(source: string, from: number, to: number):
  { from: number; to: number; linkEnd: number } | null | undefined {
  const lineStart = from === 0 ? 0 : source.lastIndexOf("\n", from - 1) + 1;
  const lineEnd = source.indexOf("\n", to);
  const line = source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  if (!line.includes("](") && !line.includes("<")) return undefined;
  from -= lineStart;
  to -= lineStart;
  let destination: { from: number; to: number; linkEnd: number } | null | undefined;
  markdownLanguage.parser.parse(line).iterate({
    enter({ name, from: start, to: end, node }) {
      if (end <= from || start > to || (from !== to && start === to) || destination !== undefined) return false;
      if (name !== "Link" && name !== "Autolink" && name !== "Image") return;
      const markers = node.getChildren("LinkMark");
      const opening = markers[2];
      if (name !== "Autolink" && (opening === undefined || line[opening.from] !== "(")) return;
      if (name === "Image" || start > from || end < to) {
        destination = null;
      } else {
        const url = node.getChild("URL");
        const empty = opening?.to ?? start + 1;
        destination = {
          from: lineStart + (url?.from ?? empty),
          to: lineStart + (url?.to ?? empty),
          linkEnd: lineStart + end,
        };
      }
      return false;
    },
  });
  return destination;
}

function wrap(context: EditorCommandContext, marker: string, id: string): EditorCommandResult | undefined {
  if ((context.selectionCount ?? 1) !== 1) return undefined;
  let from = Math.min(context.selection.anchor, context.selection.head);
  let to = Math.max(context.selection.anchor, context.selection.head);
  let selected = context.source.slice(from, to);
  if (selected.includes("\n")) return undefined;
  const destination = linkDestination(context.source, from, to);
  if (destination != null && destination.from <= from && to <= destination.to) {
    // A format command continues the sentence after the link's closing delimiter.
    from = to = destination.linkEnd;
    selected = "";
  }
  const unwrap = from >= marker.length &&
    context.source.slice(from - marker.length, from) === marker &&
    context.source.slice(to, to + marker.length) === marker;
  const start = unwrap ? from - marker.length : from;
  const end = unwrap ? to + marker.length : to;
  const insert = unwrap ? selected : `${marker}${selected}${marker}`;
  const anchor = unwrap ? start : from + marker.length;
  return {
    edits: [{ range: range(start, end), insert }],
    selection: { anchor: anchor as Utf16Offset, head: (anchor + selected.length) as Utf16Offset },
    userEvent: `input.format.${id}`,
  };
}

export const formatCommands: readonly EditorCommand[] = [
  ...([
    ["bold", "加粗", "**"], ["italic", "斜体", "*"], ["code", "行内代码", "`"],
    ["strikethrough", "删除线", "~~"], ["math", "行内公式", "$"],
  ] as const).map(([id, title, marker]) => ({
    id: `format.${id}`, title, run: (context: EditorCommandContext) => wrap(context, marker, id),
  })),
  {
    id: "format.link", title: "插入链接",
    run(context) {
      if ((context.selectionCount ?? 1) !== 1) return undefined;
      const from = Math.min(context.selection.anchor, context.selection.head);
      const to = Math.max(context.selection.anchor, context.selection.head);
      const selected = context.source.slice(from, to);
      if (selected.includes("\n")) return undefined;
      const destination = linkDestination(context.source, from, to);
      if (destination === null) return undefined;
      if (destination !== undefined) return {
        selection: {
          anchor: destination.from as Utf16Offset,
          head: destination.to as Utf16Offset,
        },
        userEvent: "select.format.link",
      };
      const text = (selected || "链接文字").replace(/\\.|[\\[\]]/gu, (token) => token.length === 1 ? "\\" + token : token);
      const insert = `[${text}](https://)`;
      const anchor = from + text.length + 3;
      return { edits: [{ range: range(from, to), insert }],
        selection: { anchor: anchor as Utf16Offset, head: (anchor + 8) as Utf16Offset },
        userEvent: "input.format.link" };
    },
  },
  ...Array.from({ length: 7 }, (_, level): EditorCommand => ({
    id: level === 0 ? "format.paragraph" : `format.heading-${level}`,
    title: level === 0 ? "正文" : `${level} 级标题`,
    run(context) {
      if ((context.selectionCount ?? 1) !== 1) return undefined;
      const position = Math.min(context.selection.anchor, context.selection.head);
      const from = position === 0 ? 0 : context.source.lastIndexOf("\n", position - 1) + 1;
      const end = context.source.indexOf("\n", from);
      const line = context.source.slice(from, end < 0 ? undefined : end);
      const existing = /^( {0,3})(#{1,6})(?:[\t ]+|$)/u.exec(line);
      const indent = existing?.[1] ?? /^ {0,3}(?! )/u.exec(line)?.[0] ?? "";
      const marker = existing?.[0].slice(indent.length) ?? "";
      const insert = level === 0 ? "" : `${"#".repeat(level)} `;
      const markerStart = from + indent.length;
      return { edits: marker === insert ? [] : [{ range: range(markerStart, markerStart + marker.length), insert }],
        userEvent: "input.format.heading" };
    },
  })),
];

export const formatShortcuts: readonly EditorShortcut[] = [
  { id: "format.bold", command: "format.bold", key: "Mod-b" },
  { id: "format.italic", command: "format.italic", key: "Mod-i" },
  { id: "format.code", command: "format.code", key: "Mod-`" },
  { id: "format.link", command: "format.link", key: "Mod-k" },
  ...Array.from({ length: 6 }, (_, index) => ({
    id: `format.heading-${index + 1}`, command: `format.heading-${index + 1}`, key: `Mod-Alt-${index + 1}`,
  })),
];
