import type { RenderNode } from "@jot-md/editor-protocol";
import { Annotation } from "@codemirror/state";
import { createClosedContainerModel } from "../../components/closed-container/model.js";

export interface EmptyClosedContainer {
  readonly nodeId: string;
  readonly kind: "fenced-code" | "math-block";
  readonly from: number;
  readonly to: number;
  readonly position: number;
  readonly closing: { readonly from: number; readonly to: number };
}

/** Internal proof that this input belongs to a confirmed zero-width body. */
export const emptyContainerFirstInput = Annotation.define<{
  readonly nodeId: string;
  readonly position: number;
  readonly kind: "fenced-code" | "math-block";
}>();

/**
 * An opening immediately followed by its closer has no physical body row.
 * Identify that case from confirmed component ranges, never from raw markers.
 */
export function resolveEmptyClosedContainer(
  nodes: readonly RenderNode[],
  position: number,
): EmptyClosedContainer | undefined {
  let best: EmptyClosedContainer | undefined;
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const model = createClosedContainerModel(node);
    if (model !== undefined && model.openingRange.to < model.closingRange.from &&
        Number(model.contentRange.from) === position &&
        Number(model.contentRange.to) === position &&
        Number(model.closingRange.from) === position) {
      const candidate = {
        nodeId: model.id,
        kind: model.kind,
        from: Number(model.sourceRange.from),
        to: Number(model.sourceRange.to),
        position,
        closing: { from: Number(model.closingRange.from), to: Number(model.closingRange.to) },
      };
      if (best === undefined || candidate.to - candidate.from < best.to - best.from) best = candidate;
    }
    if (node.content.type === "structured") pending.push(...node.content.children);
  }
  return best;
}

export interface EmptyClosedContainerSeparator {
  readonly from: number;
  readonly to: number;
  readonly insert: "\n";
}

/**
 * Append a separator to the same transaction that makes the first real input.
 * Offsets are in the new document after that input; the caller retains the
 * user's original selection before this separator. Planning uses only a
 * UTF-16 length, so pasting a large block does not copy its entire text.
 */
export function planEmptyClosedContainerSeparator(
  block: EmptyClosedContainer,
  insertedUtf16Length: number,
): EmptyClosedContainerSeparator | undefined {
  if (!Number.isSafeInteger(insertedUtf16Length) || insertedUtf16Length <= 0) return undefined;
  const end = block.position + insertedUtf16Length;
  if (!Number.isSafeInteger(end)) return undefined;
  return {
    from: end,
    to: end,
    insert: "\n",
  };
}
