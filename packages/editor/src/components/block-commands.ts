import type { TextEdit, Utf16Offset } from "@jot-md/editor-protocol";
import { range } from "../adapter/text-model.js";
import { quotePrefix } from "./common/quote-prefix.js";
import { renumberList, toggleChecked } from "./list-actions.js";
import { serializeTableCell, tableRowCells } from "./table/source.js";
import type { EditorCommand, EditorCommandContext, EditorCommandResult } from "../core/commands/index.js";

export const TABLE_INSERTION_LIMITS = { rows: 100, columns: 50 } as const;

/** Shared insertion recipe: keep physical separators and place selection inside content. */
function block(
  context: EditorCommandContext,
  id: string,
  build: (selected: string, following: string) => { text: string; anchor: number; head?: number },
  preserveSelection = false,
): EditorCommandResult | undefined {
  if ((context.selectionCount ?? 1) !== 1) return undefined;
  let from = Math.min(context.selection.anchor, context.selection.head);
  let to = Math.max(context.selection.anchor, context.selection.head);
  // A standalone block that does not consume text belongs after the last selected line.
  if (preserveSelection && from !== to) {
    const newline = context.source.indexOf("\n", to - 1);
    from = to = newline < 0 ? context.source.length : newline;
  }
  const content = build(context.source.slice(from, to), context.source.slice(to, to + 2));
  const before = separator(context.source, from, content.text, 0);
  const after = separator(content.text, content.text.length, context.source, to);
  return {
    edits: [{ range: range(from, to), insert: before + content.text + after }],
    selection: {
      anchor: (from + before.length + content.anchor) as Utf16Offset,
      head: (from + before.length + (content.head ?? content.anchor)) as Utf16Offset,
    },
    userEvent: `input.insert.${id}`,
  };
}

/** Account for separators already owned by either side, including a new trailing paragraph. */
function separator(left: string, end: number, right: string, start: number): string {
  if (end === 0 || start === right.length) return "";
  let count = 0;
  for (let index = end - 1; index >= 0 && left[index] === "\n" && count < 2; index -= 1) count += 1;
  for (let index = start; index < right.length && right[index] === "\n" && count < 2; index += 1) count += 1;
  return "\n".repeat(2 - count);
}

function prefix(context: EditorCommandContext, id: string, marker: string): EditorCommandResult | undefined {
  if ((context.selectionCount ?? 1) !== 1) return undefined;
  const start = Math.min(context.selection.anchor, context.selection.head);
  const end = Math.max(context.selection.anchor, context.selection.head);
  const from = start === 0 ? 0 : context.source.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && context.source[end - 1] === "\n" ? end - 1 : end;
  const newline = context.source.indexOf("\n", last);
  const to = newline < 0 ? context.source.length : newline;
  const lines = context.source.slice(from, to).split("\n");
  let offset = from;
  const targets = lines.flatMap((line) => {
    const quoted = id === "format.task-list" ? quotePrefix(line, 0, Infinity)?.to ?? 0 : 0;
    const indent = quoted + /^[\t ]*/u.exec(line.slice(quoted))![0].length;
    const position = offset + indent;
    offset += line.length + 1;
    // A selected separator stays a separator. A single caret on a blank line
    // can still create the requested list/quote marker for subsequent typing.
    if (start !== end && line.slice(quoted).trim().length === 0) return [];
    const text = line.slice(indent);
    const existing = id === "format.task-list"
      ? /^(?:[-+*]|\d{1,9}[.)])[\t ]+\[[ xX\t]\](?:[\t ]+|$)/u.exec(text)?.[0]
      : id === "format.ordered-list"
      ? /^\d+[.)] /u.exec(text)?.[0]
      : text.startsWith(marker) ? marker : undefined;
    const previous = id === "format.task-list" && existing === undefined
      ? /^(?:[-+*]|\d+[.)])[\t ]+/u.exec(text)?.[0]
      : undefined;
    return [{ position, existing, previous }];
  });
  if (targets.length === 0) return undefined;
  const remove = targets.every((target) => target.existing !== undefined);
  const edits: TextEdit[] = targets.flatMap(({ position, existing, previous }) =>
    remove
      ? [{ range: range(position, position + existing!.length), insert: "" }]
      : existing === undefined ? [{ range: range(position, position + (previous?.length ?? 0)), insert: marker }] : []);
  const map = (position: number): Utf16Offset => {
    let delta = 0;
    for (const edit of edits) {
      if (position < edit.range.from) break;
      if (position <= edit.range.to) return (edit.range.from + delta + edit.insert.length) as Utf16Offset;
      delta += edit.insert.length - (edit.range.to - edit.range.from);
    }
    return (position + delta) as Utf16Offset;
  };
  return { edits,
    selection: { anchor: map(context.selection.anchor), head: map(context.selection.head) },
    userEvent: `input.${id}` };
}

export const blockCommands: readonly EditorCommand[] = [
  ...([
    ["format.bullet-list", "切换无序列表", "- "],
    ["format.ordered-list", "切换有序列表", "1. "],
    ["format.task-list", "切换任务列表", "- [ ] "],
    ["format.quote", "切换引用", "> "],
  ] as const).map(([id, title, marker]): EditorCommand => ({
    id, title, category: "块格式",
    ...(id === "format.task-list" ? { description: "将所选行设为待办任务（TODO）或移除任务标记" } : {}),
    run: (context) => prefix(context, id, marker),
  })),
  { id: "task.toggle-checked", title: "切换任务完成状态", description: "完成或重新打开当前待办任务（TODO）",
    category: "列表", run: toggleChecked },
  { id: "list.renumber", title: "重排有序列表编号", description: "从首项序号开始，为当前层级的连续列表重新编号",
    category: "列表", run: renumberList },
  { id: "insert.code-block", title: "插入代码块", category: "插入", run: (context) =>
    block(context, "code-block", (selected) => {
      const opening = "``` js begin\n";
      return { text: `${opening}${selected}\n\`\`\` end`, anchor: opening.length, head: opening.length + selected.length };
    }) },
  { id: "insert.math-block", title: "插入公式块", category: "插入", run: (context) =>
    block(context, "math-block", (selected) => ({ text: `$$\n${selected || "x"}\n$$`, anchor: 3, head: 3 + (selected || "x").length })) },
  { id: "insert.table", title: "插入表格", category: "插入", run: (context) => {
    const size = context.tableSize;
    const rows = size?.rows ?? 2;
    const columns = size?.columns ?? 2;
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > TABLE_INSERTION_LIMITS.rows ||
        !Number.isSafeInteger(columns) || columns < 1 || columns > TABLE_INSERTION_LIMITS.columns) return undefined;
    return block(context, "table", () => {
      const blank = "|" + "  |".repeat(columns);
      const header = size === undefined ? "| A | B |" : blank;
      const prefix = header + "\n|" + " --- |".repeat(columns);
      const text = prefix + ("\n" + blank).repeat(rows - 1);
      const anchor = size === undefined
        ? tableRowCells(blank, prefix.length + 1)[0]!.from
        : tableRowCells(header, 0)[0]!.from;
      return { text, anchor };
    }, true);
  } },
  { id: "insert.image", title: "插入图片", category: "插入", run: (context) => {
    if ((context.selectionCount ?? 1) !== 1) return undefined;
    const from = Math.min(context.selection.anchor, context.selection.head);
    const to = Math.max(context.selection.anchor, context.selection.head);
    if (context.images !== undefined) {
      if (!context.images.length) return undefined;
      const references = context.images.map((image) => {
        if (typeof image.destination !== "string" || !image.destination.trim()) {
          throw new RangeError(context.phrase?.("Image destination is empty") ?? "图片地址为空");
        }
        const alt = image.alt ?? context.source.slice(from, to);
        // Angle destinations preserve spaces, literal parentheses and signed URLs.
        if (/[\r\n\0]/u.test(image.destination)) {
          throw new RangeError(context.phrase?.("Image destination cannot contain a newline or null character") ?? "图片地址不能包含换行符或空字符");
        }
        const url = /[\s()<>\\]/u.test(image.destination)
          ? `<${image.destination.replace(/[<>\\]/gu, "\\$&")}>` : image.destination;
        return `![${imageAlt(alt)}](${url})`;
      });
      // A paste stays inline even inside a list, a quote, or an unprojected cell.
      // Markdown backslash escapes preserve literal pipes in either rendering context.
      const markdown = serializeTableCell(references.join(" "), false);
      const caret = (from + markdown.length) as Utf16Offset;
      return { edits: [{ range: range(from, to), insert: markdown }], selection: { anchor: caret, head: caret },
        origin: context.imageSource === "paste" ? "paste" : "api",
        userEvent: context.imageSource === "paste" ? "input.paste.image" : "input.insert.image" };
    }
    if (context.canPickImage) return { action: "image.choose-file", userEvent: "select.image" };
    const opening = serializeTableCell(`![${imageAlt(context.source.slice(from, to))}](`, false);
    const anchor = (from + opening.length) as Utf16Offset;
    return { edits: [{ range: range(from, to), insert: `${opening}https://)` }],
      selection: { anchor, head: (anchor + "https://".length) as Utf16Offset }, userEvent: "input.insert.image" };
  } },
  { id: "insert.thematic-break", title: "插入分隔线", category: "插入", run: (context) =>
    block(context, "thematic-break", (_selected, following) => {
      const existing = /^\n*/u.exec(following)![0].length;
      return { text: "---" + "\n".repeat(2 - existing), anchor: 5 };
    }, true) },
];

function imageAlt(value: string): string {
  return value.replace(/\r\n?|\n/gu, " ").replace(/\\/gu, "\\\\").replace(/[\[\]]/gu, "\\$&");
}
