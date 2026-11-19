// Exercise the shipped page through its controls and browser input, with no Demo test facade.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { findChrome, waitForHttp, connectCdp, waitForEvaluation, stopProcess } from "../support/browser-test-utils.mjs";

const output = resolve("dist/demo-browser-report");
const assets = resolve("dist/demo/assets");
const oversizedChunks = readdirSync(assets).filter(file => file.endsWith(".js") &&
  statSync(resolve(assets, file)).size > 500_000);
const base = process.env.JOT_DEMO_BROWSER_BASE ?? "/";
const url = new URL(base, "http://127.0.0.1:4180/").href;
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(resolve(tmpdir(), "jot-demo-test-"));
let server, chrome, client;
const evidence = [];
try {
  server = spawn(resolve("node_modules/.bin/vite"), ["preview", "--config", "apps/demo/vite.config.mjs", "--base", base, "--port", "4180", "--strictPort"], { stdio: "ignore" });
  await waitForHttp(url, 15000);
  chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ["--headless=new", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, url], { stdio: ["ignore", "ignore", process.env.CI ? "inherit" : "ignore"] });
  await waitForHttp("http://127.0.0.1:9333/json/version", 30_000);
  const pages = await fetch("http://127.0.0.1:9333/json/list").then(r => r.json());
  client = await connectCdp(pages.find(p => p.type === "page" && p.url.includes(":4180")).webSocketDebuggerUrl);
  await client.command("Runtime.enable");
  await wait(`document.querySelector('#mode')?.disabled === false`);
  assert.equal(await client.evaluate(`document.querySelector('#mode').value`), "live-preview", "Demo initially selects live preview");
  assert.equal(await client.evaluate(`document.querySelector('#editor-root').dataset.jotEditorMode`), "live-preview", "the selected default is actually mounted");
  await wait(`!!document.querySelector('.jot-katex .katex')`, 30000);
  assert.equal(await client.evaluate(`performance.getEntriesByType('resource').some(e=>/mermaid\.core/.test(e.name))`), false,
    "the default article must not load Mermaid before a diagram is visible");
  const initialScripts = await client.evaluate(`performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname.split('/').at(-1))`);
  assert.deepEqual(oversizedChunks.filter(file => initialScripts.includes(file)), [],
    "the default article must not fetch oversized JavaScript chunks");
  for (const width of [1440, 390]) {
    await client.command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const mode of ["split", "preview", "live-preview", "source", "pretext"]) {
      await choose("mode", mode);
      await wait(`document.querySelector('#editor-root').dataset.jotEditorMode === ${JSON.stringify(mode)}`);
      if (mode === "split" || mode === "preview") {
        await client.evaluate("document.querySelector('.jot-markdown-editor__surface').scrollTop=0");
      }
      await settle();
      const readBoxes = () => client.evaluate(`(() => {
        const root = document.querySelector('#editor-root');
        const pane = root.querySelector(${JSON.stringify(mode === "preview" || mode === "split" || mode === "pretext" ? ".jot-markdown-editor__surface" : ".cm-scroller")});
        const rect = pane.getBoundingClientRect();
        const nodes = [...pane.querySelectorAll('[data-jot-kind]')].filter(node => {
          const box = node.getBoundingClientRect();
          return box.height > 0 && box.bottom > rect.top && box.top < rect.bottom;
        });
        const foldButton = [...pane.querySelectorAll('.jot-heading-fold-gutter button[data-jot-fold-id]')].find(button => {
          const r = button.getBoundingClientRect();
          return r.width > 0 && r.top >= rect.top && r.bottom <= rect.bottom;
        });
        const buttonRect = foldButton?.getBoundingClientRect();
        const headingLine = buttonRect && [...pane.querySelectorAll('.cm-content .cm-line')].find(line => {
          const r = line.getBoundingClientRect();
          return r.top <= buttonRect.top + buttonRect.height / 2 && r.bottom >= buttonRect.top + buttonRect.height / 2;
        });
        return {
          width: innerWidth, mode: root.dataset.jotEditorMode,
          fontSize: parseFloat(getComputedStyle(pane.querySelector(${JSON.stringify(mode === "preview" || mode === "split" || mode === "pretext" ? ".jot-editor-content" : ".cm-content")})).fontSize),
          fontFamily: getComputedStyle(pane.querySelector(${JSON.stringify(mode === "preview" || mode === "split" || mode === "pretext" ? ".jot-editor-content" : ".cm-content")})).fontFamily,
          paragraphLineHeight: parseFloat(getComputedStyle(pane.querySelector(${JSON.stringify(mode === "preview" || mode === "split" || mode === "pretext" ? ".jot-editor-content" : ".cm-content")})).getPropertyValue('--jot-paragraph-line-height')),
          listMarkerGaps: [...pane.querySelectorAll('.jot-live-preview-list-item')].map(n=> {
            const row=getComputedStyle(n),marker=getComputedStyle(n,'::before');
            return parseFloat(row.paddingInlineStart)-parseFloat(marker.insetInlineStart)-parseFloat(marker.width);
          }),
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
          foldButton: buttonRect && headingLine ? {
            gap: headingLine.getBoundingClientRect().left - buttonRect.right,
            hit: document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2) === foldButton,
            gutterBackground: getComputedStyle(foldButton.closest('.cm-gutters')).backgroundColor,
            gutterBorder: parseFloat(getComputedStyle(foldButton.closest('.cm-gutters')).borderRightWidth),
          } : null,
          pane: { width: rect.width, height: rect.height, scrollWidth: pane.scrollWidth, clientWidth: pane.clientWidth },
          stacked: root.dataset.jotEditorMode==='split' && rect.top>=root.querySelector('.jot-markdown-editor__input').getBoundingClientRect().bottom-1,
          boxes: nodes.map(node => { const r = node.getBoundingClientRect(); const s = getComputedStyle(node); return {
            kind: node.dataset.jotKind, text: node.textContent.slice(0,100), x:r.x, y:r.y, width:r.width, height:r.height,
            fontSize:s.fontSize, lineHeight:s.lineHeight, display:s.display,
          }; }),
          inlineMath: [...pane.querySelectorAll('.jot-math-inline')].map(n=> { const r=n.getBoundingClientRect(); const h=n.querySelector('.katex-html')?.getBoundingClientRect(); return { left:r.left, right:r.right, contentRight:h?.right, paneLeft:rect.left, paneRight:rect.left + pane.clientLeft + pane.clientWidth }; }),
          headers: [...pane.querySelectorAll('.jot-table-grid-header .jot-table-cell')].map(n=>n.textContent),
          math: [...pane.querySelectorAll('.katex')].map(n=> {
            const hidden = n.querySelector('.katex-mathml')?.getBoundingClientRect();
            const html = n.querySelector('.katex-html')?.getBoundingClientRect();
            return { hiddenWidth:hidden?.width, hiddenHeight:hidden?.height, htmlWidth:html?.width, htmlHeight:html?.height };
          }),
          blocks: [...pane.querySelectorAll('.jot-editor-content > [data-jot-virtual-index]')].map(n=> {
            const r=n.getBoundingClientRect(); return { kind:n.dataset.jotKind, top:r.top, bottom:r.bottom, height:r.height };
          }),
          columns: [...pane.querySelectorAll('.jot-table-grid-header .jot-table-cell')].map(n=> {
            const r=n.getBoundingClientRect(); const body=pane.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="'+n.dataset.jotColumnIndex+'"]');
            const b=body?.getBoundingClientRect(); return {left:r.left,right:r.right,bodyLeft:b?.left,bodyRight:b?.right};
          }),
          error: document.querySelector('#status').dataset.error,
        };
      })()`);
      const boxes = await readBoxes();
      assert(!boxes.error, JSON.stringify(boxes));
      assert.equal(boxes.fontSize, 17, 'Demo typography reaches the actual visible host');
      assert.match(boxes.fontFamily, /system-ui/, 'Demo uses the system font in the visible host');
      if (mode !== 'source') assert(Math.abs(boxes.paragraphLineHeight - boxes.fontSize * 22 / 14) < 0.1,
        `Demo uses the font-relative default paragraph metric at ${width}/${mode}`);
      assert(boxes.pageOverflow <= 1, `page overflows at ${width}/${mode}`);
      assert(boxes.pane.width > 100 && boxes.pane.height > 300);
      if (mode === 'live-preview' || mode === 'source') {
        assert(boxes.foldButton?.hit && boxes.foldButton.gap >= 0 && boxes.foldButton.gap <= 25,
          `fold control must be clickable in the paper margin at ${width}/${mode}: ${JSON.stringify(boxes.foldButton)}`);
        assert.equal(boxes.foldButton.gutterBackground, 'rgba(0, 0, 0, 0)', 'sole fold gutter has no sidebar background');
        assert.equal(boxes.foldButton.gutterBorder, 0, 'sole fold gutter has no sidebar border');
      }
      if (mode !== "source") assert(boxes.boxes.length > 0, `no rendered boxes at ${width}/${mode}`);
      if (mode === "preview" || mode === "split") {
        if (mode === "split") assert.equal(boxes.stacked, width <= 600);
        for (const kind of ["heading", "paragraph"]) assert(boxes.boxes.some(b => b.kind === kind), `missing ${kind} at ${width}/${mode}`);
        let tableView = boxes;
        for (let step = 0; step < 3 && !tableView.boxes.some(b => b.kind === "table"); step++) {
          // A stacked reading pane may start with its table below the fold.
          await client.evaluate(`(()=>{const pane=document.querySelector('.jot-markdown-editor__surface');pane.scrollTop+=pane.clientHeight*.7})()`);
          await settle();
          tableView = await readBoxes();
        }
        assert(tableView.boxes.some(b => b.kind === "table"), `missing visible table at ${width}/${mode}`);
        assert.deepEqual(tableView.headers, ["名称", "说明"], `unhydrated header at ${width}/${mode}`);
        for (const snapshot of [boxes, tableView]) {
          assert(snapshot.pane.scrollWidth <= snapshot.pane.clientWidth + 1, `preview horizontal overflow at ${width}`);
          for (const [i, block] of snapshot.blocks.entries()) {
            assert(block.height > 0, `collapsed block: ${block.kind}`);
            if (i > 0) assert(block.top >= snapshot.blocks[i-1].bottom - 1, `overlapping blocks at ${width}/${mode}`);
          }
        }
        assert(tableView.columns.length === 2);
        for (const col of tableView.columns) {
          assert(Math.abs(col.left-col.bodyLeft) <= 1 && Math.abs(col.right-col.bodyRight) <= 1, "table header/body misaligned");
        }
        await client.evaluate("document.querySelector('.jot-markdown-editor__surface').scrollTop=0");
        await settle();
        assert(boxes.math.length > 0, "missing formula");
        for (const math of boxes.math) {
          assert(math.hiddenWidth <= 1 && math.hiddenHeight <= 1, "MathML must be accessible but visually hidden");
          assert(math.htmlWidth > 0 && math.htmlHeight > 0, "missing visible math layout");
        }
      }
      if (mode === "live-preview") {
        assert(boxes.listMarkerGaps.length > 0 && boxes.listMarkerGaps.every(gap=>gap>=4), 'compact list markers must leave readable space before text');
        assert(boxes.inlineMath.length > 0, "missing inline formula widget");
        for (const math of boxes.inlineMath) assert(math.left >= math.paneLeft - 1 && math.right <= math.paneRight + 1 && math.contentRight <= math.right + 1, `clipped inline math at ${width}`);
      }
      evidence.push(boxes);
      await screenshot(`${width}-${mode}`);
    }
  }
  // Image decoding changes a real box asynchronously; the end anchor must survive it.
  await choose("mode", "preview");
  await settle();
  await client.evaluate(`(() => { const p=document.querySelector('.jot-markdown-editor__surface'); p.scrollTop=p.scrollHeight; })()`);
  await wait(`(() => { const img=document.querySelector('.jot-markdown-editor__surface img'); return img?.complete && img.naturalWidth>0; })()`);
  await settle();
  const imageBox = await client.evaluate(`(() => {
    const p=document.querySelector('.jot-markdown-editor__surface'), img=p.querySelector('img');
    const r=img.getBoundingClientRect(), pane=p.getBoundingClientRect();
    const lastLine=document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().trimEnd().split('\\n').at(-1);
    const end=[...p.querySelectorAll('[data-jot-kind="paragraph"]')].find(n=>n.textContent===lastLine)?.getBoundingClientRect();
    return { width:r.width, height:r.height, naturalWidth:img.naturalWidth, available:p.clientWidth, endVisible:end!==undefined && end.top>=pane.top && end.bottom<=pane.bottom };
  })()`);
  assert(imageBox.width>0 && imageBox.height>0 && imageBox.width<=imageBox.available+1, "image box is missing or overflows");
  assert(imageBox.endVisible, "image decoding lost the document end");
  evidence.push({dataset:"article-image", ...imageBox});
  await screenshot("article-end");
  await client.evaluate(`document.querySelector('.jot-markdown-editor__surface').scrollTop=0`);
  // Real browser typing must become semantic DOM after the worker confirms it.
  await client.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await choose("mode", "split");
  await settle();
  await client.evaluate(`document.querySelector('.cm-content').focus()`);
  await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home", modifiers: 2 });
  await client.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home", modifiers: 2 });
  await client.command("Input.insertText", { text: "# 浏览器实际输入\n\n" });
  await wait(`document.querySelector('.jot-markdown-editor__surface [data-jot-kind="heading"]')?.textContent.includes('浏览器实际输入')`);
  await screenshot("edit-confirmed");
  // Unrelated later boxes must not be replaced by editing the first heading.
  await client.evaluate(`window.savedTable = document.querySelector('.jot-markdown-editor__surface [data-jot-kind="table"]')`);
  await client.command("Input.insertText", { text: "新增正文\n\n" });
  await wait(`document.querySelector('.jot-markdown-editor__surface')?.textContent.includes('新增正文')`);
  assert(await client.evaluate(`window.savedTable === document.querySelector('.jot-markdown-editor__surface [data-jot-kind="table"]')`), "unrelated table DOM replaced");
  // Exercise the production chunks as shipped, including the external-style
  // no-space fence and content after the diagram.
  await choose("mode", "live-preview");
  await wait(`document.querySelector('#editor-root').dataset.jotEditorMode === 'live-preview'`);
  await choose("sample", "mermaid");
  await client.evaluate(`document.querySelector('#load').click()`);
  await wait(`document.querySelector('#status').textContent === '正文已确认' && !!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`, 60000);
  assert(await client.evaluate(`document.querySelector('#mermaid').checked`), "Mermaid is enabled in the Demo");
  assert(await client.evaluate(`[...document.querySelectorAll('.jot-live-preview-source-heading')].some(n=>n.textContent.includes('图表后的章节'))`),
    "the heading after the unspaced diagram fence must remain a heading");
  assert(await client.evaluate(`performance.getEntriesByType('resource').some(e=>/mermaid\.core/.test(e.name))`),
    "the production page loads Mermaid when a diagram becomes visible");
  evidence.push({dataset:"production-mermaid", loaded:true});
  await screenshot("mermaid");
  // Load the large fixtures via the same controls exposed to consumers.
  for (const dataset of ["list", "table", "code", "text"]) {
    await choose("sample", dataset);
    await client.evaluate(`document.querySelector('.jot-markdown-editor__surface').scrollTop = 0`);
    await settle();
    await client.evaluate(`document.querySelector('#load').click()`);
    await choose("mode", "preview");
    const title = {list:"大列表", table:"大表格", code:"大代码块", text:"大文本"}[dataset];
    await wait(`document.querySelector('.jot-markdown-editor__surface [data-jot-kind="heading"]')?.textContent === ${JSON.stringify(title)}`, 90000);
    await wait(`document.querySelector('#status').textContent === '正文已确认'`, 90000);
    await settle();
    for (const ratio of [0, .5, 1]) {
      await client.evaluate(`(() => { const p = document.querySelector('.jot-markdown-editor__surface'); p.scrollTop = (p.scrollHeight-p.clientHeight)*${ratio}; })()`);
      await settle();
      const visible = await client.evaluate(`(() => {
        const p = document.querySelector('.jot-markdown-editor__surface'); const r = p.getBoundingClientRect();
        const nodes = [...p.querySelectorAll('[data-jot-kind]')].filter(n => { const b=n.getBoundingClientRect(); return b.width>0 && b.height>0 && b.bottom>r.top && b.top<r.bottom; });
        return { count:nodes.length, text:nodes.map(n=>n.textContent).join(' ').slice(-300), scrollTop:p.scrollTop, scrollHeight:p.scrollHeight, clientHeight:p.clientHeight, elements:p.querySelectorAll('*').length };
      })()`);
      assert(visible.count > 0, `blank viewport: ${dataset}/${ratio}`);
      assert(visible.elements < 3000, `unbounded DOM: ${dataset}`);
      if (ratio === 1) {
        const end = {list:"列表结束。", table:"表格结束。", code:"代码结束。", text:"长文档结束。"}[dataset];
        assert(visible.text.includes(end), `end marker not visible: ${dataset}`);
        assert(Math.abs(visible.scrollHeight-visible.clientHeight-visible.scrollTop) < 2, `did not reach scrollbar end: ${dataset}`);
      }
      evidence.push({ dataset, ratio, ...visible });
      await screenshot(`${dataset}-${ratio}`);
    }
    // Explicitly leaving the end must cancel the sticky end anchor.
    await client.evaluate(`(() => { const p=document.querySelector('.jot-markdown-editor__surface'); p.scrollTop=(p.scrollHeight-p.clientHeight)/2; })()`);
    await settle();
    assert(await client.evaluate(`(() => { const p=document.querySelector('.jot-markdown-editor__surface'); return p.scrollTop < (p.scrollHeight-p.clientHeight)*.9; })()`), `end anchor trapped scrolling: ${dataset}`);
  }
  writeFileSync(resolve(output, "report.json"), JSON.stringify({ status: "pass", evidence }, null, 2));
  console.log(`Native Demo browser checks passed; screenshots and boxes: ${output}`);
} catch (error) {
  if (client) await screenshot("failure").catch(() => {});
  writeFileSync(resolve(output, "report.json"), JSON.stringify({ status:"fail", error:String(error), evidence }, null, 2));
  throw error;
} finally {
  client?.socket.close();
  await stopProcess(chrome);
  await stopProcess(server);
  rmSync(profile, { recursive:true, force:true, maxRetries:20, retryDelay:100 });
}
function wait(expression, timeout=20000) { return waitForEvaluation(client, expression, timeout); }
async function choose(id, value) {
  await client.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
}
async function settle() {
  await client.evaluate(`document.fonts.ready`);
  await new Promise(r=>setTimeout(r, 400));
  await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}
async function screenshot(name) {
  const result = await client.command("Page.captureScreenshot", { format:"png" });
  writeFileSync(resolve(output, `${name}.png`), Buffer.from(result.data, "base64"));
}
