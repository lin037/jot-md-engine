import { type DocumentId, type RenderNode, type Revision, type Utf16Offset } from "../../../editor-protocol/src/index.js";
import { ProjectionStore, range, Utf16TextModel } from "../../src/adapter/index.js";
import { mapOffsetThroughEdits, renderNodeKey, replacesMostDocument } from "../../src/components/common/render-utils.js";
import { RenderNodeTranslator, sanitizeUrl } from "../../src/components/common/dom-renderer.js";
import { scrollAnchorAdjustment } from "../../src/core/virtual/dom-virtual-list.js";
import { VirtualAxis } from "../../src/core/virtual/virtual-axis.js";
import { renderNode } from "./fixtures/render-node.js";

const DOCUMENT = "render-document" as DocumentId;

function virtual_axis_handles_hundred_thousand_variable_rows(): void {
  const axis = new VirtualAxis(20);
  axis.resize(100_000);
  equal(axis.totalSize, 2_000_000);
  axis.setSize(50_000, 60);
  equal(axis.offsetAt(50_001), 1_000_060);
  equal(axis.indexAt(1_000_030), 50_000);
  const window = axis.window(1_000_000, 600, 200);
  assert(window.from <= 50_000 && window.toExclusive > 50_000);
  assert(window.toExclusive - window.from < 100);
  equal(window.beforePixels + window.afterPixels <= window.totalPixels, true);
}

function virtual_axis_splices_preserve_only_unaffected_measurements(): void {
  const axis = new VirtualAxis(20);
  axis.resize(5);
  axis.setSize(3, 70);
  axis.splice(1, 1, 2);
  equal(axis.count, 6);
  equal(axis.sizeAt(4), 70);
  equal(axis.isMeasured(4), true);
  equal(axis.sizeAt(1), 20);
  equal(axis.isMeasured(1), false);
  equal(axis.sizeAt(2), 20);
  axis.invalidate();
  equal(axis.sizeAt(4), 20);
  equal(axis.isMeasured(4), false);
}

function text_edits_report_physical_line_splices(): void {
  const model = new Utf16TextModel("a\nb\nc");
  const changes = model.apply([{
    range: range(1, 1),
    insert: "\n",
  }]);
  equal(changes.length, 1);
  equal(changes[0]?.fromLine, 0);
  equal(changes[0]?.removeCount, 1);
  equal(changes[0]?.insertCount, 2);
  equal(model.lineCount, 4);
  equal(model.text, "a\n\nb\nc");
}

function translator_is_semantic_and_never_accepts_unsafe_urls(): void {
  equal(sanitizeUrl("javascript:alert(1)"), undefined);
  equal(sanitizeUrl("data:text/html,x", true), undefined);
  equal(sanitizeUrl("data:image/png;base64,AA", true), "data:image/png;base64,AA");
  const document = new FakeDocument();
  const translator = new RenderNodeTranslator();
  let deferred: RenderNode | undefined;
  const heading = renderNode("heading", {
    type: "structured",
    children: [renderNode("text", { type: "source" })],
  }, [{
    name: "level",
    value: { type: "number", value: 2 },
  }]);
  const element = translator.mount(heading, {
    document: document as unknown as Document,
    mode: "preview",
    sourceForRange: () => "safe title",
    onDeferred: (node) => {
      deferred = node;
    },
  }) as unknown as FakeElement;
  equal(element.tagName, "H2");
  equal(element.children[0]?.textContent, "safe title");
  equal(element.children[0]?.className.includes("jot-inline-text"), true);
  equal(element.innerHTMLWrites, 0);

  const image = renderNode("image", { type: "source" }, [{
    name: "destination",
    value: { type: "string", value: "/diagram.svg" },
  }, {
    name: "alt",
    value: { type: "string", value: "diagram alt" },
  }, {
    name: "title",
    value: { type: "string", value: "caption" },
  }]);
  const imageElement = translator.mount(image, {
    document: document as unknown as Document,
    mode: "preview",
    sourceForRange: () => "",
    onDeferred: () => {},
    resolveImageMetadata: () => ({ width: 1600, height: 900 }),
  }) as unknown as FakeElement;
  equal(imageElement.tagName, "IMG");
  equal(imageElement.src, "/diagram.svg");
  equal(imageElement.alt, "diagram alt");
  equal(imageElement.title, "caption");
  equal(imageElement.attributes.get("width"), "1600");
  equal(imageElement.attributes.get("height"), "900");
  equal(imageElement.style["aspectRatio"], String(16 / 9));
  equal(imageElement.dataset["jotImageAspectRatio"], String(16 / 9));

  translator.mount(renderNode("block-quote", { type: "deferred" }), {
    document: document as unknown as Document,
    mode: "preview",
    sourceForRange: () => "",
    onDeferred: (node) => { deferred = node; },
  });
  equal(deferred?.kind, "block-quote");

  const numberedItem = renderNode("list-item", {
    type: "structured",
    children: [],
  }, [{
    name: "number",
    value: { type: "number", value: 7 },
  }, {
    name: "delimiter",
    value: { type: "string", value: ")" },
  }, {
    name: "indentColumns",
    value: { type: "number", value: 4 },
  }]);
  const item = translator.mount(numberedItem, {
    document: document as unknown as Document,
    mode: "preview",
    sourceForRange: () => "7) ",
    onDeferred: () => {},
  }) as unknown as FakeElement;
  equal(item.tagName, "DIV");
  equal(item.attributes.get("role"), "listitem");
  equal(item.attributes.get("value"), "7");
  equal(item.dataset["delimiter"], ")");
  equal(item.dataset["markerText"], "7)");
  equal(item.dataset["jotListIndent"], "4");
  equal(item.dataset["jotListLevel"], "2");
  equal(item.style["marginInlineStart"]?.startsWith("min(4ch,"), true);
  equal(item.style["marginInlineStart"]?.includes("--jot-list-min-content"), true);
  equal(item.style["width"]?.startsWith("calc(100% - min(4ch,"), true);
  equal(item.textContent, "");

  const blank = translator.mount(renderNode("blank-line", { type: "source" }), {
    document: document as unknown as Document,
    mode: "preview",
    sourceForRange: () => "",
    onDeferred: () => {},
  }) as unknown as FakeElement;
  equal(blank.tagName, "DIV");
  equal(blank.attributes.get("role"), "presentation");
}

function sparse_projection_store_reports_unloaded_nested_windows(): void {
  const store = new ProjectionStore();
  equal(
    JSON.stringify(store.missingRanges("large-list", "syntax-children", 500, 540)),
    JSON.stringify([{ from: 500, toExclusive: 540 }]),
  );
  store.apply({
    documentId: DOCUMENT,
    documentRevision: 0 as Revision,
    viewRevision: 0,
    operations: [{
      type: "replace-children",
      parentId: "large-list",
      axis: "syntax-children",
      from: 510,
      removeCount: 10,
      totalChildren: 10_000,
      inserted: Array.from({ length: 10 }, (_, index) =>
        renderNodeAt(`item-${510 + index}`, 510 + index)),
    }],
  });
  equal(
    JSON.stringify(store.missingRanges("large-list", "syntax-children", 500, 530)),
    JSON.stringify([
      { from: 500, toExclusive: 510 },
      { from: 520, toExclusive: 530 },
    ]),
  );
  const snapshot = store.snapshot();
  equal(snapshot.length, 1);
  equal(snapshot[0]?.parentId, "large-list");
  equal(snapshot[0]?.totalChildren, 10_000);
  equal(snapshot[0]?.loaded.length, 10);
  equal(snapshot[0]?.loaded[0]?.index, 510);
}

function measured_rows_preserve_the_logical_scroll_anchor(): void {
  equal(scrollAnchorAdjustment(100, 20, 32, 58), 26);
  equal(scrollAnchorAdjustment(100, 100, 32, 58), 0);
  equal(scrollAnchorAdjustment(100, 140, 32, 58), 0);
  equal(scrollAnchorAdjustment(100, 20, 58, 32), -26);
}

function projection_store_resets_nested_windows_for_broad_replacements(): void {
  const store = new ProjectionStore();
  store.apply({
    documentId: DOCUMENT,
    documentRevision: 0 as Revision,
    viewRevision: 0,
    operations: [{
      type: "replace-children",
      parentId: "table",
      axis: "syntax-children",
      from: 0,
      removeCount: 0,
      totalChildren: 2_000,
      inserted: [renderNodeAt("row-0", 0)],
    }],
  });
  store.advanceRevision(
    1 as Revision,
    [{ range: range(0, 1_000), insert: "replacement" }],
    undefined,
    { reset: true },
  );
  equal(store.snapshot().length, 0);
}

function render_keys_include_kind_when_engine_ids_are_reused(): void {
  const paragraph = renderNode("paragraph", { type: "deferred" });
  const table = { ...paragraph, kind: "table" };
  assert(renderNodeKey(paragraph) !== renderNodeKey(table));
  equal(
    renderNodeKey(paragraph),
    renderNodeKey({ ...paragraph, contentVersion: paragraph.contentVersion + 1 }),
  );
  const h1 = renderNode("heading", { type: "deferred" }, [{
    name: "level",
    value: { type: "number", value: 1 },
  }]);
  const h2 = {
    ...h1,
    attributes: [{
      name: "level",
      value: { type: "number" as const, value: 2 },
    }],
  };
  assert(renderNodeKey(h1) !== renderNodeKey(h2));
}

function projection_store_carries_unaffected_nested_windows_across_revisions(): void {
  const store = new ProjectionStore();
  const quote = {
    ...renderNodeAt("quote", 6),
    kind: "block-quote",
    sourceRange: range(6, 50),
    childCount: 3,
  };
  store.apply({
    documentId: DOCUMENT,
    documentRevision: 0 as Revision,
    viewRevision: 0,
    operations: [{
      type: "replace-children",
      parentId: "0",
      axis: "syntax-children",
      from: 0,
      removeCount: 3,
      totalChildren: 3,
      inserted: [
        { ...renderNodeAt("before", 0), sourceRange: range(0, 5) },
        quote,
        { ...renderNodeAt("after", 51), sourceRange: range(51, 56) },
      ],
    }, {
      type: "replace-children",
      parentId: "quote",
      axis: "syntax-children",
      from: 0,
      removeCount: 3,
      totalChildren: 3,
      inserted: [
        { ...renderNodeAt("item-0", 6), sourceRange: range(6, 15) },
        { ...renderNodeAt("item-1", 16), sourceRange: range(16, 30) },
        { ...renderNodeAt("item-2", 31), sourceRange: range(31, 50) },
      ],
    }],
  });
  store.advanceRevision(
    1 as Revision,
    [{ range: range(20, 24), insert: "EDIT" }],
    {
      reparsedRange: range(16, 30),
      totalBlocks: 3,
      changedBlocks: 1,
      blockChanges: [{
        fromBlock: 1,
        removeCount: 1,
        inserted: [{
          id: "quote",
          kind: "block-quote",
          sourceRange: range(6, 50),
          contentVersion: 1,
        }],
      }],
      projectionChanges: [{
        parentId: "quote",
        axis: "syntax-children",
        from: 1,
        removeCount: 1,
        insertCount: 1,
        totalChildren: 3,
      }],
    },
  );
  equal(store.nodeAt("0", "syntax-children", 0)?.id, "before");
  equal(store.nodeAt("0", "syntax-children", 1), undefined);
  equal(store.nodeAt("0", "syntax-children", 2)?.id, "after");
  equal(store.nodeAt("quote", "syntax-children", 0)?.id, "item-0");
  equal(store.nodeAt("quote", "syntax-children", 1), undefined);
  equal(store.nodeAt("quote", "syntax-children", 2)?.id, "item-2");

  store.apply({
    documentId: DOCUMENT,
    documentRevision: 1 as Revision,
    viewRevision: 1,
    operations: [{
      type: "replace-children",
      parentId: "another",
      axis: "syntax-children",
      from: 0,
      removeCount: 1,
      totalChildren: 1,
      inserted: [renderNodeAt("another-child", 100)],
    }],
  });
  equal(store.nodeAt("quote", "syntax-children", 0)?.id, "item-0");
}

function source_line_splices_keep_the_unaffected_suffix(): void {
  const store = new ProjectionStore();
  const code = {
    ...renderNodeAt("code", 0),
    kind: "fenced-code",
    sourceRange: range(0, 40),
    childCount: 0,
  };
  store.apply({
    documentId: DOCUMENT,
    documentRevision: 0 as Revision,
    viewRevision: 0,
    operations: [{
      type: "replace-children",
      parentId: "0",
      axis: "syntax-children",
      from: 0,
      removeCount: 1,
      totalChildren: 1,
      inserted: [code],
    }, {
      type: "replace-children",
      parentId: "code",
      axis: "source-lines",
      from: 0,
      removeCount: 3,
      totalChildren: 3,
      inserted: [
        { ...renderNodeAt("line-0", 10), kind: "source-line", sourceRange: range(10, 16) },
        { ...renderNodeAt("line-1", 16), kind: "source-line", sourceRange: range(16, 23) },
        { ...renderNodeAt("line-2", 23), kind: "source-line", sourceRange: range(23, 29) },
      ],
    }],
  });
  store.advanceRevision(
    1 as Revision,
    [{ range: range(15, 16), insert: " " }],
    {
      reparsedRange: range(15, 16),
      totalBlocks: 1,
      changedBlocks: 1,
      blockChanges: [{
        fromBlock: 0,
        removeCount: 1,
        inserted: [{
          id: "code",
          kind: "fenced-code",
          sourceRange: range(0, 39),
          contentVersion: 1,
        }],
      }],
      projectionChanges: [{
        parentId: "code",
        axis: "source-lines",
        from: 0,
        removeCount: 2,
        insertCount: 1,
        totalChildren: 2,
      }],
    },
  );
  equal(store.nodeAt("code", "source-lines", 0), undefined);
  equal(store.nodeAt("code", "source-lines", 1)?.id, "line-2");
  equal(store.nodeAt("code", "source-lines", 1)?.sourceRange.from, 23 as Utf16Offset);
}

function broad_replacements_reset_stale_virtual_measurements(): void {
  equal(replacesMostDocument([{ range: range(0, 900), insert: "new" }], 103), true);
  equal(replacesMostDocument([{ range: range(500, 501), insert: "x" }], 1_000), false);
}

function viewport_anchor_maps_through_exact_transaction_edits(): void {
  const edits = [
    { range: range(2, 4), insert: "abcdef" },
    { range: range(10, 12), insert: "" },
  ];
  equal(mapOffsetThroughEdits(1, edits), 1);
  equal(mapOffsetThroughEdits(3, edits), 2);
  equal(mapOffsetThroughEdits(8, edits), 12);
  equal(mapOffsetThroughEdits(11, edits), 14);
  equal(mapOffsetThroughEdits(20, edits), 22);
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
}

class FakeElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly style = {
    removeProperty: (name: string) => {
      delete this.style[name];
    },
  } as Record<string, string> & { removeProperty: (name: string) => void };
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly classList = {
    add: (...names: string[]) => {
      this.className = [this.className, ...names].filter(Boolean).join(" ");
    },
  };
  className = "";
  textContent = "";
  innerHTMLWrites = 0;
  src = "";
  alt = "";
  href = "";
  rel = "";
  title = "";

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }

  setAttribute(name: string, value: string): void {
    if (name === "src") this.src = value;
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(): void {}
}

function renderNodeAt(id: string, from: number): RenderNode {
  return {
    ...renderNode("list-item", { type: "deferred" }),
    id,
    sourceRange: {
      from: from as Utf16Offset,
      to: (from + 1) as Utf16Offset,
    },
  };
}

function cached_ranges_keep_boundary_association(): void {
  const store = new ProjectionStore();
  const kept: RenderNode = { ...renderNodeAt("kept", 6),
    attributes: [{ name: "related", value: { type: "range", value: range(5, 9) } }],
    content: { type: "structured", children: [renderNodeAt("child", 6)] } };
  store.apply({ documentId: DOCUMENT, documentRevision: 0 as Revision, viewRevision: 0,
    operations: [{ type: "replace-children", parentId: "0", axis: "syntax-children", from: 0,
      removeCount: 0, totalChildren: 3, inserted: [renderNodeAt("touched", 4), kept, renderNodeAt("suffix", 10)] }] });
  const edits = [
    { range: range(1, 3), insert: "😀" },
    { range: range(5, 5), insert: "a" }, { range: range(5, 5), insert: "b" },
    { range: range(5, 6), insert: "long" }, { range: range(7, 10), insert: "" },
  ];
  const slices = store.slicesTouchingEdits(edits);
  equal(slices.length, 1);
  equal(JSON.stringify(slices[0]?.window), JSON.stringify({ type: "index", from: 0, toExclusive: 1 }));
  store.advanceRevision(1 as Revision, edits);
  equal(store.nodeAt("0", "syntax-children", 0), undefined);
  const mapped = store.nodeAt("0", "syntax-children", 1);
  equal(JSON.stringify(mapped?.sourceRange), JSON.stringify(range(11, 12)));
  equal(JSON.stringify(mapped?.attributes[0]?.value), JSON.stringify({ type: "range", value: range(11, 12) }));
  assert(mapped?.content.type === "structured");
  equal(JSON.stringify(mapped.content.children[0]?.sourceRange), JSON.stringify(range(11, 12)));
  equal(store.nodeAt("0", "syntax-children", 2)?.sourceRange.from, 12 as Utf16Offset);
}

function cached_nodes_use_indexed_batch_offsets(): void {
  const store = new ProjectionStore();
  const count = 256;
  let rangeReads = 0;
  const edits = Array.from({ length: count }, (_, i) => {
    const position = range(i * 8, i * 8 + 1);
    return { get range() { rangeReads++; return position; }, insert: "😀" };
  });
  const nodes = edits.map((_, i) => renderNodeAt(String(i), i * 8 + 2));
  store.apply({ documentId: DOCUMENT, documentRevision: 0 as Revision, viewRevision: 0,
    operations: [{ type: "replace-children", parentId: "0", axis: "syntax-children",
      from: 0, removeCount: 0, totalChildren: count, inserted: nodes }] });
  store.advanceRevision(1 as Revision, edits);
  for (let i = 0; i < count; i++) {
    equal(store.nodeAt("0", "syntax-children", i)?.sourceRange.from, (i * 9 + 3) as Utf16Offset);
  }
  assert(rangeReads < count * 64, `cached nodes repeatedly scanned the edit batch (${rangeReads} range reads)`);
}

function shallow_projection_does_not_erase_confirmed_detail(): void {
  const store = new ProjectionStore();
  let version = 0;
  const apply = (node: RenderNode) => store.apply({ documentId: DOCUMENT,
    documentRevision: 0 as Revision, viewRevision: ++version, operations: [{
      type: "replace-children", parentId: "0", axis: "syntax-children", from: 0,
      removeCount: 1, totalChildren: 1, inserted: [node],
    }] });
  const child = renderNodeAt("child", 0);
  const detailed: RenderNode = { ...renderNodeAt("paragraph", 0), childCount: 1,
    content: { type: "structured", children: [child] } };
  apply(detailed);
  apply({ ...detailed, content: { type: "deferred" } });
  equal(store.nodeAt("0", "syntax-children", 0)?.content.type, "structured");
  apply({ ...detailed, contentVersion: detailed.contentVersion + 1, content: { type: "deferred" } });
  equal(store.nodeAt("0", "syntax-children", 0)?.content.type, "deferred");
  apply(detailed);
  apply({ ...detailed, mode: "source", content: { type: "deferred" } });
  equal(store.nodeAt("0", "syntax-children", 0)?.content.type, "deferred");
}
function assert(condition: boolean, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

const tests: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
  ["virtual axis scales to one hundred thousand rows", virtual_axis_handles_hundred_thousand_variable_rows],
  ["virtual axis splices preserve unaffected measurements", virtual_axis_splices_preserve_only_unaffected_measurements],
  ["text edits report physical line splices", text_edits_report_physical_line_splices],
  ["translator emits safe semantic DOM", translator_is_semantic_and_never_accepts_unsafe_urls],
  ["sparse nested projections request only missing windows", sparse_projection_store_reports_unloaded_nested_windows],
  ["measured rows preserve the logical scroll anchor", measured_rows_preserve_the_logical_scroll_anchor],
  ["broad replacements clear stale nested projection windows", projection_store_resets_nested_windows_for_broad_replacements],
  ["render keys distinguish reused ids with a new kind", render_keys_include_kind_when_engine_ids_are_reused],
  ["projection cache survives revisions with scoped holes", projection_store_carries_unaffected_nested_windows_across_revisions],
  ["source-line splices preserve the unchanged suffix", source_line_splices_keep_the_unaffected_suffix],
  ["broad replacements reset stale virtual measurements", broad_replacements_reset_stale_virtual_measurements],
  ["viewport anchors map through exact transaction edits", viewport_anchor_maps_through_exact_transaction_edits],
  ["cached ranges keep their boundary association", cached_ranges_keep_boundary_association],
  ["cached nodes use indexed batch offsets", cached_nodes_use_indexed_batch_offsets],
  ["shallow projection preserves confirmed detail", shallow_projection_does_not_erase_confirmed_detail],
];

for (const [name, test] of tests) {
  await test();
  console.log(`ok - ${name}`);
}
