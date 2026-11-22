// E2E: real component, Worker, browser scroll track and partially loaded index.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_SCROLL_TEST_PORT??4331),debugPort=Number(process.env.JOT_SCROLL_TEST_DEBUG_PORT??9531);
const repetitions=Number(process.env.JOT_SCROLL_TEST_REPEAT??1);
assert(Number.isSafeInteger(repetitions)&&repetitions>0);
const profile=mkdtempSync(resolve(tmpdir(),'jot-scroll-e2e-'));
let server,chrome,c;
try{
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking','--disable-renderer-backgrounding',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  c=await connectCdp(pages.find(page=>page.type==='page'&&page.url.includes(`:${port}`)).webSocketDebuggerUrl);
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const wait=(expr,timeout=30000)=>waitForEvaluation(c,expr,timeout);
  const frame=()=>c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  // The native scroll limit is rounded. The text can be fully visible while
  // a fraction of the empty leading on its line box extends past the pane.
  const visibleText = `(line, pane) => {
    if (!line) return false;
    const range=line.ownerDocument.createRange();
    range.selectNodeContents(line);
    const text=range.getBoundingClientRect(), bounds=pane.getBoundingClientRect();
    return text.height>0 && text.top>=bounds.top && text.bottom<=bounds.bottom;
  }`;
  await wait(`document.readyState==='complete' && document.title==='Jot native component integration fixture'`);
  await c.evaluate(`(()=>{window.probe={stage:'starting',errors:[],held:[],holding:true};(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const {sample}=await import('/src/sample.ts');
    const root=document.createElement('div');root.style.cssText='width:900px;height:760px;margin:10px';document.body.replaceChildren(root);
    const source=sample('text').repeat(${repetitions})+'\\nSCROLL_PROBE_END';
    const worker=new Worker('/src/worker.ts',{type:'module'});window.worker=worker;window.source=source;
    const listeners=new Map(),endpoint={postMessage(value){worker.postMessage(value)},
      addEventListener(type,listener){const wrapped=event=>{if(type==='message'&&probe.holding&&event.data?.body?.type==='analysis-state-changed')probe.held.push(()=>listener(event));else listener(event)};listeners.set(listener,wrapped);worker.addEventListener(type,wrapped)},
      removeEventListener(type,listener){const wrapped=listeners.get(listener);if(wrapped)worker.removeEventListener(type,wrapped);listeners.delete(listener)}};
    window.releaseAnalysis=async()=>{while(probe.held.length){probe.held.shift()();await Promise.resolve()}probe.holding=false};
    probe.started=performance.now();window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint,documentId:'scroll-e2e',generation:1,source,syntaxProfile:{id:'default',version:1,enabledExtensions:[{id:'commonmark-fence-language',version:'1.0.0'}]}},onError:e=>probe.errors.push(String(e))});
    window.view=editor.input.view;await editor.open();probe.openMs=performance.now()-probe.started;probe.stage='opened';
  })().catch(e=>{probe.errors.push(String(e));probe.stage='failed'})})()`);
  await wait(`probe.stage==='opened'||probe.stage==='failed'`,180000);
  assert.equal(await c.evaluate('probe.stage'),'opened',JSON.stringify(await c.evaluate('probe.errors')));
  await wait(`(()=>{const b=editor.session.adapter.blocks.blocks;return editor.session.adapter.analysis?.state==='pending'&&b.some(x=>x.kind==='unloaded')&&b.some(x=>x.kind!=='unloaded')})()`,60000);
  await wait(`!![...document.querySelectorAll('.jot-direct-scrollbar')].find(n=>getComputedStyle(n).display!=='none')`);
  const snapshot=()=>c.evaluate(`(()=>{const d=view.scrollDOM,p=d.getBoundingClientRect(),t=[...document.querySelectorAll('.jot-direct-scrollbar')].find(n=>getComputedStyle(n).display!=='none'),b=t.querySelector('.jot-direct-scrollbar__thumb'),tr=t.getBoundingClientRect(),br=b.getBoundingClientRect(),line=view.lineBlockAtHeight(d.scrollTop+view.documentPadding.top),blocks=editor.session.adapter.blocks.blocks;return{scroll:d.scrollTop,max:Math.max(0,d.scrollHeight-d.clientHeight),head:view.state.selection.main.head,doc:view.state.doc.length,sourceAt:line.from,analysis:editor.session.adapter.analysis?.state,loaded:blocks.filter(x=>x.kind!=='unloaded').length,blocks:blocks.length,track:{top:tr.top,bottom:tr.bottom,left:tr.left,right:tr.right,thumbTop:br.top,thumbBottom:br.bottom,value:Number(t.getAttribute('aria-valuenow')),max:Number(t.getAttribute('aria-valuemax'))},visible:[...view.contentDOM.querySelectorAll('.cm-line,.jot-live-preview-widget--block')].filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>p.top&&r.top<p.bottom}).slice(0,10).map(n=>({text:n.textContent.slice(0,60),class:n.className}))}})()`);
  const initial=await snapshot();
  assert(initial.track.thumbBottom>initial.track.thumbTop,'the initial scrollbar has a measurable thumb');
  const pane=await c.evaluate(`(()=>{const r=view.scrollDOM.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
  await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...pane,deltaX:0,deltaY:14000});
  await wait('view.scrollDOM.scrollTop>1000');await frame();
  const pending=await snapshot();
  const physicalRatio=pending.scroll/pending.max,thumbRatio=pending.track.value/pending.track.max;
  assert(physicalRatio>0&&physicalRatio<.8,'the wheel leaves the viewport inside the document');
  assert(Math.abs(thumbRatio-physicalRatio)<.03,`an incomplete syntax index must not claim an end-of-document scrollbar: ${JSON.stringify({physicalRatio,thumbRatio,pending})}`);
  const trackX=(pending.track.left+pending.track.right)/2;
  const targetY=pending.track.top+(pending.track.bottom-pending.track.top)*.65;
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:trackX,y:targetY});
  await frame();const clicked=await snapshot();
  assert(Math.abs(clicked.scroll/clicked.max-.65)<.08,`track click reaches its physical proportion while analysis is incomplete: ${JSON.stringify(clicked)}`);
  assert.equal(clicked.head,initial.head,'using the scrollbar preserves the editor selection');

  // The track is clipped by the window even when the editor element itself
  // keeps its height. Its thumb must use the new track dimensions immediately.
  await c.command('Emulation.setDeviceMetricsOverride',{width:1280,height:500,deviceScaleFactor:1,mobile:false});
  await frame();const resized=await snapshot();
  const thumbTravel=(resized.track.bottom-resized.track.top)-6-(resized.track.thumbBottom-resized.track.thumbTop);
  const thumbPosition=(resized.track.thumbTop-resized.track.top-3)/Math.max(1,thumbTravel);
  assert(resized.track.thumbBottom<=resized.track.bottom-2,`resize keeps the thumb inside the visible track: ${JSON.stringify(resized.track)}`);
  assert(Math.abs(thumbPosition-resized.scroll/resized.max)<.03,`resize recalculates the thumb using the new track height: ${JSON.stringify({thumbPosition,resized})}`);
  await c.command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await frame();

  let edge=await snapshot();const edgeX=(edge.track.left+edge.track.right)/2;
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:edgeX,y:edge.track.bottom-4});
  await wait(`view.viewport.to===view.state.doc.length && view.scrollDOM.scrollTop>=view.scrollDOM.scrollHeight-view.scrollDOM.clientHeight-1`,60000);
  edge=await snapshot();assert(edge.sourceAt>edge.doc*.95,'the bottom of the scrollbar reaches the actual final portion of the document');
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:edgeX,y:edge.track.top+4});
  await wait(`view.scrollDOM.scrollTop<=1 && view.viewport.from===0`,60000);
  edge=await snapshot();assert(edge.sourceAt===0,'the top of the scrollbar reaches the document start');

  const drag=await snapshot(),dragX=(drag.track.left+drag.track.right)/2;
  const thumbHeight=drag.track.thumbBottom-drag.track.thumbTop;
  const dragStart=(drag.track.thumbTop+drag.track.thumbBottom)/2;
  const dragEnd=drag.track.top+3+((drag.track.bottom-drag.track.top)-6-thumbHeight)*.3+thumbHeight/2;
  await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:dragX,y:dragStart});
  await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:dragX,y:dragEnd});
  await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:dragX,y:dragEnd});
  await frame();const dragged=await snapshot();
  assert(Math.abs(dragged.scroll/dragged.max-.3)<.06,`thumb dragging tracks the physical document while analysis is incomplete: ${JSON.stringify(dragged)}`);
  assert.equal(dragged.head,initial.head,'dragging the thumb preserves the editor selection');

  await c.evaluate('releaseAnalysis()');
  await wait(`editor.session.adapter.analysis?.state==='complete'`,180000);
  await wait(`(()=>{const t=[...document.querySelectorAll('.jot-direct-scrollbar')].find(n=>getComputedStyle(n).display!=='none');return !!t&&Number(t.getAttribute('aria-valuemax'))>0&&Number(t.getAttribute('aria-valuenow'))/Number(t.getAttribute('aria-valuemax'))>.12&&Number(t.getAttribute('aria-valuenow'))/Number(t.getAttribute('aria-valuemax'))<.55})()`,60000);
  await wait(`(()=>{const p=view.scrollDOM.getBoundingClientRect();return [...view.contentDOM.querySelectorAll('.cm-line,.jot-live-preview-widget--block')].some(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>p.top&&r.top<p.bottom&&n.className.includes('jot-live-preview-')})})()`,60000);
  await wait(`(()=>{const pane=view.scrollDOM,t=[...document.querySelectorAll('.jot-direct-scrollbar')].find(n=>getComputedStyle(n).display!=='none');return !!t&&Number(t.getAttribute('aria-valuemax'))===pane.scrollHeight-pane.clientHeight&&Math.abs(Number(t.getAttribute('aria-valuenow'))-pane.scrollTop)<=1})()`);
  const confirmed=await snapshot();
  assert(Math.abs(confirmed.sourceAt-dragged.sourceAt)<confirmed.doc*.04,
    `analysis confirmation preserves the reader's approximate source position: ${JSON.stringify({dragged,confirmed})}`);
  assert.equal(confirmed.track.max,confirmed.max,'confirmation still exposes the native scroll range');
  assert(Math.abs(confirmed.track.value-confirmed.scroll)<=1,
    `confirmation must not switch the thumb to an estimated document axis: ${JSON.stringify(confirmed)}`);
  const confirmedX=(confirmed.track.left+confirmed.track.right)/2;
  const confirmedThumb=confirmed.track.thumbBottom-confirmed.track.thumbTop;
  const jumpY=confirmed.track.top+3+((confirmed.track.bottom-confirmed.track.top)-6-confirmedThumb)*.7+confirmedThumb/2;
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',
    {type,button:'left',clickCount:1,x:confirmedX,y:jumpY});
  await wait(`view.viewport.from>${confirmed.sourceAt+confirmed.doc*.2}`,60000);
  await wait(`(()=>{const pane=view.scrollDOM.getBoundingClientRect();return [...view.contentDOM.querySelectorAll('.cm-line,.jot-live-preview-widget--block:not(.jot-live-preview-widget--geometry)')].some(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>pane.top&&r.top<pane.bottom&&!!n.textContent.trim()&&n.className.includes('jot-live-preview-')})})()`,60000);
  await frame();
  const confirmedJump=await snapshot();
  assert(Math.abs(confirmedJump.scroll/confirmedJump.max-.7)<.08,
    `a single track click directly reaches a distant window after analysis: ${JSON.stringify(confirmedJump)}`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:confirmedX,y:confirmed.track.bottom-4});
  await wait(`view.viewport.to===view.state.doc.length && view.scrollDOM.scrollTop>=view.scrollDOM.scrollHeight-view.scrollDOM.clientHeight-1`,60000);
  try {
    await wait(`(()=>{
      const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(node=>node.textContent==='SCROLL_PROBE_END');
      return (${visibleText})(line,view.scrollDOM);
    })()`,60000);
  } catch (error) {
    const geometry = await c.evaluate(`(()=>{
      const pane=view.scrollDOM, bounds=pane.getBoundingClientRect();
      const rows=[...view.contentDOM.querySelectorAll('.cm-line')];
      const row=rows.find(line=>line.textContent==='SCROLL_PROBE_END');
      const vertical=rect=>rect&&{top:rect.top,bottom:rect.bottom};
      const text=row?.ownerDocument.createRange();
      if(text) text.selectNodeContents(row);
      return {
        viewport:view.viewport, visibleRanges:view.visibleRanges, length:view.state.doc.length,
        scrollTop:pane.scrollTop, scrollHeight:pane.scrollHeight, clientHeight:pane.clientHeight,
        bounds:vertical(bounds), row:vertical(row?.getBoundingClientRect()), text:vertical(text?.getBoundingClientRect()),
        pageTail:rows.slice(-4).map(line=>line.textContent.slice(0,80)),
        endCaret:vertical(view.coordsAtPos(view.state.doc.length)), live:editor.livePreview.snapshot, errors:probe.errors,
      };
    })()`).catch(cause => ({ captureError: String(cause) }));
    console.error('Scrollbar end geometry', JSON.stringify(geometry));
    throw error;
  }
  const confirmedBottom=await snapshot();
  assert(confirmedBottom.sourceAt>confirmedBottom.doc*.95,'the confirmed scrollbar end reaches the real document end');
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:confirmedX,y:confirmed.track.top+4});
  await wait(`view.scrollDOM.scrollTop<=1 && view.viewport.from===0`,60000);
  assert.equal((await snapshot()).sourceAt,0,'the confirmed scrollbar start reaches the real document start');
  assert.equal(await c.evaluate('view.state.selection.main.head'),initial.head,'completed-axis navigation preserves the editor selection');
  assert.equal(await c.evaluate('editor.value===source&&editor.confirmedValue===source'),true,'scrolling preserves the exact source');
  assert.deepEqual(await c.evaluate('probe.errors'),[]);
  const mixed={bytes:await c.evaluate('new TextEncoder().encode(source).length'),openMs:await c.evaluate('probe.openMs'),pending:{physicalRatio,thumbRatio,loaded:pending.loaded,blocks:pending.blocks},clicked:{ratio:clicked.scroll/clicked.max},dragged:{ratio:dragged.scroll/dragged.max,sourceAt:dragged.sourceAt},confirmed:{sourceAt:confirmed.sourceAt,thumbRatio:confirmed.track.value/confirmed.track.max,analysis:confirmed.analysis},confirmedJump:{ratio:confirmedJump.scroll/confirmedJump.max,sourceAt:confirmedJump.sourceAt}};
  await c.evaluate('editor.dispose();worker.terminate()');
  // Match the tall Demo viewport where the rendered image and bottom padding
  // make the physical scroll range far taller than the old estimated range.
  await c.command('Emulation.setDeviceMetricsOverride',{width:1240,height:1057,deviceScaleFactor:2,mobile:false});
  await c.command('Page.navigate',{url:`http://127.0.0.1:${port}/`});
  await wait(`document.querySelector('#status')?.textContent==='正文已确认' &&
    document.querySelector('.cm-content img.jot-image')?.naturalHeight>0 &&
    document.querySelector('.jot-table-grid-body .jot-table-row')!==null`);
  const demoSnapshot=()=>c.evaluate(`(()=>{
    const pane=document.querySelector('.cm-scroller'),bounds=pane.getBoundingClientRect();
    const track=[...document.querySelectorAll('.jot-direct-scrollbar')].find(n=>getComputedStyle(n).display!=='none');
    const rect=track.getBoundingClientRect(),thumb=track.firstElementChild.getBoundingClientRect();
    const style=getComputedStyle(track),top=rect.top+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop),
      bottom=rect.bottom-parseFloat(style.borderBottomWidth)-parseFloat(style.paddingBottom);
    const lastLine=pane.querySelector('.cm-content').cmTile.root.view.state.doc.toString().trimEnd().split('\\n').at(-1);
    const end=[...pane.querySelectorAll('.cm-line')].find(n=>n.textContent===lastLine);
    return{scroll:pane.scrollTop,max:pane.scrollHeight-pane.clientHeight,thumbMax:Number(track.getAttribute('aria-valuemax')),thumbValue:Number(track.getAttribute('aria-valuenow')),thumbRatio:(thumb.top-top)/(bottom-top-thumb.height),
      thumbGap:bottom-thumb.bottom,trackX:rect.left+rect.width/2,trackBottom:bottom,paneX:bounds.left+20,paneY:bounds.top+100,
      lastLineVisible:(${visibleText})(end,pane)};
  })()`);
  // 先让滚轮从确定的起点出发。导航恢复位置和图片测量都可能挪动初始视口。
  await c.evaluate("document.querySelector('.cm-scroller').scrollTop=0");
  await wait("document.querySelector('.cm-scroller').scrollTop<=1");
  const demoStart=await demoSnapshot();
  assert(demoStart.max>140&&!demoStart.lastLineVisible,
    `the Demo must start with enough scroll range and its last line off screen: ${JSON.stringify(demoStart)}`);
  await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',x:demoStart.paneX,y:demoStart.paneY,deltaX:0,deltaY:40});
  await wait("document.querySelector('.cm-scroller').scrollTop>20");await frame();
  const demoMiddle=await demoSnapshot();
  assert(demoMiddle.max-demoMiddle.scroll>100&&!demoMiddle.lastLineVisible,
    `fixture must still have more than 100px and the actual last line below the viewport: ${JSON.stringify(demoMiddle)}`);
  assert.equal(demoMiddle.thumbMax,demoMiddle.max);
  assert(Math.abs(demoMiddle.thumbValue-demoMiddle.scroll)<=1 && demoMiddle.thumbGap>10 &&
    Math.abs(demoMiddle.thumbRatio-demoMiddle.scroll/demoMiddle.max)<.015,
  `the Demo thumb must stay away from the end until the document reaches it: ${JSON.stringify(demoMiddle)}`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',
    {type,button:'left',clickCount:1,x:demoMiddle.trackX,y:demoMiddle.trackBottom-1});
  await wait(`(()=>{const p=document.querySelector('.cm-scroller');return p.scrollHeight-p.clientHeight-p.scrollTop<=1})()`);
  await frame();const demoEnd=await demoSnapshot();
  assert(demoEnd.lastLineVisible&&demoEnd.thumbGap<=2,
    `the final track click must show both the final line and the thumb at the end: ${JSON.stringify(demoEnd)}`);
  console.log(JSON.stringify({status:'pass',...mixed,demo:{middle:demoMiddle,end:demoEnd}}));
}finally{
  try{await c?.evaluate('(async()=>{await window.releaseAnalysis?.();window.editor?.dispose();window.worker?.terminate()})()')}catch{}
  c?.socket.close();
  await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
