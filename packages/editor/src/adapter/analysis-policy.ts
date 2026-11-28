import type {
  AnalysisPurpose,
  AnalysisRequest,
  AnalysisWorkBudget,
  ProjectionMode,
  TextEdit,
  TextRange,
} from "@jot-md/editor-protocol";

import { range } from "./text-model.js";

export interface EditorViewport {
  readonly visibleRanges: readonly TextRange[];
  readonly activeRange?: TextRange;
}

export interface AnalysisPolicyInput {
  readonly edits: readonly TextEdit[];
  readonly viewport: EditorViewport;
  readonly mode: ProjectionMode;
  readonly documentUtf16Length: number;
  /** Source before `edits`; enables UTF-16-safe hints without copying the document. */
  readonly sourceBeforeEdits?: string;
  readonly purpose?: AnalysisPurpose;
}

export interface EditorAnalysisBudgets {
  readonly interactive: AnalysisWorkBudget;
  readonly bulk: AnalysisWorkBudget;
}

export const DEFAULT_EDITOR_BUDGETS: EditorAnalysisBudgets = {
  interactive: { maxSourceLines: 96, maxBlocks: 48, maxUtf16Units: 16_384 },
  bulk: { maxSourceLines: 32, maxBlocks: 16, maxUtf16Units: 8_192 },
};

export function createAnalysisRequest(
  input: AnalysisPolicyInput,
  budgets: EditorAnalysisBudgets = DEFAULT_EDITOR_BUDGETS,
): AnalysisRequest {
  const insertedUnits = input.edits.reduce((total, edit) => total + edit.insert.length, 0);
  const removedUnits = input.edits.reduce(
    (total, edit) => total + Number(edit.range.to) - Number(edit.range.from),
    0,
  );
  const bulk = insertedUnits + removedUnits >= 16_384 || input.edits.length > 8;
  const initialBudget = bulk ? budgets.bulk : budgets.interactive;
  // A dispersed batch still commits every edit. Only the viewport needs priority
  // when its edit locations outnumber the foreground parsing budget.
  const changed = input.edits.length > initialBudget.maxBlocks ? [] : mapChangedRanges(input.edits);
  const purpose =
    input.purpose ?? (input.mode === "source" ? "interactive" : "preview");
  const codeUnitAt = input.sourceBeforeEdits === undefined ? undefined :
    targetCodeUnitReader(input.sourceBeforeEdits, input.edits);
  return {
    priority: {
      priorityRanges: clampRanges(changed, input.documentUtf16Length, codeUnitAt),
      visibleRanges: clampRanges(input.viewport.visibleRanges, input.documentUtf16Length, codeUnitAt),
      ...(input.viewport.activeRange === undefined
        ? {}
        : { activeRange: clampRange(input.viewport.activeRange, input.documentUtf16Length, codeUnitAt) }),
      urgency: bulk ? "normal" : "interactive",
    },
    consistency: "allow-partial",
    purpose,
    initialBudget,
  };
}

export function mapChangedRanges(edits: readonly TextEdit[]): readonly TextRange[] {
  let delta = 0;
  return edits.map((edit) => {
    const from = Number(edit.range.from) + delta;
    const result = range(from, from + edit.insert.length);
    delta += edit.insert.length - (Number(edit.range.to) - Number(edit.range.from));
    return result;
  });
}

function clampRanges(ranges: readonly TextRange[], length: number, codeUnitAt?: (offset: number) => number): TextRange[] {
  return ranges.map((value) => clampRange(value, length, codeUnitAt));
}

function clampRange(value: TextRange, length: number, codeUnitAt?: (offset: number) => number): TextRange {
  let from = Math.max(0, Math.min(length, Number(value.from)));
  let to = Math.max(from, Math.min(length, Number(value.to)));
  const splitsPair = (position: number): boolean => {
    if (codeUnitAt === undefined || position <= 0 || position >= length) return false;
    const previous = codeUnitAt(position - 1), next = codeUnitAt(position);
    return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  };
  if (from === to && splitsPair(from)) {
    from -= 1;
    to = from;
  } else {
    if (splitsPair(from)) from -= 1;
    if (splitsPair(to)) to += 1;
  }
  return range(from, to);
}

/** Index target-revision spans without allocating another complete document. */
function targetCodeUnitReader(source: string, edits: readonly TextEdit[]): (offset: number) => number {
  const spans: Array<{ text: string; sourceStart: number; targetStart: number; targetEnd: number }> = [];
  let sourceCursor = 0, targetCursor = 0;
  const append = (text: string, from: number, to: number): void => {
    if (to <= from) return;
    const targetEnd = targetCursor + to - from;
    spans.push({ text, sourceStart: from, targetStart: targetCursor, targetEnd });
    targetCursor = targetEnd;
  };
  for (const edit of edits) {
    append(source, sourceCursor, Number(edit.range.from));
    append(edit.insert, 0, edit.insert.length);
    sourceCursor = Number(edit.range.to);
  }
  append(source, sourceCursor, source.length);
  return (offset) => {
    let low = 0, high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle]!.targetEnd <= offset) low = middle + 1;
      else high = middle;
    }
    const span = spans[low];
    return span === undefined || offset < span.targetStart ? NaN :
      span.text.charCodeAt(span.sourceStart + offset - span.targetStart);
  };
}
