// Exercise CodeMirror's document-height probe with differently styled lines.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, keyboardEventKey, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_METRIC_TEST_PORT??4332),debugPort=Number(process.env.JOT_METRIC_TEST_DEBUG_PORT??9532);
const profile=mkdtempSync(resolve(tmpdir(),'jot-metric-e2e-'));
const lines=Array.from({length:180},(_,i)=>`let v${i} = ${i};`);
const fixtureSource=['普通正文','','``` js begin',...lines,'``` end','','>> short','','结束'].join('\n');
let server,chrome,c;
try {
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  c=await connectCdp(pages.find(page=>page.type==='page'&&page.url.includes(`:${port}`)).webSocketDebuggerUrl);
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});
  const wait=(expression,timeout=30000)=>waitForEvaluation(c,expression,timeout);
  const frame=()=>c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await wait(`document.readyState==='complete' && document.title==='Jot native component integration fixture'`);
  await c.evaluate(`(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.style.cssText='width:720px;height:450px;margin:10px';document.body.replaceChildren(root);
    window.source=${JSON.stringify(fixtureSource)};
    window.worker=new Worker('/src/worker.ts',{type:'module'});window.editorErrors=[];
    window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint:worker,documentId:'metric-guard',generation:1,source,syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>editorErrors.push(String(e))});
    await editor.open();window.view=editor.input.view;
  })()`);
  await wait(`editor.value===editor.confirmedValue&&editor.session.adapter.analysis?.state==='complete'`);
  const jump=async position=>{
    await c.evaluate(`view.dispatch({selection:{anchor:${position}},scrollIntoView:true});view.focus()`);
    await c.evaluate('editor.livePreview.settled()');await frame();
  };
  const measure=()=>c.evaluate(`(()=>{
    const head=view.state.selection.main.head,line=view.state.doc.lineAt(head),dom=view.domAtPos(head).node,
      element=dom.nodeType===1?dom:dom.parentElement,row=element?.closest('.cm-line'),box=row?.getBoundingClientRect();
    return {line:line.text,head,height:view.defaultLineHeight,width:view.defaultCharacterWidth,
      fontSize:getComputedStyle(view.contentDOM).fontSize,fontFamily:getComputedStyle(view.contentDOM).fontFamily,
      rowHeight:box?.height,rowLineHeight:row?parseFloat(getComputedStyle(row).lineHeight):null,
      rowText:row?.textContent,rowClass:row?.className,guards:view.contentDOM.querySelectorAll('[data-jot-metric-guard]').length,
      caret:(()=>{const r=view.coordsAtPos(head);return r?{left:r.left,top:r.top,bottom:r.bottom}:null})()};
  })()`);
  const cases=[];
  for(const [fontSize,fontFamily] of [[16,'sans-serif'],[20,'serif'],[24,'monospace']]){
    // Line metrics are configuration, not a fixed value in the guard.
    const bodyLineHeight=fontSize*1.5,codeLineHeight=fontSize*1.25;
    await c.evaluate(`editor.setLayoutStyle({fontSize:${fontSize},fontFamily:${JSON.stringify(fontFamily)},metrics:{paragraphLineHeight:${bodyLineHeight},blankLineHeight:${bodyLineHeight},codeLineHeight:${codeLineHeight}}})`);
    await jump(0);await c.evaluate('view.requestMeasure()');await frame();const body=await measure();
    const position=await c.evaluate(`source.indexOf('let v90 = 90;')+4`);
    await jump(position);await c.evaluate('view.requestMeasure()');await frame();const code=await measure();
    assert(code.rowClass?.includes('jot-live-preview-source-fenced-code'),JSON.stringify(code));
    assert(code.guards>0,'short ASCII lines in the viewport are guarded');
    assert(Math.abs(code.height-body.height)<.1,`code must not replace the body height used for the whole document: ${JSON.stringify({body,code})}`);
    assert(Math.abs(code.width-body.width)<.1,`code font must not replace the body character-width estimate: ${JSON.stringify({body,code})}`);
    assert.equal(parseFloat(body.fontSize),fontSize,'requested font size reaches the editor content');
    assert(Math.abs(code.rowLineHeight-codeLineHeight)<.1,'actual code keeps its configured line height');
    assert(Math.abs(body.rowLineHeight-bodyLineHeight)<.1,'actual body keeps its configured line height');
    assert(Math.abs(body.height-bodyLineHeight)<.1,'the default measurement follows the configured body line height');
    if(cases.length)assert(Math.abs(body.width-cases.at(-1).bodyWidth)>.1,'the measured character width follows font changes');
    assert(code.caret&&code.caret.top>=-1&&code.caret.bottom<=800,'the source caret remains visible');
    cases.push({fontSize,fontFamily,bodyHeight:body.height,codeHeight:code.height,bodyWidth:body.width,codeWidth:code.width,renderedCodeHeight:code.rowLineHeight});
  }

  // Diagnostic for the known CodeMirror font-width refresh limitation: keep
  // line heights unchanged and report the oracle against a real text sample.
  if(process.env.JOT_METRIC_FIXED_FONT_DIAG==='1'){
    const fixed=[];
    for(const [fontSize,fontFamily] of [[16,'sans-serif'],[20,'serif'],[24,'monospace']]){
      await c.evaluate(`editor.setLayoutStyle({fontSize:${fontSize},fontFamily:${JSON.stringify(fontFamily)},metrics:{paragraphLineHeight:36,blankLineHeight:36,codeLineHeight:20}})`);
      await jump(0);await c.evaluate('view.requestMeasure()');await frame();const actual=await measure();
      const expected=await c.evaluate(`(()=>{const style=getComputedStyle(view.contentDOM),span=document.createElement('span');span.style.font=style.font;span.style.letterSpacing=style.letterSpacing;span.style.whiteSpace='pre';span.textContent='abc def ghi jkl mno pqr stu';document.body.append(span);const width=span.getBoundingClientRect().width/27;span.remove();return width})()`);
      fixed.push({fontSize,fontFamily,width:actual.width,expected});
      await jump(await c.evaluate(`source.indexOf('let v90 = 90;')+4`));
    }
    console.log(JSON.stringify({fixedFont:fixed}));
  }

  // Real keyboard text insertion and deletion on a guarded line retain exact
  // source positions and content, including Undo and Redo.
  const position=await c.evaluate(`source.indexOf('let v90 = 90;')+4`);
  await jump(position);
  await c.command('Input.insertText',{text:'Z'});
  const inserted=await c.evaluate('editor.value');
  assert.equal(inserted,await c.evaluate(`source.slice(0,${position})+'Z'+source.slice(${position})`));
  assert.equal(await c.evaluate('view.state.selection.main.head'),position+1);
  const mod=await c.evaluate('/Mac|iPhone|iPad/.test(navigator.platform)')?4:2;
  const key=async(name,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:keyboardEventKey(name,modifiers),code:name==='z'?'KeyZ':name,windowsVirtualKeyCode:name==='z'?90:8,modifiers})};
  await key('z',mod);await wait('editor.value===source');
  await key('z',mod|8);await wait(`editor.value===${JSON.stringify(inserted)}`);
  await key('Backspace');await wait('editor.value===source');
  await wait('editor.value===editor.confirmedValue');await c.evaluate('editor.livePreview.settled()');await frame();

  // Pointer coordinates inside the decorated line still resolve to its source.
  const point=await c.evaluate(`(()=>{const r=view.coordsAtPos(${position});return{x:r.left,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
  await wait(`Math.abs(view.state.selection.main.head-${position})<=1`);
  await c.evaluate(`view.dispatch({selection:{anchor:${position}}});view.focus()`);
  await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});
  await c.command('Input.insertText',{text:'是'});
  await wait(`editor.value===source.slice(0,${position})+'是'+source.slice(${position})`);
  assert.equal(await c.evaluate('view.state.selection.main.head'),position+1,'composition commits at the source caret');
  await key('z',mod);await wait('editor.value===source');
  await wait('editor.value===editor.confirmedValue');

  await c.evaluate(`editor.setMode('source')`);await frame();
  assert.equal(await c.evaluate(`view.contentDOM.querySelectorAll('[data-jot-metric-guard]').length`),0,'source mode does not keep live-preview decorations');
  await c.evaluate(`editor.setMode('live-preview')`);await jump(position);
  assert((await measure()).guards>0,'returning to live preview restores the guard');
  assert.equal(await c.evaluate('editor.value===source&&editor.confirmedValue===source'),true);
  assert.deepEqual(await c.evaluate('editorErrors'),[]);
  console.log(JSON.stringify({status:'pass',cases,keyboard:true,pointer:true,composition:true,modeSwitch:true}));
} finally {
  try { if(c){await c.evaluate('editor?.dispose();worker?.terminate()');c.socket.close()} } catch {}
  await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
