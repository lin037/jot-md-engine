import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from "../support/browser-test-utils.mjs";

const port = 4285;
const debugPort = 9485;
const profile = mkdtempSync(resolve(tmpdir(), "jot-outline-"));
const root = "/@fs" + process.cwd();
let server, chrome, client;
const exceptions = [];
try {
  server = spawn(resolve("node_modules/.bin/vite"), ["--config", "apps/demo/vite.config.mjs", "--port", String(port), "--strictPort"], { stdio: "ignore" });
  await waitForHttp(`http://127.0.0.1:${port}/`, 15_000);
  const url = new URL(root + "/scripts/browser/support/editor-browser-fixture.html", `http://127.0.0.1:${port}`).href;
  chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ["--headless=new", "--no-first-run", "--disable-background-networking",
    "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profile, url], { stdio: "ignore" });
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 30_000);
  const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json());
  client = await connectCdp(pages.find(p => p.type === "page" && p.url === url).webSocketDebuggerUrl);
  client.socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
  });
  await client.command("Runtime.enable");
  const wait = expression => waitForEvaluation(client, expression, 20_000);
  const run = (fn, ...args) => client.evaluate(`(${fn})(${args.map(arg => JSON.stringify(arg)).join(",")})`);
  await wait("document.readyState === 'complete' && document.title === 'Jot native component integration fixture'");
  await run(async root => {
    const { MarkdownEditor, createHeadingFoldPlugin } = await import(root + "/packages/editor/src/index.ts");
    const { mountOutline, createOutlinePlugin } = await import(root + "/packages/editor/src/plugins/outline.ts");
    const source = ["# **甲😀**", "正文", "> # 引用", "```", "# 代码", "```", "$$", "# 数学", "$$",
      ...Array.from({ length: 45 }, (_, i) => "段 " + i + "\n"),
      "### [同名](https://example.com) ###", "正文", "## 同名", "######",
      ...Array.from({ length: 40 }, (_, i) => "后 " + i + "\n")].join("\n");
    const make = (tag, parent) => parent.appendChild(document.createElement(tag));
    const host = make("aside", document.body);
    const sibling = make("span", host);
    const editorRoot = make("main", document.body);
    editorRoot.style.cssText = "height:270px;width:650px;";
    host.style.cssText = "width:240px;--jot-outline-max-height:160px";
    const worker = new Worker("/src/worker.ts", { type: "module" });
    const state = window.f = { source, host, sibling, worker, mountOutline, errors: [], requests: 0, maxBatch: 0, maxMounted: 0, totals: [] };
    const recordError = error => state.errors.push(String(error));
    const editor = state.editor = new MarkdownEditor({ root: editorRoot, mode: "source",
      plugins: [createHeadingFoldPlugin(), createOutlinePlugin({ container: host, enabled: false, onError: recordError })],
      session: { endpoint: worker, documentId: "outline", generation: 1, source,
        syntaxProfile: { id: "default", version: 1, enabledExtensions: [] },
        onProtocolEvent({ direction, message }) {
          if (direction === "request" && message.body.projection?.slices.some(s => s.axis === "heading-outline")) state.requests++;
        } }, onError: recordError });
    editor.subscribe(effect => {
      for (const op of effect.renderPatch?.operations ?? []) if (op.axis === "heading-outline") {
        if (effect.projectionChanged) recordError("outline invalidated the shared projection cache");
        state.maxBatch = Math.max(state.maxBatch, op.inserted.length);
        state.totals.push(op.totalChildren);
      }
    });
    state.nav = () => host.querySelector(".jot-outline");
    state.buttons = () => Array.from(host.querySelectorAll(".jot-outline__row"));
    state.labels = () => state.buttons().map(b => b.textContent);
    new MutationObserver(() => {
      state.maxMounted = Math.max(state.maxMounted, state.buttons().length);
      if (state.labels().includes("过期")) recordError("a stale projection was painted");
    }).observe(host, { childList: true, subtree: true });
    await editor.open();
    await editor.settled();
  }, root);
  assert.equal(await run(() => f.requests), 0, "an unbound editor performs no outline queries");
  assert.equal(await run(async () => {
    const invalidate = f.editor.invalidateLayout.bind(f.editor);
    let calls = 0;
    f.editor.invalidateLayout = () => { calls++; return invalidate(); };
    try { await f.editor.setPluginEnabled("outline", true); } finally { f.editor.invalidateLayout = invalidate; }
    return calls;
  }), 0, "opening an external outline does not remeasure the editor");
  await wait("f.buttons().length === 4");
  assert.deepEqual(await run(() => f.labels()), ["甲😀", "同名", "同名", "无标题"]);
  const childOffset = await run(() => f.source.indexOf("### ["));
  for (const mode of ["source", "live-preview", "split", "preview", "pretext"]) {
    await run(async mode => {
      await f.editor.setMode(mode);
      await f.editor.settled();
      f.editor.input.setSelection(0);
      f.editor.surface.scrollToOffset(0);
      const firstHeading = f.editor.session.adapter.blocks.blocks.find(b => b.kind === "heading");
      if (!await f.editor.headingFolds.toggle(firstHeading.id)) throw new Error("fold not applied");
      await f.editor.settled();
      f.buttons()[1].click();
    }, mode);
    await wait("f.editor.headingFolds.ranges.length === 0");
    if (["source", "live-preview", "split"].includes(mode)) {
      await wait(`f.editor.input.view.state.selection.main.head === ${childOffset} && f.editor.input.view.scrollDOM.scrollTop > 0`);
    }
    if (["preview", "pretext", "split"].includes(mode)) {
      await wait(`Math.abs(f.editor.surface.captureScrollAnchor().sourceOffset - ${childOffset}) <= 4`);
    }
    assert.equal(await run(() => f.editor.mode), mode);
    assert.equal(await run(() => f.editor.value === f.source && f.editor.revision === 0), true);
  }
  await run(() => f.editor.setMode("source"));
  // Click the old DOM row in the same turn as an edit, before its offsets are confirmed.
  await run(() => {
    const view = f.editor.input.view;
    view.dispatch({ changes: { from: f.source.indexOf("正文") + 1, insert: "新😀" }, userEvent: "input.type" });
    f.buttons()[1].click();
  });
  await wait(`f.editor.input.view.state.selection.main.head === ${childOffset + 3}`);
  await run(() => f.editor.executeCommand("history.undo"));
  await wait("f.editor.confirmedValue === f.source");
  await run(() => f.editor.setValue("无标题的正文"));
  await wait("f.buttons().length === 0 && f.nav().textContent.includes('暂无标题')");
  // Hold one real Worker result while the editor confirms a newer revision.
  await run(() => {
    const original = f.editor.session.project.bind(f.editor.session);
    f.editor.session.project = async (...args) => {
      if (!args[0].some(s => s.axis === "heading-outline")) return original(...args);
      const oldResult = await original(...args);
      f.editor.session.project = original;
      await new Promise(resolve => { f.release = resolve; });
      return oldResult;
    };
    f.editor.setValue("# 过期");
  });
  await wait("typeof f.release === 'function'");
  await run(async () => { f.editor.setValue("# 新标题"); await f.editor.input.settled(); f.release(); });
  await wait("f.labels().join() === '新标题'");
  await run(() => f.editor.setValue(Array.from({ length: 3000 }, (_, i) => "## 标题 " + i + "\n段落 " + i).join("\n")));
  await wait("f.totals.at(-1) === 3000 && f.labels()[0] === '标题 0'");
  await run(() => {
    const first = f.buttons()[0];
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  });
  await wait("document.activeElement?.textContent === '标题 2999'");
  await run(() => { f.editor.setReadOnly(true); document.activeElement.click(); });
  await wait("f.editor.input.view.state.selection.main.head === f.editor.value.lastIndexOf('## 标题 2999')");
  assert.equal(await run(() => f.editor.input.view.state.readOnly), true);
  await run(async () => {
    await f.editor.setMode("preview");
    f.nav().scrollTop = 2500 * 32;
  });
  await wait("f.buttons().some(b => b.textContent === '标题 2500')");
  await run(() => f.buttons().find(b => b.textContent === "标题 2500").click());
  await wait(`(() => {
    const pane = f.editor.surfacePane.getBoundingClientRect();
    const heading = [...f.editor.surfacePane.querySelectorAll('[data-jot-kind="heading"]')].find(n => n.textContent.includes("标题 2500"));
    const rect = heading?.getBoundingClientRect();
    return rect && rect.top < pane.bottom && rect.bottom > pane.top;
  })()`);
  const metrics = await run(() => ({ headings: f.totals.at(-1), maxMounted: f.maxMounted, maxBatch: f.maxBatch }));
  assert(metrics.maxMounted > 0 && metrics.maxMounted <= 48, JSON.stringify(metrics));
  assert(metrics.maxBatch > 0 && metrics.maxBatch <= 48, JSON.stringify(metrics));
  // Report timings without tying correctness to the development machine's speed.
  const timings = await run(async () => {
    await f.editor.settled();
    const samples = [];
    for (let i = 0; i < 31; i++) {
      const from = i * 97;
      const start = performance.now();
      await f.editor.session.project([{ parentId: "0", axis: "heading-outline",
        window: { type: "index", from, toExclusive: from + 24 }, maxDepth: 0 }]);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { samples: samples.length, warmWindowP50ms: +samples[15].toFixed(2), warmWindowP95ms: +samples[29].toFixed(2) };
  });
  await run(() => f.editor.setPluginEnabled("outline", false));
  const disabledRequests = await run(() => f.requests);
  await run(async () => { f.editor.setReadOnly(false); f.editor.setValue("# 已关闭"); await f.editor.settled(); });
  assert.equal(await run(() => f.requests), disabledRequests);
  assert.equal(await run(() => f.host.childNodes.length === 1 && f.sibling.isConnected), true);
  // A second host (inside a shadow root) can bind the same editor and clean up independently.
  await run(() => {
    const panel = document.body.appendChild(document.createElement("section")).attachShadow({ mode: "open" });
    f.other = panel.appendChild(document.createElement("div"));
    f.binding = f.mountOutline(f.host, f.editor);
    f.mountOutline(f.other, f.editor);
  });
  await wait("f.labels()[0] === '已关闭' && f.other.querySelector('button')?.textContent === '已关闭'");
  await run(async root => {
    f.binding.dispose();
    const { MarkdownEditor } = await import(root + "/packages/editor/src/index.ts");
    const worker = f.worker2 = new Worker("/src/worker.ts", { type: "module" });
    // Deliver foreground responses normally but hold background progress. This
    // lets the first confirmed page and final index be checked independently.
    const endpoint = new EventTarget();
    endpoint.postMessage = message => worker.postMessage(message);
    const held = [];
    const forward = event => endpoint.dispatchEvent(new MessageEvent("message", { data: event.data }));
    let hold = true;
    worker.addEventListener("message", event => {
      if (hold && event.data.body.type === "analysis-state-changed") held.push(event);
      else forward(event);
    });
    f.releaseAnalysis = () => { hold = false; held.splice(0).forEach(forward); };
    const editorRoot = document.body.appendChild(document.createElement("main"));
    editorRoot.style.cssText = "height:240px;width:650px";
    const next = f.editor2 = new MarkdownEditor({ root: editorRoot, mode: "source",
      session: { endpoint, documentId: "second", generation: 1,
        source: Array.from({ length: 3000 }, (_, i) => "# 另一个文档 " + i + "\n段落").join("\n"),
        syntaxProfile: { id: "default", version: 1, enabledExtensions: [] } } });
    f.mountOutline(f.host, next);
    await next.open();
  }, root);
  await wait("f.editor2.session.adapter.analysis.state === 'pending' && f.labels()[0] === '另一个文档 0' && f.nav().getAttribute('aria-busy') === 'true'");
  assert.equal(await run(() => f.other.querySelector("button").textContent), "已关闭");
  await run(() => f.releaseAnalysis());
  await wait("f.nav().getAttribute('aria-busy') === 'false' && f.nav().scrollHeight === 3000 * 32");
  await run(() => { f.editor.dispose(); f.worker.terminate(); });
  assert.equal(await run(() => !!f.nav() && !f.other.firstChild), true);
  await run(() => { f.editor2.dispose(); f.worker2.terminate(); });
  assert.equal(await run(() => !f.nav() && f.sibling.isConnected), true);
  assert.deepEqual(await run(() => f.errors), []);
  assert.deepEqual(exceptions, []);
  console.log("outline browser passed", JSON.stringify({ ...metrics, ...timings }));
} finally {
  client?.socket.close();
  await stopProcess(chrome);
  await stopProcess(server);
  rmSync(profile, { recursive: true, force: true });
}
