import type { RenderNode, TextRange } from "@jot-md/editor-protocol";
import {
  numberAttribute,
  rangeAttribute,
  sanitizeUrl,
  stringAttribute,
} from "../../components/common/dom-renderer.js";
import { quotePrefix } from "../../components/common/quote-prefix.js";
import { listDisplayIndentColumns } from "../../layout/list-geometry.js";
import {
  defaultMarkdownComponentRegistry,
  type ComponentLivePreviewPlan,
} from "../../components/index.js";
import type {
  LivePreviewDecoration,
  LivePreviewGeometryGap,
  LivePreviewPlan,
  LivePreviewPlanInput,
  LivePreviewSelectionRange,
  LivePreviewWidgetDescriptor,
  LivePreviewWrapper,
} from "./types.js";
import { resolveSourceRootAt } from "./presentation.js";

const DEFAULT_MAX_DECORATIONS = 4_000;
const DEFAULT_MAX_GEOMETRY_DECORATIONS = 1_024;

/**
 * 把已确认的可见 RenderNode 转成与 CodeMirror 无关的纯装饰计划。
 * 缺失语义、激活块和超限内容有意保留源码。
 */
export function planLivePreview(input: LivePreviewPlanInput): LivePreviewPlan {
  const maximum = positiveInteger(input.maxDecorations, DEFAULT_MAX_DECORATIONS);
  const geometryMaximum = positiveInteger(
    input.maxGeometryDecorations,
    DEFAULT_MAX_GEOMETRY_DECORATIONS,
  );
  const decorations: LivePreviewDecoration[] = [];
  const wrappers: LivePreviewWrapper[] = [];
  const lines = new Map<number, {
    classes: Set<string>;
    nodeId: string;
    structuralOwners?: Set<string>;
    indentColumns: number;
    headingLevel?: number;
    listMarker?: string;
    codeLine?: number;
    codeOwner?: string;
    quoteDepth?: number;
    quoteOpen?: number;
    quoteClose?: number;
    quoteMarkerHidden?: boolean;
    quoteMarkerOnly?: boolean;
  }>();
  const quoteLines = new Map<number, RenderNode>();
  const quoteOwners = new Map<string, RenderNode>();
  for (const line of input.quoteLines ?? []) {
    quoteLines.set(physicalLineStart(input.source, Number(line.sourceRange.from)), line);
    if (line.content.type === "structured") for (const owner of line.content.children) quoteOwners.set(owner.id, owner);
  }
  const visitedIds = new Set<string>();
  let visitedNodes = 0;
  let activeBlocks = 0;
  let fallbackBlocks = 0;
  let visualDecorationCount = 0;
  let geometryDecorationCount = 0;
  let widgetCount = 0;
  let geometryWidgetCount = 0;
  let truncated = false;
  let geometryTruncated = false;

  const selectionTouches = (range: TextRange): boolean =>
    (input.selectionHighlights ?? []).some((selection) => rangesTouch(range, selection));
  // `activeSourceRange` is supplied by LivePreviewController in production.
  // Preserve the public planner's direct-call ergonomics for unit/component
  // tests: a single collapsed `selections` range has the same semantic
  // meaning, while non-collapsed / multiple ranges still never source-reveal
  // every intersecting root.
  const fallbackActiveRange = input.selections.length === 1 &&
    input.selections[0]?.from === input.selections[0]?.to
    ? input.selections[0]
    : undefined;
  const activeSourceRange = input.activeSourceRange ?? fallbackActiveRange;
  const activeSourceNode = activeSourceRange === undefined
    ? undefined
    : resolveSourceRootAt(input.source, input.nodes, activeSourceRange.from);
  const revealSyntax = input.revealSyntax === true;

  const add = (decoration: LivePreviewDecoration): boolean => {
    if (visualDecorationCount + lines.size >= maximum) {
      truncated = true;
      return false;
    }
    decorations.push(decoration);
    visualDecorationCount += 1;
    if (decoration.type === "replace" && decoration.widget !== undefined) {
      widgetCount += 1;
    }
    return true;
  };

  const addGeometry = (decoration: LivePreviewDecoration): boolean => {
    if (geometryDecorationCount >= geometryMaximum) {
      geometryTruncated = true;
      return false;
    }
    decorations.push(decoration);
    geometryDecorationCount += 1;
    if (decoration.type === "replace" && decoration.widget !== undefined) {
      geometryWidgetCount += 1;
    }
    return true;
  };

  const addLines = (node: RenderNode, ...classNames: readonly string[]): void => {
    if (truncated) return;
    const codeContent = node.kind === "fenced-code" ? rangeAttribute(node, "contentRange") : undefined;
    let codeLine = 1;
    let codeOffset = Number(codeContent?.from ?? 0);
    let codeLineInitialized = false;
    for (const from of lineStarts(input.source, node.sourceRange, input.visibleRange)) {
      if (!lines.has(from) && visualDecorationCount + lines.size >= maximum) {
        truncated = true;
        return;
      }
      const line = lines.get(from) ?? {
        classes: new Set<string>(),
        nodeId: node.id,
        indentColumns: 0,
      };
      if (line.nodeId !== node.id) {
        line.structuralOwners ??= new Set([line.nodeId]);
        line.structuralOwners.add(node.id);
      }
      classNames.forEach((className) => line.classes.add(className));
      line.classes.add(`jot-md-${node.kind}`);
      if (codeContent !== undefined && from >= physicalLineStart(input.source, Number(codeContent.from)) && from <= Number(codeContent.to) &&
          from < Number(rangeAttribute(node, "closingRange")?.from ?? node.sourceRange.to)) {
        // The viewport can start hundreds of thousands of lines into one
        // code block. Reuse the host's indexed line model to find the first
        // visible number, then scan only the remaining visible lines. The
        // direct planner API keeps its source-scan fallback when no index is
        // provided, preserving its existing standalone contract.
        if (!codeLineInitialized) {
          codeLineInitialized = true;
          if (input.countSourceLines !== undefined && from > codeOffset) {
            codeLine = input.countSourceLines(codeOffset, Math.min(input.source.length, from + 1));
            codeOffset = from;
          }
        }
        for (let newline = input.source.indexOf("\n", codeOffset);
          newline >= 0 && newline < from;
          newline = input.source.indexOf("\n", newline + 1)) {
          codeLine += 1;
        }
        codeOffset = from;
        line.codeLine = codeLine;
        line.codeOwner = node.id;
        line.classes.add("jot-code-line");
      }
      if (node.kind === "heading") {
        line.classes.add("jot-live-preview-source-heading");
        line.headingLevel = headingLevel(node);
      }
      if (node.kind === "blank-line") {
        line.classes.add("jot-live-preview-blank-line");
      }
      if (node.kind === "list-item") {
        line.indentColumns = Math.max(
          line.indentColumns,
          listDisplayIndentColumns(numberAttribute(node, "indentColumns") ?? 0),
        );
        const marker = from === physicalLineStart(input.source, Number(node.sourceRange.from)) ? listMarkerText(node) : undefined;
        if (marker !== undefined) line.listMarker = marker;
      }
      lines.set(from, line);
    }
  };

  const addLineAt = (
    node: RenderNode,
    from: number,
    ...classNames: readonly string[]
  ): void => {
    if (truncated || from < 0 || from > input.source.length) return;
    if (
      input.visibleRange !== undefined &&
      (from < input.visibleRange.from || from > input.visibleRange.to)
    ) return;
    if (!lines.has(from) && visualDecorationCount + lines.size >= maximum) {
      truncated = true;
      return;
    }
    const line = lines.get(from) ?? {
      classes: new Set<string>(),
      nodeId: node.id,
      indentColumns: 0,
    };
    classNames.forEach((className) => line.classes.add(className));
    lines.set(from, line);
  };

  /**
   * 普通文本块继续使用 CodeMirror 的真实物理行。只给最后一条物理行附加
   * block gap，使 source/preview 切换不会改变顶层块间距，同时不把整块文本
   * 变成一个对光标不透明的 replacement widget。
   */
  const addNativeBlockLines = (
    node: RenderNode,
    root: boolean,
    ...classNames: readonly string[]
  ): void => {
    const starts = lineStarts(input.source, node.sourceRange, input.visibleRange);
    addLines(
      node,
      "jot-live-preview-line",
      "jot-live-preview-native-block",
      `jot-live-preview-native-block--${node.kind}`,
      ...classNames,
    );
    const last = starts.at(-1);
    if (root && last !== undefined && last === lastPhysicalLineStart(input.source, node.sourceRange)) {
      lines.get(last)?.classes.add("jot-live-preview-native-block--last");
    }
    if (root && node.kind === "fenced-code") {
      const from = clamp(Number(node.sourceRange.from), 0, input.source.length);
      const to = clamp(Number(node.sourceRange.to), from, input.source.length);
      const content = rangeAttribute(node, "contentRange");
      const contentFrom = clamp(Number(content?.from ?? from), from, to);
      const contentTo = clamp(Number(content?.to ?? to), contentFrom, to);
      const count = input.countSourceLines?.(contentFrom, contentTo) ?? 1;
      const digits = Math.max(4, String(Math.max(1, count)).length);
      if (to > from) wrappers.push({
        type: "wrapper", from, to, nodeId: node.id,
        className: "jot-live-preview-code-scroll",
        attributes: { style: `--jot-code-number-width:${digits}ch` },
      });
    }
  };

  const addActiveSourceShell = (node: RenderNode): void => {
    if (node.kind === "blank-line") return;
    const from = clamp(Number(node.sourceRange.from), 0, input.source.length);
    // source BlockWrapper 只包 Rust 的语义 sourceRange，不能像 replacement
    // widget 那样吞掉终止 LF。BlockWrapper 的 `to` 是 exclusive，若扩展到 LF
    // 后的位置，它会把后继真实 `.cm-line`（尤其 BlankLine）也裹进 shell，
    // 导致 source 模式多出一行 padding/border，正是切换时高度跳动的来源。
    const to = clamp(Number(node.sourceRange.to), from, input.source.length);
    if (to <= from) return;
    const attributes: Record<string, string> = {};
    attributes["data-jot-source-from"] = String(from);
    attributes["data-jot-source-to"] = String(to);
    if (node.kind === "heading") {
      attributes["data-jot-heading-level"] = String(headingLevel(node));
    }
    const reservedHeight = input.estimateBlockHeight?.(node);
    if (
      reservedHeight !== undefined &&
      Number.isFinite(reservedHeight) &&
      reservedHeight > 0
    ) {
      const pixels = Math.ceil(reservedHeight * 100) / 100;
      attributes["style"] = `min-height:${pixels}px`;
      attributes["data-jot-live-reserved-height"] = String(pixels);
    }
    wrappers.push({
      type: "wrapper",
      from,
      to,
      nodeId: node.id,
      className: [
        "jot-live-preview-source-block-shell",
        `jot-live-preview-source-block-shell--${node.kind}`,
      ].join(" "),
      ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
    });
  };

  const replace = (
    node: RenderNode,
    range: TextRange,
    widget?: LivePreviewWidgetDescriptor,
    structural = false,
    quotePrefix = false,
  ): boolean => {
    const from = clamp(Number(range.from), 0, input.source.length);
    const to = clamp(Number(range.to), from, input.source.length);
    if (from === to || hasLineBreak(input.source, from, to)) return false;
    return add({
      type: "replace",
      from,
      to,
      nodeId: node.id,
      ...(widget === undefined ? {} : { widget }),
      ...(structural ? { structural: true } : {}),
      ...(quotePrefix ? { quotePrefix: true } : {}),
    });
  };

  const sourceCompanionIds = new Set<string>();
  const addSourceCompanionImages = (node: RenderNode): void => {
    let added = false;
    const visitImage = (candidate: RenderNode): void => {
      if (
        !added && candidate.kind === "image" && !sourceCompanionIds.has(candidate.id) && activeSourceRange !== undefined &&
        rangesTouch(candidate.sourceRange, activeSourceRange)
      ) {
        const position = clamp(
          Number(node.sourceRange.to),
          0,
          input.source.length,
        );
        if (
          input.visibleRange === undefined ||
          (input.visibleRange.from <= position && position <= input.visibleRange.to)
        ) {
          add({
            type: "replace",
            from: position,
            to: position,
            nodeId: candidate.id,
            widget: {
              kind: "image",
              node: candidate,
              block: false,
              sourceCompanion: true,
            },
          });
          sourceCompanionIds.add(candidate.id);
          added = true;
        }
      }
      if (!added && candidate.content.type === "structured") {
        candidate.content.children.forEach(visitImage);
      }
    };
    visitImage(node);
  };

  const replaceBlock = (node: RenderNode, widgetKind = node.kind): void => {
    const from = clamp(Number(node.sourceRange.from), 0, input.source.length);
    const rawTo = clamp(Number(node.sourceRange.to), from, input.source.length);
    if (node.kind === "blank-line") {
      // 空白行不是一个需要替换 DOM 的内容块，而是 CodeMirror 行轴上的
      // 一个真实物理槽位。这里仅给该行加样式，既保留源码中的空格/Tab 和
      // 行尾换行，也避免把一个 block DOM 放进 `.cm-line`，或与前一个
      // block replacement 在同一端点形成重叠。这样点击、上下方向键和
      // Preview 的空白高度都继续由同一条 CodeMirror 行轴决定。
      addLines(node, "jot-live-preview-blank-line");
      return;
    }
    // Block widget 必须消费当前物理源码行的结尾 LF。否则 CodeMirror 会为了
    // 留下的 newline 再创建一个空 `.cm-line`：当后面本来就有 BlankLine 时，
    // 页面会同时出现“残留行 shell + 真正空行”两条视觉空行，并在 widget
    // 切换时引起 viewport 跳动。
    //
    // 这里只消费 *一个* 终止 LF：若 sourceRange 已包含它则保留 rawTo；若
    // sourceRange 结束在 LF 前则扩展一个 UTF-16 单元。后面的 BlankLine
    // newline 仍属于它自己的物理 CodeMirror 行，不能一起吞掉。
    const to = blockReplacementEnd(input.source, from, rawTo);
    if (to <= from) {
      fallbackBlocks += 1;
      return;
    }
    const estimatedHeight = input.estimateBlockHeight?.(node);
    const accepted = add({
      type: "replace",
      from,
      to,
      nodeId: node.id,
      widget: {
        kind: widgetKind,
        node,
        block: true,
        ...(selectionTouches(node.sourceRange) ? { selected: true } : {}),
        ...(estimatedHeight === undefined ? {} : { estimatedHeight }),
      },
    });
    if (!accepted) fallbackBlocks += 1;
  };

  const hideOuterSyntax = (
    node: RenderNode,
    contentFrom: number,
    contentTo: number,
  ): void => {
    replace(node, textRange(Number(node.sourceRange.from), contentFrom), undefined, node.kind === "heading");
    replace(node, textRange(contentTo, Number(node.sourceRange.to)), undefined, node.kind === "heading");
  };

  const decorateTaskMarker = (node: RenderNode): void => {
    const from = Number(node.sourceRange.from), to = Number(node.sourceRange.to);
    if (input.selections.some((selection) => selection.from === selection.to
      ? from <= selection.from && selection.from < to
      : selection.from < to && from < selection.to)) return;
    // Preserve the confirmed marker while nearby composition text is still
    // unconfirmed; editing the marker itself invalidates it immediately.
    replace(node, node.sourceRange, { kind: "task-marker", node, block: false }, true);
  };

  const containsTaskMarker = (node: RenderNode): boolean => node.kind === "task-marker" ||
    (node.content.type === "structured" && node.content.children.some(containsTaskMarker));

  const hideClosedContainerSyntax = (
    node: RenderNode,
    collapseMarkerLines: boolean,
  ): void => {
    const opening = rangeAttribute(node, "openingRange");
    const closing = rangeAttribute(node, "closingRange");
    if (opening === undefined || closing === undefined) return;
    // The opening marker is an editable source line when the actual caret is
    // on it. Retain the closed container's content shell while exposing that
    // one line; the closing marker stays protected. This also preserves the
    // native IME surface during edits of a fence's language / attributes.
    const showOpening = activeSourceRange !== undefined &&
      activeSourceRange.from === activeSourceRange.to &&
      Number(opening.from) <= activeSourceRange.from && activeSourceRange.from <= Number(opening.to);
    const content = rangeAttribute(node, "contentRange");
    const showEmptyContent = content !== undefined && activeSourceRange !== undefined &&
      activeSourceRange.from === activeSourceRange.to &&
      Number(content.from) === Number(content.to) && Number(content.to) === Number(closing.from) &&
      activeSourceRange.from === Number(content.from);
    if (!showOpening) replace(node, opening, undefined, true);
    replace(node, closing, undefined, true);
    if (showEmptyContent) {
      const from = physicalLineStart(input.source, Number(closing.from));
      addLineAt(node, from, "jot-live-preview-empty-container-line");
      if (node.kind === "fenced-code") {
        const line = lines.get(from);
        if (line !== undefined) { line.classes.add("jot-code-line"); line.codeLine = 1; line.codeOwner = node.id; }
      }
    }
    if (!collapseMarkerLines) {
      if (node.kind === "fenced-code") {
        if (!showOpening) addLineAt(node, physicalLineStart(input.source, Number(opening.from)), "jot-live-preview-code-boundary");
        if (!showEmptyContent) addLineAt(node, physicalLineStart(input.source, Number(closing.from)), "jot-live-preview-code-boundary");
      }
      return;
    }
    if (!showOpening) {
      addLineAt(
        node,
        physicalLineStart(input.source, Number(opening.from)),
        "jot-live-preview-structural-line",
      );
    }
    if (!showEmptyContent) {
      addLineAt(
        node,
        physicalLineStart(input.source, Number(closing.from)),
        "jot-live-preview-structural-line",
      );
    }
  };

  const applyQuotePresentation = (node: RenderNode, hideSyntax: boolean): void => {
    const first = physicalLineStart(input.source, Number(node.sourceRange.from));
    const last = lastPhysicalLineStart(input.source, node.sourceRange);
    for (const from of lineStarts(input.source, node.sourceRange, input.visibleRange)) {
      const line = lines.get(from);
      if (line === undefined) continue;
      const projected = quoteLines.get(from);
      // 引用根先于行窗口到达时，只能确认最外层。保留该前缀的光标边界，
      // 等 Rust 返回这一行后，再隐藏嵌套前缀或区分代码里的字面量 `>`。
      line.quoteDepth = projected === undefined ? 1 : numberAttribute(projected, "quoteDepth") ?? 1;
      line.quoteOpen = projected === undefined ? Number(from === first) : numberAttribute(projected, "quoteOpen") ?? 0;
      line.quoteClose = projected === undefined ? Number(from === last) : numberAttribute(projected, "quoteClose") ?? 0;
      if (!hideSyntax) continue;
      const hiddenMarker = projected === undefined
        ? quotePrefix(input.source, from, 1)
        : rangeAttribute(projected, "markerRange");
      if (hiddenMarker !== undefined && replace(node, textRange(hiddenMarker.from, hiddenMarker.to), undefined, true, true)) {
        line.quoteMarkerHidden = true;
        const markerEnd = Number(hiddenMarker.to);
        line.quoteMarkerOnly = markerEnd >= input.source.length || input.source.charCodeAt(markerEnd) === 10;
      }
    }
  };

  const hideListItemSyntax = (node: RenderNode): void => {
    const bounds = childBounds(node);
    const marker = bounds === undefined
      ? listItemMarkerRange(input.source, node.sourceRange)
      : {
          from: Number(node.sourceRange.from),
          to: bounds.from,
        };
    if (marker !== undefined) replace(node, textRange(marker.from, marker.to), undefined, true);
    if (marker === undefined) return;
    let contentIndent = 0;
    for (const character of input.source.slice(marker.from, marker.to)) {
      contentIndent += character === "\t" ? 4 - contentIndent % 4 : 1;
    }
    for (const from of lineStarts(input.source, node.sourceRange, input.visibleRange)) {
      if (from === physicalLineStart(input.source, Number(node.sourceRange.from))) continue;
      const projected = quoteLines.get(from);
      const confirmedPrefix = projected === undefined ? undefined : rangeAttribute(projected, "markerRange");
      const prefixFrom = Number(node.sourceRange.from) > physicalLineStart(input.source, Number(node.sourceRange.from))
        ? Number(confirmedPrefix?.to ?? quotePrefix(input.source, from, Number.POSITIVE_INFINITY)?.to ?? from)
        : from;
      let to = prefixFrom, column = 0;
      while (column < contentIndent && (input.source[to] === " " || input.source[to] === "\t")) {
        column += input.source[to] === "\t" ? 4 - column % 4 : 1;
        to += 1;
      }
      replace(node, textRange(prefixFrom, to), undefined, true);
    }
  };

  const componentPlanFor = (node: RenderNode): ComponentLivePreviewPlan | undefined => {
    const definition = defaultMarkdownComponentRegistry.resolve(node);
    const model = definition?.createModel(node);
    return model === undefined
      ? undefined
      : definition?.capabilities.livePreview?.plan(model, {
          source: input.source,
          selections: input.selections,
          ...(input.visibleRange === undefined ? {} : { visibleRange: input.visibleRange }),
          maxDecorations: maximum,
          ...(input.estimateBlockHeight === undefined
            ? {}
            : { estimateBlockHeight: input.estimateBlockHeight }),
        });
  };

  const addComponentPlan = (plan: ComponentLivePreviewPlan): void => {
    if (plan.lineClasses !== undefined) {
      // lineClasses 的目标节点由调用方处理；组件自定义 line decoration 应明确给范围。
    }
    for (const decoration of plan.decorations ?? []) {
      if (truncated) return;
      const from = clamp(decoration.from, 0, input.source.length);
      if (decoration.type === "line") {
        if (input.visibleRange !== undefined &&
            (from < input.visibleRange.from || from > input.visibleRange.to)) continue;
        if (!lines.has(from) && visualDecorationCount + lines.size >= maximum) {
          truncated = true;
          return;
        }
        const line = lines.get(from) ?? {
          classes: new Set<string>(),
          nodeId: decoration.nodeId,
          indentColumns: 0,
        };
        if (line.nodeId !== decoration.nodeId) {
          line.structuralOwners ??= new Set([line.nodeId]);
          line.structuralOwners.add(decoration.nodeId);
        }
        decoration.className.split(/\s+/u).filter(Boolean).forEach((className) => line.classes.add(className));
        lines.set(from, line);
        continue;
      }
      const rawTo = clamp(decoration.to, from, input.source.length);
      const to = decoration.type === "replace" && decoration.widget?.block === true
        ? blockReplacementEnd(input.source, from, rawTo)
        : rawTo;
      if (
        decoration.type === "replace" &&
        hasLineBreak(input.source, from, to) &&
        !isCompleteBlockReplacement(input.source, from, to, decoration.widget?.block === true)
      ) continue;
      const widget = decoration.type !== "replace"
        ? undefined
        : decoration.widget === undefined
          ? undefined
          : {
            ...decoration.widget,
            ...(selectionTouches(decoration.widget.node.sourceRange) ? { selected: true } : {}),
          };
      const accepted = add({
        ...decoration,
        from,
        to,
        ...(widget === undefined ? {} : { widget }),
      });
      if (!accepted && decoration.type === "replace" && decoration.widget?.block === true) {
        fallbackBlocks += 1;
      }
    }
    for (const wrapper of plan.wrappers ?? []) {
      const from = clamp(wrapper.from, 0, input.source.length);
      const to = clamp(wrapper.to, from, input.source.length);
      if (from === to) continue;
      wrappers.push({ ...wrapper, from, to });
    }
  };

  const visit = (
    node: RenderNode,
    suppliedPlan?: ComponentLivePreviewPlan,
    root = false,
  ): void => {
    node = quoteOwners.get(node.id) ?? node;
    if (truncated || visitedIds.has(node.id)) return;
    visitedIds.add(node.id);
    visitedNodes += 1;
    const componentPlan = suppliedPlan ?? componentPlanFor(node);
    if (componentPlan !== undefined) {
      if (componentPlan.lineClasses !== undefined) addLines(node, ...componentPlan.lineClasses);
      addComponentPlan(componentPlan);
      fallbackBlocks += componentPlan.fallbackBlocks ?? 0;
      if (componentPlan.visitChildren === true) visitChildren(node);
      return;
    }
    switch (node.kind) {
      case "heading": {
        addNativeBlockLines(node, root, "jot-live-preview-heading");
        const bounds = childBounds(node);
        if (bounds === undefined) {
          fallbackBlocks += 1;
          return;
        }
        hideOuterSyntax(node, bounds.from, bounds.to);
        visitChildren(node);
        return;
      }
      case "paragraph": {
        addNativeBlockLines(node, root, "jot-live-preview-paragraph");
        visitChildren(node);
        return;
      }
      case "block-quote": {
        addNativeBlockLines(
          node,
          root,
          "jot-live-preview-block-quote",
          "jot-live-preview-source-block-quote",
        );
        visitChildren(node);
        return;
      }
      case "list-item": {
        addNativeBlockLines(node, root, "jot-live-preview-list-item");
        if (containsTaskMarker(node)) addLines(node, "jot-live-preview-task-item");
        hideListItemSyntax(node);
        visitChildren(node);
        return;
      }
      case "fenced-code": {
        if (input.pluginRegistry?.codeBlock(node) !== undefined) {
          replaceBlock(node, "plugin-block");
          return;
        }
        // CodeMirror 保留真实 fence/content 物理行。首版只做稳定的 code 行
        // 排版，不为只读高亮把多行源码替换成不透明 block widget。
        addNativeBlockLines(node, root, "jot-live-preview-source-fenced-code");
        hideClosedContainerSyntax(node, false);
        return;
      }
      case "blank-line":
        replaceBlock(node);
        return;
      case "strong":
      case "emphasis":
      case "strikethrough":
      case "link": {
        const bounds = childBounds(node);
        if (bounds === undefined) return;
        hideOuterSyntax(node, bounds.from, bounds.to);
        const destination = node.kind === "link" ? stringAttribute(node, "destination") : undefined;
        const href = destination === undefined ? undefined : sanitizeUrl(destination);
        add({
          type: "mark",
          from: bounds.from,
          to: bounds.to,
          className: `jot-live-preview-${node.kind}`,
          nodeId: node.id,
          ...(href === undefined ? {} : { linkHref: href }),
        });
        visitChildren(node);
        return;
      }
      case "task-marker":
        decorateTaskMarker(node);
        return;
      case "escaped-text": {
        const content = rangeAttribute(node, "contentRange");
        if (content !== undefined) hideOuterSyntax(node, Number(content.from), Number(content.to));
        return;
      }
      case "inline-code": {
        const range = rangeAttribute(node, "contentRange") ?? node.sourceRange;
        const from = Number(range.from);
        const to = Number(range.to);
        hideOuterSyntax(node, from, to);
        add({
          type: "mark",
          from,
          to,
          className: "jot-live-preview-inline-code",
          nodeId: node.id,
        });
        return;
      }
      case "hard-break":
        // The physical LF remains CodeMirror's only line axis. Rust gives
        // the explicit marker range; hide its two spaces, never the LF.
        replace(node, textRange(Number(node.sourceRange.from), Number(node.sourceRange.to) - 1), undefined, true);
        return;
      case "inline-math":
      case "image": {
        replace(node, node.sourceRange, {
          kind: node.kind,
          node,
          block: false,
        });
        return;
      }
      case "math-block": {
        replaceBlock(node);
        return;
      }
      case "thematic-break": {
        replaceBlock(node);
        return;
      }
      case "dirty-source":
        addLines(node, "jot-live-preview-line", "jot-live-preview-dirty-line");
        fallbackBlocks += 1;
        return;
      default:
        visitChildren(node);
    }
  };

  const visitChildren = (node: RenderNode): void => {
    if (node.content.type !== "structured") {
      if (node.childCount > 0) fallbackBlocks += 1;
      return;
    }
    for (const child of node.content.children) visit(child, undefined, false);
  };

  const activeInlineIds = new Set<string>();
  let activeSourceLines: LivePreviewSelectionRange | undefined;
  const decorateActiveSourceInline = (node: RenderNode, localSelection?: LivePreviewSelectionRange): void => {
    node = quoteOwners.get(node.id) ?? node;
    if (activeInlineIds.has(node.id)) return;
    activeInlineIds.add(node.id);
    if (node.content.type !== "structured") return;
    for (const child of node.content.children) {
      // CodeMirror edits physical lines even when several lines share a root.
      // Keep the rendered geometry of inline widgets on the other lines.
      if (isRenderSizedInline(child) && activeSourceRange !== undefined && !revealSyntax) {
        activeSourceLines ??= physicalSourceLines(input.source, activeSourceRange);
        if (!rangesTouch(child.sourceRange, activeSourceLines) && !selectionTouches(child.sourceRange)) {
          visit(child);
          continue;
        }
      }
      // Source-edit 不隐藏 Markdown delimiter，但应保留 Preview 的关键行内
      // typography token。这样 `[label](url)`、`**strong**`、`*emphasis*`
      // 在切换时不会突然丢失 underline / weight / italic 而产生视觉跳动。
      const bounds = childBounds(child);
      const sourceClass = child.kind === "link"
        ? "jot-live-preview-source-link"
        : child.kind === "strong"
          ? "jot-live-preview-source-strong"
          : child.kind === "emphasis"
            ? "jot-live-preview-source-emphasis"
            : child.kind === "strikethrough"
              ? "jot-live-preview-source-strikethrough"
            : undefined;
      if (localSelection !== undefined &&
          (sourceClass !== undefined || child.kind === "inline-code" || child.kind === "escaped-text") &&
          (Number(child.sourceRange.to) <= localSelection.from || localSelection.to < Number(child.sourceRange.from))) {
        visit(child);
        continue;
      }
      if (bounds !== undefined && sourceClass !== undefined) {
        add({
          type: "mark",
          from: bounds.from,
          to: bounds.to,
          className: sourceClass,
          nodeId: child.id,
        });
      }
      if (child.kind === "inline-code") {
        const content = rangeAttribute(child, "contentRange") ?? child.sourceRange;
        add({
          type: "mark",
          from: Number(content.from),
          to: Number(content.to),
          className: "jot-live-preview-source-inline-code",
          nodeId: child.id,
        });
      }
      if (child.kind === "task-marker") decorateTaskMarker(child);
      decorateActiveSourceInline(child, localSelection);
    }
  };

  const activeSyntaxIds = new Set<string>();
  const decorateActiveSourceBlockSyntax = (node: RenderNode): void => {
    node = quoteOwners.get(node.id) ?? node;
    if (activeSyntaxIds.has(node.id)) return;
    activeSyntaxIds.add(node.id);
    if (node.kind === "fenced-code" && quoteOwners.has(node.id)) {
      addNativeBlockLines(node, false, "jot-live-preview-source-fenced-code");
      hideClosedContainerSyntax(node, false);
      return;
    }
    if (node.kind === "list-item") {
      addLines(node, "jot-live-preview-list-item");
      if (containsTaskMarker(node)) addLines(node, "jot-live-preview-task-item");
      hideListItemSyntax(node);
      const hideBreaks = (child: RenderNode): void => {
        if (child.kind === "hard-break") {
          replace(child, textRange(Number(child.sourceRange.from), Number(child.sourceRange.to) - 1), undefined, true);
        } else if (child.content.type === "structured") child.content.children.forEach(hideBreaks);
      };
      if (node.content.type === "structured") node.content.children.forEach(hideBreaks);
    }
    if (node.kind !== "block-quote") return;
    // Quote prefixes were already handled once per physical line from the
    // confirmed quote projection. Continue into nested list markers only.
    if (node.content.type === "structured") node.content.children.forEach(decorateActiveSourceBlockSyntax);
  };

  const visitQuoteLineOwners = (node: RenderNode, callback: (owner: RenderNode) => void): void => {
    const seen = new Set<string>();
    for (const from of lineStarts(input.source, node.sourceRange, input.visibleRange)) {
      const line = quoteLines.get(from);
      if (line?.content.type !== "structured") continue;
      for (const owner of line.content.children) if (!seen.has(owner.id)) {
        seen.add(owner.id);
        callback(owner);
      }
    }
  };

  for (const node of input.nodes) {
    if (truncated) break;
    const componentPlan = componentPlanFor(node);
    const selectedRoot = activeSourceNode?.id === node.id;
    // A document containing only a diagram still needs a way back to its
    // preview. On blur, keep ranges/search/IME in source; otherwise allow the
    // ordinary widget to render. Its next pointer activation focuses source.
    const previewOnBlur = selectedRoot && input.editorFocused === false &&
      input.forceSource !== true && !revealSyntax &&
      !selectionTouches(node.sourceRange) &&
      input.pluginRegistry?.codeBlock(node) !== undefined;
    const active = selectedRoot && !previewOnBlur;
    const quote = node.kind === "block-quote";
    let quoteHasRenderSizedInline = false;
    if (quote) {
      addNativeBlockLines(node, true, "jot-live-preview-block-quote", "jot-live-preview-source-block-quote");
      applyQuotePresentation(node, !revealSyntax && (active || node.mode !== "source"));
      visitQuoteLineOwners(node, owner => { quoteHasRenderSizedInline ||= hasRenderSizedInline(owner); });
    }
    // `selection: "mapped"` 的 table-root 正常情况下不因 caret 回退为源码；
    // 但 IME 没有第二个 widget contenteditable 可以承载 composition DOM。宿主
    // 显式要求时，先把命中的根块交还给真实 CodeMirror 行轴，避免浏览器把
    // composition 文本写到 replacement 边界。
    if (input.forceSource === true && active) {
      activeBlocks += 1;
      const forceQuoteShell = quote && (quoteHasRenderSizedInline || hasRenderSizedInline(node));
      if (isNativeTextBlock(node) && !forceQuoteShell) {
        addNativeBlockLines(
          node,
          true,
          "jot-live-preview-active-line",
          `jot-live-preview-source-${node.kind}`,
        );
      } else {
        addLines(
          node,
          ...(isNativeTextBlock(node) ? ["jot-live-preview-native-block", `jot-live-preview-native-block--${node.kind}`] : []),
          "jot-live-preview-line",
          "jot-live-preview-active-line",
          `jot-live-preview-source-${node.kind}`,
        );
        addActiveSourceShell(node);
      }
      if (!revealSyntax) {
        decorateActiveSourceBlockSyntax(node);
        decorateActiveSourceInline(node);
        if (quote) visitQuoteLineOwners(node, owner => {
          decorateActiveSourceBlockSyntax(owner);
          decorateActiveSourceInline(owner);
        });
        hideClosedContainerSyntax(node, node.kind === "math-block");
        addSourceCompanionImages(node);
        if (quote) visitQuoteLineOwners(node, addSourceCompanionImages);
      }
      continue;
    }
    if (componentPlan?.handlesSelection === true) {
      visit(node, componentPlan);
      continue;
    }
    if (active || node.mode === "source" || node.kind === "dirty-source") {
      activeBlocks += active ? 1 : 0;
      const sourceLineClasses = [
        "jot-live-preview-line",
        active ? "jot-live-preview-active-line" : "jot-live-preview-dirty-line",
        `jot-live-preview-source-${node.kind}`,
      ];
      const geometryShell = isNativeTextBlock(node) && (hasRenderSizedInline(node) || quoteHasRenderSizedInline);
      if (isNativeTextBlock(node) && !geometryShell) {
        addNativeBlockLines(node, true, ...sourceLineClasses);
      } else {
        addLines(
          node,
          ...(isNativeTextBlock(node)
            ? [
              "jot-live-preview-native-block",
              `jot-live-preview-native-block--${node.kind}`,
            ]
            : []),
          ...sourceLineClasses,
        );
        addActiveSourceShell(node);
      }
      if (active) decorateActiveSourceBlockSyntax(node);
      const quoteSelection = quote && !geometryShell ? activeSourceRange : undefined;
      if (active) decorateActiveSourceInline(node, quoteSelection);
      if (active && quote) visitQuoteLineOwners(node, owner => {
        decorateActiveSourceBlockSyntax(owner);
        decorateActiveSourceInline(owner, quoteSelection);
      });
      if (active) hideClosedContainerSyntax(node, node.kind === "math-block");
      if (active) addSourceCompanionImages(node);
      if (active && quote) visitQuoteLineOwners(node, addSourceCompanionImages);
      if (!active) fallbackBlocks += 1;
      continue;
    }
    visit(node, componentPlan, true);
    if (quote) visitQuoteLineOwners(node, owner => visit(owner));
  }

  for (const geometry of input.geometryGaps ?? []) {
    if (geometryTruncated) break;
    const from = clamp(geometry.from, 0, input.source.length);
    const rawTo = clamp(geometry.to, from, input.source.length);
    // Geometry chunk 和真实 Preview block 一样必须消费自身最后一个终止 LF。
    // 否则每个离屏 PreText chunk 都会在边界遗留一个 CodeMirror 空行，重新引入
    // 之前修复过的 double-line / scroll jump 问题。
    const to = blockReplacementEnd(input.source, from, rawTo);
    if (to <= from) continue;
    // A source-active root must stay addressable even while it is offscreen.
    // Replacing it with its own estimate hides the search/caret destination.
    if (activeSourceNode !== undefined && from < Number(activeSourceNode.sourceRange.to) &&
        Number(activeSourceNode.sourceRange.from) < to) continue;
    // Sparse projection may not have materialized the active root yet. The
    // source target itself remains authoritative; never cull its native slot.
    const required = activeSourceRange === undefined
      ? input.geometryExclusions ?? [] : [activeSourceRange, ...(input.geometryExclusions ?? [])];
    if (required.some(range => range.from === range.to
      ? from <= range.from && range.from < to
      : from < range.to && range.from < to)) continue;
    const accepted = addGeometry({
      type: "replace",
      from,
      to,
      nodeId: geometry.id,
      widget: {
        kind: "geometry-gap",
        node: geometryNode(geometry),
        block: true,
        geometry: true,
        estimatedHeight: geometry.estimatedHeight,
      },
    });
    if (!accepted) fallbackBlocks += 1;
  }

  for (const [from, line] of lines) {
    if (visualDecorationCount >= maximum) {
      truncated = true;
      break;
    }
    decorations.push({
      type: "line",
      from,
      className: [...line.classes].join(" "),
      nodeId: line.nodeId,
      ...(line.structuralOwners === undefined ? {} : { structuralOwners: [...line.structuralOwners] }),
      ...lineAttributes(line),
    });
    visualDecorationCount += 1;
  }
  decorations.sort(compareDecorations);
  // Only consecutive empty replacements beginning at a quote's physical
  // prefix are leading markers. A later inline marker must keep its normal
  // DOM layout, even when it has the same CodeMirror buffer structure.
  const leadingMarkerPositions = new Set<number>();
  for (const [from, line] of lines) if (line.quoteMarkerHidden) leadingMarkerPositions.add(from);
  for (let index = 0; index < decorations.length; index += 1) {
    const decoration = decorations[index]!;
    if (decoration.type !== "replace" || decoration.widget !== undefined ||
        !leadingMarkerPositions.has(decoration.from)) continue;
    leadingMarkerPositions.delete(decoration.from);
    leadingMarkerPositions.add(decoration.to);
    decorations[index] = { ...decoration, leadingQuoteMarker: true };
  }

  return {
    decorations,
    wrappers,
    visitedNodes,
    activeBlocks,
    fallbackBlocks,
    visualDecorationCount,
    geometryDecorationCount,
    widgetCount,
    geometryWidgetCount,
    truncated,
    geometryTruncated,
  };
}

function geometryNode(geometry: LivePreviewGeometryGap): RenderNode {
  return {
    id: geometry.id,
    kind: "geometry-gap",
    sourceRange: textRange(geometry.from, geometry.to),
    contentVersion: 0,
    mode: "preview",
    childCount: 0,
    attributes: [],
    content: { type: "deferred" },
  };
}

function headingLevel(node: RenderNode): number {
  return clamp(numberAttribute(node, "level") ?? 1, 1, 6);
}

function lineAttributes(line: {
  readonly indentColumns: number;
  readonly headingLevel?: number;
  readonly listMarker?: string;
  readonly codeLine?: number;
  readonly codeOwner?: string;
  readonly quoteDepth?: number;
  readonly quoteOpen?: number;
  readonly quoteClose?: number;
  readonly quoteMarkerHidden?: boolean;
  readonly quoteMarkerOnly?: boolean;
}): { readonly attributes?: Readonly<Record<string, string>> } {
  const styles: string[] = [];
  if (line.indentColumns !== 0) {
    styles.push(`--jot-live-list-indent:${line.indentColumns}ch`);
  }
  const attributes: Record<string, string> = {};
  if (line.quoteDepth !== undefined) {
    attributes["data-jot-quote-depth"] = String(line.quoteDepth);
    attributes["data-jot-quote-open"] = String(line.quoteOpen ?? 0);
    attributes["data-jot-quote-close"] = String(line.quoteClose ?? 0);
    styles.push(`--jot-live-quote-depth:${line.quoteDepth}`);
    styles.push(`--jot-live-quote-open:${line.quoteOpen ?? 0}`);
    styles.push(`--jot-live-quote-close:${line.quoteClose ?? 0}`);
  }
  if (line.quoteMarkerHidden) attributes["data-jot-quote-marker-hidden"] = "true";
  if (line.quoteMarkerOnly) attributes["data-jot-quote-marker-only"] = "true";
  if (line.codeLine !== undefined) attributes["data-jot-line-number"] = String(line.codeLine);
  if (line.codeOwner !== undefined) attributes["data-jot-code-owner"] = line.codeOwner;
  if (line.headingLevel !== undefined) {
    attributes["data-jot-heading-level"] = String(line.headingLevel);
  }
  if (line.listMarker !== undefined) {
    attributes["data-jot-live-list-marker"] = line.listMarker;
    // Rust already provided the marker; reserve space for long ordered
    // numbers without allowing the text to escape the editor's left edge.
    // Use ch so the column follows the host's actual font size/family.
    if (/^[0-9]+[.)]$/u.test(line.listMarker)) {
      styles.push(`--jot-live-list-marker-columns:${line.listMarker.length}ch`);
    }
  }
  if (styles.length > 0) attributes["style"] = styles.join(";");
  return Object.keys(attributes).length === 0 ? {} : { attributes };
}

export function rangesTouch(
  node: TextRange,
  selection: LivePreviewSelectionRange,
): boolean {
  const nodeFrom = Number(node.from);
  const nodeTo = Number(node.to);
  if (nodeFrom === nodeTo) {
    return selection.from <= nodeFrom && nodeFrom <= selection.to;
  }
  if (selection.from === selection.to) {
    return nodeFrom <= selection.from && selection.from <= nodeTo;
  }
  return nodeFrom < selection.to && selection.from < nodeTo;
}

function childBounds(node: RenderNode): { readonly from: number; readonly to: number } | undefined {
  if (node.content.type !== "structured" || node.content.children.length === 0) return undefined;
  return {
    from: Math.min(...node.content.children.map((child) => Number(child.sourceRange.from))),
    to: Math.max(...node.content.children.map((child) => Number(child.sourceRange.to))),
  };
}

function isNativeTextBlock(node: RenderNode): boolean {
  return [
    "heading",
    "paragraph",
    "block-quote",
    "list-item",
    "fenced-code",
    "blank-line",
    "dirty-source",
  ].includes(node.kind);
}

function isRenderSizedInline(node: RenderNode): boolean {
  return node.kind === "image" || node.kind === "inline-math";
}

function hasRenderSizedInline(node: RenderNode): boolean {
  return isRenderSizedInline(node) ||
    (node.content.type === "structured" && node.content.children.some(hasRenderSizedInline));
}

function physicalLineStart(source: string, offset: number): number {
  const safe = clamp(offset, 0, source.length);
  return source.lastIndexOf("\n", Math.max(0, safe - 1)) + 1;
}

function physicalSourceLines(source: string, selection: LivePreviewSelectionRange): LivePreviewSelectionRange {
  const last = Math.max(selection.from, selection.to - 1);
  const end = source.indexOf("\n", last);
  return {
    from: physicalLineStart(source, selection.from),
    to: end < 0 ? source.length : end,
  };
}

function listMarkerText(node: RenderNode): string | undefined {
  const marker = stringAttribute(node, "marker");
  if (marker !== undefined) return "•";
  const number = numberAttribute(node, "number");
  return number === undefined
    ? undefined
    : `${number}${stringAttribute(node, "delimiter") ?? "."}`;
}

/**
 * Rust 已经确认该根是 ListItem；这里仅定位它在同一物理行上的 presentation
 * prefix，不重新决定 Markdown 节点类型。非空项优先使用 child sourceRange，
 * 只有空项才按 CommonMark marker 的有界形式寻找隐藏范围。
 */
function listItemMarkerRange(
  source: string,
  range: TextRange,
): { readonly from: number; readonly to: number } | undefined {
  const from = clamp(Number(range.from), 0, source.length);
  const rawTo = clamp(Number(range.to), from, source.length);
  const lineEndIndex = source.indexOf("\n", from);
  const to = Math.min(rawTo, lineEndIndex < 0 ? source.length : lineEndIndex);
  let cursor = from;
  while (cursor < to && (source[cursor] === " " || source[cursor] === "\t")) cursor += 1;
  const markerStart = cursor;
  if (["-", "+", "*"].includes(source[cursor] ?? "")) {
    cursor += 1;
  } else {
    let digits = 0;
    while (cursor < to && /[0-9]/u.test(source[cursor] ?? "") && digits < 9) {
      cursor += 1;
      digits += 1;
    }
    if (digits === 0 || (source[cursor] !== "." && source[cursor] !== ")")) return undefined;
    cursor += 1;
  }
  if (cursor === markerStart || cursor > to) return undefined;
  while (cursor < to && (source[cursor] === " " || source[cursor] === "\t")) cursor += 1;
  return { from, to: cursor };
}

function lineStarts(
  source: string,
  range: TextRange,
  visible: LivePreviewSelectionRange | undefined,
): readonly number[] {
  const rangeFrom = clamp(Number(range.from), 0, source.length);
  const rangeTo = clamp(Number(range.to), rangeFrom, source.length);
  const from = visible === undefined ? rangeFrom : Math.max(rangeFrom, visible.from);
  const to = visible === undefined ? rangeTo : Math.min(rangeTo, visible.to);
  if (to < from) return [];
  const last = to > from ? to - 1 : from;
  const starts: number[] = [];
  let lineFrom = source.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  while (lineFrom <= last) {
    starts.push(lineFrom);
    const next = source.indexOf("\n", lineFrom);
    if (next < 0 || next >= last) break;
    lineFrom = next + 1;
  }
  return starts;
}

function lastPhysicalLineStart(source: string, range: TextRange): number {
  const from = clamp(Number(range.from), 0, source.length);
  const to = clamp(Number(range.to), from, source.length);
  const position = to > from && source[to - 1] === "\n" ? to - 1 : Math.max(from, to - 1);
  return source.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
}

function hasLineBreak(source: string, from: number, to: number): boolean {
  const index = source.indexOf("\n", from);
  return index >= 0 && index < to;
}

function isCompleteBlockReplacement(
  source: string,
  from: number,
  to: number,
  block: boolean,
): boolean {
  if (!block || (from !== 0 && source[from - 1] !== "\n")) return false;
  return to === source.length || source[to - 1] === "\n";
}

function blockReplacementEnd(source: string, from: number, rawTo: number): number {
  if (rawTo <= from || rawTo >= source.length) return rawTo;
  return source[rawTo - 1] === "\n" || source[rawTo] !== "\n"
    ? rawTo
    : rawTo + 1;
}

function textRange(from: number, to: number): TextRange {
  return { from: from as TextRange["from"], to: to as TextRange["to"] };
}

function compareDecorations(left: LivePreviewDecoration, right: LivePreviewDecoration): number {
  return left.from - right.from || decorationRank(left) - decorationRank(right) ||
    ("to" in left ? left.to : left.from) - ("to" in right ? right.to : right.from);
}

function decorationRank(decoration: LivePreviewDecoration): number {
  return decoration.type === "line" ? 0 : decoration.type === "mark" ? 1 : 2;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
