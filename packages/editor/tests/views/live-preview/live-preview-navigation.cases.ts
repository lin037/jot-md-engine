import type { RenderNode, TextRange } from "../../../../editor-protocol/src/index.js";
import { LivePreviewEditPolicy } from "../../../src/hosts/live-preview/edit-policy.js";
import { planLivePreview } from "../../../src/hosts/live-preview/planner.js";
import { SyntaxBlockIndex } from "../../../src/adapter/block-index.js";
import { confirmedPrefixMarkerRisks, optimisticMarkerRisk, resolveOptimisticEmptyMarkerKind } from "../../../src/hosts/shared/markdown-markers.js";
import {
  planEmptyClosedContainerSeparator,
  resolveEmptyClosedContainer,
} from "../../../src/hosts/live-preview/empty-block-input.js";
import { resolveSourceRootAt } from "../../../src/hosts/live-preview/presentation.js";
import {
  resolveLivePreviewBlockExit,
  resolveLivePreviewCaret,
  resolveLivePreviewOpeningNavigation,
  resolveLivePreviewOpeningRange,
} from "../../../src/hosts/live-preview/vertical-navigation.js";

export function livePreviewNavigationRegression(): void {
  optimistic_empty_container_respects_marker_and_prefix_boundaries();
  const paragraphs = [node("paragraph", 0, 5), node("paragraph", 6, 12)];
  equal(resolveSourceRootAt("first\nsecond", paragraphs, 5), paragraphs[0], "EOL belongs to the paragraph ending before its LF");
  const shared = [node("paragraph", 0, 5), node("paragraph", 5, 12)];
  equal(resolveSourceRootAt("first\nsecond", shared, 5), shared[1], "right root wins an exact shared seam");
  equal(resolveSourceRootAt("first\nsecond", paragraphs, 12), paragraphs[1], "EOF belongs to final visible text");
  const blank = node("blank-line", 6, 6);
  const terminated = node("paragraph", 0, 6);
  equal(resolveSourceRootAt("first\n\n", [terminated, blank], 6), blank, "zero-width blank row owns its physical position");
  equal(resolveSourceRootAt("first\n", [terminated], 6), undefined, "consumed LF never owns following empty EOF row");
  const eolPlan = planLivePreview({ source: "first\nsecond", nodes: paragraphs, selections: [{ from: 5, to: 5 }] });
  equal(eolPlan.activeBlocks, 1, "presentation uses the same EOL ownership as exit commands");
  equal(eolPlan.decorations.some((item) => item.type === "line" && item.nodeId === paragraphs[0]!.id && item.className.includes("jot-live-preview-active-line")), true, "EOL activates the left paragraph's painted line");
  exit("first\n\nsecond", { from: 0, to: 5 }, "after", 6, "", 6);
  for (const prefix of ["> ", "- ", "> > ", "  - "]) {
    const policy = new LivePreviewEditPolicy();
    policy.update(`before\n${prefix}\nafter`, []);
    policy.setHiddenSyntax([{ from: 7, to: 7 + prefix.length }]);
    equal(policy.isEmptyPrefixLine(7 + prefix.length), true, "empty visible prefix offers a shared exit");
    policy.update(`before\n${prefix}text\nafter`, []);
    equal(policy.isEmptyPrefixLine(7 + prefix.length), false, "nonempty content still continues normally");
  }
  // Both structural components use the same contract, including adjacent
  // BlankLines, EOF, pointer placement and backward/forward entry and exit.
  for (const [kind, opening, closing] of [
    ["fenced-code", "``` js begin", "``` end"],
    ["math-block", "$$", "$$"],
  ] as const) {
    const source = `before\n\n${opening}\nalpha\nbeta\n${closing}\n\nafter`;
    const from = source.indexOf(opening);
    const contentFrom = from + opening.length + 1;
    const contentTo = source.indexOf(closing, contentFrom) - 1;
    const to = contentTo + 1 + closing.length;
    const component = closedNode(kind, from, to, contentFrom, contentTo);
    const policy = new LivePreviewEditPolicy();
    policy.update(source, [component]);
    equal(policy.resolveCaret(from), undefined, `${kind}: visible opening is a caret destination`);
    equal(policy.resolveCaret(to - 1), contentTo, `${kind}: pointer closing`);
    equal(policy.resolveCaret(to), contentTo, `${kind}: pointer at closing-row EOL uses the same root ownership`);
    equal(policy.resolveCaret(to, { direction: "backward" }), contentTo, `${kind}: backward from closing EOL enters content`);
    equal(policy.resolveCaret(to, { direction: "forward" }), to + 1, `${kind}: forward from closing EOL preserves following blank row`);
    equal(policy.resolveCaret(contentFrom), undefined, `${kind}: content start remains editable`);
    equal(policy.resolveCaret(contentTo), undefined, `${kind}: content end remains editable`);
    equal(policy.resolveCaret(from, { direction: "backward" }), undefined, `${kind}: opener remains editable`);
    equal(policy.resolveCaret(from, { direction: "forward" }), undefined, `${kind}: opener remains navigable`);
    equal(policy.resolveCaret(to - 1, { direction: "backward" }), contentTo, `${kind}: enter last row`);
    equal(policy.resolveCaret(to - 1, { direction: "forward" }), to + 1, `${kind}: keep following blank line`);
    equal(policy.resolveCaret(to + 1), undefined, `${kind}: next root owns its start`);
    equal(policy.resolveCaret(from, { direction: "backward", lineBoundary: true }), undefined, `${kind}: Home stays in opening`);
    equal(policy.allows([{ from: contentFrom, to: contentFrom, insert: "x" }]), true, "content input");
    equal(policy.allows([{ from, to: from + 1, insert: "x" }]), true, "opening syntax can be edited");
    equal(policy.allows([{ from: contentFrom - 1, to: contentFrom, insert: "" }]), false, "opening/content line break protected");
    equal(policy.allows([{ from: contentTo + 1, to: contentTo + 2, insert: "" }]), false, "closing syntax protected");

    const up = resolveLivePreviewOpeningNavigation(source, [component], contentFrom + 2, from - 1, "up");
    equal(up?.anchor, from + opening.length, `${kind}: up from first content row enters opener`);
    equal(up?.range.from, from, `${kind}: reveal belongs to the confirmed root`);
    equal(resolveLivePreviewOpeningNavigation(source, [component], contentFrom + 2, contentFrom + 1, "up"), undefined, `${kind}: up inside wrapped physical row remains native`);
    equal(resolveLivePreviewOpeningNavigation(source, [component], source.indexOf("beta") + 1, contentFrom, "up"), undefined, `${kind}: subsequent content rows remain native`);
    equal(resolveLivePreviewOpeningNavigation(source, [component], from - 1, from, "down")?.anchor, contentFrom, `${kind}: down from preceding blank row enters content`);
    equal(resolveLivePreviewOpeningNavigation(source, [component], 3, from, "down"), undefined, `${kind}: an intervening blank line is not skipped`);
    equal(resolveLivePreviewOpeningRange([component], from + opening.length)?.from, from, `${kind}: opener EOL is an editable caret`);
    equal(resolveLivePreviewOpeningRange([component], contentFrom), undefined, `${kind}: body is not the opening range`);
    const openedPlan = planLivePreview({ source, nodes: [component], selections: [{ from: from + 2, to: from + 2 }] });
    equal(openedPlan.decorations.some(item => item.type === "replace" && item.from === from && item.to === from + opening.length), false,
      `${kind}: opening source is actually revealed when the caret is on it`);
    equal(openedPlan.decorations.some(item => item.type === "line" && item.from === from &&
      (item.className.includes("jot-live-preview-code-boundary") || item.className.includes("jot-live-preview-structural-line"))), false,
      `${kind}: editable opening line is not collapsed by a boundary style`);
    equal(openedPlan.decorations.some(item => item.type === "replace" && item.from === contentTo + 1 && item.to === to), true,
      `${kind}: closing syntax remains hidden while the opener is edited`);
    const bodyPlan = planLivePreview({ source, nodes: [component], selections: [{ from: contentFrom, to: contentFrom }] });
    equal(bodyPlan.decorations.some(item => item.type === "replace" && item.from === from && item.to === from + opening.length), true,
      `${kind}: opening syntax hides again after the caret leaves`);
    policy.clear();
    equal(policy.resolveCaret(from), undefined, "stale semantic ranges are discarded");

    const eof = source.slice(from, to);
    policy.update(eof, [closedNode(kind, 0, eof.length, contentFrom - from, contentTo - from)]);
    equal(policy.resolveCaret(0, { direction: "backward" }), undefined, "document start exposes its editable opening");
    equal(policy.resolveCaret(eof.length, { direction: "forward" }), contentTo - from, "document end clamps to content");
    policy.update(eof + "\n", [closedNode(kind, 0, eof.length + 1, contentFrom - from, contentTo - from)]);
    equal(policy.resolveCaret(eof.length + 1), undefined, "empty EOF line remains outside the terminated root");
  }

  for (const [kind, opening, closing] of [
    ["fenced-code", "```", "```"],
    ["math-block", "$$", "$$"],
  ] as const) {
    const source = `${opening}\n\n${closing}`;
    const body = opening.length + 1;
    const component = closedNode(kind, 0, source.length, body, body);
    const policy = new LivePreviewEditPolicy();
    policy.update(source, [component]);
    equal(policy.allows([{ from: 0, to: opening.length, insert: opening }]), true, `${kind}: opening replacement is legal even with empty content`);
    equal(policy.allows([{ from: opening.length, to: body, insert: "" }]), false, `${kind}: joining LF stays protected when content is empty`);
    equal(policy.allows([{ from: body + 1, to: source.length, insert: "" }]), false, `${kind}: closing remains protected when content is empty`);
    equal(resolveLivePreviewOpeningNavigation(source, [component], body, body, "up")?.anchor, opening.length,
      `${kind}: up from empty content enters opener at document start`);

    // Here the empty body already has a real physical blank row; do not add
    // another separator when the user types into it.
    equal(resolveEmptyClosedContainer([component], body), undefined, `${kind}: existing empty row is not a missing body row`);
    const adjacentSource = `${opening}\n${closing}`;
    const adjacent = { ...closedNode(kind, 0, adjacentSource.length, body, body), attributes: [
      { name: "closed", value: { type: "boolean" as const, value: true } },
      { name: "openingRange", value: { type: "range" as const, value: range(0, opening.length) } },
      { name: "contentRange", value: { type: "range" as const, value: range(body, body) } },
      { name: "closingRange", value: { type: "range" as const, value: range(body, adjacentSource.length) } },
    ] };
    const missing = resolveEmptyClosedContainer([adjacent], body);
    equal(missing?.position, body, `${kind}: adjacent closer has a zero-width body`);
    equal(missing?.nodeId, adjacent.id, `${kind}: presentation proof identifies the actual confirmed node`);
    equal(missing?.kind, kind, `${kind}: presentation proof keeps the node type`);
    equal(resolveEmptyClosedContainer([adjacent], body - 1), undefined, `${kind}: a different caret cannot claim the empty body`);
    if (missing === undefined) throw new Error(`${kind}: expected a confirmed empty closed container`);
    equal(planEmptyClosedContainerSeparator(missing, 0), undefined, `${kind}: empty input creates no separator`);
    const text = "中🙂\n";
    const separator = planEmptyClosedContainerSeparator(missing, text.length);
    equal(separator?.from, body + text.length, `${kind}: separator uses the exact UTF-16 input length`);
    equal(separator?.insert, "\n", `${kind}: the closer remains on its own physical line`);
    const afterInput = adjacentSource.slice(0, body) + text + adjacentSource.slice(body);
    const after = afterInput.slice(0, separator!.from) + separator!.insert + afterInput.slice(separator!.to);
    equal(after, `${opening}\n中🙂\n\n${closing}`, `${kind}: first multiline input preserves the complete closer`);
  }

  // A hypothetical extension declares ranges rather than requiring another
  // kind branch in the controller. Real blank rows between regions stay owned
  // by that component, and pointer placement chooses the nearer region.
  const source = "open\nalpha\nhidden\nbeta\nclose\nnext";
  const surfaces = [{ sourceRange: { from: 0, to: 29 }, navigationRanges: [
    { from: 5, to: 10 }, { from: 18, to: 22 },
  ] }];
  equal(resolveLivePreviewCaret(source, 13, surfaces, [], { direction: "backward" }), 10, "extension backward gap");
  equal(resolveLivePreviewCaret(source, 13, surfaces, [], { direction: "forward" }), 18, "extension forward gap");
  equal(resolveLivePreviewCaret(source, 16, surfaces, []), 18, "extension nearest region");

  // Quote and list use the actual planner's hidden decorations, with no
  // duplicate marker detection in the interaction layer.
  for (const [kind, prefix, projected] of [
    ["block-quote", "> ", false],
    ["block-quote", "> ", true],
    ["list-item", "- ", false],
  ] as const) {
    const source = `before\n\n${prefix}item\n\nafter`;
    const from = 8;
    const child = node("text", from + prefix.length, from + prefix.length + 4);
    const block = { ...node(kind, from, from + prefix.length + 4), content: { type: "structured" as const, children: [child] } };
    const quoteLines: RenderNode[] = projected ? [{
      ...node("quote-line", from, Number(block.sourceRange.to)),
      attributes: [
        { name: "quoteDepth", value: { type: "number", value: 1 } },
        { name: "quoteOpen", value: { type: "number", value: 1 } },
        { name: "quoteClose", value: { type: "number", value: 1 } },
        { name: "markerRange", value: { type: "range", value: range(from, from + prefix.length) } },
      ],
    }] : [];
    for (const active of [false, true]) {
      const plan = planLivePreview({ source, nodes: [block], quoteLines, selections: active
        ? [{ from: from + prefix.length, to: from + prefix.length }] : [] });
      const hidden = plan.decorations.flatMap((item) => item.type === "replace" && item.widget === undefined
        ? [{ from: item.from, to: item.to }] : []);
      const policy = new LivePreviewEditPolicy();
      policy.update(source, [block]);
      policy.setHiddenSyntax(hidden);
      equal(policy.resolveCaret(from), from + prefix.length, `${kind}: pointer prefix`);
      equal(policy.resolveCaret(from, { direction: "backward", lineBoundary: true }), from + prefix.length, `${kind}: Home`);
      equal(policy.resolveCaret(from + 1, { direction: "backward" }), from - 1, `${kind}: previous physical line`);
      equal(policy.resolveCaret(from, { direction: "backward", vertical: true }), from + prefix.length, `${kind}: Up stays on the chosen row`);
      equal(policy.resolveCaret(from + 1, { direction: "backward", vertical: true }), from + prefix.length, `${kind}: Up clamps inside the hidden prefix`);
      equal(policy.resolveCaret(from, { direction: "forward" }), from + prefix.length, `${kind}: next physical line`);
      equal(policy.resolveCaret(from + prefix.length), undefined, `${kind}: visible boundary`);
    }
  }

  // Exit commands share root-boundary behavior for every component. Reuse
  // neighboring empty rows, otherwise make exactly one editable physical row.
  exit("before\n\nbody\n\nafter", { from: 8, to: 13 }, "before", 7, "", 7);
  exit("before\n\nbody\n\nafter", { from: 8, to: 13 }, "after", 13, "", 13);
  exit("before\nbody\nafter", { from: 7, to: 12 }, "before", 7, "\n", 7);
  exit("before\nbody\nafter", { from: 7, to: 12 }, "after", 12, "\n", 12);
  exit("body", { from: 0, to: 4 }, "before", 0, "\n", 0);
  exit("body", { from: 0, to: 4 }, "after", 4, "\n", 5);
  exit("body\n", { from: 0, to: 5 }, "after", 5, "", 5);
}

function optimistic_empty_container_respects_marker_and_prefix_boundaries(): void {
  const valid = [
    ["```", "```", "code-bare"],
    ["``` ts", "```", "code-bare"],
    ["  ``` 是🙂", " ```  ", "code-bare"],
    ["``` begin", "``` end", "code-end"],
    ["``` rust begin", "``` end", "code-end"],
    ["``` rust begin", "``` other end", "code-end"],
    [" $$", "$$ \t", "math-dollar"],
    ["\\[", " \\]", "math-bracket"],
  ] as const;
  for (const [opening, closing, expected] of valid) {
    equal(resolveOptimisticEmptyMarkerKind(opening, closing), expected, `${opening} / ${closing}: candidate marker kind`);
  }
  for (const [opening, closing] of [
    ["```rust", "```"], ["```begin", "``` end"], ["```\tts", "```"],
    ["```` ts", "```"], ["    ```", "```"], ["``` ts", "``` end"],
    ["``` begin", "```"], ["``` end", "``` end"], ["``` rust end", "``` end"],
    ["$$", "\\]"], ["\\[", "$$"], ["$$ text", "$$"],
  ]) equal(resolveOptimisticEmptyMarkerKind(opening!, closing!), undefined, `${opening} / ${closing}: invalid or mismatched candidate`);
  equal(resolveOptimisticEmptyMarkerKind("```mermaid", "```", true), "code-bare", "opt-in compatibility recognizes a single unspaced language");
  equal(resolveOptimisticEmptyMarkerKind("```begin", "``` end", true), undefined, "explicit markers still require a space");
  equal(resolveOptimisticEmptyMarkerKind("```rust begin", "``` end", true), undefined, "unspaced metadata is not an explicit opener");
  equal(resolveOptimisticEmptyMarkerKind(`\`\`\` ${"x".repeat(513)}`, "```"), undefined, "unusually long candidates decline the optimistic path");

  const scenarios = [
    ["plain words", 0],
    ["inline ``` and $$ remain prose", 0],
    ["```rust", 0],
    ["``` end", 0],
    ["```", optimisticMarkerRisk["code-bare"]],
    ["``` ts", optimisticMarkerRisk["code-bare"]],
    ["``` 中文🙂 begin", optimisticMarkerRisk["code-end"]],
    ["$$", optimisticMarkerRisk["math-dollar"]],
    ["\\[", optimisticMarkerRisk["math-bracket"]],
  ] as const;
  for (const [prefix, expected] of scenarios) {
    const source = `${prefix}\n\ntail`, position = prefix.length + 1;
    const index = blockIndex([node("paragraph", 0, prefix.length), node("blank-line", position, position), node("paragraph", position + 1, source.length)]);
    equal(confirmedPrefixMarkerRisks(source, index, position, 3), expected, `confirmed prefix ${prefix}`);
    equal(confirmedPrefixMarkerRisks(source, index, position, 4), undefined, "missing metadata cannot prove a safe prefix");
  }
  const unspaced = "```mermaid\n\ntail", unspacedPosition = "```mermaid\n".length;
  const unspacedIndex = blockIndex([node("paragraph", 0, unspacedPosition - 1), node("blank-line", unspacedPosition, unspacedPosition), node("paragraph", unspacedPosition + 1, unspaced.length)]);
  equal(confirmedPrefixMarkerRisks(unspaced, unspacedIndex, unspacedPosition, 3, true), optimisticMarkerRisk["code-bare"], "opt-in prefix detects an unresolved unspaced opener");
  equal(confirmedPrefixMarkerRisks(unspaced, unspacedIndex, unspacedPosition, 3), 0, "strict profile keeps the same prefix literal");
  const mixed = "``` begin\n$$\n\\[", mixedSource = `${mixed}\n\ntail`, mixedPosition = mixed.length + 1;
  const mixedIndex = blockIndex([node("paragraph", 0, mixed.length), node("blank-line", mixedPosition, mixedPosition), node("paragraph", mixedPosition + 1, mixedSource.length)]);
  equal(confirmedPrefixMarkerRisks(mixedSource, mixedIndex, mixedPosition, 3),
    optimisticMarkerRisk["code-end"] | optimisticMarkerRisk["math-dollar"] | optimisticMarkerRisk["math-bracket"],
    "different unresolved opener types are tracked independently");
  const initialBlank = blockIndex([node("blank-line", 0, 0), node("blank-line", 1, 1)]);
  equal(confirmedPrefixMarkerRisks("\n", initialBlank, 0, 2), 0, "blank document start has no preceding marker");
  equal(confirmedPrefixMarkerRisks("", new SyntaxBlockIndex(), 0, 0), 0, "exactly empty document is safe even if the parser has no root");
  equal(confirmedPrefixMarkerRisks("text", new SyntaxBlockIndex(), 0, 0), undefined, "nonempty document cannot use the no-root exception");
  const body = "```\n$$\n\\[\n```";
  const source = `${body}\n\ntail`, position = body.length + 1;
  const closed = blockIndex([node("fenced-code", 0, body.length), node("blank-line", position, position), node("paragraph", position + 1, source.length)]);
  equal(confirmedPrefixMarkerRisks(source, closed, position, 3), 0, "confirmed code root shields all literal markers inside it");
  const listPrefix = "- item  ", listSource = `${listPrefix}\n\ntail`, listPosition = listPrefix.length + 1;
  const list = blockIndex([node("list-item", 0, listPrefix.length), node("blank-line", listPosition, listPosition), node("paragraph", listPosition + 1, listSource.length)]);
  equal(confirmedPrefixMarkerRisks(listSource, list, listPosition, 3), undefined, "explicit list continuation declines speculative ownership");
  const gapSource = "```\n\ntail", gapPosition = 4;
  const uncovered = blockIndex([node("paragraph", 0, 1), node("blank-line", gapPosition, gapPosition), node("paragraph", gapPosition + 1, gapSource.length)]);
  equal(confirmedPrefixMarkerRisks(gapSource, uncovered, gapPosition, 3), undefined, "standalone marker without a covering root cannot prove ownership");
  closed.applyTextEdits([{ range: range(position, position), insert: "x" }]);
  equal(confirmedPrefixMarkerRisks(source, closed, position, 3), undefined, "dirty root metadata cannot prove a safe prefix");
  const dense = Array.from({ length: 4_097 }, () => "inline ``` text").join("\n");
  const denseSource = `${dense}\n\ntail`, densePosition = dense.length + 1;
  const denseIndex = blockIndex([node("paragraph", 0, dense.length), node("blank-line", densePosition, densePosition), node("paragraph", densePosition + 1, denseSource.length)]);
  equal(confirmedPrefixMarkerRisks(denseSource, denseIndex, densePosition, 3), undefined, "bounded prefix proof declines oversized marker scans");
  for (const count of [256, 1_000]) {
    const lead = count === 1_000 ? "x".repeat(1_048_576) : "lead";
    const block = "```\n$$\n\\[\n```";
    const roots: RenderNode[] = [node("paragraph", 0, lead.length)];
    let cursor = lead.length + 1;
    for (let i = 0; i < count; i++) {
      roots.push(node("fenced-code", cursor, cursor + block.length));
      cursor += block.length + 1;
    }
    const body = [lead, ...Array<string>(count).fill(block), "", "tail"].join("\n");
    roots.push(node("blank-line", cursor, cursor), node("paragraph", cursor + 1, body.length));
    const index = blockIndex(roots);
    equal(confirmedPrefixMarkerRisks(body, index, cursor, roots.length), 0,
      `${count} confirmed closed blocks, including literal other markers, remain provably safe`);
  }
}

function blockIndex(nodes: RenderNode[]): SyntaxBlockIndex {
  const index = new SyntaxBlockIndex();
  index.seedProjection(0, nodes, nodes.length);
  return index;
}

function exit(source: string, range: { from: number; to: number }, direction: "before" | "after", from: number, insert: string, anchor: number): void {
  const target = resolveLivePreviewBlockExit(source, range, direction);
  equal(target.from, from, "exit edit offset");
  equal(target.insert, insert, "exit inserted text");
  equal(target.anchor, anchor, "exit resulting caret");
}

function closedNode(kind: string, from: number, to: number, contentFrom: number, contentTo: number): RenderNode {
  return { ...node(kind, from, to), attributes: [
    { name: "closed", value: { type: "boolean", value: true } },
    { name: "openingRange", value: { type: "range", value: range(from, contentFrom - 1) } },
    { name: "contentRange", value: { type: "range", value: range(contentFrom, contentTo) } },
    { name: "closingRange", value: { type: "range", value: range(contentTo + 1, to) } },
  ] };
}

function node(kind: string, from: number, to: number): RenderNode {
  return { id: `${kind}-${from}`, kind, sourceRange: range(from, to), contentVersion: 1,
    mode: "preview", childCount: 0, attributes: [], content: { type: "source" } };
}

function range(from: number, to: number): TextRange {
  return { from: from as TextRange["from"], to: to as TextRange["to"] };
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}
