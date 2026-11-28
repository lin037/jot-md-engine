// Capacity probe against the real component, Worker and release Wasm.
// Build with `pnpm run wasm:demo` before running this script.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from "../support/browser-test-utils.mjs";

const output = resolve(process.env.JOT_LARGE_REPORT ?? "dist/large-document-report/report.json");
const sizes = (process.env.JOT_LARGE_MIB ?? "1,10").split(",").map(Number);
assert(sizes.every((size) => Number.isFinite(size) && size > 0), "sizes must be positive MiB values");
const profile = mkdtempSync(resolve(tmpdir(), "jot-large-"));
const results = [];
let server, chrome, client;
try {
  server = spawn(resolve("node_modules/.bin/vite"), ["--config", "apps/demo/vite.config.mjs", "--port", "4186", "--strictPort"], { stdio: "ignore" });
  await waitForHttp("http://127.0.0.1:4186/", 15_000);
  chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ["--headless=new", "--no-first-run", "--disable-background-networking", "--enable-precise-memory-info", "--remote-debugging-port=9338", `--user-data-dir=${profile}`, `http://127.0.0.1:4186/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`], { stdio: "ignore" });
  await waitForHttp("http://127.0.0.1:9338/json/version", 15_000);
  const pages = await fetch("http://127.0.0.1:9338/json/list").then((response) => response.json());
  client = await connectCdp(pages.find((page) => page.type === "page" && page.url.includes(":4186")).webSocketDebuggerUrl);
  await client.command("Runtime.enable");
  await client.command("Emulation.setDeviceMetricsOverride", { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await waitForEvaluation(client, "document.readyState === 'complete' && document.title === 'Jot native component integration fixture'", 15_000);
  for (const mib of sizes) {
    if (process.env.JOT_LARGE_PROFILE) {
      await client.command("Profiler.enable");
      await client.command("Profiler.start");
    }
    // Launch asynchronously: CDP's per-evaluation timeout must not become the
    // document's analysis deadline. Progress remains readable while it opens.
    await client.evaluate(String.raw`(() => {
      window.largeProbe = { done: false, stage: 'starting' };
      (async () => {
        const { MarkdownEditor } = await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
        const { createKaTeXRenderer } = await import('/@fs${process.cwd()}/packages/editor/src/components/math/katex.ts');
        const piece = '# Heading\n\n中文与 emoji 😀 **strong** and *emphasis* with [link](https://example.com).\n\n- item one\n- item two\n\n> quotation\n\n$x^2$\n\n';
        const pieceBytes = new TextEncoder().encode(piece).length;
        const source = piece.repeat(Math.ceil(${mib} * 1048576 / pieceBytes)) + '\nTAIL_SENTINEL';
        const bytes = new TextEncoder().encode(source).length;
        const root = document.createElement('div');
        root.style.cssText = 'height:700px;width:1000px;margin:10px';
        document.body.replaceChildren(root);
        const worker = new Worker('/src/worker.ts', { type: 'module' });
        const errors = [];
        const protocol = [];
        const longTasks = [];
        const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)));
        observer.observe({ type: 'longtask', buffered: false });
        let firstPreviewMs;
        let largestSyntaxUpdate = 0;
        const started = performance.now();
        const editor = new MarkdownEditor({ root, mode: 'live-preview',
          session: { endpoint: worker, documentId: 'large-${mib}', generation: 1, source, syntaxProfile: { id: 'default', version: 1, enabledExtensions: [] },
            onProtocolEvent: (event) => {
              const body = event.message.body;
              if (body.type === 'analysis-state-changed' && body.update?.syntax) {
                const inserted = body.update.syntax.blockChanges.reduce((count, change) => count + change.inserted.length, 0);
                largestSyntaxUpdate = Math.max(largestSyntaxUpdate, inserted);
              }
              if (protocol.length < 200 && (event.channel !== 'background' || body.analysis?.state === 'complete')) {
                protocol.push({ atMs: performance.now() - started, direction: event.direction, type: body.type,
                  state: body.analysis?.state, slices: body.projection?.slices?.map((slice) => ({ parentId: slice.parentId, window: slice.window, maxDepth: slice.maxDepth })),
                  operations: body.patch?.operations?.map((operation) => ({ total: operation.totalChildren, from: operation.from, count: operation.inserted.length })) });
              }
            } },
          livePreview: { renderMath: createKaTeXRenderer(), onCommit: (event) => {
            if (firstPreviewMs === undefined && event.visibleBlocks > 0 && event.projectedNodes > 0) {
              firstPreviewMs = performance.now() - started;
            }
          } }, onError: (error) => errors.push(String(error)),
        });
        let fullTextReads = 0;
        const cmDocument = editor.input.view.state.doc;
        const originalToString = cmDocument.toString.bind(cmDocument);
        Object.defineProperty(cmDocument, 'toString', { configurable: true, value: () => { fullTextReads += 1; return originalToString(); } });
        window.largeProbe.stage = 'opening';
        await editor.open();
        const openAcknowledgedMs = performance.now() - started;
        window.largeProbe.stage = 'background-analysis';
        const deadline = performance.now() + 180000;
        while (editor.session.adapter.analysis?.state !== 'complete') {
          if (performance.now() > deadline) throw new Error('analysis deadline exceeded');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const analysisCompleteMs = performance.now() - started;
        await editor.livePreview.settled();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const top = { ...editor.livePreview.snapshot };
        const readyMs = performance.now() - started;
        const view = editor.input.view;
        window.largeProbe.stage = 'tail-scroll';
        view.dispatch({ selection: { anchor: source.length }, scrollIntoView: true });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await editor.livePreview.settled();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await editor.livePreview.settled();
        const tail = { ...editor.livePreview.snapshot };
        const tailVisible = view.contentDOM.textContent.includes('TAIL_SENTINEL');
        const result = { mib: ${mib}, bytes, utf16: source.length, openAcknowledgedMs, firstPreviewCommitMs: firstPreviewMs,
          analysisCompleteMs, readyMs, tailVisible, top, tail, largestSyntaxUpdate, rootBlocks: editor.session.adapter.blocks.blocks.length,
          mountedElements: root.querySelectorAll('*').length, longTaskCount: longTasks.length,
          longTaskTotalMs: longTasks.reduce((sum, value) => sum + value, 0), maxLongTaskMs: Math.max(0, ...longTasks),
          heapBytes: performance.memory?.usedJSHeapSize, fullTextReads, errors, protocol };
        Reflect.deleteProperty(cmDocument, 'toString');
        observer.disconnect();
        editor.dispose(); worker.terminate();
        window.largeProbe = { done: true, result };
      })().catch((error) => { window.largeProbe = { done: true, error: String(error.stack ?? error) }; });
    })()`);
    await waitForEvaluation(client, "window.largeProbe.done", 240_000);
    const probe = await client.evaluate("window.largeProbe");
    if (process.env.JOT_LARGE_PROFILE) {
      const { profile: cpuProfile } = await client.command("Profiler.stop");
      writeFileSync(resolve(process.env.JOT_LARGE_PROFILE), JSON.stringify(cpuProfile));
    }
    assert.equal(probe.error, undefined, probe.error);
    results.push(probe.result);
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, JSON.stringify({ environment: await client.command("Browser.getVersion"), results }, null, 2) + "\n");
    assert.equal(probe.result.errors.length, 0, "component reported an error");
    assert(probe.result.fullTextReads <= 5, "background analysis must not repeatedly flatten unchanged CM Text");
    assert(probe.result.top.visibleBlocks > 0 && !probe.result.top.truncated, "first viewport must have a valid plan");
    assert(probe.result.tail.visibleBlocks > 0 && !probe.result.tail.truncated, "tail viewport must have a valid plan");
    assert(probe.result.tailVisible, "tail sentinel must be painted after jumping to EOF");
    assert(probe.result.mountedElements < 5_000, "mounted DOM must remain bounded");
    console.log(JSON.stringify({ mib, ...probe.result, top: undefined, tail: undefined, protocol: undefined }));
  }
} finally {
  client?.socket.close();
  await stopProcess(chrome);
  await stopProcess(server);
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
