import {
  Annotation,
  EditorState,
  StateEffect,
  Prec,
  RangeSet,
  StateField,
  Transaction,
  type Extension,
  type Range,
  type TransactionSpec,
} from "@codemirror/state";
import {
  BlockWrapper,
  Decoration,
  EditorView,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { livePreviewTheme } from "./theme.js";
import { createStableMetricGuard } from "./metric-guard.js";
import { linkNavigationAttributes } from "../../components/common/dom-renderer.js";
import { emptyContainerFirstInput } from "./empty-block-input.js";
import type { RenderRuntime } from "../../render/runtime/dom-runtime.js";
import type {
  LivePreviewPlan,
  LivePreviewWidgetDescriptor,
} from "./types.js";
import { LivePreviewWidget } from "./widget.js";
import { TaskMarkerWidget } from "./task-marker-widget.js";
import { applyOptimisticQuoteEdits, emptyQuoteForwardDeleteAt, leadingQuoteMarkerWidget, ordinaryQuoteLineAt, quoteLineAt, resolveOptimisticQuoteEdits, type QuoteLine } from "./optimistic-quote.js";
import { applyOptimisticCodeLines, resolveOptimisticCodeLines } from "./optimistic-code-lines.js";
import { resolveListIndents } from "./list-indent.js";
import { quotedCodeLineAt, type QuotedCodeLine } from "./quoted-code-line.js";

const wrapperNodeIds = new WeakMap<BlockWrapper, string>();
const codeScrollWrappers = new WeakSet<BlockWrapper>();
const codeCaretMeasureKey = {};
const firstHeadingMarkerLine = Decoration.line({
  class: "jot-live-preview-line jot-live-preview-native-block--heading jot-live-preview-source-heading",
  attributes: { "data-jot-heading-level": "1" },
});

/** Temporary, locally proven presentation while the Worker confirms a pair. */
export interface OptimisticEmptyFirstInput {
  readonly id: string;
  readonly from: number;
  readonly openingTo: number;
  readonly closingFrom: number;
  readonly closingTo: number;
  readonly kind: "fenced-code" | "math-block";
}
export const optimisticEmptyFirstInput = Annotation.define<OptimisticEmptyFirstInput>();
export const mappedTableCellEdit = Annotation.define<{ readonly from: number; readonly to: number }>();

interface OptimisticPresentation {
  readonly id: string;
  readonly from: number;
  readonly openingTo: number;
  readonly to: number;
  readonly kind: "fenced-code" | "math-block";
  readonly openingVisible: boolean;
}

interface DecorationState {
  readonly decorations: DecorationSet;
  readonly atomic: DecorationSet;
  readonly wrappers: RangeSet<BlockWrapper>;
  /**
   * `WidgetType.eq()` may intentionally preserve a component-owned block DOM
   * across content updates. Keep its newest descriptor outside the RangeSet so
   * the extension can call `RenderRuntime.update()` without forcing a
   * CodeMirror HeightMap/widget rebuild.
   */
  readonly inPlaceWidgets: ReadonlyMap<string, LivePreviewWidgetDescriptor>;
  readonly optimistic?: OptimisticPresentation;
}

interface LivePreviewExtensionCallbacks {
  readonly isEnabled: () => boolean;
  readonly onUpdate: (update: ViewUpdate) => void;
  readonly onKeyDown: (view: EditorView, event: KeyboardEvent) => boolean;
  readonly onBeforeInput: (view: EditorView, event: InputEvent) => boolean;
  readonly onToggleTask?: (from: number) => boolean;
  readonly onWidgetActivate: (view: EditorView, from: number, to: number) => void;
  readonly onTransaction: (transaction: Transaction) => Transaction | readonly TransactionSpec[];
  readonly resolveMappedTableEdit: (transaction: Transaction) => { readonly from: number; readonly to: number } | undefined;
  readonly onComposition: (active: boolean, event: CompositionEvent, view: EditorView) => void;
}

export interface LivePreviewExtensionHandle {
  readonly extension: Extension;
  apply(view: EditorView, plan: LivePreviewPlan, runtime: RenderRuntime): void;
  clear(view: EditorView): void;
  prepareOptimisticEmpty(view: EditorView, input: OptimisticEmptyFirstInput): void;
  hasOptimisticEmpty(view: EditorView, id: string): boolean;
  quotedCodeLine(view: EditorView, position: number): QuotedCodeLine | undefined;
  emptyQuoteForwardDelete(view: EditorView, position: number): { readonly from: number; readonly to: number; readonly selection: number } | undefined;
  quoteLine(view: EditorView, position: number): QuoteLine | undefined;
  ordinaryQuoteLine(view: EditorView, position: number): QuoteLine | undefined;
}

export function createLivePreviewExtension(
  callbacks: LivePreviewExtensionCallbacks,
): LivePreviewExtensionHandle {
  const setDecorations = StateEffect.define<DecorationState>();
  const prepareOptimistic = StateEffect.define<OptimisticEmptyFirstInput>();
  const field = StateField.define<DecorationState>({
    create: () => emptyState(),
    update(value, transaction) {
      let next = transaction.docChanged
        ? mapUnaffectedDecorations(value, transaction, callbacks.isEnabled())
        : value;
      for (const effect of transaction.effects) {
        if (effect.is(setDecorations)) next = effect.value;
        else if (effect.is(prepareOptimistic)) next = prepareOptimisticPresentation(next, effect.value, transaction.newDoc);
      }
      if (next.optimistic !== undefined) {
        const selection = transaction.newSelection;
        const presentation = next.optimistic;
        if (selection.ranges.length !== 1 || selection.main.head < presentation.from ||
            selection.main.head > presentation.to) {
          next = clearOptimisticPresentation(next);
        } else {
          next = setOptimisticOpeningVisible(next, selection.main.head <= presentation.openingTo);
        }
      }
      return next;
    },
    provide: (stateField) => [
      EditorView.decorations.from(stateField, (value) => value.decorations),
      EditorView.blockWrappers.from(stateField, (value) => value.wrappers),
    ],
  });

  const extension: Extension = [
    field,
    createStableMetricGuard(callbacks.isEnabled),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
    EditorState.transactionFilter.of(callbacks.onTransaction),
    EditorState.transactionExtender.of((transaction) => {
      const cell = callbacks.resolveMappedTableEdit(transaction);
      return cell === undefined ? null : { annotations: mappedTableCellEdit.of(cell) };
    }),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) scrollCodeCaretIntoView(update.view);
      if (update.state.readOnly !== update.startState.readOnly) {
        for (const checkbox of update.view.contentDOM.querySelectorAll<HTMLInputElement>(".jot-live-preview-task-checkbox")) {
          checkbox.disabled = update.state.readOnly;
        }
      }
      if (update.docChanged) {
        const toggles = new Map<number, boolean>();
        update.changes.iterChanges((fromA, toA, fromB, toB) => {
          if (fromA < 1 || fromB < 1 || toA !== fromA + 1 || toB !== fromB + 1 ||
              toA >= update.startState.doc.length || toB >= update.state.doc.length) return;
          const before = update.startState.doc.sliceString(fromA - 1, toA + 1);
          const after = update.state.doc.sliceString(fromB - 1, toB + 1);
          if (/^\[[ xX\t]\]$/u.test(before) && /^\[[ xX\t]\]$/u.test(after)) {
            toggles.set(fromB - 1, after[1] === "x" || after[1] === "X");
          }
        });
        if (toggles.size > 0) {
          for (const checkbox of update.view.contentDOM.querySelectorAll<HTMLInputElement>(".jot-live-preview-task-checkbox")) {
            const position = update.view.posAtDOM(checkbox, 0);
            const checked = toggles.get(position);
            if (checked !== undefined) checkbox.checked = checked;
          }
        }
      }
      callbacks.onUpdate(update);
    }),
    Prec.high(EditorView.domEventHandlers({
      compositionstart: (event, view) => {
        callbacks.onComposition(true, event, view);
        return false;
      },
      compositionend: (event, view) => {
        callbacks.onComposition(false, event, view);
        return false;
      },
      keydown: (event, view) => callbacks.onKeyDown(view, event),
      beforeinput: (event, view) => callbacks.onBeforeInput(view, event as InputEvent),
    })),
    livePreviewTheme,
  ];

  return {
    extension,
    apply(view, plan, runtime) {
      const next = decorationState(plan, runtime, callbacks.onWidgetActivate, callbacks.onToggleTask);
      const previous = view.state.field(field);
      const head = view.state.selection.main.head;
      const codeAppeared = !hasCodeScrollAt(previous.wrappers, head) && hasCodeScrollAt(next.wrappers, head);
      view.dispatch({ effects: setDecorations.of(next) });
      if (codeAppeared) scrollCodeCaretIntoView(view);
      updateInPlaceWidgets(view, previous.inPlaceWidgets, next.inPlaceWidgets, runtime);
    },
    clear(view) {
      view.dispatch({ effects: setDecorations.of(emptyState()) });
    },
    prepareOptimisticEmpty(view, input) {
      if (view.state.field(field).optimistic?.id !== input.id) {
        view.dispatch({ effects: prepareOptimistic.of(input) });
      }
    },
    hasOptimisticEmpty(view, id) { return view.state.field(field).optimistic?.id === id; },
    quotedCodeLine(view, position) {
      return quotedCodeLineAt(view.state.field(field).decorations, view.state.doc, position);
    },
    emptyQuoteForwardDelete(view, position) {
      return emptyQuoteForwardDeleteAt(view.state.field(field).decorations, view.state.doc, position);
    },
    ordinaryQuoteLine(view, position) {
      return ordinaryQuoteLineAt(view.state.field(field).decorations, view.state.doc, position);
    },
    quoteLine(view, position) {
      return quoteLineAt(view.state.field(field).decorations, view.state.doc, position);
    },
  };
}

function hasCodeScrollAt(wrappers: RangeSet<BlockWrapper>, position: number): boolean {
  let found = false;
  wrappers.between(position, position, (from, to, wrapper) => {
    if (from <= position && position < to && codeScrollWrappers.has(wrapper)) found = true;
  });
  return found;
}

/** CodeMirror scrolls its outer scroller; code has a separate horizontal viewport. */
function scrollCodeCaretIntoView(view: EditorView): void {
  if (!view.hasFocus) return;
  const currentNode = view.domAtPos(view.state.selection.main.head).node;
  const currentElement = currentNode.nodeType === 1 ? currentNode as Element : currentNode.parentElement;
  if (currentElement?.closest(".jot-live-preview-code-scroll") == null) return;
  view.requestMeasure({
    key: codeCaretMeasureKey,
    read(current) {
      const head = current.state.selection.main.head;
      const node = current.domAtPos(head).node;
      const element = node.nodeType === 1 ? node as Element : node.parentElement;
      const container = element?.closest<HTMLElement>(".jot-live-preview-code-scroll");
      if (container === null || container === undefined) return undefined;
      const caret = current.coordsAtPos(head);
      if (caret === null) return undefined;
      const bounds = container.getBoundingClientRect();
      const inset = 8;
      const delta = caret.left < bounds.left + inset
        ? caret.left - bounds.left - inset
        : caret.right > bounds.right - inset ? caret.right - bounds.right + inset : 0;
      return { container, delta };
    },
    write(measurement) {
      if (measurement !== undefined && measurement.delta !== 0 && measurement.container.isConnected) {
        measurement.container.scrollLeft += measurement.delta;
      }
    },
  });
}

function decorationState(
  plan: LivePreviewPlan,
  runtime: RenderRuntime,
  onWidgetActivate: LivePreviewExtensionCallbacks["onWidgetActivate"],
  onToggleTask: LivePreviewExtensionCallbacks["onToggleTask"],
): DecorationState {
  const decorations: Array<Range<Decoration>> = [];
  const atomic: Array<Range<Decoration>> = [];
  const inPlaceWidgets = new Map<string, LivePreviewWidgetDescriptor>();
  for (const item of plan.decorations) {
    let range: Range<Decoration>;
    switch (item.type) {
      case "line":
        range = Decoration.line({
          class: item.className,
          jotLiveNode: item.nodeId,
          jotLiveSourceLine: true,
          jotLiveStructuralOwners: item.structuralOwners,
          attributes: {
            "data-jot-live-node": item.nodeId,
            ...item.attributes,
          },
        }).range(item.from);
        break;
      case "mark":
        range = Decoration.mark({
          class: item.className,
          ...(item.linkHref === undefined ? {} : { tagName: "a" }),
          attributes: {
            "data-jot-live-node": item.nodeId,
            ...(item.linkHref === undefined ? {} : linkNavigationAttributes(item.linkHref)),
          },
        }).range(item.from, item.to);
        break;
      case "replace": {
        if (item.widget?.inPlaceUpdate === true) {
          inPlaceWidgets.set(inPlaceWidgetKey(item.from, item.to, item.widget), item.widget);
        }
        const widget = item.widget === undefined
          ? item.leadingQuoteMarker === true ? leadingQuoteMarkerWidget : undefined
          : item.widget.kind === "task-marker"
          ? new TaskMarkerWidget(item.from, item.widget, onToggleTask)
          : new LivePreviewWidget(
            item.from,
            item.to,
            item.widget,
            runtime,
            onWidgetActivate,
          );
        if (widget !== undefined && item.from === item.to) {
          // 零宽 widget 只用于确实没有源码内容的 inline projection。物理
          // blank-line 不走这里，而由 Planner 的 line decoration 保留原生行轴。
          range = Decoration.widget({
            widget,
            ...(item.widget?.block === true ? { block: true } : {}),
            side: 0,
          }).range(item.from);
        } else {
          range = Decoration.replace({
            ...(widget === undefined ? {} : { widget }),
            ...(item.widget?.block === true
              // block replacement 只覆盖 RenderNode 自身的内容；尾部
              // separator 仍属于 CodeMirror 的下一条物理行，不能因默认的
              // inclusiveEnd 把相邻 blank-line/line decoration 吸进 widget。
              ? { block: true, inclusiveStart: true, inclusiveEnd: false }
              : { inclusive: false }),
            jotLiveNode: item.nodeId,
            jotLiveStructural: item.structural === true,
            jotLiveQuotePrefix: item.quotePrefix === true,
            jotLiveTaskMarker: item.widget?.kind === "task-marker",
            jotLiveSelection: item.widget?.selection ?? "atomic",
          }).range(item.from, item.to);
          if (item.widget?.selection !== "mapped" && item.from < item.to) atomic.push(range);
        }
        break;
      }
    }
    decorations.push(range);
  }
  const wrappers = BlockWrapper.set(plan.wrappers.map((item) => {
    const wrapper = BlockWrapper.create({
      tagName: "div",
      attributes: {
        class: item.className,
        "data-jot-live-node": item.nodeId,
        ...item.attributes,
      },
    });
    wrapperNodeIds.set(wrapper, item.nodeId);
    if (item.className === "jot-live-preview-code-scroll") codeScrollWrappers.add(wrapper);
    return wrapper.range(item.from, item.to);
  }));
  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set(atomic, true),
    wrappers,
    inPlaceWidgets,
  };
}

function projectedLineAt(decorations: DecorationSet, position: number): Decoration | undefined {
  let line: Decoration | undefined;
  decorations.between(position, position, (from, _to, decoration) => {
    if (from === position && decoration.spec.jotLiveSourceLine === true) line = decoration;
  });
  return line;
}

function mapUnaffectedDecorations(
  value: DecorationState,
  transaction: Transaction,
  enabled: boolean,
): DecorationState {
  const quoteEdits = resolveOptimisticQuoteEdits(value.decorations, transaction);
  const codeLines = resolveOptimisticCodeLines(value.decorations, transaction);
  const listIndents = resolveListIndents(value.decorations, transaction);
  const changed: Array<{ readonly from: number; readonly to: number }> = [];
  const edits: Array<{ readonly from: number; readonly to: number }> = [];
  const mappedEdits: Array<{ readonly from: number; readonly to: number }> = [];
  let inlineOnly = true;
  transaction.changes.iterChanges((fromA, toA, fromB, toB, insert) => {
    edits.push({ from: fromA, to: toA });
    mappedEdits.push({ from: fromB, to: toB });
    inlineOnly &&= insert.lines === 1 &&
      transaction.startState.doc.lineAt(fromA).number === transaction.startState.doc.lineAt(toA).number;
    changed.push({
      from: Math.max(0, fromB - 1),
      to: Math.min(transaction.newDoc.length, Math.max(fromB, toB) + 1),
    });
  });
  const quoteMarkerByStart = new Map<number, typeof quoteEdits[number][]>();
  type StructuralMarker = NonNullable<typeof quoteEdits[number]["structuralMarkers"]>[number];
  const structuralByStart = new Map<number, StructuralMarker[]>();
  const structuralByLine = new Map<number, StructuralMarker[]>();
  const quoteOwners = new Set<string>();
  for (const quoteEdit of quoteEdits) {
    quoteOwners.add(quoteEdit.owner);
    const markers = quoteMarkerByStart.get(quoteEdit.oldMarkerFrom) ?? [];
    markers.push(quoteEdit);
    quoteMarkerByStart.set(quoteEdit.oldMarkerFrom, markers);
  }
  for (const marker of [...listIndents, ...quoteEdits.flatMap(edit => edit.structuralMarkers ?? [])]) {
    const at = structuralByStart.get(marker.oldFrom) ?? [];
    at.push(marker); structuralByStart.set(marker.oldFrom, at);
    const line = transaction.startState.doc.lineAt(marker.oldFrom).from;
    const onLine = structuralByLine.get(line) ?? [];
    onLine.push(marker); structuralByLine.set(line, onLine);
  }
  const firstInput = transaction.annotation(emptyContainerFirstInput);
  const optimisticInput = transaction.annotation(optimisticEmptyFirstInput);
  const firstEmptyInput = firstInput !== undefined && edits.length === 1 &&
    edits[0]!.from === firstInput.position && edits[0]!.to === firstInput.position
    ? firstInput : undefined;
  // Presentation is not a semantic parse cache. While an IME candidate is
  // deliberately unconfirmed, keep untouched block syntax and same-line skins
  // instead of exposing half a Markdown prefix or unstyling one code row.
  const invalidatedNodes = new Set<string>();
  const stableTaskMarkers = new Set<string>();
  const unchangedSourceLines: Array<{ readonly from: number; readonly to: number }> = [];
  const affectedLineStarts = new Set(inlineOnly ? [] : changed.flatMap(range => [
    transaction.newDoc.lineAt(range.from).from,
    transaction.newDoc.lineAt(range.to).from,
  ]));
  // The opening marker is temporarily revealed when the caret moves onto it.
  // Its replacement is then absent, so explicitly invalidate the temporary
  // presentation if the user edits that marker while it is visible.
  const optimisticOpening = value.optimistic;
  if (optimisticOpening?.openingVisible && edits.some(edit => edit.from === edit.to
    ? optimisticOpening.from <= edit.from && edit.from <= optimisticOpening.openingTo
    : optimisticOpening.from < edit.to && edit.from < optimisticOpening.openingTo)) {
    invalidatedNodes.add(optimisticOpening.id);
  }
  value.decorations.between(0, transaction.startState.doc.length, (from, to, decoration) => {
    if (!inlineOnly && decoration.spec.jotLiveSourceLine === true) {
      const mappedFrom = transaction.changes.mapPos(from, 1);
      if (affectedLineStarts.has(mappedFrom)) {
        const line = transaction.startState.doc.lineAt(from);
        const mappedTo = transaction.changes.mapPos(line.to, -1);
        const next = transaction.newDoc.lineAt(mappedFrom);
        const touched = edits.some(edit => edit.from === edit.to
          ? line.from < edit.from && edit.from < line.to
          : line.from < edit.to && edit.from < line.to);
        if (!touched && line.length > 0 && next.from === mappedFrom && next.to === mappedTo) {
          unchangedSourceLines.push({ from: mappedFrom, to: mappedTo });
        }
      }
    }
    if (decoration.spec.jotLiveStructural !== true) return;
    if (decoration.spec.jotLiveTaskMarker === true) {
      const lineStart = transaction.startState.doc.lineAt(from).from;
      if (!edits.some(edit => edit.from <= to && lineStart <= edit.to)) return;
      const prefixChanged = edits.some(edit => edit.from === edit.to
        ? lineStart <= edit.from && edit.from <= from
        : edit.from < from && lineStart <= edit.to);
      const relevantEdits = edits.filter(edit => lineStart <= edit.to && edit.from <= from);
      const listIndentProved = relevantEdits.length === 1 && structuralByLine.get(lineStart)?.some(marker =>
        marker.oldTo <= from && relevantEdits[0]!.from >= marker.oldFrom && relevantEdits[0]!.to <= marker.oldTo) === true;
      if (prefixChanged && !listIndentProved) {
        // The preceding list/quote marker determines whether this is a task.
        // Retaining the old checkbox after that prefix changes would present
        // unconfirmed semantics over an ordinary paragraph.
        invalidatedNodes.add(decoration.spec.jotLiveNode as string);
        return;
      }
      const mappedFrom = transaction.changes.mapPos(from, 1);
      const mappedTo = mappedFrom + 3;
      if (mappedTo > transaction.newDoc.length) {
        invalidatedNodes.add(decoration.spec.jotLiveNode as string);
        return;
      }
      const marker = transaction.newDoc.sliceString(mappedFrom, mappedTo);
      const following = transaction.newDoc.sliceString(mappedTo, Math.min(mappedTo + 1, transaction.newDoc.length));
      if (!/^\[[ xX\t]\]$/u.test(marker) || (following !== "" && !/^[ \t\n]$/u.test(following))) {
        // The separating whitespace is part of the task-marker rule even
        // though it is outside the checkbox's three-character source range.
        invalidatedNodes.add(decoration.spec.jotLiveNode as string);
        return;
      }
    }
    const edit = edits[0], mapped = mappedEdits[0];
    if (decoration.spec.jotLiveTaskMarker === true && edits.length === 1 &&
        edit !== undefined && mapped !== undefined && to === from + 3 &&
        edit.from === from + 1 && edit.to === from + 2 &&
        mapped.to === mapped.from + 1 &&
        /^\[[ xX\t]\]$/u.test(transaction.startState.doc.sliceString(from, to)) &&
        /^\[[ xX\t]\]$/u.test(transaction.newDoc.sliceString(from, to))) {
      stableTaskMarkers.add(decoration.spec.jotLiveNode as string);
      return;
    }
    if (edits.some(edit => edit.from === edit.to
      ? from <= edit.from && (edit.from < to ||
          (value.optimistic !== undefined && decoration.spec.jotLiveNode === value.optimistic.id && edit.from === to)) &&
        !(firstEmptyInput !== undefined &&
          decoration.spec.jotLiveNode === firstEmptyInput.nodeId && from === firstEmptyInput.position)
      : from < edit.to && edit.from < to)) {
      if (quoteMarkerByStart.get(from)?.some(quoteEdit => decoration.spec.jotLiveQuotePrefix === true &&
          decoration.spec.jotLiveNode === quoteEdit.owner &&
          from === quoteEdit.oldMarkerFrom && to === quoteEdit.oldMarkerTo)) return;
      if (structuralByStart.get(from)?.some(marker => marker.owner === decoration.spec.jotLiveNode &&
          marker.oldTo === to && marker.decoration === decoration)) return;
      if (codeLines?.removedQuoteMarker !== undefined && decoration.spec.jotLiveQuotePrefix === true &&
          decoration.spec.jotLiveNode === codeLines.removedQuoteMarker.owner &&
          from === codeLines.removedQuoteMarker.from && to === codeLines.removedQuoteMarker.to) return;
      invalidatedNodes.add(decoration.spec.jotLiveNode as string);
    }
  });
  const structuralKeep = (from: number, to: number, decoration: Decoration): boolean =>
    decoration.spec.jotLiveStructural === true &&
    !invalidatedNodes.has(decoration.spec.jotLiveNode as string) &&
    !mappedEdits.some(range => from < range.to && range.from < to);
  const keep = (from: number, to: number, value: Decoration): boolean => {
    if ((value.spec.jotLiveSourceLine === true || value.spec.jotLiveStructural === true) &&
        (invalidatedNodes.has(value.spec.jotLiveNode as string) ||
          (value.spec.jotLiveStructuralOwners as readonly string[] | undefined)?.some(id => invalidatedNodes.has(id)))) return false;
    // A proven quote edit leaves the following physical block intact. Do not
    // discard its line decoration merely because the broad damage window
    // touches the first position of the next blank line.
    if (quoteEdits.length > 0 && value.spec.jotLiveSourceLine === true &&
        !quoteOwners.has(value.spec.jotLiveNode as string) &&
        mappedEdits.every(range => from > range.to)) return true;
    if (codeLines !== undefined && value.spec.jotLiveSourceLine === true &&
        /\bjot-live-preview-code-boundary\b/u.test(String(value.spec.class ?? "")) &&
        (value.spec.jotLiveNode === codeLines.owner ||
          (value.spec.jotLiveStructuralOwners as readonly string[] | undefined)?.includes(codeLines.owner))) return true;
    return (value.spec.jotLiveTaskMarker === true && stableTaskMarkers.has(value.spec.jotLiveNode as string)) ||
    (value.spec.block !== true && unchangedSourceLines.some(line => line.from <= from && to <= line.to)) ||
    structuralKeep(from, to, value) ||
    (firstEmptyInput !== undefined && value.spec.jotLiveSourceLine === true &&
      value.spec.jotLiveNode === firstEmptyInput.nodeId && from === firstEmptyInput.position) ||
    (inlineOnly && value.spec.jotLiveSourceLine === true &&
      !invalidatedNodes.has(value.spec.jotLiveNode as string)) || !changed.some((range) =>
      from <= range.to && range.from <= to);
  };
  // Check the OLD source ownership before mapping. The extra physical LF
  // included in a block replacement ends immediately before the next line.
  // An insertion at that exclusive endpoint must never dismantle the grid.
  // Only a trusted table-edit transaction may retain a touched grid.
  const dirtyMappedRoots = new Set<string>();
  if (!isTableInputTransaction(transaction)) {
    for (const edit of edits) {
      value.decorations.between(edit.from, edit.to, (from, to, decoration) => {
        const touchesSource = edit.from === edit.to
          ? from <= edit.from && edit.from < to
          : from < edit.to && edit.from < to;
        if (isMappedSelection(decoration) && touchesSource) {
          dirtyMappedRoots.add(decoration.spec.jotLiveNode as string);
        }
      });
    }
  }
  const keepMapped = (from: number, to: number, decoration: Decoration): boolean =>
    isMappedSelection(decoration) ? !dirtyMappedRoots.has(decoration.spec.jotLiveNode as string) : keep(from, to, decoration);
  let decorations = value.decorations.map(transaction.changes).update({ filter: keepMapped });
  // WebKit can keep painting the caret at the old font's advance until it
  // blinks. Give a newly typed root '#' its heading metrics in the input edit.
  const { doc, selection } = transaction.startState;
  const at = selection.main.head;
  const typedOne = edits.length === 1 && edits[0]!.from === at &&
    edits[0]!.to === at && mappedEdits[0]!.to === at + 1;
  if (enabled && typedOne && selection.ranges.length === 1 && selection.main.empty &&
      transaction.annotation(Transaction.userEvent) === "input.type" &&
      transaction.newDoc.sliceString(at, at + 1) === "#" && doc.lineAt(at).length === 0) {
    const line = projectedLineAt(value.decorations, at);
    const rootBlank = line?.spec.jotLiveStructuralOwners === undefined &&
      String(line?.spec.class ?? "").includes("jot-md-blank-line");
    // Enter can create an unprojected empty row after the last line of a
    // projected root. A bare marker at either document edge is also outside
    // any code or math fence, since this dialect requires both delimiters.
    const previous = line === undefined && at > 0
      ? projectedLineAt(value.decorations, doc.lineAt(at - 1).from)
      : undefined;
    const followsRoot = String(previous?.spec.class ?? "").includes("jot-live-preview-native-block--last");
    if (at === 0 || at === doc.length || rootBlank || followsRoot) {
      decorations = decorations.update({
        filterFrom: at, filterTo: at + 1,
        filter: (_from, _to, decoration) => decoration !== line,
        add: [firstHeadingMarkerLine.range(at)],
      });
    }
  }
  let atomic = value.atomic.map(transaction.changes).update({ filter: keep });
  const stableIndents = listIndents.filter(indent => !invalidatedNodes.has(indent.owner));
  if (stableIndents.length > 0) {
    const moved = new Set(stableIndents.map(indent => indent.decoration));
    const rows = new Map(stableIndents.flatMap(indent => indent.row === undefined ? [] : [[indent.from, indent]] as const));
    const markers = stableIndents.map(indent => indent.decoration.range(indent.from, indent.to));
    decorations = decorations.update({
      filter: (from, _to, decoration) => !moved.has(decoration) &&
        !(decoration.spec.jotLiveSourceLine === true && rows.get(from)?.owner === decoration.spec.jotLiveNode),
      add: [...markers, ...[...rows.values()].map(indent => indent.row!.range(indent.from))],
      sort: true,
    });
    atomic = atomic.update({ filter: (_from, _to, decoration) => !moved.has(decoration), add: markers, sort: true });
  }
  const safeQuoteEdits = quoteEdits.filter(quoteEdit => !invalidatedNodes.has(quoteEdit.owner));
  if (safeQuoteEdits.length > 0) ({ decorations, atomic } = applyOptimisticQuoteEdits(decorations, atomic, safeQuoteEdits));
  if (codeLines !== undefined && !invalidatedNodes.has(codeLines.owner)) {
    let numberWidth: number | undefined;
    value.wrappers.between(0, transaction.startState.doc.length, (_from, to, wrapper) => {
      if (!codeScrollWrappers.has(wrapper) || wrapperNodeIds.get(wrapper) !== codeLines.owner) return;
      const oldCount = transaction.startState.doc.lineAt(to).number - codeLines.firstCodeLine;
      if (oldCount < 1 || oldCount + codeLines.lineDelta < 1) return;
      const oldWidth = Math.max(4, String(oldCount).length);
      const nextWidth = Math.max(4, String(oldCount + codeLines.lineDelta).length);
      if (oldWidth !== nextWidth) numberWidth = nextWidth;
    });
    ({ decorations, atomic } = applyOptimisticCodeLines(decorations, atomic, codeLines, numberWidth));
  }
  let wrappers = value.wrappers.update({ filter: (from, to, wrapper) =>
    !invalidatedNodes.has(wrapperNodeIds.get(wrapper) ?? "") &&
    (!edits.some(edit => from <= edit.to && edit.from <= to) ||
      (firstEmptyInput !== undefined && wrapperNodeIds.get(wrapper) === firstEmptyInput.nodeId) ||
      ((inlineOnly || codeScrollWrappers.has(wrapper)) && edits.every(edit => from <= edit.from && edit.to <= to)))
  }).map(transaction.changes);
  if (firstEmptyInput !== undefined) {
    const closingStart = transaction.changes.mapPos(firstEmptyInput.position, 1);
    const className = firstEmptyInput.kind === "fenced-code"
      ? "jot-live-preview-code-boundary" : "jot-live-preview-structural-line";
    decorations = decorations.update({ add: [Decoration.line({
      class: className,
      jotLiveNode: firstEmptyInput.nodeId,
      jotLiveSourceLine: true,
      attributes: { "data-jot-live-node": firstEmptyInput.nodeId },
    }).range(closingStart)], sort: true });
  }
  let optimistic = value.optimistic === undefined || invalidatedNodes.has(value.optimistic.id)
    ? undefined : {
      id: value.optimistic.id,
      from: transaction.changes.mapPos(value.optimistic.from, -1),
      openingTo: transaction.changes.mapPos(value.optimistic.openingTo, -1),
      to: transaction.changes.mapPos(value.optimistic.to, 1),
      kind: value.optimistic.kind,
      openingVisible: value.optimistic.openingVisible,
    };
  if (optimisticInput !== undefined && edits.length === 1 &&
      edits[0]!.from === optimisticInput.closingFrom && edits[0]!.to === optimisticInput.closingFrom) {
    const openingFrom = optimisticInput.from;
    const openingTo = optimisticInput.openingTo;
    const bodyFrom = optimisticInput.closingFrom;
    const closingFrom = transaction.changes.mapPos(optimisticInput.closingFrom, 1);
    const closingTo = transaction.changes.mapPos(optimisticInput.closingTo, 1);
    if (openingFrom < openingTo && closingFrom < closingTo &&
        transaction.newDoc.sliceString(closingFrom - 1, closingFrom) === "\n") {
      const marker = () => Decoration.replace({ inclusive: false, jotLiveNode: optimisticInput.id,
        jotLiveStructural: true, jotLiveSelection: "atomic" });
      const openRange = marker().range(openingFrom, openingTo), closeRange = marker().range(closingFrom, closingTo);
      const code = optimisticInput.kind === "fenced-code";
      const base = `jot-live-preview-line jot-live-preview-source-${optimisticInput.kind} jot-md-${optimisticInput.kind}`;
      const boundary = code ? "jot-live-preview-code-boundary" : "jot-live-preview-structural-line";
      const line = (from: number, classes: string, number = false) => Decoration.line({
        class: classes, jotLiveNode: optimisticInput.id, jotLiveSourceLine: true,
        attributes: { "data-jot-live-node": optimisticInput.id, ...(number ? { "data-jot-line-number": "1" } : {}) },
      }).range(from);
      decorations = decorations.update({ add: [openRange, closeRange,
        line(openingFrom, `${base} ${boundary}`),
        line(bodyFrom, `${base} jot-live-preview-active-line${code ? " jot-code-line" : ""}`, code),
        line(closingFrom, `${base} ${boundary}`),
      ], sort: true });
      atomic = atomic.update({ add: [openRange, closeRange], sort: true });
      {
        const wrapper = BlockWrapper.create({ tagName: "div", attributes: {
          class: code ? "jot-live-preview-code-scroll" :
            "jot-live-preview-source-block-shell jot-live-preview-source-block-shell--math-block",
          "data-jot-live-node": optimisticInput.id,
        } });
        wrapperNodeIds.set(wrapper, optimisticInput.id);
        if (code) codeScrollWrappers.add(wrapper);
        wrappers = wrappers.update({ add: [wrapper.range(openingFrom, closingTo)], sort: true });
      }
      optimistic = { id: optimisticInput.id, from: openingFrom, openingTo, to: closingTo,
        kind: optimisticInput.kind, openingVisible: false };
    }
  }
  return {
    decorations,
    atomic,
    wrappers,
    inPlaceWidgets: mapInPlaceWidgets(value.inPlaceWidgets, transaction),
    ...(optimistic === undefined ? {} : { optimistic }),
  };
}

function setOptimisticOpeningVisible(value: DecorationState, visible: boolean): DecorationState {
  const optimistic = value.optimistic;
  if (optimistic === undefined || optimistic.openingVisible === visible) return value;
  const openingDecoration = (from: number, to: number, decoration: Decoration): boolean =>
    decoration.spec.jotLiveNode === optimistic.id &&
    ((decoration.spec.jotLiveStructural === true && from === optimistic.from && to === optimistic.openingTo) ||
      (decoration.spec.jotLiveSourceLine === true && from === optimistic.from && to === from));
  const base = `jot-live-preview-line jot-live-preview-source-${optimistic.kind} jot-md-${optimistic.kind}`;
  const boundary = optimistic.kind === "fenced-code"
    ? "jot-live-preview-code-boundary" : "jot-live-preview-structural-line";
  const line = Decoration.line({
    class: visible ? base : `${base} ${boundary}`,
    jotLiveNode: optimistic.id,
    jotLiveSourceLine: true,
    attributes: { "data-jot-live-node": optimistic.id },
  }).range(optimistic.from);
  const marker = visible ? [] : [Decoration.replace({ inclusive: false, jotLiveNode: optimistic.id,
    jotLiveStructural: true, jotLiveSelection: "atomic" }).range(optimistic.from, optimistic.openingTo)];
  return {
    ...value,
    decorations: value.decorations.update({ filter: (from, to, decoration) =>
      !openingDecoration(from, to, decoration), add: [...marker, line], sort: true }),
    atomic: value.atomic.update({ filter: (from, to, decoration) =>
      !openingDecoration(from, to, decoration), add: marker, sort: true }),
    optimistic: { ...optimistic, openingVisible: visible },
  };
}

function clearOptimisticPresentation(value: DecorationState): DecorationState {
  const optimistic = value.optimistic;
  if (optimistic === undefined) return value;
  const keep = (_from: number, _to: number, decoration: Decoration): boolean =>
    decoration.spec.jotLiveNode !== optimistic.id;
  return {
    decorations: value.decorations.update({ filter: keep }),
    atomic: value.atomic.update({ filter: keep }),
    wrappers: value.wrappers.update({ filter: (_from, _to, wrapper) => wrapperNodeIds.get(wrapper) !== optimistic.id }),
    inPlaceWidgets: value.inPlaceWidgets,
  };
}

function prepareOptimisticPresentation(
  state: DecorationState,
  input: OptimisticEmptyFirstInput,
  doc: Transaction["newDoc"],
): DecorationState {
  if (state.optimistic?.id === input.id) return state;
  if (input.from < 0 || input.from >= input.openingTo || input.openingTo + 1 !== input.closingFrom ||
      input.closingFrom >= input.closingTo || input.closingTo > doc.length ||
      doc.sliceString(input.openingTo, input.closingFrom) !== "\n") return state;
  const value = clearOptimisticPresentation(state);
  const outside = (from: number, to: number): boolean => from === to
    ? from < input.from || from > input.closingTo
    : to <= input.from || from >= input.closingTo;
  const marker = () => Decoration.replace({ inclusive: false, jotLiveNode: input.id,
    jotLiveStructural: true, jotLiveSelection: "atomic" });
  const opening = marker().range(input.from, input.openingTo);
  const closing = marker().range(input.closingFrom, input.closingTo);
  const code = input.kind === "fenced-code";
  const base = `jot-live-preview-line jot-live-preview-source-${input.kind} jot-md-${input.kind}`;
  const line = (from: number, classes: string, number = false) => Decoration.line({
    class: classes, jotLiveNode: input.id, jotLiveSourceLine: true,
    attributes: { "data-jot-live-node": input.id, ...(number ? { "data-jot-line-number": "1" } : {}) },
  }).range(from);
  const openingLine = line(input.from, `${base} ${code ? "jot-live-preview-code-boundary" : "jot-live-preview-structural-line"}`);
  // The closer starts at the zero-width content position. Its characters are
  // hidden while its physical line remains the native editable body row.
  const bodyLine = line(input.closingFrom, `${base} jot-live-preview-active-line${code ? " jot-code-line" : ""}`, code);
  let wrappers = value.wrappers.update({ filter: (from, to) => outside(from, to) });
  {
    const wrapper = BlockWrapper.create({ tagName: "div", attributes: {
      class: code ? "jot-live-preview-code-scroll" :
        "jot-live-preview-source-block-shell jot-live-preview-source-block-shell--math-block",
      "data-jot-live-node": input.id,
    } });
    wrapperNodeIds.set(wrapper, input.id);
    if (code) codeScrollWrappers.add(wrapper);
    wrappers = wrappers.update({ add: [wrapper.range(input.from, input.closingTo)], sort: true });
  }
  return {
    decorations: value.decorations.update({ filter: (from, to) => outside(from, to),
      add: [opening, closing, openingLine, bodyLine], sort: true }),
    atomic: value.atomic.update({ filter: (from, to) => outside(from, to), add: [opening, closing], sort: true }),
    wrappers,
    inPlaceWidgets: value.inPlaceWidgets,
    optimistic: { id: input.id, from: input.from, openingTo: input.openingTo, to: input.closingTo,
      kind: input.kind, openingVisible: false },
  };
}

function isMappedSelection(value: Decoration): boolean {
  const spec = (value as unknown as {
    readonly spec?: { readonly jotLiveSelection?: unknown };
  }).spec;
  return spec?.jotLiveSelection === "mapped";
}

export function isTableInputTransaction(transaction: Transaction): boolean {
  return transaction.annotation(mappedTableCellEdit) !== undefined ||
    transaction.annotation(Transaction.userEvent)?.startsWith("input.table.") === true;
}

function emptyState(): DecorationState {
  return {
    decorations: Decoration.none,
    atomic: Decoration.none,
    wrappers: BlockWrapper.set([]),
    inPlaceWidgets: new Map(),
  };
}

function updateInPlaceWidgets(
  view: EditorView,
  previous: ReadonlyMap<string, LivePreviewWidgetDescriptor>,
  next: ReadonlyMap<string, LivePreviewWidgetDescriptor>,
  runtime: RenderRuntime,
): void {
  for (const [key, descriptor] of next) {
    const previousDescriptor = previous.get(key);
    if (
      previousDescriptor !== undefined &&
      sameInPlaceDescriptor(previousDescriptor, descriptor)
    ) {
      continue;
    }
    const dom = findInPlaceWidgetDOM(view.dom, descriptor);
    if (dom === null) continue;
    if (dom.dataset["jotRenderKey"] !== runtime.key(descriptor.node)) continue;
    runtime.update(dom, descriptor.node);
    dom.dataset["jotLiveInPlaceKey"] = key;
    dom.dataset["jotLiveInPlaceId"] = descriptor.node.id;
    dom.classList.toggle("jot-live-preview-widget--selected", descriptor.selected === true);
  }
}

function mapInPlaceWidgets(
  widgets: ReadonlyMap<string, LivePreviewWidgetDescriptor>,
  transaction: Transaction,
): ReadonlyMap<string, LivePreviewWidgetDescriptor> {
  if (!transaction.docChanged || widgets.size === 0) return widgets;
  const mapped = new Map<string, LivePreviewWidgetDescriptor>();
  for (const [key, descriptor] of widgets) {
    const range = parseInPlaceWidgetKey(key);
    if (range === undefined) continue;
    const from = transaction.changes.mapPos(range.from, 1);
    const to = transaction.changes.mapPos(range.to, -1);
    if (to < from) continue;
    mapped.set(
      inPlaceWidgetKey(from, to, descriptor),
      descriptor,
    );
  }
  return mapped;
}

function sameInPlaceDescriptor(
  left: LivePreviewWidgetDescriptor,
  right: LivePreviewWidgetDescriptor,
): boolean {
  return left.kind === right.kind &&
    left.block === right.block &&
    left.selection === right.selection &&
    left.geometry === right.geometry &&
    left.sourceCompanion === right.sourceCompanion &&
    left.selected === right.selected &&
    left.inPlaceUpdate === right.inPlaceUpdate &&
    left.node.id === right.node.id &&
    left.node.kind === right.node.kind &&
    left.node.contentVersion === right.node.contentVersion &&
    Number(left.node.sourceRange.from) === Number(right.node.sourceRange.from) &&
    Number(left.node.sourceRange.to) === Number(right.node.sourceRange.to);
}

function inPlaceWidgetKey(
  from: number,
  to: number,
  descriptor: LivePreviewWidgetDescriptor,
): string {
  return `${from}:${to}:${descriptor.kind}:${descriptor.node.id}`;
}

function parseInPlaceWidgetKey(key: string): { readonly from: number; readonly to: number } | undefined {
  const [from, to] = key.split(":", 3);
  const start = Number(from);
  const end = Number(to);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start
    ? { from: start, to: end }
    : undefined;
}

function findInPlaceWidgetDOM(
  root: HTMLElement,
  descriptor: LivePreviewWidgetDescriptor,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-jot-live-in-place-id]")) {
    if (
      element.dataset["jotLiveInPlaceId"] === descriptor.node.id &&
      element.dataset["jotKind"] === descriptor.node.kind
    ) {
      return element;
    }
  }
  return null;
}
