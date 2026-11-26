import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isMainThread, MessageChannel, Worker, workerData } from "node:worker_threads";
import { EditorDocumentSession, range } from "@jot-md/editor/adapter";
import { bootstrapEditorWorker } from "@jot-md/editor/worker";
import init, { WasmEditorHost } from "@jot-md/editor/wasm";

// 此文件由 package:verify 复制到已安装编辑器的临时项目中执行。
if (isMainThread) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), { workerData: port2, transferList: [port2] });
  const session = new EditorDocumentSession({
    endpoint: port1,
    documentId: "package-test",
    generation: 1,
    source: "# 😀\r\n\r\n- 第一项",
    syntaxProfile: { id: "default", version: 1, enabledExtensions: [] },
  });
  port1.start();
  const timeout = setTimeout(() => session.dispose(), 15_000);
  try {
    assert.ok((await session.handshake()).capabilities.includes("protocol-v1"));
    const viewport = { visibleRanges: [range(0, 4)] };
    await session.open(viewport);
    await session.transact({ origin: "keyboard", edits: [{ range: range(2, 4), insert: "标题" }], viewport });
    assert.equal(session.adapter.text.text, "# 标题\n\n- 第一项");
    const { renderPatch } = await session.projectRoot(0, 10);
    assert.ok(renderPatch.operations.length > 0);
    const kinds = session.adapter.blocks.blocks.map((block) => block.kind);
    assert.ok(kinds.includes("heading") && kinds.includes("list-item"));
    console.log("ok - installed packages: protocol v1, Worker/Wasm transaction and projection");
  } finally {
    clearTimeout(timeout);
    session.dispose();
    port1.close();
    await worker.terminate();
  }
} else {
  // Node 通过文件系统读取 Wasm；浏览器中的默认初始化器直接请求相邻的 .wasm 文件。
  const binary = new URL("./editor_wasm_bg.wasm", import.meta.resolve("@jot-md/editor/wasm"));
  const bytes = await readFile(binary);
  await bootstrapEditorWorker({
    endpoint: workerData,
    loadWasm: async () => ({ default: () => init({ module_or_path: bytes }), WasmEditorHost }),
  });
  workerData.start();
}
