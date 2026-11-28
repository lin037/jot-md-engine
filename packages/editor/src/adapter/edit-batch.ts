import type { TextEdit, TextRange } from "@jot-md/editor-protocol";
import { range } from "./text-model.js";

/** Coordinates in one validated, ordered batch. All input offsets belong to the old revision. */
export class EditRangeIndex {
  readonly #deltas = [0];

  constructor(private readonly edits: readonly TextEdit[]) {
    let delta = 0;
    for (const { range, insert } of edits) {
      delta += insert.length - (range.to - range.from);
      this.#deltas.push(delta);
    }
  }

  deltaBefore(index: number): number {
    return this.#deltas[index]!;
  }

  firstEndingAtOrAfter(offset: number): number {
    let low = 0, high = this.edits.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.edits[mid]!.range.to < offset) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  touches(span: TextRange): boolean {
    for (let i = this.firstEndingAtOrAfter(span.from); i < this.edits.length; i++) {
      const { from, to } = this.edits[i]!.range;
      if (from > span.to) break;
      // An insertion belongs to both neighbors at their shared boundary.
      if (from === to || (span.from < to && from < span.to)) return true;
    }
    return false;
  }

  mapRange(span: TextRange): TextRange {
    return range(this.mapBoundary(span.from, 1), this.mapBoundary(span.to, -1));
  }

  private mapBoundary(offset: number, association: -1 | 1): number {
    // Right-associated positions include every edit ending at the offset.
    const i = this.firstEndingAtOrAfter(association > 0 ? offset + 1 : offset);
    const edit = this.edits[i];
    const delta = this.deltaBefore(i);
    if (edit === undefined || offset < edit.range.from) return offset + delta;
    return edit.range.from + delta + (association > 0 ? edit.insert.length : 0);
  }
}

/** Shared invalidation threshold for projection identities and measured viewport geometry. */
export function replacesMostDocument(edits: readonly TextEdit[], newLength: number): boolean {
  let removed = 0, inserted = 0;
  for (const edit of edits) {
    removed += edit.range.to - edit.range.from;
    inserted += edit.insert.length;
  }
  const oldLength = newLength - inserted + removed;
  return oldLength > 0 && removed / oldLength >= 0.6;
}
