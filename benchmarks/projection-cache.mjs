// Run after pnpm run build:editor. Only advancing the cached revision is timed.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ProjectionStore } from "../packages/editor/dist/adapter/projection-store.js";

const count = 4096;
const nodes = Array.from({ length: count }, (_, i) => ({
  id: String(i + 1), kind: "paragraph", mode: "hybrid", contentVersion: 0, childCount: 0,
  sourceRange: { from: i * 256 + 64, to: i * 256 + 80 }, attributes: [], content: { type: "source" },
}));
for (const editCount of [1, count]) {
  const edits = Array.from({ length: editCount }, (_, i) => ({
    range: { from: i * 256 + 4, to: i * 256 + 5 }, insert: "xy",
  }));
  const samples = [];
  for (let run = 0; run < 7; run++) {
    const store = new ProjectionStore();
    store.apply({ documentId: "cache", documentRevision: 0, viewRevision: 0, operations: [{
      type: "replace-children", parentId: "0", axis: "syntax-children", from: 0,
      removeCount: 0, inserted: nodes, totalChildren: count,
    }] });
    const start = performance.now();
    store.advanceRevision(1, edits);
    const elapsed = performance.now() - start;
    for (const [i, node] of nodes.entries()) {
      const delta = Math.min(i + 1, editCount);
      assert.deepEqual(store.nodeAt("0", "syntax-children", i)?.sourceRange,
        { from: node.sourceRange.from + delta, to: node.sourceRange.to + delta });
    }
    if (run >= 2) samples.push(elapsed);
  }
  console.log(JSON.stringify({ editCount, cachedNodes: count, node: process.version,
    warmups: 2, samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[2] }));
}
