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
  const press = async (key, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"]) {
      await client.command("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode });
    }
  };
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
    const editor = state.editor = new MarkdownEditor({ root: editorRoot, mode: "source", locale: "zh-CN",
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
  assert.deepEqual(await run(() => f.buttons().map(b => [b.getAttribute("aria-level"), b.getAttribute("aria-expanded")])),
    [["1", "true"], ["2", null], ["2", "true"], ["3", null]]);
  assert.deepEqual(await run(() => f.buttons().map(row => {
    const icon = row.querySelector(".jot-outline__chevron");
    if (!icon) return null;
    const css = getComputedStyle(icon);
    return [icon.getAttribute("aria-hidden"), css.strokeLinecap, css.transform];
  })), [["true", "round", "none"], null, ["true", "round", "none"], null]);
  const caret = await run(() => {
    f.editor.commands.configureShortcuts({ "focus.editor": "F8", "focus.outline": "F9" });
    f.editor.input.setSelection(3, 5);
    f.editor.focus();
    const view = f.editor.input.view;
    return [view.state.selection.main.anchor, view.state.selection.main.head, view.scrollDOM.scrollTop];
  });
  await press("F9", 120);
  await wait("document.activeElement === f.buttons()[0]");
  await press("ArrowDown", 40);
  await wait("document.activeElement === f.buttons()[1]");
  await press("F8", 119);
  await wait("f.editor.input.view.hasFocus");
  assert.deepEqual(await run(() => {
    const view = f.editor.input.view;
    return [view.state.selection.main.anchor, view.state.selection.main.head, view.scrollDOM.scrollTop];
  }), caret, "focus navigation preserves selection and scroll position");
  await run(() => {
    f.properties = document.body.appendChild(document.createElement("aside"));
    f.properties.tabIndex = -1;
    f.editor.commands.register({ id: "focus.properties", title: "聚焦属性面板", requiresInput: false,
      run: () => ({ action: "focus.properties", userEvent: "command.focus.properties" }) });
    f.releaseProperties = f.editor.registerFocusTarget("focus.properties", f.properties);
    f.editor.commands.configureShortcuts({ "focus.properties": "F10" });
  });
  await press("F10", 121);
  await wait("document.activeElement === f.properties");
  await press("F8", 119);
  await wait("f.editor.input.view.hasFocus");
  assert.equal(await run(() => {
    f.releaseProperties();
    f.properties.remove();
    return f.editor.executeCommand("focus.properties");
  }), false, "custom focus targets can be removed without losing their shortcut slot");
  await run(() => f.editor.input.setSelection(0));
  await run(() => {
    f.buttons()[2].querySelector(".jot-outline__toggle").click();
    f.treeKey = (i, key) => {
      const row = f.buttons()[i];
      row.focus();
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };
  });
  await wait("f.buttons().length === 3");
  assert.equal(await run(() => getComputedStyle(f.buttons()[2].querySelector(".jot-outline__chevron")).transform), "matrix(0, -1, 1, 0, 0, 0)");
  await run(() => f.treeKey(0, "ArrowLeft"));
  await wait("f.labels().join() === '甲😀'");
  assert.deepEqual(await run(() => [f.editor.revision, f.editor.input.view.state.selection.main.head, f.editor.headingFolds.ranges.length]), [0, 0, 0]);
  await run(() => {
    f.mirror = document.body.appendChild(document.createElement("aside"));
    f.mirrorBinding = f.mountOutline(f.mirror, f.editor, { scrollbar: "native" });
  });
  await wait("f.mirror.querySelectorAll('[role=treeitem]').length === 4 && f.buttons().length === 1");
  assert.equal(await run(() => f.mirror.querySelector("[role=scrollbar]") === null), true);
  await run(() => { f.mirrorBinding.dispose(); f.mirror.remove(); f.treeKey(0, "ArrowRight"); });
  await wait("f.buttons().length === 3 && f.buttons()[2].getAttribute('aria-expanded') === 'false'");
  await run(() => f.treeKey(0, "ArrowRight"));
  await wait("document.activeElement === f.buttons()[1]");
  await run(() => f.treeKey(1, "ArrowLeft"));
  await wait("document.activeElement === f.buttons()[0]");
  await run(() => f.treeKey(2, "ArrowRight"));
  await wait("f.buttons().length === 4");
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
    if (mode === "preview") {
      await run(() => f.editor.focus());
      await press("F9", 120);
      await wait("f.buttons().includes(document.activeElement)");
      await press("F8", 119);
      await wait("document.activeElement === f.editor.surfacePane");
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
  await run(() => f.treeKey(2, "ArrowLeft"));
  await wait("f.buttons().length === 3");
  await run(() => {
    f.editedRequests = f.requests;
    f.editor.input.view.dispatch({ changes: { from: f.source.indexOf("正文") + 1, insert: "改" }, userEvent: "input.type" });
  });
  await wait("f.requests > f.editedRequests && f.nav().getAttribute('aria-busy') === 'false' && f.buttons().length === 3 && f.buttons()[2].getAttribute('aria-expanded') === 'false'");
  await run(() => f.editor.setValue("无标题的正文"));
  await wait("f.buttons().length === 0 && f.nav().textContent.includes('暂无标题')");
  await run(() => f.editor.focus());
  await press("F9", 120);
  await wait("document.activeElement === f.nav()");
  await press("F8", 119);
  await wait("f.editor.input.view.hasFocus");
  // Project long wrapped cells on both sides of the last heading in a narrow writing pane.
  const geometryFixture = await run(async () => {
    const view = f.editor.input.view;
    const root = view.dom.closest("main");
    const savedStyle = root.style.cssText;
    root.style.cssText = "height:360px;width:340px;";
    const text = "窄窗口中的长文字会换行。".repeat(10);
    const table = "| A | B | C |\n|---|---|---|\n" +
      Array.from({ length: 8 }, (_, i) => `| ${i} | ${text} | ${text} |`).join("\n");
    f.outlineFixture = "### First\n" + (text + "\n\n").repeat(25) + "### Middle\n" +
      text + "\n\n" + table + "\n\n### Last\n\n" + table;
    f.editor.setValue(f.outlineFixture);
    await f.editor.settled();
    return savedStyle;
  });
  await wait("f.labels().join() === 'First,Middle,Last'");
  for (const mode of ["source", "live-preview"]) {
    await run(async mode => { await f.editor.setMode(mode); await f.editor.settled(); }, mode);
    for (const target of [1, 2]) {
      await run(() => f.buttons()[0].click());
      await wait("f.editor.input.view.state.selection.main.head === 0");
      const trace = await run(async index => {
        const view = f.editor.input.view, scroll = view.scrollDOM;
        const title = f.buttons()[index].textContent;
        const offset = f.outlineFixture.indexOf("### " + title);
        f.buttons()[index].click();
        const samples = [];
        for (let i = 0; i < 30; ++i) {
          await new Promise(requestAnimationFrame);
          if (view.state.selection.main.head !== offset) continue;
          const row = [...view.contentDOM.querySelectorAll(".cm-line")].find(line => line.textContent.includes(title));
          samples.push(row ? Math.round(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top) : null);
        }
        return { samples, line: view.defaultLineHeight, padding: view.documentPadding.top };
      }, target);
      const aligned = y => y !== null && y >= -1 && y <= trace.padding + trace.line;
      const first = trace.samples.findIndex(aligned);
      assert.ok(first >= 0 && trace.samples.slice(first).every(aligned),
        mode + " must retain " + (target === 2 ? "Last" : "Middle") + " at the top through table measurement: " + JSON.stringify(trace.samples));
      if (mode === "live-preview" && target === 2) {
        const landing = await run(async () => {
          await f.editor.settled();
          const view = f.editor.input.view;
          const row = [...view.contentDOM.querySelectorAll(".cm-line")].find(line => line.textContent.includes("Last"));
          return {
            top: row ? row.getBoundingClientRect().top - view.scrollDOM.getBoundingClientRect().top : null,
            tables: view.contentDOM.querySelectorAll(".jot-table").length,
          };
        });
        assert.equal(landing.tables, 2, "the settled jump restores the normal projection on both sides of Last");
        assert.ok(aligned(landing.top), "Last remains aligned when both tables have mounted: " + JSON.stringify(landing));
      }
    }
  }
  const hostScroll = await run(async () => {
    await f.editor.settled();
    const scroll = f.editor.input.view.scrollDOM;
    const before = scroll.scrollTop;
    scroll.scrollTop = 0;
    await f.editor.settled();
    return { before, after: scroll.scrollTop };
  });
  assert.ok(hostScroll.before > 0, "the outline jump must start away from the top");
  assert.ok(hostScroll.after <= 1, "a settled outline jump must release the viewport: " + JSON.stringify(hostScroll));
  await run(() => f.buttons().at(-1).click());
  await wait(`(() => {
    const view = f.editor.input.view;
    const row = [...view.contentDOM.querySelectorAll(".cm-line")].find(line => line.textContent.includes("Last"));
    return row && Math.abs(row.getBoundingClientRect().top - view.scrollDOM.getBoundingClientRect().top) <= view.defaultLineHeight;
  })()`);
  const wheelPoint = await run(async () => {
    await f.editor.settled();
    const scroll = f.editor.input.view.scrollDOM;
    scroll.scrollIntoView({ block: "center" });
    const box = scroll.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + f.editor.input.view.defaultLineHeight / 2 };
  });
  await client.command("Input.dispatchMouseEvent", { type: "mouseWheel", ...wheelPoint, deltaX: 0, deltaY: -140 });
  const userScrolled = `(() => {
    const view = f.editor.input.view;
    const row = [...view.contentDOM.querySelectorAll(".cm-line")].find(line => line.textContent.includes("Last"));
    return row && row.getBoundingClientRect().top - view.scrollDOM.getBoundingClientRect().top > 60;
  })()`;
  await wait(userScrolled);
  await run(() => f.editor.settled());
  assert.ok(await client.evaluate(userScrolled), "a later table measurement must respect manual scrolling");

  // A short last section may leave room above it. That part of the table must remain rendered.
  await run(async () => {
    f.editor.setValue(f.outlineFixture.slice(0, f.outlineFixture.indexOf("### Last") + "### Last".length));
    await f.editor.settled();
  });
  await wait("f.labels().at(-1) === 'Last' && f.nav().getAttribute('aria-busy') === 'false'");
  await run(() => f.buttons().at(-1).click());
  await wait("f.editor.input.view.state.selection.main.head === f.editor.value.indexOf('### Last')");
  await run(() => f.editor.settled());
  const tail = await run(() => {
    const view = f.editor.input.view, box = view.scrollDOM.getBoundingClientRect();
    const row = [...view.contentDOM.querySelectorAll(".cm-line")].find(line => line.textContent.includes("Last"));
    const table = view.contentDOM.querySelector(".jot-table");
    return { heading: !!row && row.getBoundingClientRect().top >= box.top && row.getBoundingClientRect().bottom <= box.bottom + 1,
      table: !!table && table.getBoundingClientRect().bottom > box.top && table.getBoundingClientRect().top < box.bottom };
  });
  assert.deepEqual(tail, { heading: true, table: true }, "the end of the document keeps adjacent visible content");
  await run(async style => {
    f.editor.input.view.dom.closest("main").style.cssText = style;
    await f.editor.setMode("source");
    f.editor.setValue(f.source);
    await f.editor.settled();
  }, geometryFixture);
  await wait("f.labels()[0] === '甲😀'");
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
  await wait("getComputedStyle(f.host.querySelector('[role=scrollbar]')).display !== 'none'");
  // Keep the first window in flight. A direct jump must render the newer target
  // before the older result returns, even when the user reverses direction.
  await run(() => {
    const project = f.editor.session.project.bind(f.editor.session);
    f.editor.session.project = async (...args) => {
      if (!args[0].some(s => s.axis === "heading-outline")) return project(...args);
      f.editor.session.project = project;
      const old = await project(...args);
      await new Promise(resolve => { f.releaseScroll = resolve; });
      return old;
    };
    f.nav().scrollTop = 400 * 32;
  });
  await wait("typeof f.releaseScroll === 'function'");
  const point = await run(() => {
    const bar = f.host.querySelector("[role=scrollbar]");
    const rect = bar.getBoundingClientRect(), thumb = bar.firstElementChild.getBoundingClientRect();
    const css = getComputedStyle(bar), inset = parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop);
    const travel = rect.height - 2 * inset - thumb.height;
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + inset + thumb.height / 2 + .63 * travel);
    if (document.elementFromPoint(x, y) !== bar || bar.getAttribute("aria-controls") !== f.nav().id) throw new Error("outline track is obstructed or unbound");
    bar.addEventListener("pointerdown", () => { f.pressedTop = f.nav().scrollTop; }, { once: true });
    const expected = (y - rect.top - inset - thumb.height / 2) / travel * (f.nav().scrollHeight - f.nav().clientHeight);
    return { x, y, expected };
  });
  const mouse = (type, x, y, buttons) => client.command("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
  await mouse("mousePressed", point.x, point.y, 1);
  assert(Math.abs(await run(() => f.pressedTop) - point.expected) <= 2, "track click jumps proportionally on pointerdown");
  await mouse("mouseReleased", point.x, point.y, 0);
  await wait("f.buttons().some(b => Number(b.dataset.index) === Math.floor(f.nav().scrollTop / 32))");
  await run(() => f.releaseScroll());
  const thumb = await run(() => {
    const bar = f.host.querySelector("[role=scrollbar]");
    const rect = bar.firstElementChild.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, bottom: bar.getBoundingClientRect().bottom };
  });
  await mouse("mousePressed", thumb.x, thumb.y, 1);
  await mouse("mouseMoved", thumb.x, thumb.bottom, 1);
  await mouse("mouseReleased", thumb.x, thumb.bottom, 0);
  await wait("f.nav().scrollTop === f.nav().scrollHeight - f.nav().clientHeight && f.labels().includes('标题 2999')");
  await run(() => f.host.querySelector("[role=scrollbar]").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  await wait("f.nav().scrollTop === 0 && f.labels()[0] === '标题 0'");
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
  // Long labels exercise both the Worker's range projection and the actual sidebar DOM.
  // Keep full-document analysis outside the jump timings.
  await run(async () => {
    f.editor.setReadOnly(false);
    await f.editor.setMode("source");
    const unit = "排版😀";
    const ordinary = unit.repeat(512);
    const source = Array.from({ length: 1024 }, (_, i) =>
      "# " + i + " " + (i === 512 ? unit.repeat(16_384) : ordinary)).join("\n");
    f.longLength = source.length;
    const stop = f.editor.subscribe(effect => {
      if (effect.analysis?.state === "complete" && f.editor.confirmedValue.length === f.longLength) {
        f.longAnalysisMs = Math.round(performance.now() - f.longStart);
        stop();
      }
    });
    f.longStart = performance.now();
    f.nav().scrollTop = 0;
    f.editor.setValue(source);
  });
  await wait("f.totals.at(-1) === 1024 && f.labels()[0]?.startsWith('0 ') && f.nav().getAttribute('aria-busy') === 'false'");
  const longTitles = await run(async () => {
    const setupMs = Math.round(performance.now() - f.longStart);
    const samples = [];
    let maxRows = 0, maxLabel = 0;
    for (const index of [512, 80, 970, 235, 601, 43, 872, 180, 693, 325, 988, 552, 134]) {
      const start = performance.now();
      f.nav().scrollTop = index * 32;
      await new Promise((resolve, reject) => {
        function waitForRow() {
          if (f.buttons().some(b => b.textContent.startsWith(index + " "))) requestAnimationFrame(resolve);
          else if (performance.now() - start > 5000) reject(new Error("outline did not show heading " + index));
          else requestAnimationFrame(waitForRow);
        }
        waitForRow();
      });
      samples.push(performance.now() - start);
      maxRows = Math.max(maxRows, f.buttons().length);
      for (const label of f.labels()) {
        maxLabel = Math.max(maxLabel, label.length);
        if (!label.endsWith("…") || !label.isWellFormed()) throw new Error("invalid outline abbreviation");
      }
    }
    samples.sort((a, b) => a - b);
    return { headings: 1024, sourceUtf16: f.longLength, longestTitleUtf16: 65_540, setupMs, analysisMs: f.longAnalysisMs, maxRows, maxLabel,
      jumps: samples.length, jumpP50ms: Math.round(samples[6]), jumpP95ms: Math.round(samples[12]),
      directScrollbar: f.nav().classList.contains("jot-direct-scrollbar-host") };
  });
  assert(longTitles.maxRows <= 48 && longTitles.maxLabel <= 161, JSON.stringify(longTitles));
  assert(longTitles.directScrollbar);
  console.log("outline long titles", JSON.stringify(longTitles));
  await run(() => f.editor.setPluginEnabled("outline", false));
  assert.equal(await run(() => f.editor.executeCommand("focus.outline")), false);
  assert.equal(await run(() => f.editor.commands.shortcuts.find(key => key.command === "focus.outline")?.key), "F9");
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
  await run(() => f.other.querySelector("button").focus());
  await press("F8", 119);
  await wait("f.editor.input.view.hasFocus");
  await run(async root => {
    f.binding.dispose();
    const { MarkdownEditor } = await import(root + "/packages/editor/src/index.ts");
    const worker = f.worker2 = new Worker(root + "/scripts/browser/support/outline-test-worker.mjs", { type: "module" });
    worker.postMessage("pause-analysis");
    const editorRoot = document.body.appendChild(document.createElement("main"));
    editorRoot.style.cssText = "height:240px;width:650px";
    const next = f.editor2 = new MarkdownEditor({ root: editorRoot, mode: "source",
      session: { endpoint: worker, documentId: "second", generation: 1,
        source: Array.from({ length: 3000 }, (_, i) => (i === 0 || i === 2999 ? "# " : "## ") + "另一个文档 " + i + "\n段落").join("\n"),
        syntaxProfile: { id: "default", version: 1, enabledExtensions: [] } } });
    next.subscribe(effect => {
      const outline = effect.renderPatch?.operations.find(op => op.axis === "heading-outline");
      if (outline) {
        f.secondBatch = { visible: outline.totalChildren, received: outline.inserted.length };
        f.secondOutlineRevision = effect.renderPatch.documentRevision;
      }
    });
    f.mountOutline(f.host, next);
    await next.open();
  }, root);
  await wait("f.editor2.session.adapter.analysis.state === 'pending' && f.labels()[0] === '另一个文档 0' && f.nav().getAttribute('aria-busy') === 'true'");
  assert.equal(await run(() => f.other.querySelector("button").textContent), "已关闭");
  await run(() => f.worker2.postMessage("resume-analysis"));
  await wait("f.nav().getAttribute('aria-busy') === 'false' && f.nav().scrollHeight === 3000 * 32");
  await run(() => f.buttons()[0].querySelector(".jot-outline__toggle").click());
  await wait("f.labels().join(',') === '另一个文档 0,另一个文档 2999'");
  assert.deepEqual(await run(() => f.secondBatch), { visible: 2, received: 2 });
  assert.equal(await run(() => f.editor2.revision), 0);
  // Click once while the heading is known but its section end is still unparsed.
  await client.command("Browser.grantPermissions", {
    origin: new URL(url).origin, permissions: ["clipboardSanitizedWrite"],
  });
  for (const mode of ["source", "split"]) {
    await run(async mode => {
      await f.editor2.setMode(mode);
      f.pasteSource = "# Start\n\n" + "Paragraph.\n\n".repeat(25) + "## Target\n\nbody";
      f.editor2.setValue(f.pasteSource);
    }, mode);
    // Replacing the document can change heading IDs while preserving both labels.
    await wait("f.editor2.confirmedValue === f.pasteSource && f.secondOutlineRevision === f.editor2.revision && f.labels().join() === 'Start,Target' && f.nav().getAttribute('aria-busy') === 'false'");
    await run(async () => {
      f.worker2.postMessage("pause-analysis");
      f.pasteSection = null;
      f.stopPasteProbe = f.editor2.subscribe(effect => {
        const heading = effect.renderPatch?.operations.find(op => op.axis === "heading-section")?.inserted[0];
        if (heading) f.pasteSection = {
          offset: heading.sourceRange.from,
          complete: heading.attributes.find(attr => attr.name === "confirmed").value.value,
        };
      });
      f.editor2.input.setSelection(f.pasteSource.length);
      f.editor2.focus();
      const text = "\n\nPasted paragraph.".repeat(15000).slice(0, 248944 - f.pasteSource.length);
      await navigator.clipboard.writeText(text);
      f.trustedPaste = false;
      f.editor2.input.view.contentDOM.addEventListener("paste", event => { f.trustedPaste = event.isTrusted; }, { once: true });
    });
    await client.command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, commands: ["Paste"] });
    await client.command("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86 });
    await wait("f.trustedPaste && f.editor2.input.view.state.selection.main.head === 248944 && f.editor2.session.adapter.analysis.state === 'pending'");
    const target = mode === "source" ? "Start" : "Target";
    const point = await run(target => {
      const row = f.buttons().find(button => button.textContent === target);
      row.scrollIntoView({ block: "center" });
      const rect = row.querySelector(".jot-outline__label").getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, target);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await client.command("Input.dispatchMouseEvent", { ...point, type, button: "left", clickCount: 1 });
    }
    await wait("f.pasteSection !== null");
    const offset = await run(target => f.pasteSource.indexOf(target === "Start" ? "# Start" : "## Target"), target);
    assert.deepEqual(await run(() => f.pasteSection), { offset, complete: false }, "heading identity is confirmed before its section end");
    assert.equal(await run(() => f.editor2.input.view.state.selection.main.head), offset, mode + " first click during analysis");
    if (mode === "split") {
      await wait(`Math.abs(f.editor2.surface.captureScrollAnchor().sourceOffset - ${offset}) <= 1`);
    }
    await run(() => { f.stopPasteProbe(); f.worker2.postMessage("resume-analysis"); });
    await wait("f.editor2.session.adapter.analysis.state === 'complete'");
    assert.equal(await run(() => f.editor2.input.view.state.selection.main.head), offset);
  }
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
