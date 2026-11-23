import { EditorSelection, EditorState } from "@codemirror/state";
import type { RenderAttribute, RenderNode, Utf16Offset } from "../../../editor-protocol/src/index.js";
import { movedOrderedListNumber, orderedListLine, resolveListEnter, type ListEnterContext } from "../../src/components/list-commands.js";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function item(source: string, from = 0, to = source.length): RenderNode {
  const line = source.slice(from).split("\n")[0]!;
  const prefix = /^([\t ]*)([-+*]|\d{1,9}[.)])/u.exec(line)!;
  let columns = 0;
  for (const char of prefix[1]!) columns += char === "\t" ? 4 - columns % 4 : 1;
  const marker = prefix[2]!;
  const attributes: RenderAttribute[] = [{ name: "indentColumns", value: { type: "number", value: columns } }];
  if (["-", "+", "*"].includes(marker)) attributes.push({ name: "marker", value: { type: "string", value: marker } });
  else attributes.push(
    { name: "number", value: { type: "number", value: Number(marker.slice(0, -1)) } },
    { name: "delimiter", value: { type: "string", value: marker.at(-1)! } },
  );
  return { id: `item:${from}`, kind: "list-item", mode: "preview", contentVersion: 1,
    sourceRange: { from: from as Utf16Offset, to: to as Utf16Offset }, attributes,
    childCount: 0, content: { type: "source" } };
}

function run(source: string, anchor = source.length, options: Partial<ListEnterContext> = {}) {
  const context: ListEnterContext = {
    source, selection: { anchor: anchor as Utf16Offset, head: anchor as Utf16Offset },
    item: item(source), ...options,
  };
  const result = resolveListEnter(context);
  if (result === undefined) throw new Error("expected applicable list command");
  const state = EditorState.create({ doc: source, selection: EditorSelection.range(context.selection.anchor, context.selection.head) })
    .update({ changes: result.edits!.map((edit) => ({ from: edit.range.from, to: edit.range.to, insert: edit.insert })),
      selection: EditorSelection.range(result.selection!.anchor, result.selection!.head) }).state;
  return { source: state.doc.toString(), cursor: state.selection.main.head, event: result.userEvent };
}

function physical_list_enter_preserves_markers_and_splits_utf16_content(): void {
  for (const marker of ["-", "+", "*", "9.", "42)", "999999999."]) {
    const source = `    ${marker} 中文😀`;
    const next = marker === "9." ? "10." : marker === "42)" ? "43)" : marker;
    equal(run(source).source, `${source}\n    ${next} `);
  }
  const split = run("- 中文😀tail", "- 中文😀".length);
  equal(split.source, "- 中文😀\n- tail");
  equal(split.cursor, "- 中文😀\n- ".length);
  equal(split.event, "input.list.continue");
  equal(run("- one   ").source, "- one\n- ");
  equal(run("- [x] done").source, "- [x] done\n- [ ] ");
  equal(run("- [ ] ").source, "");
}

function empty_items_exit_one_confirmed_level_without_invisible_rows(): void {
  for (const marker of ["-", "+", "*", "1.", "9)"]) {
    const at = marker.length as Utf16Offset;
    for (const shift of [false, true]) {
      equal(resolveListEnter({ source: marker, selection: { anchor: at, head: at }, item: item(marker), shift }), undefined);
    }
    equal(run(`${marker} `).source, "");
    equal(run(`${marker}\t`).source, "");
  }
  equal(run("  - ").source, "");
  const source = "1. parent\n    - ";
  const start = source.indexOf("    -");
  const context = { item: item(source, start), precedingItems: [item(source, 0, source.indexOf("\n"))] };
  const result = run(source, source.length, context);
  equal(result.source, "1. parent\n2. ");
  equal(result.event, "input.list.exit");
  const nested = "- parent\n  + inner\n      * ";
  equal(run(nested, nested.length, { item: item(nested, nested.lastIndexOf("\n") + 1),
    precedingItems: [item(nested, 0, 8), item(nested, 9, nested.lastIndexOf("\n"))] }).source,
    "- parent\n  + inner\n  + ");
  const separated = "- unrelated\n\n  - ";
  equal(run(separated, separated.length, { item: item(separated, separated.lastIndexOf("\n") + 1),
    precedingItems: [item(separated, 0, "- unrelated".length)] }).source,
    "- unrelated\n\n");
}

function shift_enter_uses_explicit_hard_breaks_and_content_columns(): void {
  for (const [source, expected] of [
    ["- first", "- first  \n  "],
    ["  9) first", "  9) first  \n     "],
    ["\t- first", "\t- first  \n      "],
    ["- first   ", "- first  \n  "],
  ]) equal(run(source!, source!.length, { shift: true }).source, expected);
  const first = run("- first", 7, { shift: true });
  equal(first.event, "input.list.hard-break");
  const typed = first.source + "second";
  equal(run(typed).source, "- first  \n  second\n- ");
  equal(run(first.source).source, "- first\n- ");
  equal(run(first.source, first.source.length, { shift: true }).source, "- first  \n    \n  ");
  const split = "9. first  \n   second";
  equal(run(split, "9. fir".length).source, "9. fir\n10. st  \n    second");
}

function list_commands_require_confirmed_compatible_ranges(): void {
  const source = "- body";
  const base = { source, selection: { anchor: 6 as Utf16Offset, head: 6 as Utf16Offset }, item: item(source) };
  equal(resolveListEnter({ ...base, item: { ...base.item, kind: "paragraph" } }), undefined);
  equal(resolveListEnter({ ...base, item: { ...base.item, mode: "source" } }), undefined);
  equal(resolveListEnter({ ...base, selectionCount: 2 }), undefined);
  equal(resolveListEnter({ ...base, selection: { anchor: 0 as Utf16Offset, head: 0 as Utf16Offset } }), undefined);
  equal(resolveListEnter({ ...base, item: { ...base.item, sourceRange: { from: 0 as Utf16Offset, to: 5 as Utf16Offset } } }), undefined);
  equal(resolveListEnter({ source: "- ", selection: { anchor: 2 as Utf16Offset, head: 2 as Utf16Offset }, item: item("- "), shift: true }), undefined);
}

function splitting_before_a_hard_break_promotes_the_right_body_without_losing_its_chain(): void {
  for (const [source, at, expected] of [
    ["- first  \n  second", 7, "- first\n- second"],
    ["- first tail  \n  second", 7, "- first\n- tail  \n  second"],
    ["- first  \n  second  \n  third", 7, "- first\n- second  \n  third"],
    ["- first tail  \n  second  \n  third", 7, "- first\n- tail  \n  second  \n  third"],
    ["9. first  \n   second", 8, "9. first\n10. second"],
    ["9. first tail  \n   second", 8, "9. first\n10. tail  \n    second"],
    ["9. first  \n   second  \n   third", 8, "9. first\n10. second  \n    third"],
    ["9. first tail  \n   second  \n   third", 8, "9. first\n10. tail  \n    second  \n    third"],
    ["- first  \n    \n  second", 7, "- first\n- second"],
  ] as const) {
    const context = { source, item: item(source), selection: { anchor: at as Utf16Offset, head: at as Utf16Offset } };
    const result = resolveListEnter(context)!;
    let previousTo = 0;
    for (const edit of result.edits!) {
      if (edit.range.from < previousTo) throw new Error("list split edits overlap or are unordered");
      previousTo = edit.range.to;
    }
    const actual = run(source, at);
    equal(actual.source, expected);
    equal(actual.cursor, expected.indexOf("\n") + 1 + (source.startsWith("9.") ? 4 : 2));
  }
}

function ordered_indentation_numbers_only_the_destination_run(): void {
  for (const [source, indent, expected] of [
    ["9) Parent\n10) ", 2, 1],
    ["2. Parent\n  7. Child\n9. Moved", 2, 8],
    ["2. Parent\n  7) Child\n9. Moved", 2, 1],
    ["9) Parent\n  7) Child", 0, 10],
    ["Paragraph\n\n12. Existing", 2, undefined],
    ["9. Not a contiguous parent\n\n12. Existing", 2, undefined],
  ] as const) {
    const from = source.lastIndexOf("\n") + 1;
    const row = orderedListLine(source, from, source.length)!;
    const roots: RenderNode[] = [];
    let offset = 0;
    for (const text of source.slice(0, from).split("\n").slice(0, -1)) {
      if (/^[\t ]*\d+[.)][\t ]/u.test(text)) {
        roots.push({ ...item(source, offset, offset + text.length), childCount: 1 });
      }
      offset += text.length + 1;
    }
    equal(movedOrderedListNumber(source, row, indent, roots), expected);
  }
}

physical_list_enter_preserves_markers_and_splits_utf16_content();
empty_items_exit_one_confirmed_level_without_invisible_rows();
shift_enter_uses_explicit_hard_breaks_and_content_columns();
list_commands_require_confirmed_compatible_ranges();
splitting_before_a_hard_break_promotes_the_right_body_without_losing_its_chain();
ordered_indentation_numbers_only_the_destination_run();
