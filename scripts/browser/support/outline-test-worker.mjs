import { bootstrapEditorWorker } from "../../../packages/editor/src/worker/index.ts";

// Let a pointer click race a real, partially parsed document on any test machine.
// Only the background parser pauses; foreground projections still use the Wasm host.
let paused = false;
let pending;
self.addEventListener("message", event => {
  if (event.data !== "pause-analysis" && event.data !== "resume-analysis") return;
  event.stopImmediatePropagation();
  paused = event.data === "pause-analysis";
  if (!paused && pending) {
    setTimeout(pending, 0);
    pending = undefined;
  }
});
await bootstrapEditorWorker({
  endpoint: self,
  loadWasm: () => import("../../../apps/demo/src/generated/editor_wasm.js"),
  scheduleTask(task) {
    if (paused) pending = task;
    else setTimeout(task, 0);
  },
});
