import type {
  RenderAttribute,
  RenderContent,
  RenderNode,
  RenderValue,
  TextRange,
} from "../../../../editor-protocol/src/index.js";
import { Text } from "@codemirror/state";
import {
  planLivePreview,
  rangesTouch,
  resolveLivePreviewVerticalNavigation,
  sourcePresentationRanges,
  type LivePreviewDecoration,
} from "../../../src/hosts/live-preview/index.js";
import {
  tableRenderCellAt,
  tableMappedInputChange,
  tableMappedInputUserEvent,
  tableRenderNavigation,
  tableRenderPositionAt,
  tableRenderRootAt,
} from "../../../src/components/table/adapters/interaction.js";
import { resolveTableSurfaceNavigation } from "../../../src/components/table/source.js";
import { LivePreviewEditPolicy } from "../../../src/hosts/live-preview/edit-policy.js";
import { nearestRevealDelta } from "../../../src/hosts/live-preview/viewport.js";
import { tableInteractionAdapter } from "../../../src/components/table/adapters/interaction.js";
import { createTableComponentModel } from "../../../src/components/table/model.js";
import { widgetLifecycleRegression } from "./widget-lifecycle.cases.js";
import { livePreviewNavigationRegression } from "./live-preview-navigation.cases.js";
import { livePreviewPointerRegression } from "./live-preview-pointer.cases.js";
import { livePreviewPerformanceRegression } from "./live-preview-performance.cases.js";
import { livePreviewProjectionWindowRegression } from "./live-preview-projection-window.cases.js";
import { livePreviewQuoteLocalityRegression } from "./live-preview-quote-locality.cases.js";

function heading_hides_markup_only_when_inactive(): void {
  const source = "# Attention Is All You Need";
  const text = node("text", 2, source.length, { type: "source" });
  const heading = node("heading", 0, source.length, structured(text), [number("level", 1)]);
  const inactive = planLivePreview({ source, nodes: [heading], selections: [] });
  includes(inactive.decorations, (item) =>
    item.type === "replace" && item.from === 0 && item.to === 2 && item.widget === undefined);
  includes(inactive.decorations, (item) =>
    item.type === "line" && item.className.includes("jot-live-preview-native-block") &&
    item.className.includes("jot-live-preview-heading") &&
    item.attributes?.["data-jot-heading-level"] === "1");
  equal(inactive.widgetCount, 0);

  const active = planLivePreview({
    source,
    nodes: [heading],
    selections: [{ from: 8, to: 8 }],
  });
  equal(active.decorations.some((item) => item.type === "replace"), false);
  equal(active.activeBlocks, 1);
  includes(active.decorations, (item) =>
    item.type === "line" && item.className.includes("jot-live-preview-source-heading") &&
    item.attributes?.["data-jot-heading-level"] === "1");
}

function every_heading_level_uses_the_same_source_mapping(): void {
  for (let level = 1; level <= 6; level += 1) {
    const source = `${"#".repeat(level)} title`;
    const heading = node("heading", 0, source.length, structured(
      node("text", level + 1, source.length, { type: "source" }),
    ), [number("level", level)]);
    const plan = planLivePreview({
      source,
      nodes: [heading],
      selections: [{ from: source.length, to: source.length }],
    });
    const line = plan.decorations.find((item) => item.type === "line");
    if (line?.type !== "line") throw new Error(`missing heading line for h${level}`);
    equal(line.className.includes("jot-live-preview-source-heading"), true);
    equal(line.attributes?.["data-jot-heading-level"], String(level));
  }
}

function inline_nodes_share_rust_ranges_without_reparsing(): void {
  const source = "**loss** and $x^2$ ![plot](plot.png)";
  const strongText = node("text", 2, 6, { type: "source" });
  const strong = node("strong", 0, 8, structured(strongText));
  const plain = node("text", 8, 13, { type: "source" });
  const math = node("inline-math", 13, 18, { type: "source" }, [
    rangeAttribute("contentRange", 14, 17),
  ]);
  const gap = node("text", 18, 19, { type: "source" });
  const image = node("image", 19, source.length, { type: "source" }, [
    string("destination", "plot.png"),
    string("alt", "plot"),
  ]);
  const paragraph = node(
    "paragraph",
    0,
    source.length,
    structured(strong, plain, math, gap, image),
  );
  const plan = planLivePreview({ source, nodes: [paragraph], selections: [] });
  includes(plan.decorations, (item) =>
    item.type === "line" && item.className.includes("jot-live-preview-paragraph"));
  includes(plan.decorations, (item) =>
    item.type === "mark" && item.className === "jot-live-preview-strong");
  includes(plan.decorations, (item) =>
    item.type === "replace" && item.widget?.kind === "inline-math" && item.widget.block === false);
  includes(plan.decorations, (item) =>
    item.type === "replace" && item.widget?.kind === "image" && item.widget.block === false);
  equal(plan.widgetCount, 2);
}

function native_heading_keeps_its_physical_line_break(): void {
  const source = "## title\nnext";
  const text = node("text", 3, 8, { type: "source" });
  const heading = node("heading", 0, 9, structured(text), [number("level", 2)]);
  const plan = planLivePreview({ source, nodes: [heading], selections: [] });
  equal(plan.widgetCount, 0);
  includes(plan.decorations, (item) =>
    item.type === "replace" && source.slice(item.from, item.to) === "## " &&
    item.widget === undefined);
  equal(plan.decorations.some((item) =>
    item.type === "replace" && source.slice(item.from, item.to).includes("\n")), false);
}

function blank_lines_remain_physical_codemirror_lines(): void {
  const source = "first\n\nsecond";
  const blank = node("blank-line", 6, 6, { type: "source" });
  const plan = planLivePreview({
    source,
    nodes: [blank],
    selections: [],
  });
  equal(plan.widgetCount, 0);
  equal(plan.decorations.some((item) => item.type === "replace"), false);
  includes(plan.decorations, (item) =>
    item.type === "line" && item.from === 6 &&
    item.className.includes("jot-live-preview-blank-line"));

  const active = planLivePreview({
    source,
    nodes: [blank],
    selections: [{ from: 6, to: 6 }],
  });
  equal(active.decorations.some((item) => item.type === "replace"), false);
  includes(active.decorations, (item) =>
    item.type === "line" && item.from === 6 &&
    item.className.includes("jot-live-preview-active-line"));

  const whitespace = "first\n \t\nsecond";
  const whitespaceBlank = node("blank-line", 6, 8, { type: "source" });
  const whitespacePlan = planLivePreview({
    source: whitespace,
    nodes: [whitespaceBlank],
    selections: [],
  });
  equal(whitespacePlan.decorations.some((item) => item.type === "replace"), false);
  includes(whitespacePlan.decorations, (item) =>
    item.type === "line" && item.from === 6 &&
    item.className.includes("jot-live-preview-blank-line"));
}

function presentation_is_selection_driven_and_never_hover_driven(): void {
  const inactive = sourcePresentationRanges({
    composing: false,
    visibleRange: { from: 20, to: 40 },
    selections: [],
  });
  equal(inactive.length, 0);

  const selected = sourcePresentationRanges({
    composing: false,
    visibleRange: { from: 20, to: 40 },
    selections: [{ from: 8, to: 8 }, { from: 12, to: 16 }],
    pendingReveal: { from: 14, to: 22 },
  });
  equal(selected.length, 1);
  equal(selected[0]?.from, 14);
  equal(selected[0]?.to, 22);

  const fullDocumentSelection = sourcePresentationRanges({
    composing: false,
    visibleRange: { from: 20, to: 40 },
    selections: [{ from: 0, to: 10_000 }],
  });
  // Select All must remain a CodeMirror source selection over Preview widgets,
  // not a request to reveal every Markdown block as source.
  equal(fullDocumentSelection.length, 0);

  const composing = sourcePresentationRanges({
    composing: true,
    visibleRange: { from: 20, to: 40 },
    selections: [{ from: 8, to: 8 }],
  });
  equal(composing.length, 1);
  equal(composing[0]?.from, 8);
  equal(composing[0]?.to, 8);
}

function ordinary_caret_activates_only_one_root_at_a_shared_seam(): void {
  const source = "first\nsecond";
  const first = node("paragraph", 0, 5, { type: "source" });
  const second = node("paragraph", 6, source.length, { type: "source" });
  // The physical newline is consumed by the preceding block replacement, so
  // the normal source ranges are adjacent at 5/6 depending on Rust block
  // ownership. Verify the stricter planner rule at an exact shared semantic
  // seam: one caret must never source-reveal both roots.
  const left = node("paragraph", 0, 5, { type: "source" });
  const right = node("paragraph", 5, source.length, { type: "source" });
  const seam = planLivePreview({
    source,
    nodes: [left, right],
    selections: [{ from: 5, to: 5 }],
  });
  equal(seam.activeBlocks, 1);
  equal(seam.widgetCount, 0);
  const rightSource = seam.decorations.filter((item) =>
    item.type === "line" &&
    item.nodeId === right.id &&
    item.className.includes("jot-live-preview-active-line"));
  equal(rightSource.length > 0, true);

  const end = planLivePreview({
    source,
    nodes: [first, second],
    selections: [{ from: source.length, to: source.length }],
  });
  equal(end.activeBlocks, 1);
  includes(end.decorations, (item) =>
    item.type === "line" && item.from === 6 &&
    item.className.includes("jot-live-preview-active-line"));
}

function vertical_navigation_enters_adjacent_preview_blocks_without_skipping_blank_lines(): void {
  const source = "first\n\nsecond";
  const replacements = [
    { from: 0, to: 6 },
    { from: 7, to: source.length },
  ];
  const up = resolveLivePreviewVerticalNavigation(source, 6, replacements, "up");
  equal(up?.range.from, 0);
  equal(up?.anchor, 5);
  const down = resolveLivePreviewVerticalNavigation(source, 6, replacements, "down");
  equal(down?.range.from, 7);
  equal(down?.anchor, 7);

  const twoBlankLines = "first\n\n\nsecond";
  const separated = [
    { from: 0, to: 6 },
    { from: 8, to: twoBlankLines.length },
  ];
  // The first physical blank line must not jump across the second one.
  equal(resolveLivePreviewVerticalNavigation(twoBlankLines, 6, separated, "down"), undefined);
  equal(resolveLivePreviewVerticalNavigation(twoBlankLines, 7, separated, "down")?.anchor, 8);
}

function active_source_keeps_preview_inline_typography_tokens(): void {
  const source = "[**bold** and *italic*](https://example.test) with `code`";
  const boldText = node("text", 3, 7, { type: "source" });
  const bold = node("strong", 1, 9, structured(boldText));
  const gap = node("text", 9, 14, { type: "source" });
  const italicText = node("text", 15, 21, { type: "source" });
  const italic = node("emphasis", 14, 22, structured(italicText));
  const link = node("link", 0, 44, structured(bold, gap, italic));
  const linkGap = node("text", 44, 50, { type: "source" });
  const code = node("inline-code", 50, source.length, { type: "source" }, [
    rangeAttribute("contentRange", 51, source.length - 1),
  ]);
  const paragraph = node("paragraph", 0, source.length, structured(link, linkGap, code));
  const plan = planLivePreview({
    source,
    nodes: [paragraph],
    selections: [{ from: 2, to: 2 }],
  });
  includes(plan.decorations, (item) =>
    item.type === "mark" && item.className === "jot-live-preview-source-link");
  includes(plan.decorations, (item) =>
    item.type === "mark" && item.className === "jot-live-preview-source-strong");
  includes(plan.decorations, (item) =>
    item.type === "mark" && item.className === "jot-live-preview-source-emphasis");
  includes(plan.decorations, (item) =>
    item.type === "mark" && item.className === "jot-live-preview-source-inline-code");
}

function noncollapsed_selection_keeps_preview_blocks_and_geometry_uses_a_separate_budget(): void {
  const source = "first\nsecond\nthird";
  const middle = node("paragraph", 6, 12, { type: "source" });
  const plan = planLivePreview({
    source,
    nodes: [middle],
    // Select All is a visual/source selection, not a request to source-reveal
    // every block.
    selections: [],
    selectionHighlights: [{ from: 0, to: source.length }],
    geometryGaps: [
      {
        id: "first",
        from: 0,
        to: 5,
        estimatedHeight: 48,
      },
      {
        id: "third",
        from: 13,
        to: source.length,
        estimatedHeight: 64,
      },
    ],
    maxDecorations: 1,
    maxGeometryDecorations: 2,
  });
  equal(plan.activeBlocks, 0);
  equal(plan.widgetCount, 0);
  equal(plan.geometryWidgetCount, 2);
  equal(plan.visualDecorationCount, 1);
  equal(plan.geometryDecorationCount, 2);
  equal(plan.truncated, false);
  equal(plan.geometryTruncated, false);
  equal(plan.decorations.some((item) =>
    item.type === "replace" && item.widget?.selected === true), false);

  const firstGeometry = plan.decorations.find((item) =>
    item.type === "replace" && item.widget?.geometry === true && item.from === 0);
  if (firstGeometry?.type !== "replace") throw new Error("expected geometry replacement");
  equal(source.slice(firstGeometry.from, firstGeometry.to), "first\n");
}

function offscreen_active_root_cannot_be_replaced_by_geometry(): void {
  const source = "before\n$$\nx + y\n$$\nafter";
  const from = source.indexOf("$$");
  const to = source.indexOf("\nafter");
  const math = node("math-block", from, to, { type: "deferred" }, [bool("closed", true)]);
  const geometryGaps = [
    { id: "before", from: 0, to: from - 1, estimatedHeight: 40 },
    { id: "active", from, to, estimatedHeight: 80 },
    { id: "after", from: to + 1, to: source.length, estimatedHeight: 40 },
  ];
  for (const forceSource of [false, true]) {
    const plan = planLivePreview({
      source, nodes: [math], selections: [{ from: from + 3, to: from + 3 }],
      activeSourceRange: { from: from + 3, to: from + 3 },
      visibleRange: { from: 0, to: from - 1 }, geometryGaps,
      ...(forceSource ? { forceSource: true, revealSyntax: true } : {}),
    });
    equal(plan.activeBlocks, 1);
    equal(plan.geometryWidgetCount, 2);
    equal(plan.decorations.some(item => item.type === "replace" && item.widget?.geometry === true &&
      item.from < to && from < item.to), false);
    includes(plan.decorations, item => item.type === "replace" && item.widget?.geometry === true && item.to === from);
    includes(plan.decorations, item => item.type === "replace" && item.widget?.geometry === true && item.from === to + 1);
  }
}

function sparse_search_target_cannot_be_replaced_by_geometry(): void {
  const source = "before\n$$\nx + target\n$$\nafter";
  const from = source.indexOf("$$");
  const to = source.indexOf("\nafter");
  const target = source.indexOf("target");
  const geometryGaps = [{ id: "unprojected", from, to, estimatedHeight: 688 }];
  for (const nodes of [[], [node("paragraph", 0, from - 1, { type: "source" })]]) {
    const search = planLivePreview({
      source, nodes, selections: [], geometryGaps,
      geometryExclusions: [{ from: target, to: target + 6 }],
      visibleRange: { from: 0, to: from - 1 },
    });
    equal(search.geometryWidgetCount, 0);
    const caret = planLivePreview({
      source, nodes, selections: [{ from: target, to: target }], geometryGaps,
      visibleRange: { from: 0, to: from - 1 },
    });
    equal(caret.geometryWidgetCount, 0);
    const ordinary = planLivePreview({
      source, nodes, selections: [], geometryGaps,
      selectionHighlights: [{ from: 0, to: source.length }],
    });
    equal(ordinary.geometryWidgetCount, 1);
  }
}

function large_table_uses_one_shared_root_widget(): void {
  const rows = [
    "| id | value |",
    "| --- | --- |",
    ...Array.from({ length: 2_000 }, (_, index) => `| ${index} | value |`),
  ].join("\n");
  const table = node("table", 0, rows.length, { type: "deferred" }, [], 2_001);
  const plan = planLivePreview({
    source: rows,
    nodes: [table],
    selections: [],
    visibleRange: { from: 0, to: 300 },
    maxDecorations: 12,
  });
  equal(plan.decorations.length, 1);
  equal(plan.wrappers.length, 0);
  equal(plan.visitedNodes, 1);
  equal(plan.widgetCount, 1);
  equal(plan.truncated, false);
  equal(plan.fallbackBlocks, 0);
  includes(plan.decorations, (item) =>
    item.type === "replace" && item.widget?.kind === "table");
}

function table_selection_keeps_the_shared_projection_mounted(): void {
  const source = "| id | value |\n| --- | --- |\n| 1 | alpha |\n| 2 | beta |";
  const table = node("table", 0, source.length, { type: "deferred" }, [], 3);
  const active = source.indexOf("alpha");
  const plan = planLivePreview({
    source,
    nodes: [table],
    selections: [{ from: active, to: active }],
  });
  equal(plan.fallbackBlocks, 0);
  equal(plan.widgetCount, 1);
  includes(plan.decorations, (item) =>
    item.type === "replace" && item.widget?.kind === "table");
}

function table_selection_does_not_create_a_second_editor_state(): void {
  const source = "| id | value |\n| --- | --- |\n| 1 | alpha |";
  const table = node("table", 0, source.length, { type: "deferred" }, [], 2);
  const active = source.indexOf("alpha");
  const focused = planLivePreview({
    source,
    nodes: [table],
    selections: [{ from: active, to: active }],
  });
  equal(focused.widgetCount, 1);
  const focusedWidget = focused.decorations.find((item) =>
    item.type === "replace" && item.widget?.kind === "table");
  if (focusedWidget?.type !== "replace" || focusedWidget.widget === undefined) {
    throw new Error("expected shared table widget");
  }
  equal(focusedWidget.widget.selection, "mapped");
  equal(focusedWidget.widget.inPlaceUpdate, true);

  const editing = planLivePreview({
    source,
    nodes: [table],
    selections: [{ from: active, to: active }],
  });
  equal(editing.widgetCount, 1);
  equal(editing.decorations.some((item) =>
    item.type === "replace" && item.widget?.kind === "table-row"), false);
}

function composition_forces_a_mapped_table_back_to_codemirror_source(): void {
  const source = "| head | value |\n| --- | --- |\n| A | one |";
  const headerEnd = source.indexOf("\n");
  const bodyStart = source.indexOf("\n", headerEnd + 1) + 1;
  const table = node("table", 0, source.length, structured(
    tableRow(source, 0, headerEnd),
    tableRow(source, bodyStart, source.length),
  ), [strings("alignments", ["none", "none"])], 2);
  const plan = planLivePreview({
    source,
    nodes: [table],
    selections: [{ from: source.indexOf("A"), to: source.indexOf("A") }],
    forceSource: true,
  });
  equal(plan.activeBlocks, 1);
  equal(plan.decorations.some((item) =>
    item.type === "replace" && item.widget?.kind === "table"), false);
  equal(plan.decorations.filter((item) => item.type === "line").length >= 2, true);
  equal(plan.wrappers.some((item) =>
    item.className.includes("jot-live-preview-source-block-shell--table")), true);
}

function table_interaction_consumes_rust_cell_ranges(): void {
  const source = "| head | value |\n| --- | --- |\n| A | one |\n| B | two |";
  const headerEnd = source.indexOf("\n");
  const delimiterEnd = source.indexOf("\n", headerEnd + 1);
  const bodyStart = delimiterEnd + 1;
  const bodyEnd = source.indexOf("\n", bodyStart);
  const header = tableRow(source, 0, headerEnd);
  const first = tableRow(source, bodyStart, bodyEnd);
  const second = tableRow(source, bodyEnd + 1, source.length);
  const table = node("table", 0, source.length, structured(header, first, second), [
    strings("alignments", ["none", "none"]),
  ], 3);
  const nodes = [table];
  const firstCellOffset = source.indexOf("A");
  const active = tableRenderCellAt(nodes, firstCellOffset);
  if (active === undefined) throw new Error("Rust cell range should resolve to a table cell");
  equal(active.rowIndex, 1);
  equal(active.columnIndex, 0);
  const right = tableRenderNavigation(nodes, firstCellOffset + 1, "right");
  if (right?.kind !== "cell") throw new Error("right should move to the next Rust cell");
  equal(source.slice(Number(right.target.cell.sourceRange.from), Number(right.target.cell.sourceRange.to)), "one");
  const down = tableRenderNavigation(nodes, firstCellOffset + 1, "down");
  if (down?.kind !== "cell") throw new Error("down should move to the next Rust row");
  equal(source.slice(Number(down.target.cell.sourceRange.from), Number(down.target.cell.sourceRange.to)), "B");
}

function table_interaction_yields_source_fallback_at_edges(): void {
  const source = "| head | value |\n| --- | --- |\n| A | one |";
  const headerEnd = source.indexOf("\n");
  const bodyStart = source.indexOf("\n", headerEnd + 1) + 1;
  const header = tableRow(source, 0, headerEnd);
  const body = tableRow(source, bodyStart, source.length);
  const table = node("table", 0, source.length, structured(header, body), [
    strings("alignments", ["none", "none"]),
  ], 2);
  const firstCell = source.indexOf("head");
  const lastCell = source.indexOf("one");
  equal(tableRenderNavigation([table], firstCell, "left"), undefined);
  equal(tableRenderNavigation([table], lastCell, "down"), undefined);
  equal(tableRenderNavigation([table], firstCell + "head".length, "right")?.kind, "cell");
  equal(tableRenderPositionAt([table], 0)?.kind, "protected");
  equal(tableRenderRootAt([table], firstCell)?.id, table.id);
  equal(tableRenderNavigation([table], 0, "right"), undefined);
  equal(tableRenderPositionAt([
    node("table", 0, source.length, { type: "deferred" }, [], 2),
  ], firstCell), undefined);
}

function table_surface_keeps_character_motion_inside_a_cell(): void {
  const source = "| head | value |\n| --- | --- |\n| A | one |";
  const inside = source.indexOf("head") + 2;
  equal(resolveTableSurfaceNavigation(source, inside, "left"), undefined);
  equal(resolveTableSurfaceNavigation(source, inside, "right"), undefined);
  const start = source.indexOf("head");
  equal(resolveTableSurfaceNavigation(source, start, "left")?.kind, "handled");
  const end = start + "head".length;
  equal(resolveTableSurfaceNavigation(source, end, "right")?.kind, "cell");
}

function non_table_blocks_keep_native_vertical_navigation(): void {
  const source = "$$\nx^2 + y^2\nnext line\n$$\nafter";
  const inside = source.indexOf("next line") + 2;
  equal(resolveTableSurfaceNavigation(source, inside, "up"), undefined);
  equal(resolveTableSurfaceNavigation(source, inside, "down"), undefined);
}

function table_edit_policy_protects_structure_without_blocking_cell_text(): void {
  const source = "| head | value |\n| --- | --- |\n| A | one |";
  const headerEnd = source.indexOf("\n");
  const bodyStart = source.indexOf("\n", headerEnd + 1) + 1;
  const table = node(
    "table",
    0,
    source.length,
    structured(
      tableRow(source, 0, headerEnd),
      tableRow(source, bodyStart, source.length),
    ),
    [strings("alignments", ["none", "none"])],
    2,
  );
  const policy = new LivePreviewEditPolicy();
  policy.update(source, [table]);
  equal(policy.allows([{ from: source.indexOf("A"), to: source.indexOf("A"), insert: "X" }]), true);
  const firstCell = source.indexOf("A");
  const firstCellEnd = firstCell + 1;
  // Pure insertion sits between UTF-16 code units. The visual cell edge is
  // still part of the editable surface; otherwise clicking a rendered cell
  // places a valid caret that rejects the very first keystroke.
  equal(policy.allows([{ from: firstCellEnd, to: firstCellEnd, insert: "X" }]), true);
  equal(policy.allows([{ from: source.indexOf("A"), to: source.indexOf("A"), insert: "|" }]), false);
  equal(policy.allows([{ from: source.indexOf("A"), to: source.indexOf("A") + 1, insert: "a\nb" }]), false);
  equal(policy.allows([{ from: source.indexOf("A"), to: source.indexOf("one") + 3, insert: "merged" }]), false);
  equal(policy.allows([{ from: source.indexOf("A"), to: source.indexOf("A"), insert: "\\|" }]), true);
  equal(policy.commandRanges.length, 1);

  // Confirmed interaction policy is intentionally never mapped across a local
  // CodeMirror edit. Controller clears it on docChanged and rebuilds it only
  // from the next Rust-confirmed projection; retaining a mapped old table
  // surface would make stale pipe/cell ranges interpret new Markdown.
}

function table_edit_policy_allows_whole_root_replacement_but_not_partial_structure_crossing(): void {
  const before = "before\n";
  const tableSource = "| head | value |\n| --- | --- |\n| A | one |";
  const after = "\nafter";
  const source = `${before}${tableSource}${after}`;
  const tableFrom = before.length;
  const tableTo = tableFrom + tableSource.length;
  const headerEnd = source.indexOf("\n", tableFrom);
  const bodyStart = source.indexOf("\n", headerEnd + 1) + 1;
  const table = node(
    "table",
    tableFrom,
    tableTo,
    structured(
      tableRow(source, tableFrom, headerEnd),
      tableRow(source, bodyStart, tableTo),
    ),
    [strings("alignments", ["none", "none"])],
    2,
  );
  const policy = new LivePreviewEditPolicy();
  policy.update(source, [table]);

  // Delete / Paste after Cmd/Ctrl+A may cover the complete document, including
  // one or more mapped table roots. That is replacement of the root, not an
  // attempt to edit its protected pipes in place.
  equal(policy.allows([{ from: 0, to: source.length, insert: "" }]), true);
  equal(policy.allows([{ from: 0, to: source.length, insert: "# replacement" }]), true);
  equal(policy.allows([{ from: tableFrom, to: tableTo, insert: "paragraph" }]), true);

  // A partial edit crossing table structure remains rejected.
  equal(policy.allows([{
    from: source.indexOf("A"),
    to: source.indexOf("one") + "one".length,
    insert: "merged",
  }]), false);
  // Insertion at the root boundary is not a complete replacement.
  equal(policy.allows([{ from: tableTo, to: tableTo, insert: "!" }]), false);
}

function table_interaction_adapter_owns_root_and_cell_deletion_boundaries(): void {
  const source = [
    "before",
    "| head | value |",
    "| --- | --- |",
    "| A | one |",
    "",
    "after",
  ].join("\n");
  const tableFrom = source.indexOf("| head");
  const tableTo = source.indexOf("\n\nafter");
  const headerEnd = source.indexOf("\n", tableFrom);
  const bodyStart = source.indexOf("\n", headerEnd + 1) + 1;
  const table = node(
    "table",
    tableFrom,
    tableTo,
    structured(
      tableRow(source, tableFrom, headerEnd),
      tableRow(source, bodyStart, tableTo),
    ),
    [strings("alignments", ["none", "none"])],
    2,
  );
  const model = createTableComponentModel(table);
  if (model === undefined || model.kind !== "table") {
    throw new Error("expected a table component model");
  }
  const ranges = tableInteractionAdapter.ranges(model, { source });
  if (ranges === undefined) throw new Error("expected table interaction ranges");
  const rootDelete = tableInteractionAdapter.resolveDeletion?.(
    model,
    { position: tableFrom, direction: "forward" },
    ranges,
    { source },
  );
  if (rootDelete?.kind !== "delete-range") {
    throw new Error("table adapter should own Delete at its external root start");
  }
  equal(source.slice(rootDelete.from, rootDelete.to), `${source.slice(tableFrom, tableTo)}\n`);

  const cellStart = source.indexOf("A");
  const cellEnd = cellStart + 1;
  equal(
    tableInteractionAdapter.resolveDeletion?.(
      model,
      { position: cellStart, direction: "backward" },
      ranges,
      { source },
    )?.kind,
    "consume",
  );
  equal(
    tableInteractionAdapter.resolveDeletion?.(
      model,
      { position: cellEnd, direction: "forward" },
      ranges,
      { source },
    )?.kind,
    "consume",
  );

  // The last editable cell and the root share EOF when the row has no
  // trailing pipe. A character Backspace there must never delete the table.
  const terminal = "A | B\n--- | ---\nx | y";
  const firstEnd = terminal.indexOf("\n"), lastStart = terminal.lastIndexOf("\n") + 1;
  const terminalNode = node("table", 0, terminal.length, structured(
    tableRow(terminal, 0, firstEnd), tableRow(terminal, lastStart, terminal.length),
  ));
  const terminalModel = createTableComponentModel(terminalNode);
  if (terminalModel === undefined || terminalModel.kind !== "table") throw new Error("expected terminal table");
  const terminalRanges = tableInteractionAdapter.ranges(terminalModel, { source: terminal });
  if (terminalRanges === undefined) throw new Error("expected terminal table ranges");
  equal(tableInteractionAdapter.resolveDeletion?.(terminalModel,
    { position: terminal.length, direction: "backward" }, terminalRanges, { source: terminal }), undefined);
  equal(tableInteractionAdapter.resolveDeletion?.(terminalModel,
    { position: terminal.length, direction: "forward" }, terminalRanges, { source: terminal })?.kind, "consume");
}

function table_mapped_input_uses_the_component_serializer(): void {
  const source = "| head | value |\n| --- | --- |\n| A | one |";
  const from = source.indexOf("one");
  const cell = { from, to: from + "one".length };
  const typed = tableMappedInputChange(
    source,
    { from, to: from },
    cell,
    {
      inputType: "insertText",
      data: "x|y\nz",
    },
  );
  if (typed === undefined) throw new Error("expected a mapped table text change");
  equal(typed.insert, "x\\|y z");
  const pasted = tableMappedInputChange(
    source,
    { from, to: from + 1 },
    cell,
    {
      inputType: "insertFromPaste",
      data: "a\nb|c",
    },
  );
  if (pasted === undefined) throw new Error("expected a mapped table paste change");
  equal(pasted.insert, "a b\\|c");
  equal(tableMappedInputUserEvent("insertFromPaste"), "input.table.paste");
  equal(tableMappedInputUserEvent("deleteContentBackward"), "input.table.delete");
}

function native_active_source_does_not_consume_the_following_physical_blank_line(): void {
  const source = "> quote\n\nafter";
  const quote = node("block-quote", 0, "> quote".length, { type: "source" });
  const blank = node("blank-line", "> quote\n".length, "> quote\n".length, { type: "source" });
  const after = node("paragraph", "> quote\n\n".length, source.length, { type: "source" });
  const plan = planLivePreview({
    source,
    nodes: [quote, blank, after],
    selections: [{ from: 2, to: 2 }],
  });
  equal(plan.wrappers.length, 0);
  includes(plan.decorations, (item) =>
    item.type === "line" && item.from === 0 &&
    item.className.includes("jot-live-preview-native-block--block-quote"));
  includes(plan.decorations, (item) =>
    item.type === "line" && item.from === "> quote\n".length &&
    item.className.includes("jot-live-preview-blank-line"));
}

function active_quote_source_marker_is_nonlayout_presentation(): void {
  const source = "> first\n> second";
  const quote = node("block-quote", 0, source.length, { type: "source" });
  const projectedLines = [
    node("quote-line", 0, 7, structured(), [number("quoteDepth", 1), number("quoteOpen", 1), number("quoteClose", 0), rangeAttribute("markerRange", 0, 2)]),
    node("quote-line", 8, source.length, structured(), [number("quoteDepth", 1), number("quoteOpen", 0), number("quoteClose", 1), rangeAttribute("markerRange", 8, 10)]),
  ];
  const plan = planLivePreview({
    source,
    nodes: [quote],
    quoteLines: projectedLines,
    selections: [{ from: 3, to: 3 }],
  });
  const markers = plan.decorations.filter((item) =>
    item.type === "replace" && item.widget === undefined);
  equal(markers.length, 2);
  const first = markers[0];
  const second = markers[1];
  if (first?.type !== "replace" || second?.type !== "replace") {
    throw new Error("expected hidden quote prefixes");
  }
  equal(source.slice(first.from, first.to), "> ");
  equal(source.slice(second.from, second.to), "> ");
  const quoteLines = plan.decorations.filter((item) =>
    item.type === "line" && item.className.includes("jot-live-preview-source-block-quote"));
  equal(quoteLines.length, 2);
  const firstLine = quoteLines[0];
  const secondLine = quoteLines[1];
  if (firstLine?.type !== "line" || secondLine?.type !== "line") {
    throw new Error("expected quote source lines");
  }
  equal(firstLine.attributes?.["data-jot-live-marker"], undefined);
  equal(secondLine.attributes?.["data-jot-live-marker"], undefined);
  equal(firstLine.attributes?.["data-jot-quote-marker-hidden"], "true");
  equal(secondLine.attributes?.["data-jot-quote-marker-hidden"], "true");

  const revealed = planLivePreview({
    source,
    nodes: [quote],
    quoteLines: projectedLines,
    selections: [{ from: 3, to: 3 }],
    revealSyntax: true,
  });
  equal(revealed.decorations.some((item) => item.type === "line" &&
    item.attributes?.["data-jot-quote-marker-hidden"] !== undefined), false);
  equal(revealed.decorations.some((item) => item.type === "replace"), false);

  const emptySource = "> ";
  const emptyQuote = node("block-quote", 0, emptySource.length, { type: "source" });
  const empty = planLivePreview({
    source: emptySource, nodes: [emptyQuote], selections: [{ from: 2, to: 2 }],
    quoteLines: [node("quote-line", 0, 2, structured(), [
      number("quoteDepth", 1), number("quoteOpen", 1), number("quoteClose", 1), rangeAttribute("markerRange", 0, 2),
    ])],
  });
  includes(empty.decorations, item => item.type === "line" &&
    item.attributes?.["data-jot-quote-marker-only"] === "true");
}

function quote_keeps_rendered_inline_geometry_outside_the_edited_line(): void {
  const imageSource = "![plot](plot.png)";
  const mathSource = "$x^2$";
  const source = `> edit\n> Image: ${imageSource}\n> Formula: ${mathSource}`;
  const imageFrom = source.indexOf(imageSource);
  const mathFrom = source.indexOf(mathSource);
  const image = node("image", imageFrom, imageFrom + imageSource.length, { type: "source" });
  const math = node("inline-math", mathFrom, mathFrom + mathSource.length, { type: "source" });
  const quote = node("block-quote", 0, source.length, structured(
    node("paragraph", imageFrom, source.length, structured(image, math)),
  ));
  const rendered = (caret: number, forceSource: boolean, revealSyntax = false): string => {
    const plan = planLivePreview({
      source,
      nodes: [quote],
      selections: [{ from: caret, to: caret }],
      forceSource,
      revealSyntax,
    });
    return plan.decorations.flatMap(item =>
      item.type === "replace" && item.widget !== undefined && item.from < item.to ? [item.widget.kind] : [],
    ).join(",");
  };
  for (const forceSource of [false, true]) {
    equal(rendered(3, forceSource), "image,inline-math");
    equal(rendered(source.indexOf("Image:"), forceSource), "inline-math");
    equal(rendered(source.indexOf("Formula:"), forceSource), "image");
  }
  equal(rendered(3, true, true), "");
}

function nested_quote_uses_confirmed_lines_and_richer_inline_owner_once(): void {
  const source = "> > **bold**";
  const strong = node("strong", 4, 12, structured(node("text", 6, 10, { type: "source" })));
  const owner = node("paragraph", 4, 12, structured(strong));
  const shallowOwner = node("paragraph", 4, 12, { type: "deferred" }, [], 1);
  const nested = node("block-quote", 2, 12, structured(shallowOwner));
  const quote = node("block-quote", 0, 12, structured(nested));
  const quoteLine = node("quote-line", 0, 12, structured(owner), [
    number("quoteDepth", 2), number("quoteOpen", 2), number("quoteClose", 2), rangeAttribute("markerRange", 0, 4),
  ]);
  const waiting = planLivePreview({ source, nodes: [quote], selections: [] });
  includes(waiting.decorations, item => item.type === "replace" && item.from === 0 && item.to === 2);
  equal(waiting.decorations.some(item => item.type === "replace" && item.from === 0 && item.to === 4), false);
  const plan = planLivePreview({ source, nodes: [quote], quoteLines: [quoteLine], selections: [] });
  const markers = plan.decorations.filter(item => item.type === "replace" && item.from === 0 && item.to === 4);
  equal(markers.length, 1);
  equal(markers[0]?.leadingQuoteMarker, true);
  includes(plan.decorations, item => item.type === "replace" && item.from === 4 && item.to === 6 && item.leadingQuoteMarker === true);
  includes(plan.decorations, item => item.type === "replace" && item.from === 10 && item.to === 12 && item.leadingQuoteMarker !== true);
  equal(plan.decorations.filter(item => item.type === "mark" && item.className === "jot-live-preview-strong").length, 1);
  const line = plan.decorations.find(item => item.type === "line");
  if (line?.type !== "line") throw new Error("expected quote line");
  equal(line.attributes?.["data-jot-quote-depth"], "2");
  equal(line.attributes?.["style"]?.includes("--jot-live-quote-open:2"), true);
  equal(line.attributes?.["style"]?.includes("--jot-live-quote-close:2"), true);

  const separated = "> lead **bold**";
  const strongFrom = separated.indexOf("**");
  const separatedStrong = node("strong", strongFrom, separated.length,
    structured(node("text", strongFrom + 2, separated.length - 2, { type: "source" })));
  const separatedQuote = node("block-quote", 0, separated.length,
    structured(node("paragraph", 2, separated.length, structured(separatedStrong))));
  const separatedPlan = planLivePreview({
    source: separated, nodes: [separatedQuote], selections: [],
    quoteLines: [node("quote-line", 0, separated.length, structured(), [
      number("quoteDepth", 1), number("quoteOpen", 1), number("quoteClose", 1), rangeAttribute("markerRange", 0, 2),
    ])],
  });
  includes(separatedPlan.decorations, item => item.type === "replace" && item.from === 0 && item.leadingQuoteMarker === true);
  includes(separatedPlan.decorations, item => item.type === "replace" && item.from === strongFrom && item.leadingQuoteMarker !== true);
}

function block_replacements_consume_one_terminating_line_break(): void {
  const source = "| id | value |\n| --- | --- |\n| 1 | alpha |\n| 2 | beta |";
  const table = node("table", 0, source.length, { type: "deferred" }, [], 3);
  const plan = planLivePreview({ source, nodes: [table], selections: [] });
  for (const decoration of plan.decorations) {
    if (decoration.type !== "replace" || decoration.widget?.block !== true) continue;
    const replaced = source.slice(decoration.from, decoration.to);
    if (decoration.to < source.length) equal(replaced.endsWith("\n"), true);
  }
}

function table_preserves_a_source_blank_line_after_the_last_row(): void {
  const source = "| id | value |\n| --- | --- |\n| 1 | alpha |\n\nafter";
  const table = node("table", 0, source.indexOf("\n\nafter"), { type: "deferred" }, [], 3);
  const plan = planLivePreview({ source, nodes: [table], selections: [] });
  const tableWidget = plan.decorations.find((item) =>
    item.type === "replace" && item.widget?.kind === "table");
  if (tableWidget?.type !== "replace") throw new Error("expected table replacement");
  equal(source.slice(tableWidget.from, tableWidget.to).endsWith("\n"), true);
  equal(source.slice(tableWidget.to), "\nafter");
}

function native_blocks_keep_exactly_one_codemirror_blank_line(): void {
  const source = "first\n\nsecond";
  // The first paragraph's semantic source range ends before its physical LF,
  // while BlankLine owns the second LF at offset 6.
  const first = node("paragraph", 0, 5, { type: "source" });
  const blank = node("blank-line", 6, 6, { type: "source" });
  const second = node("paragraph", 7, source.length, { type: "source" });
  const plan = planLivePreview({ source, nodes: [first, blank, second], selections: [] });
  equal(plan.widgetCount, 0);
  equal(plan.decorations.some((item) => item.type === "replace"), false);
  equal(
    plan.decorations.filter((item) =>
      item.type === "line" && item.className.includes("jot-live-preview-blank-line")).length,
    1,
  );
}

function utf16_selection_boundaries_are_not_code_point_offsets(): void {
  const source = "# 😀 model";
  const text = node("text", 2, source.length, { type: "source" });
  const heading = node("heading", 0, source.length, structured(text));
  // emoji 占两个 UTF-16 code units；偏移 4 仍位于同一 Rust/CodeMirror 范围内。
  equal(rangesTouch(heading.sourceRange, { from: 4, to: 4 }), true);
  const plan = planLivePreview({
    source,
    nodes: [heading],
    selections: [{ from: 4, to: 4 }],
  });
  equal(plan.activeBlocks, 1);
  equal(plan.decorations.some((item) => item.type === "replace"), false);
}

function decoration_cap_degrades_instead_of_expanding_the_document(): void {
  const source = Array.from({ length: 200 }, (_, index) => `paragraph ${index}`).join("\n");
  const paragraphs: RenderNode[] = [];
  let cursor = 0;
  for (let index = 0; index < 200; index += 1) {
    const value = `paragraph ${index}`;
    paragraphs.push(node("paragraph", cursor, cursor + value.length, { type: "source" }));
    cursor += value.length + 1;
  }
  const plan = planLivePreview({
    source,
    nodes: paragraphs,
    selections: [],
    maxDecorations: 12,
  });
  equal(plan.truncated, true);
  equal(plan.decorations.length <= 12, true);
}

function native_block_overflow_is_bounded_without_widgets(): void {
  const first = "first paragraph";
  const second = "second paragraph";
  const source = `${first}\n${second}`;
  const paragraphs = [
    node("paragraph", 0, first.length, { type: "source" }),
    node("paragraph", first.length + 1, source.length, { type: "source" }),
  ];
  const plan = planLivePreview({
    source,
    nodes: paragraphs,
    selections: [],
    maxDecorations: 1,
  });
  equal(plan.widgetCount, 0);
  equal(plan.fallbackBlocks, 0);
  equal(plan.decorations.filter((item) => item.type === "line").length, 1);
  equal(plan.truncated, true);
}

function list_indent_uses_rust_columns_without_reparsing_source(): void {
  const source = "    - nested item";
  const text = node("text", 6, source.length, { type: "source" });
  const item = node("list-item", 0, source.length, structured(text), [
    number("indentColumns", 4),
    string("marker", "-"),
  ]);
  const plan = planLivePreview({ source, nodes: [item], selections: [] });
  includes(plan.decorations, (decoration) =>
    decoration.type === "line" && decoration.className.includes("jot-live-preview-list-item") &&
    decoration.attributes?.["data-jot-live-list-marker"] === "•" &&
    decoration.attributes?.["style"]?.includes("--jot-live-list-indent:4ch") === true);
  includes(plan.decorations, (decoration) =>
    decoration.type === "replace" && decoration.from === 0 && decoration.to === 6 &&
    decoration.widget === undefined);
  equal(plan.widgetCount, 0);

  const orderedSource = "100000. item";
  const ordered = node("list-item", 0, orderedSource.length, structured(
    node("text", 8, orderedSource.length, { type: "source" }),
  ), [number("indentColumns", 0), number("number", 100000), string("delimiter", ".")]);
  includes(planLivePreview({ source: orderedSource, nodes: [ordered], selections: [] }).decorations, decoration =>
    decoration.type === "line" && decoration.attributes?.["data-jot-live-list-marker"] === "100000." &&
    decoration.attributes?.["style"]?.includes("--jot-live-list-marker-columns:7ch") === true);
}

function closed_math_source_hides_markers_and_preserves_rendered_height(): void {
  const source = "$$\nx + y\n$$";
  const math = node("math-block", 0, source.length, { type: "deferred" }, [
    bool("closed", true),
    rangeAttribute("openingRange", 0, 2),
    rangeAttribute("contentRange", 3, 8),
    rangeAttribute("closingRange", 9, 11),
  ]);
  const plan = planLivePreview({
    source,
    nodes: [math],
    selections: [{ from: 4, to: 4 }],
    estimateBlockHeight: () => 82,
  });
  equal(plan.widgetCount, 0);
  includes(plan.decorations, (item) =>
    item.type === "replace" && item.from === 0 && item.to === 2);
  includes(plan.decorations, (item) =>
    item.type === "replace" && item.from === 9 && item.to === 11);
  equal(plan.decorations.filter((item) =>
    item.type === "line" &&
    item.className.includes("jot-live-preview-structural-line")).length, 2);
  equal(plan.wrappers[0]?.attributes?.["data-jot-live-reserved-height"], "82");
}

function closed_container_edit_policy_allows_opening_but_protects_closing(): void {
  const source = "$$\nx + y\n$$\nafter";
  const math = node("math-block", 0, 11, { type: "deferred" }, [
    bool("closed", true),
    rangeAttribute("openingRange", 0, 2),
    rangeAttribute("contentRange", 3, 8),
    rangeAttribute("closingRange", 9, 11),
  ]);
  const policy = new LivePreviewEditPolicy();
  policy.update(source, [math]);
  equal(policy.allows([{ from: 5, to: 5, insert: "z" }]), true);
  equal(policy.allows([{ from: 0, to: 1, insert: "" }]), true);
  equal(policy.allows([{ from: 2, to: 3, insert: "" }]), false);
  equal(policy.allows([{ from: 8, to: 10, insert: "" }]), false);
  equal(policy.resolveDeletion({ position: 3, direction: "backward" })?.kind, "consume");
  const root = policy.resolveDeletion({ position: 12, direction: "backward" });
  equal(root?.kind, "delete-range");
  if (root?.kind === "delete-range") equal(root.to, 12);
}

function active_image_source_keeps_the_last_rendered_geometry(): void {
  const source = "lead ![layout](/pretext-layout.svg)";
  const imageFrom = source.indexOf("![");
  const image = node("image", imageFrom, source.length, { type: "source" }, [
    string("destination", "/pretext-layout.svg"),
  ]);
  const paragraph = node("paragraph", 0, source.length, structured(image));
  const plan = planLivePreview({
    source,
    nodes: [paragraph],
    selections: [{ from: imageFrom + 3, to: imageFrom + 3 }],
    estimateBlockHeight: () => 729,
  });
  equal(plan.widgetCount, 1);
  includes(plan.decorations, (item) =>
    item.type === "replace" && item.from === source.length && item.to === source.length &&
    item.widget?.kind === "image" && item.widget.sourceCompanion === true);
  equal(plan.wrappers[0]?.className.includes("source-block-shell--paragraph"), true);
  equal(plan.wrappers[0]?.attributes?.["data-jot-live-reserved-height"], "729");
  equal(plan.wrappers[0]?.attributes?.["data-jot-source-from"], "0");
  equal(plan.wrappers[0]?.attributes?.["data-jot-source-to"], String(source.length));

  const textActive = planLivePreview({
    source,
    nodes: [paragraph],
    selections: [{ from: 2, to: 2 }],
    estimateBlockHeight: () => 729,
  });
  equal(textActive.widgetCount, 0);
}

function projected_table_caret_uses_nearest_visual_scroll_delta(): void {
  equal(nearestRevealDelta(120, 136, 100, 200), 0);
  equal(nearestRevealDelta(80, 96, 100, 200), -20);
  equal(nearestRevealDelta(196, 212, 100, 200), 12);
  equal(nearestRevealDelta(10, 20, 50, 50), 0);
}

function node(
  kind: string,
  from: number,
  to: number,
  content: RenderContent,
  attributes: readonly RenderAttribute[] = [],
  childCount = content.type === "structured" ? content.children.length : 0,
): RenderNode {
  return {
    id: `${kind}:${from}:${to}`,
    kind,
    sourceRange: textRange(from, to),
    contentVersion: 1,
    mode: "preview",
    childCount,
    attributes,
    content,
  };
}

function structured(...children: readonly RenderNode[]): RenderContent {
  return { type: "structured", children };
}

function tableRow(source: string, from: number, to: number): RenderNode {
  const line = source.slice(from, to);
  const separators = [...line].flatMap((character, index) =>
    character === "|" ? [index] : []);
  const cells: RenderNode[] = [];
  let start = line.startsWith("|") ? 1 : 0;
  const startsWithPipe = line.startsWith("|");
  const endsWithPipe = line.endsWith("|");
  for (let index = startsWithPipe ? 1 : 0; index < separators.length; index += 1) {
    const separator = separators[index]!;
    let cellFrom = start;
    let cellTo = separator;
    while (cellFrom < cellTo && /\s/u.test(line[cellFrom]!)) cellFrom += 1;
    while (cellTo > cellFrom && /\s/u.test(line[cellTo - 1]!)) cellTo -= 1;
    cells.push(node("table-cell", from + cellFrom, from + cellTo, { type: "source" }));
    start = separator + 1;
  }
  if (!endsWithPipe && start <= line.length) {
    let cellFrom = start;
    let cellTo = line.length;
    while (cellFrom < cellTo && /\s/u.test(line[cellFrom]!)) cellFrom += 1;
    while (cellTo > cellFrom && /\s/u.test(line[cellTo - 1]!)) cellTo -= 1;
    cells.push(node("table-cell", from + cellFrom, from + cellTo, { type: "source" }));
  }
  return node("table-row", from, to, structured(...cells), [], cells.length);
}

function number(name: string, value: number): RenderAttribute {
  return attribute(name, { type: "number", value });
}

function string(name: string, value: string): RenderAttribute {
  return attribute(name, { type: "string", value });
}

function strings(name: string, value: readonly string[]): RenderAttribute {
  return attribute(name, { type: "strings", value });
}

function bool(name: string, value: boolean): RenderAttribute {
  return attribute(name, { type: "boolean", value });
}

function rangeAttribute(name: string, from: number, to: number): RenderAttribute {
  return attribute(name, { type: "range", value: textRange(from, to) });
}

function attribute(name: string, value: RenderValue): RenderAttribute {
  return { name, value };
}

function textRange(from: number, to: number): TextRange {
  return { from: from as TextRange["from"], to: to as TextRange["to"] };
}

function includes(
  decorations: readonly LivePreviewDecoration[],
  predicate: (decoration: LivePreviewDecoration) => boolean,
): void {
  if (!decorations.some(predicate)) throw new Error("expected matching Live Preview decoration");
}

function equal<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

heading_hides_markup_only_when_inactive();
widgetLifecycleRegression();
livePreviewNavigationRegression();
livePreviewPointerRegression();
livePreviewPerformanceRegression();
livePreviewProjectionWindowRegression();
livePreviewQuoteLocalityRegression();
every_heading_level_uses_the_same_source_mapping();
inline_nodes_share_rust_ranges_without_reparsing();
native_heading_keeps_its_physical_line_break();
blank_lines_remain_physical_codemirror_lines();
presentation_is_selection_driven_and_never_hover_driven();
ordinary_caret_activates_only_one_root_at_a_shared_seam();
vertical_navigation_enters_adjacent_preview_blocks_without_skipping_blank_lines();
active_source_keeps_preview_inline_typography_tokens();
noncollapsed_selection_keeps_preview_blocks_and_geometry_uses_a_separate_budget();
offscreen_active_root_cannot_be_replaced_by_geometry();
sparse_search_target_cannot_be_replaced_by_geometry();
large_table_uses_one_shared_root_widget();
table_selection_keeps_the_shared_projection_mounted();
table_selection_does_not_create_a_second_editor_state();
composition_forces_a_mapped_table_back_to_codemirror_source();
table_interaction_consumes_rust_cell_ranges();
table_interaction_yields_source_fallback_at_edges();
table_surface_keeps_character_motion_inside_a_cell();
non_table_blocks_keep_native_vertical_navigation();
table_edit_policy_protects_structure_without_blocking_cell_text();
table_edit_policy_allows_whole_root_replacement_but_not_partial_structure_crossing();
table_interaction_adapter_owns_root_and_cell_deletion_boundaries();
table_mapped_input_uses_the_component_serializer();
table_mapped_deletion_preserves_graphemes();
native_active_source_does_not_consume_the_following_physical_blank_line();
active_quote_source_marker_is_nonlayout_presentation();
quote_keeps_rendered_inline_geometry_outside_the_edited_line();
nested_quote_uses_confirmed_lines_and_richer_inline_owner_once();
block_replacements_consume_one_terminating_line_break();
table_preserves_a_source_blank_line_after_the_last_row();
native_blocks_keep_exactly_one_codemirror_blank_line();
utf16_selection_boundaries_are_not_code_point_offsets();
decoration_cap_degrades_instead_of_expanding_the_document();
native_block_overflow_is_bounded_without_widgets();
list_indent_uses_rust_columns_without_reparsing_source();
closed_math_source_hides_markers_and_preserves_rendered_height();
closed_container_edit_policy_allows_opening_but_protects_closing();
active_image_source_keeps_the_last_rendered_geometry();
projected_table_caret_uses_nearest_visual_scroll_delta();
large_code_line_number_uses_the_indexed_line_model();

function large_code_line_number_uses_the_indexed_line_model(): void {
  const opening = "``` ts\n", body = "code\n".repeat(100_001), source = `${opening}${body}\`\`\``;
  const from = opening.length, to = from + body.length, target = from + 99_999 * "code\n".length;
  const fence = node("fenced-code", 0, source.length, { type: "deferred" }, [
    bool("closed", true), rangeAttribute("openingRange", 0, opening.length - 1),
    rangeAttribute("contentRange", from, to), rangeAttribute("closingRange", to, source.length),
  ]);
  const doc = Text.of(source.split("\n"));
  const calls: Array<{ from: number; to: number }> = [];
  const input = { source, nodes: [fence], selections: [], visibleRange: { from: target, to: target + 10 } };
  const plan = planLivePreview({ ...input, countSourceLines: (start, end) => {
    calls.push({ from: start, to: end });
    return doc.lineAt(Math.max(start, end - 1)).number - doc.lineAt(start).number + 1;
  } });
  const fallback = planLivePreview(input);
  const numbered = (decorations: readonly LivePreviewDecoration[]) => decorations.flatMap(decoration =>
    decoration.type === "line" && decoration.attributes?.["data-jot-line-number"] !== undefined
      ? [[decoration.from, decoration.attributes["data-jot-line-number"]]] : []);
  equal(JSON.stringify(numbered(plan.decorations)), JSON.stringify(numbered(fallback.decorations)));
  equal(numbered(plan.decorations)[0]?.[1], "100000");
  equal(calls.some(call => call.from === from && call.to === target + 1), true);
}

function table_mapped_deletion_preserves_graphemes(): void {
  for (const text of ["😀", "e\u0301", "👨‍👩‍👧‍👦", "🇨🇳", "👍🏽", "中"]) {
    const source = `| A${text}B |`;
    const start = 3;
    const end = start + text.length;
    for (const [position, inputType] of [
      [end, "deleteContentBackward"], [start, "deleteContentForward"],
    ] as const) {
      const change = tableMappedInputChange(source,
        { from: position, to: position }, { from: 2, to: end + 1 }, { inputType });
      if (change === undefined) throw new Error("expected a grapheme deletion");
      equal(source.slice(0, change.from) + change.insert + source.slice(change.to), "| AB |");
    }
  }
  equal(tableMappedInputChange("| A |", { from: 2, to: 2 }, { from: 2, to: 3 },
    { inputType: "deleteContentBackward" }), undefined);
  equal(tableMappedInputChange("| A |", { from: 3, to: 3 }, { from: 2, to: 3 },
    { inputType: "deleteContentForward" }), undefined);
}
