import type {
  BlockMetadata,
  RenderNode,
  SyntaxPatchSummary,
  TextEdit,
  TextRange,
} from "@jot-md/editor-protocol";

import { range } from "./text-model.js";
import { EditRangeIndex } from "./edit-batch.js";
import { spliceItems } from "./array-splice.js";

export interface IndexedBlock extends BlockMetadata {
  readonly dirty: boolean;
}

/** 顶层语法索引；嵌套 ListItem/TableRow 索引仍由 Rust 持有。 */
export class SyntaxBlockIndex {
  #blocks: IndexedBlock[] = [];
  #version = 0;

  /** Changes even when a syntax patch splices the existing array in place. */
  get version(): number {
    return this.#version;
  }

  get blocks(): readonly IndexedBlock[] {
    return this.#blocks;
  }

  /** Find one confirmed owner for an ordered batch that cannot touch a neighboring root. */
  batchOwner(edits: readonly TextEdit[]): number | undefined {
    return edits.length >= 2 ? this.#editOwner(edits) : undefined;
  }

  #editOwner(edits: readonly TextEdit[]): number | undefined {
    const first = edits[0]!.range;
    const last = edits.at(-1)!.range;
    const index = this.blockAt(Number(first.from));
    const block = index === undefined ? undefined : this.#blocks[index];
    if (block === undefined || block.dirty || last.to > block.sourceRange.to ||
        (first.from === first.to && first.from === block.sourceRange.from) ||
        (last.from === last.to && last.to === block.sourceRange.to)) return undefined;
    return index;
  }

  applyTextEdits(edits: readonly TextEdit[]): void {
    if (edits.length === 0) return;
    this.#version += 1;
    const owner = this.#editOwner(edits);
    if (owner !== undefined) {
      const delta = edits.reduce((length, edit) =>
        length + edit.insert.length - (Number(edit.range.to) - Number(edit.range.from)), 0);
      const block = this.#blocks[owner]!;
      this.#blocks[owner] = {
        ...block,
        sourceRange: range(Number(block.sourceRange.from), Number(block.sourceRange.to) + delta),
        dirty: true,
      };
      if (delta !== 0) {
        for (let index = owner + 1; index < this.#blocks.length; index += 1) {
          const following = this.#blocks[index]!;
          if (following.kind !== "unloaded") this.#blocks[index] = shifted(following, delta);
        }
      }
      return;
    }
    // Map each root once. Edits strictly before it contribute only a net shift.
    // Intersections still use the original revision in reverse order, including
    // insertions at a shared boundary that invalidate both neighboring roots.
    const changes = new EditRangeIndex(edits);
    this.#blocks = this.#blocks.map(block => {
      if (block.kind === "unloaded") return block;
      let from = Number(block.sourceRange.from), to = Number(block.sourceRange.to);
      const low = changes.firstEndingAtOrAfter(from);
      let end = low;
      while (end < edits.length && edits[end]!.range.from <= to) end++;
      let dirty = block.dirty;
      for (let i = end - 1; i >= low; i--) {
        const edit = edits[i]!.range;
        const delta = changes.deltaBefore(i + 1) - changes.deltaBefore(i);
        if (edit.from === edit.to && from <= edit.from && edit.from <= to) {
          to += delta;
          dirty = true;
        } else if (from >= edit.to) {
          from += delta;
          to += delta;
        } else if (to > edit.from) {
          to = Math.max(from, to + delta);
          dirty = true;
        }
      }
      from += changes.deltaBefore(low);
      to += changes.deltaBefore(low);
      return from === block.sourceRange.from && to === block.sourceRange.to && dirty === block.dirty
        ? block : { ...block, sourceRange: range(from, to), dirty };
    });
  }

  applySyntaxPatch(patch: SyntaxPatchSummary): void {
    if (patch.blockChanges.length > 0 || this.#blocks.length > patch.totalBlocks) {
      this.#version += 1;
    }
    for (const change of patch.blockChanges) {
      const inserted = change.inserted.map((block) => ({ ...block, dirty: false }));
      spliceItems(this.#blocks, change.fromBlock, change.removeCount, inserted);
    }
    if (this.#blocks.length > patch.totalBlocks) {
      this.#blocks.length = patch.totalBlocks;
    }
  }

  seedProjection(fromBlock: number, blocks: readonly RenderNode[], totalBlocks: number): void {
    let changed = this.#blocks.length !== totalBlocks;
    if (this.#blocks.length !== totalBlocks) {
      this.#blocks = Array.from({ length: totalBlocks }, (_, index) =>
        this.#blocks[index] ?? placeholder(index),
      );
    }
    blocks.forEach((block, offset) => {
      const previous = this.#blocks[fromBlock + offset];
      if (previous !== undefined && !previous.dirty &&
          previous.id === block.id && previous.kind === block.kind &&
          previous.contentVersion === block.contentVersion &&
          previous.sourceRange.from === block.sourceRange.from &&
          previous.sourceRange.to === block.sourceRange.to) return;
      changed = true;
      this.#blocks[fromBlock + offset] = {
        id: block.id,
        kind: block.kind,
        sourceRange: block.sourceRange,
        contentVersion: block.contentVersion,
        dirty: false,
      };
    });
    if (changed) this.#version += 1;
  }

  blockAt(offset: number): number | undefined {
    let from = 0;
    let to = this.#blocks.length;
    while (from < to) {
      const middle = from + Math.floor((to - from) / 2);
      const block = this.#blocks[middle]!;
      if (Number(block.sourceRange.to) < offset) from = middle + 1;
      else to = middle;
    }
    const block = this.#blocks[from];
    return block !== undefined &&
      Number(block.sourceRange.from) <= offset &&
      offset <= Number(block.sourceRange.to)
      ? from
      : undefined;
  }
}

function shifted(block: IndexedBlock, delta: number): IndexedBlock {
  return {
    ...block,
    sourceRange: range(
      Number(block.sourceRange.from) + delta,
      Number(block.sourceRange.to) + delta,
    ),
  };
}

function placeholder(index: number): IndexedBlock {
  const empty: TextRange = range(0, 0);
  return {
    id: `unloaded:${index}`,
    kind: "unloaded",
    sourceRange: empty,
    contentVersion: 0,
    dirty: true,
  };
}
