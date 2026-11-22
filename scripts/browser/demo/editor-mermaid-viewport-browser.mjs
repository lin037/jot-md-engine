// Regress page-level scrolling and real Mermaid staging, including source edit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port = Number(process.env.JOT_MERMAID_VIEWPORT_PORT ?? 4272);
const debugPort = Number(process.env.JOT_MERMAID_VIEWPORT_DEBUG_PORT ?? 9472);
const production = process.env.JOT_MERMAID_VIEWPORT_PREVIEW === '1' || process.argv.includes('--preview');
const output = resolve(process.env.JOT_MERMAID_VIEWPORT_REPORT ?? (production ? 'dist/mermaid-viewport-production-browser-report' : 'dist/mermaid-viewport-browser-report'));
const profile = mkdtempSync(resolve(tmpdir(), 'jot-mermaid-viewport-'));
mkdirSync(output, { recursive: true });
let server, chrome, client;
const evidence = [], errors = [];
const fence = '```';
const graph = `flowchart LR\n  SA[系统管理员 全平台] -->|创建和管理| P[项目]\n  P --> A[项目授权]\n  P --> B[用户组]\n  A --> C[接口调用]\n  B --> C`;
const source = `# 系统管理\n\n下方关系图使用独立渲染。\n\n${fence}mermaid\n${graph}\n${fence}\n\n## 后续内容\n\n滚动和编辑都应保持源码一致。`;
try {
  server = spawn(resolve('node_modules/.bin/vite'), [...(production ? ['preview'] : []), '--config', 'apps/demo/vite.config.mjs', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
  await waitForHttp(`http://127.0.0.1:${port}/`, 15_000);
  chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ['--headless=new', '--no-first-run', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`], { stdio: 'ignore' });
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 15_000);
  const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  client = await connectCdp(pages.find((page) => page.type === 'page' && page.url.includes(`:${port}`)).webSocketDebuggerUrl);
  client.socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text); });
  await client.command('Runtime.enable');
  await client.command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await waitForEvaluation(client, `location.origin==='http://127.0.0.1:${port}' && document.querySelector('#mode')?.disabled===false`, 30_000);
  await client.evaluate(`(async()=>{
    // Make a classic page scrollbar measurable without disabling it.
    const style=document.createElement('style');style.textContent='html::-webkit-scrollbar{width:16px;height:16px}html::-webkit-scrollbar-thumb{background:#777}';document.head.append(style);
    window.renderCalls=[];
    if (!${production}) {const {loadMermaid}=await import('/src/mermaid-loader.ts');const mermaid=(await loadMermaid()).default,original=mermaid.render.bind(mermaid);mermaid.render=(...args)=>{renderCalls.push({id:args[0],hasContainer:!!args[2]});return original(...args)}}
    window.pageSamples=[];window.stageEvents=[];
    window.samplePage=reason=>{const e=document.scrollingElement,r=document.querySelector('#editor-root').getBoundingClientRect(),s=document.querySelector('.cm-scroller')?.getBoundingClientRect();pageSamples.push({reason,height:e.scrollHeight,clientHeight:e.clientHeight,width:document.documentElement.clientWidth,innerWidth:innerWidth,left:r.left,right:r.right,editorWidth:r.width,scrollTop:e.scrollTop,scrollerWidth:s?.width})};
    window.pageObserver=new MutationObserver(records=>{for(const record of records)for(const node of [...record.addedNodes,...record.removedNodes]){if(node.nodeType!==1)continue;const el=node;if(el.id?.startsWith('djot-mermaid-')||el.hasAttribute('data-jot-mermaid-stage')){const r=el.getBoundingClientRect();stageEvents.push({id:el.id,stage:el.hasAttribute('data-jot-mermaid-stage'),connected:el.isConnected,rect:{x:r.x,y:r.y,width:r.width,height:r.height},bodyHeight:document.scrollingElement.scrollHeight});samplePage('stage-mutation')}}});
    pageObserver.observe(document.body,{childList:true});
    let active=true;window.stopFrames=()=>{active=false};const tick=()=>{if(!active)return;samplePage('frame');requestAnimationFrame(tick)};requestAnimationFrame(tick);samplePage('baseline');
  })()`);
  const baseline = await client.evaluate(`pageSamples[0]`);
  assert(baseline.height <= baseline.clientHeight + 1, 'the demo initially has no page overflow');
  await client.evaluate(`(()=>{
    // Reproduce a font notification while the edit's first root projection is in flight.
    const postMessage=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(message,...options){
      const body=message.body;
      if (body?.type==='project' && body.projection.revision>0 &&
          body.projection.slices.some(slice=>slice.parentId==='0' && slice.window.type==='around-range')) {
        Worker.prototype.postMessage=postMessage;
        window.resumeRootProjection=()=>postMessage.call(this,message,...options);
        return;
      }
      return postMessage.call(this,message,...options);
    };
    const view=document.querySelector('.cm-content').cmTile.root.view;
    view.focus();
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:${JSON.stringify(source)}},selection:{anchor:0}});
  })()`);
  await waitForEvaluation(client, `typeof window.resumeRootProjection==='function'`, 15_000);
  await client.evaluate(`(()=>{
    document.fonts.dispatchEvent(new Event('loadingdone'));
    window.resumeRootProjection();
  })()`);
  await waitForEvaluation(client, `document.querySelector('#status').textContent==='正文已确认' && !!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`, 60_000);
  const nodeFill = `getComputedStyle(document.querySelector('.jot-mermaid[data-jot-mermaid-theme="base"] .node rect')).fill`;
  assert.equal(await client.evaluate(nodeFill), 'rgb(232, 240, 232)', 'the light chart uses the Demo palette');
  await client.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const initial = await client.evaluate(`({samples:pageSamples,stages:stageEvents,calls:renderCalls,source:document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()})`);
  evidence.push({ case: 'diagram-render', ...initial });
  assert.equal(initial.source, source, 'rendering preserves the exact graph source');
  if (!production) assert(initial.calls.length > 0, 'the real Mermaid renderer was called');
  assert(initial.stages.length > 0, 'the real Mermaid drawing stage was observed');
  assert(initial.samples.every((sample) => sample.height <= sample.clientHeight + 1), 'rendering must not create a page scrollbar');
  assert(initial.stages.every((stage) => stage.stage), 'Mermaid scratch SVG must be contained in its own staging host');
  if (!production) assert(initial.calls.every((call) => call.hasContainer), 'every Mermaid render receives a staging container');
  assert(initial.samples.every((sample) => Math.abs(sample.editorWidth - baseline.editorWidth) < 1), 'page width stays stable while diagrams are rendered');
  assert(initial.samples.every((sample) => Math.abs(sample.left - baseline.left) < 1), 'the centered editor does not shift horizontally');
  const screenshot = await client.command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(output, 'diagram.png'), Buffer.from(screenshot.data, 'base64'));

  // A chart can finish drawing inside a document shorter than the viewport.
  // Its new height must move the gutter control along with the heading below it.
  const foldPoint = `(()=>{
    const heading=[...document.querySelectorAll('.cm-line.jot-md-heading')].find(line=>line.textContent==='后续内容');
    if (!heading) return false;
    const row=heading.getBoundingClientRect();
    for (const button of document.querySelectorAll('.jot-heading-fold-gutter button[data-jot-fold-id]')) {
      const rect=button.getBoundingClientRect(), x=rect.left+rect.width/2, y=rect.top+rect.height/2;
      if (Math.abs(y-(row.top+row.height/2))<2 && document.elementFromPoint(x,y)===button) return {x,y,id:button.dataset.jotFoldId};
    }
    return false;
  })()`;
  await waitForEvaluation(client, foldPoint, 5_000);
  const fold = await client.evaluate(foldPoint);
  const button = `document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="${fold.id}"]')`;
  const clickFold = async () => {
    const { x, y } = await client.evaluate(`(()=>{const r=${button}.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await client.command('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, x, y });
  };
  await clickFold();
  await waitForEvaluation(client, `${button}?.getAttribute('aria-expanded')==='false'`, 5_000);
  await clickFold();
  await waitForEvaluation(client, `${button}?.getAttribute('aria-expanded')==='true'`, 5_000);

  // Keep a genuine page scrollbar visible while a different theme requires a
  // fresh Mermaid render. Its page width and scroll position must stay put.
  const pageScroll = await client.evaluate(`(()=>{window.extraPage=document.createElement('div');extraPage.style.height='240px';extraPage.textContent='page overflow fixture';document.body.append(extraPage);const e=document.scrollingElement,hasOverflow=e.scrollHeight>e.clientHeight;window.scrollTo(0,100);window.pageSamples=[];samplePage('scroll-baseline');return{hasOverflow,top:e.scrollTop,height:e.scrollHeight,left:document.querySelector('#editor-root').getBoundingClientRect().left}})()`);
  assert(pageScroll.hasOverflow && pageScroll.top > 0, 'genuine page overflow remains scrollable');
  await client.evaluate(`document.querySelector('#theme').click()`);
  await waitForEvaluation(client, `document.querySelector('.jot-mermaid .node rect') && ${nodeFill}==='rgb(46, 70, 58)' && ${production ? "stageEvents.filter(event=>event.stage && event.connected).length>=2" : "renderCalls.length>=2"}`, 60_000);
  const scrollingRender = await client.evaluate(`({samples:pageSamples,calls:renderCalls.length,top:document.scrollingElement.scrollTop})`);
  assert(scrollingRender.samples.every((sample) => sample.height === pageScroll.height && Math.abs(sample.left - pageScroll.left) < 1), 'an existing page scrollbar remains stable during a new diagram render');
  assert(scrollingRender.samples.every((sample) => sample.scrollTop === pageScroll.top), 'diagram rendering does not temporarily move the page');
  assert.equal(scrollingRender.top, pageScroll.top, 'diagram rendering does not move an independently scrolled page');
  await client.evaluate(`(()=>{window.stopFrames();pageObserver.disconnect();extraPage.remove();window.scrollTo(0,0)})()`);
  const darkDiagram = await client.command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(output, 'diagram-dark.png'), Buffer.from(darkDiagram.data, 'base64'));
  evidence.push({ case: 'legitimate-page-scroll-during-render', ...pageScroll, calls: scrollingRender.calls, frames: scrollingRender.samples.length });

  // Enter the actual graph source and check every native line against CM's
  // authoritative line, not merely a screenshot or a duplicate textContent.
  const point = await client.evaluate(`(()=>{const r=document.querySelector('.jot-mermaid svg').getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await client.command('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  await waitForEvaluation(client, `!!document.querySelector('.jot-live-preview-code-scroll .jot-code-line') && !document.querySelector('.jot-plugin-block')`, 20_000);
  const editing = await client.evaluate(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view,w=document.querySelector('.jot-live-preview-code-scroll');const lines=[...w.querySelectorAll('.jot-code-line')].map(n=>{const pos=v.posAtDOM(n,0),line=v.state.doc.lineAt(pos);return{actual:n.textContent,expected:line.text}});const e=document.scrollingElement;return{source:v.state.doc.toString(),lines,outerOverflow:e.scrollWidth-e.clientWidth,wrapperCount:document.querySelectorAll('.jot-live-preview-code-scroll').length}})()`);
  assert.equal(editing.source, source);
  assert.equal(editing.wrapperCount, 1);
  assert(editing.lines.some((line) => line.expected.includes('系统管理员')) && editing.lines.every((line) => line.actual === line.expected), 'each displayed code line matches exactly one source line');
  assert(editing.outerOverflow <= 1, 'editable graph source cannot widen the page');
  evidence.push({ case: 'edit-diagram-source', ...editing });

  const longLabel = Array.from({ length: 72 }, (_, index) => `片段${String(index).padStart(2, '0')}管理员`).join(' ');
  const longSource = `# 系统管理\n\n${fence}mermaid\nflowchart LR\n  SA["${longLabel}"] --> P[项目]\n  P --> A[项目授权]\n${fence}\n\n## 后续内容`;
  const insideLabel = longSource.indexOf(longLabel) + 1;
  await client.evaluate(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.focus();v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(longSource)}},selection:{anchor:${insideLabel}}})})()`);
  await waitForEvaluation(client, `document.querySelector('#status').textContent==='正文已确认' && !!document.querySelector('.jot-live-preview-code-scroll .jot-code-line')`, 30_000);
  const longBefore = await client.evaluate(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view,w=document.querySelector('.jot-live-preview-code-scroll'),line=[...w.querySelectorAll('.jot-code-line')].find(n=>n.textContent.includes('SA[')),r=line.getBoundingClientRect(),p=w.getBoundingClientRect(),e=document.scrollingElement;return{actual:line.textContent,expected:v.state.doc.lineAt(v.posAtDOM(line,0)).text,scrollWidth:w.scrollWidth,clientWidth:w.clientWidth,outerOverflow:e.scrollWidth-e.clientWidth,point:{x:p.left+p.width/2,y:(r.top+r.bottom)/2}}})()`);
  assert.equal(longBefore.actual, longBefore.expected, 'a long graph source line is painted once');
  assert(longBefore.scrollWidth > longBefore.clientWidth + 100 && longBefore.outerOverflow <= 1, 'the long source scrolls within its code block');
  await client.command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...longBefore.point, deltaX: 600, deltaY: 0 });
  await waitForEvaluation(client, `document.querySelector('.jot-live-preview-code-scroll').scrollLeft>100`, 10_000);
  const longVisual = await client.evaluate(`(()=>{const w=document.querySelector('.jot-live-preview-code-scroll');return [w,...w.querySelectorAll('div')].map(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return{class:n.className,background:s.backgroundColor,backgroundImage:s.backgroundImage,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,scrollLeft:n.scrollLeft}})})()`);
  const sourceShot = await client.command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(output, 'source-edit.png'), Buffer.from(sourceShot.data, 'base64'));
  const samplePixels = await client.evaluate(`(async()=>{const image=new Image();image.src=${JSON.stringify('data:image/png;base64,')}+${JSON.stringify(sourceShot.data)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const w=document.querySelector('.jot-live-preview-code-scroll'),r=w.getBoundingClientRect();return [...w.querySelectorAll('.jot-live-preview-code-boundary')].map(n=>{const b=n.getBoundingClientRect(),y=Math.round((b.top+b.bottom)/2);return [r.left+20,r.right-20].map(x=>[...ctx.getImageData(Math.round(x),y,1,1).data])})})()`);
  evidence.push({ case: 'code-background-pixels', pixels: samplePixels });
  assert(samplePixels.length === 2 && samplePixels.every(([left, right]) => left.every((channel, index) => Math.abs(channel - right[index]) <= 1)), 'horizontal scrolling keeps the code block background uniform');
  await client.evaluate(`document.querySelector('#theme').click()`);
  await waitForEvaluation(client, `document.documentElement.dataset.theme==='light' && document.querySelector('.jot-live-preview-code-scroll')?.scrollLeft>100`, 20_000);
  await client.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const lightShot = await client.command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(output, 'source-edit-light.png'), Buffer.from(lightShot.data, 'base64'));
  const lightPixels = await client.evaluate(`(async()=>{const image=new Image();image.src=${JSON.stringify('data:image/png;base64,')}+${JSON.stringify(lightShot.data)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const w=document.querySelector('.jot-live-preview-code-scroll'),r=w.getBoundingClientRect();return [...w.querySelectorAll('.jot-live-preview-code-boundary')].map(n=>{const b=n.getBoundingClientRect(),y=Math.round((b.top+b.bottom)/2);return [r.left+20,r.right-20].map(x=>[...ctx.getImageData(Math.round(x),y,1,1).data])})})()`);
  assert(lightPixels.length === 2 && lightPixels.every(([left, right]) => left.every((channel, index) => Math.abs(channel - right[index]) <= 1)), 'the light theme also keeps a uniform code block background');
  evidence.push({ case: 'code-background-light-theme', pixels: lightPixels });
  for (const type of ['mousePressed', 'mouseReleased']) await client.command('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...longBefore.point });
  const at = await client.evaluate(`document.querySelector('.cm-content').cmTile.root.view.state.selection.main.head`);
  assert(at > longSource.indexOf(longLabel) && at < longSource.indexOf(longLabel) + longLabel.length, 'a click after horizontal scrolling maps into the actual label');
  await client.command('Input.insertText', { text: '测' });
  await waitForEvaluation(client, `document.querySelector('#status').textContent==='正文已确认'`, 20_000);
  const longAfter = await client.evaluate(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view,w=document.querySelector('.jot-live-preview-code-scroll'),line=[...w.querySelectorAll('.jot-code-line')].find(n=>n.textContent.includes('SA['));return{source:v.state.doc.toString(),actual:line.textContent,expected:v.state.doc.lineAt(v.posAtDOM(line,0)).text,scrollLeft:w.scrollLeft}})()`);
  assert.equal(longAfter.source, longSource.slice(0, at) + '测' + longSource.slice(at), 'editing updates exactly the selected source position');
  assert.equal(longAfter.actual, longAfter.expected, 'editing does not duplicate the visible source');
  assert(longAfter.scrollLeft > 100, 'the code viewport preserves the user-selected horizontal offset');
  evidence.push({ case: 'long-diagram-source-scroll-and-edit', at, beforeWidth: longBefore.scrollWidth, afterScroll: longAfter.scrollLeft, visual: longVisual });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ passed: true, baseline, evidence, errors }, null, 2));
  console.log(`Mermaid viewport browser checks passed: ${output}`);
} catch (error) {
  let state;
  try { state = await client?.evaluate(`({samples:window.pageSamples,stages:window.stageEvents,calls:window.renderCalls})`); } catch {}
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ passed: false, error: String(error.stack ?? error), evidence, state, errors }, null, 2));
  throw error;
} finally {
  client?.socket.close();
  await stopProcess(chrome);
  await stopProcess(server);
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
