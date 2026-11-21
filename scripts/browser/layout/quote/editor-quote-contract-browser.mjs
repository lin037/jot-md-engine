// Compare the quote contract in the public component, including the frame
// before the Rust Worker confirms an actual keyboard edit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, keyboardEventKey, stopProcess, waitForEvaluation, waitForHttp } from '../../support/browser-test-utils.mjs';

const port = Number(process.env.JOT_QUOTE_CONTRACT_PORT ?? 4322);
const debugPort = Number(process.env.JOT_QUOTE_CONTRACT_DEBUG_PORT ?? 9522);
const profile = mkdtempSync(resolve(tmpdir(), 'jot-quote-contract-'));
const output = resolve('dist/quote-contract-browser-report');
mkdirSync(output, { recursive: true });
let server, chrome, c;
const errors = [];

try {
  server = spawn(resolve('node_modules/.bin/vite'), ['--config', 'apps/demo/vite.config.mjs', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
  await waitForHttp(`http://127.0.0.1:${port}/`, 15000);
  chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ['--headless=new', '--no-first-run', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`], { stdio: 'ignore' });
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 15000);
  const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
  c = await connectCdp(pages.find(page => page.type === 'page' && page.url.includes(`:${port}`)).webSocketDebuggerUrl);
  c.socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const wait = (expression, timeout = 30000) => waitForEvaluation(c, expression, timeout);
  const frame = () => c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const screenshot = async name => {
    const result = await c.command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve(output, `${name}.png`), Buffer.from(result.data, 'base64'));
  };
  await wait(`document.readyState==='complete' && document.title==='Jot native component integration fixture'`);
  await c.evaluate(`(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.id='quote-contract';root.style.cssText='width:800px;height:700px;margin:10px';document.body.replaceChildren(root);
    window.worker=new Worker('/src/worker.ts',{type:'module'});window.editorErrors=[];window.holdWorker=false;window.heldMessages=[];
    const listeners=new Map(),endpoint={postMessage(value){worker.postMessage(value)},
      addEventListener(type,listener){const wrapped=event=>{if(type==='message'&&holdWorker)heldMessages.push(()=>listener(event));else listener(event)};listeners.set(listener,wrapped);worker.addEventListener(type,wrapped)},
      removeEventListener(type,listener){const wrapped=listeners.get(listener);if(wrapped)worker.removeEventListener(type,wrapped);listeners.delete(listener)}};
    // Preserve the microtask checkpoint between normal Worker message events.
    window.releaseWorker=async()=>{while(heldMessages.length){heldMessages.shift()();await Promise.resolve()}holdWorker=false};
    window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint,documentId:'quote-contract',generation:1,source:'',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:error=>editorErrors.push(String(error))});
    await editor.open();window.view=editor.input.view;
    await editor.setLayoutStyle({fontSize:16,metrics:{quotePaddingX:12,quotePaddingY:12,paragraphLineHeight:28,blankLineHeight:28}});
  })()`);
  const load = async (source, position, mode = 'live-preview') => {
    await c.evaluate(`(async()=>{await editor.setMode(${JSON.stringify(mode)});if(${JSON.stringify(mode)}==='split')await editor.setSurfaceMode('preview');editor.setValue(${JSON.stringify(source)});editor.input.setSelection(${position});editor.focus()})()`);
    await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
    if (mode === 'live-preview') await c.evaluate('editor.livePreview.settled()');
    else {
      await c.evaluate('editor.surface.settled()');
      if (source.includes('文本')) await wait(`document.querySelector('.jot-editor-surface')?.innerText.includes('文本')`);
    }
    await frame();
  };
  const geometry = mode => c.evaluate(`(()=>{
    const root=${mode === 'live-preview' ? 'view.contentDOM' : "document.querySelector('.jot-editor-surface')"};
    const quote=${mode === 'live-preview' ? "root.querySelector('.cm-line[data-jot-quote-depth]')" : "root.querySelector('blockquote[data-jot-kind=block-quote]')"};
    const rect=quote.getBoundingClientRect(),style=getComputedStyle(quote),walker=document.createTreeWalker(quote,NodeFilter.SHOW_TEXT);let text;
    while((text=walker.nextNode()))if(text.nodeValue.includes('文本'))break;
    let first,last,content;if(text){first=new Range();first.setStart(text,text.nodeValue.indexOf('文本'));first.setEnd(text,text.nodeValue.indexOf('文本')+1);last=first.getBoundingClientRect();content=text.parentElement.closest('p')?.getBoundingClientRect()}
    return{height:rect.height,width:rect.width,start:last?last.left-rect.left:null,top:last?last.top-rect.top:null,
      end:content?rect.right-content.right:null,paddingStart:parseFloat(style.paddingInlineStart),paddingEnd:parseFloat(style.paddingInlineEnd),
      lineHeight:parseFloat(style.lineHeight),depth:quote.dataset.jotQuoteDepth??null,visible:quote.innerText,html:quote.outerHTML.slice(0,800)};
  })()`);
  const key = async (name, modifiers = 0) => {
    const code = name === 'z' ? 'KeyZ' : name;
    const number = { Backspace: 8, Delete: 46, Enter: 13, Tab: 9, z: 90 }[name] ?? 0;
    for (const type of ['keyDown', 'keyUp']) await c.command('Input.dispatchKeyEvent', { type, key: keyboardEventKey(name, modifiers), code, windowsVirtualKeyCode: number, modifiers });
  };
  const snapshot = () => c.evaluate(`(()=>({value:editor.value,confirmed:editor.confirmedValue,head:view.state.selection.main.head,anchor:view.state.selection.main.anchor,
    caret:(()=>{const r=view.coordsAtPos(view.state.selection.main.head);return r?{left:r.left,top:r.top}:null})(),
    rows:[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>{const line=view.state.doc.lineAt(view.posAtDOM(n,0)),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{raw:line.text,text:n.innerText,depth:n.dataset.jotQuoteDepth??null,markerOnly:n.dataset.jotQuoteMarkerOnly??null,taskCount:n.querySelectorAll('.jot-live-preview-task-checkbox').length,lineHeight:parseFloat(s.lineHeight),top:r.top,height:r.height,start:parseFloat(s.paddingInlineStart),end:parseFloat(s.paddingInlineEnd),html:n.outerHTML.slice(0,900)}})}))()`);
  const capture = async (action, { trace = false } = {}) => {
    const before = await snapshot();
    await c.evaluate('holdWorker=true');
    try {
      await action();await wait('editor.value!==editor.confirmedValue', 5000);await frame();
      const pending = await snapshot();
      if(trace) await c.evaluate(`(()=>{window.quoteFrameTrace=[];window.quoteTraceActive=true;function record(){if(!quoteTraceActive)return;quoteFrameTrace.push([...view.contentDOM.querySelectorAll('.cm-line')].map(n=>{const line=view.state.doc.lineAt(view.posAtDOM(n,0)),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{raw:line.text,depth:n.dataset.jotQuoteDepth??null,top:r.top,height:r.height,start:parseFloat(s.paddingInlineStart)}}));if(quoteFrameTrace.length<120)requestAnimationFrame(record)}requestAnimationFrame(record)})()`);
      await c.evaluate('releaseWorker()');
      await wait(`editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
      await c.evaluate('editor.livePreview.settled()');await frame();
      const after=await snapshot();
      const frames=trace?await c.evaluate(`(()=>{quoteTraceActive=false;return quoteFrameTrace})()`):[];
      return { before, pending, after, frames };
    } finally { await c.evaluate('(async()=>{await releaseWorker();window.quoteTraceActive=false})()'); }
  };

  const geometries = [];
  for (const depth of [1, 4, 9, 16]) {
    const prefix = '>'.repeat(depth) + ' ', source = `前文\n\n${prefix}文本\n\n尾部`;
    await load(source, 0, 'preview');const preview = await geometry('preview');
    if (depth === 16) await screenshot('depth16-preview');
    await load(source, 0);const live = await geometry('live-preview');
    if (depth === 16) await screenshot('depth16-live');
    await load(source, 0, 'pretext');
    const pretext = await c.evaluate(`(()=>{const n=document.querySelector('.jot-pretext-block--block-quote'),p=n.querySelector('.jot-pretext-block__preview'),s=getComputedStyle(p);return{height:n.getBoundingClientRect().height,start:parseFloat(s.paddingInlineStart),end:parseFloat(s.paddingInlineEnd),depth:n.style.getPropertyValue('--jot-pretext-quote-depth'),text:p.textContent}})()`);
    geometries.push({ depth, preview, live, pretext });
  }
  const prefix = '>>>> ', source = `前文\n\n${prefix}文本\n\n尾部`, caret = source.indexOf('文本');
  await load(source, caret);
  const point = await c.evaluate(`(()=>{const r=view.coordsAtPos(${caret});return{x:r.left+.5,y:(r.top+r.bottom)/2}})()`);
  for (const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent', { type, button:'left', clickCount:1, ...point });
  await wait(`view.state.selection.main.head===${caret}`);
  const edit = await capture(() => key('Backspace'));
  if (process.env.JOT_QUOTE_CONTRACT_DIAG === '1') console.log(JSON.stringify({ geometries: geometries.map(({depth,preview,live,pretext})=>({depth,preview:{height:preview.height,start:preview.start,end:preview.end},live:{height:live.height,start:live.start,end:live.paddingEnd},pretext})) }));

  const near = (a, b, label) => assert(Math.abs(a-b) <= 1, `${label}: ${a} versus ${b}`);
  for (const { depth, preview, live, pretext } of geometries) {
    near(preview.height, geometries[0].preview.height, `preview height at depth ${depth}`);
    near(live.height, geometries[0].live.height, `live height at depth ${depth}`);
    near(preview.top, geometries[0].preview.top, `preview first text row at depth ${depth}`);
    near(live.top, geometries[0].live.top, `live first text row at depth ${depth}`);
    near(preview.end, 12, `preview right inset at depth ${depth}`);
    near(live.paddingEnd, 12, `live right inset at depth ${depth}`);
    near(live.start, preview.start, `preview and live indentation at depth ${depth}`);
    near(pretext.height, preview.height, `pretext height at depth ${depth}`);
    near(pretext.start, preview.start, `pretext indentation at depth ${depth}`);
    near(pretext.end, 12, `pretext right inset at depth ${depth}`);
    assert.equal(Number(pretext.depth), depth, 'pretext uses the bounded first-line depth for this sizing hint');
    assert.equal(pretext.text, '文本', `pretext preserves the visible single-line quote content at depth ${depth}`);
  }
  assert.equal(edit.pending.value, source.replace('>>>> ', '>>> '), 'Backspace removes exactly one quote level and retains the body separator');
  assert.equal(edit.pending.value, edit.after.value);
  assert.equal(edit.pending.rows.find(row => row.raw.includes('文本'))?.depth, '3');
  assert.equal(edit.pending.rows.find(row => row.raw.includes('文本'))?.text, '文本');
  assert.deepEqual(edit.pending.rows.map(row => [row.raw,row.depth]), edit.after.rows.map(row => [row.raw,row.depth]));
  const stable = result => {
    assert.deepEqual(result.pending.rows.map(row => [row.raw,row.text,row.depth]), result.after.rows.map(row => [row.raw,row.text,row.depth]), 'no quote row flashes back to source while parsing');
    assert.equal(result.pending.head, result.after.head, 'the selection stays at the same source position');
    for (let i = 0; i < result.pending.rows.length; i++) {
      const pending = result.pending.rows[i], after = result.after.rows[i];
      near(pending.top, after.top, 'row top before confirmation');near(pending.height, after.height, 'row height before confirmation');
      near(pending.start, after.start, `row indentation before confirmation: ${JSON.stringify({pending,after})}`);
    }
    if (result.pending.caret && result.after.caret) {
      near(result.pending.caret.left, result.after.caret.left, 'caret horizontal position');
      near(result.pending.caret.top, result.after.caret.top, 'caret vertical position');
    }
    for(const frame of result.frames??[]){
      assert.deepEqual(frame.map(row=>[row.raw,row.depth]),result.after.rows.map(row=>[row.raw,row.depth]),'no intermediate frame loses quote styling');
      for(let i=0;i<frame.length;i++){
        near(frame[i].top,result.after.rows[i].top,'intermediate frame top');
        near(frame[i].height,result.after.rows[i].height,'intermediate frame height');
        near(frame[i].start,result.after.rows[i].start,'intermediate frame quote inset');
      }
    }
  };
  stable(edit);
  const mod = await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`) ? 4 : 2;
  const undo = await capture(() => key('z', mod));
  assert.equal(undo.pending.value, source, 'the quote level deletion is undoable');stable(undo);

  // Distinct blank/paragraph metrics expose stale marker-only presentation in
  // the interval between a real body edit and Worker confirmation.
  await c.evaluate(`editor.setLayoutStyle({metrics:{paragraphLineHeight:26,blankLineHeight:22}})`);
  const bodyTransition='前文\n\n> 上层\n>>>> \n> 下层\n\n尾部', bodyStart=bodyTransition.indexOf('>>>> ')+'>>>> '.length;
  await load(bodyTransition, bodyStart);
  const firstBody=await capture(()=>c.command('Input.insertText',{text:'字'}),{trace:true});
  assert.equal(firstBody.pending.value,bodyTransition.slice(0,bodyStart)+'字'+bodyTransition.slice(bodyStart));
  if(process.env.JOT_QUOTE_CONTRACT_DIAG==='1')console.log(JSON.stringify({bodyTransition:{pending:firstBody.pending.rows,after:firstBody.after.rows}}));
  stable(firstBody);
  assert.equal(firstBody.pending.rows.find(row=>row.raw==='>>>> 字')?.markerOnly,null,'text input immediately leaves marker-only presentation');
  const undoFirstBody=await capture(()=>key('z',mod),{trace:true});
  assert.equal(undoFirstBody.pending.value,bodyTransition,'Undo restores the empty quote');stable(undoFirstBody);
  const redoFirstBody=await capture(()=>key('z',mod|8),{trace:true});
  assert.equal(redoFirstBody.pending.value,firstBody.pending.value,'Redo restores the first body character');stable(redoFirstBody);
  const bodyText=firstBody.pending.value, bodyEnd=bodyStart+1;
  await load(bodyText,bodyEnd);
  const deleteBody=await capture(()=>key('Backspace'),{trace:true});
  assert.equal(deleteBody.pending.value,bodyTransition);
  stable(deleteBody);
  assert.equal(deleteBody.pending.rows.find(row=>row.raw==='>>>> ')?.markerOnly,'true','deleting the last body character immediately restores marker-only presentation');

  // IME candidates are not yet Rust revisions, but their native line must
  // already use the final nonempty quote geometry.
  await load(bodyTransition,bodyStart);await c.evaluate('holdWorker=true');
  try {
    await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});
    await wait('view.composing');await frame();
    const candidate=await snapshot();
    assert.equal(candidate.confirmed,bodyTransition,'IME candidate is not confirmed');
    assert.equal(candidate.rows.find(row=>row.raw==='>>>> shi')?.markerOnly,null,'IME candidate uses nonempty quote geometry');
    await c.command('Input.insertText',{text:'是'});await wait(`!view.composing && editor.value!==editor.confirmedValue`);await frame();
    const imePending=await snapshot();await c.evaluate('releaseWorker()');
    await wait(`editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
    await c.evaluate('editor.livePreview.settled()');await frame();const imeAfter=await snapshot();
    stable({pending:imePending,after:imeAfter});
    assert.equal(imeAfter.value,bodyTransition.slice(0,bodyStart)+'是'+bodyTransition.slice(bodyStart),'IME commits once into the quote body');
    for(let i=0;i<candidate.rows.length;i++){
      near(candidate.rows[i].top,imeAfter.rows[i].top,'IME candidate row top');
      near(candidate.rows[i].height,imeAfter.rows[i].height,'IME candidate row height');
      near(candidate.rows[i].start,imeAfter.rows[i].start,'IME candidate quote inset');
    }
  } finally { await c.evaluate('releaseWorker()'); }

  await load(bodyTransition,bodyStart);
  await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await wait('view.composing');
  await c.command('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await wait('!view.composing');await frame();
  const cancelledIme=await snapshot();
  assert.equal(cancelledIme.value,bodyTransition,'cancelling an IME candidate restores the source');
  assert.equal(cancelledIme.rows.find(row=>row.raw==='>>>> ')?.markerOnly,'true','cancelling IME restores empty quote geometry');

  const tabEmpty='前文\n\n>>\n\n尾部', tabAt=tabEmpty.indexOf('>>')+2;
  await load(tabEmpty,tabAt);
  const tabIndent=await capture(()=>key('Tab'),{trace:true});
  assert.equal(tabIndent.pending.value,tabEmpty.slice(0,tabAt)+' \t'+tabEmpty.slice(tabAt),'Tab inserts a body indent after a compact quote prefix');
  assert.equal(tabIndent.pending.head,tabAt+2,'the caret follows the inserted body indent');
  assert.equal(tabIndent.pending.rows.find(row=>row.raw==='>> \t')?.depth,'2');
  stable(tabIndent);
  const tabOutdent=await capture(()=>key('Tab',8));
  assert.equal(tabOutdent.pending.value,tabIndent.pending.value.replace('>> \t','> \t'),'Shift+Tab removes exactly one quote level and keeps body indentation');
  assert.equal(tabOutdent.pending.head,tabIndent.pending.head-1,'outdent preserves the caret inside the body');
  stable(tabOutdent);
  const undoTabOutdent=await capture(()=>key('z',mod));
  assert.equal(undoTabOutdent.pending.value,tabIndent.pending.value,'quote outdent is one undoable transaction');stable(undoTabOutdent);

  // Typing a new prefix and pressing Tab before Worker confirmation must
  // still indent the body, never the source before the prefix.
  const newQuote='前文\n\n\n尾部',newQuoteAt=newQuote.indexOf('\n\n')+2;
  await load(newQuote,newQuoteAt);await c.evaluate('holdWorker=true');
  let pendingNewQuote;
  try {
    await c.command('Input.insertText',{text:'>>'});await wait('editor.value!==editor.confirmedValue');
    await key('Tab');await frame();
    pendingNewQuote=await snapshot();
    assert.equal(pendingNewQuote.value,newQuote.slice(0,newQuoteAt)+'>> \t'+newQuote.slice(newQuoteAt),
      'a freshly typed quote can indent its body before Worker confirmation');
  } finally {await c.evaluate('releaseWorker()')}
  await wait(`editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await c.evaluate('editor.livePreview.settled()');await frame();
  stable({pending:pendingNewQuote,after:await snapshot()});

  const tabText='前文\n\n> 内容文本\n\n尾部', tabTextAt=tabText.indexOf('内容文本')+1;
  await load(tabText,tabTextAt);
  const tabInside=await capture(()=>key('Tab'));
  assert.equal(tabInside.pending.value,tabText.slice(0,tabTextAt)+'\t'+tabText.slice(tabTextAt),'Tab inserts at the caret within quote text');
  stable(tabInside);
  await load(tabText,tabText.indexOf('内容文本'));
  await c.evaluate(`editor.input.setSelection(${tabText.indexOf('内容文本')},${tabText.indexOf('内容文本')+2})`);
  const tabSelection=await capture(()=>key('Tab'));
  assert.equal(tabSelection.pending.value,tabText.replace('> 内容','> \t内容'),'Tab indents selected text without replacing it');
  assert.equal(tabSelection.pending.anchor,tabText.indexOf('内容文本')+1);
  assert.equal(tabSelection.pending.head,tabText.indexOf('内容文本')+3);
  stable(tabSelection);

  const quoteList='前文\n\n> - 列表\n> 下文\n\n尾部', listAt=quoteList.indexOf('列表')+1;
  await load(quoteList,listAt);
  const tabList=await capture(()=>key('Tab'),{trace:true});
  if(process.env.JOT_QUOTE_CONTRACT_DIAG==='1')console.log(JSON.stringify({tabList}));
  assert.equal(tabList.pending.value,quoteList.replace('> - 列表','>   - 列表'),'Tab indents the list inside the quote using CodeMirror\'s indent unit');
  stable(tabList);
  const tabListOutdent=await capture(()=>key('Tab',8));
  assert.equal(tabListOutdent.pending.value,quoteList,'Shift+Tab removes the list indentation inside the quote');stable(tabListOutdent);
  const undoListOutdent=await capture(()=>key('z',mod));
  assert.equal(undoListOutdent.pending.value,tabList.pending.value,'the list outdent is undoable');stable(undoListOutdent);

  const quoteTask='前文\n\n> - [ ] 任务\n> 下文\n\n尾部',taskAt=quoteTask.indexOf('任务')+1;
  await load(quoteTask,taskAt);
  const tabTask=await capture(()=>key('Tab'),{trace:true});
  assert.equal(tabTask.pending.value,quoteTask.replace('> - [ ]','>   - [ ]'),'Tab indents a task inside the quote');
  stable(tabTask);
  assert(tabTask.pending.rows.some(row=>row.raw.includes('任务')&&row.taskCount===1),'task checkbox stays mounted while parsing');
  const taskPoint=await c.evaluate(`(()=>{const r=view.contentDOM.querySelector('.jot-live-preview-task-checkbox').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const taskCheck=await capture(async()=>{for(const type of ['mousePressed','mouseReleased'])
    await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...taskPoint})},{trace:true});
  assert.equal(taskCheck.pending.value,tabTask.pending.value.replace('[ ]','[x]'),'the mapped task checkbox still edits the right source after indentation');
  stable(taskCheck);

  const ticks='```', quoteCode=`前文\n\n> ${ticks} ts\n> let value = 1;\n> ${ticks}\n\n尾部`, codeAt=quoteCode.indexOf('value')+2;
  await load(quoteCode,codeAt);
  const tabCode=await capture(()=>key('Tab'));
  if(process.env.JOT_QUOTE_CONTRACT_DIAG==='1')console.log(JSON.stringify({tabCode}));
  assert.equal(tabCode.pending.value,quoteCode.replace('> let value','>   let value'),'Tab indents code after its quote prefix');
  stable(tabCode);

  const longCodeBody='x'.repeat(65_536)+'中文😀';
  const longQuotedCode=`前文\n\n> ${ticks} ts\n>   ${longCodeBody}\n> ${ticks}\n\n尾部`;
  await load(longQuotedCode,longQuotedCode.indexOf(longCodeBody)+4);
  const longCodeOutdent=await capture(()=>key('Tab',8));
  assert.equal(longCodeOutdent.pending.value,longQuotedCode.replace('>   '+longCodeBody,'> '+longCodeBody),
    'outdenting a long quoted code line preserves the complete body');
  stable(longCodeOutdent);

  const unquotedCode=`前文\n\n${ticks} ts\n> literal\n${ticks}\n\n尾部`;
  await load(unquotedCode,unquotedCode.indexOf('literal')+2);
  const tabLiteralCode=await capture(()=>key('Tab'));
  assert.equal(tabLiteralCode.pending.value,unquotedCode.replace('> literal','  > literal'),
    'a literal greater-than inside top-level code keeps code indentation');
  stable(tabLiteralCode);

  const tabLines='前文\n\n> 第一行\n> 第二行\n\n尾部', selectionStart=tabLines.indexOf('第一行'),selectionEnd=tabLines.indexOf('第二行')+3;
  await load(tabLines,selectionStart);await c.evaluate(`editor.input.setSelection(${selectionStart},${selectionEnd})`);
  const tabMultiline=await capture(()=>key('Tab'));
  assert.equal(tabMultiline.pending.value,tabLines.replace('> 第一行\n> 第二行','> \t第一行\n> \t第二行'),'Tab indents each selected quote body without changing its prefixes');
  stable(tabMultiline);

  const mixedRows='前文\n\n>>\n>>> 内容\n> - 列表\n> [普通正文]\n\n尾部';
  const mixedFrom=mixedRows.indexOf('>>\n'),mixedTo=mixedRows.indexOf('[普通正文]')+'[普通正文]'.length;
  await load(mixedRows,mixedFrom+2);await c.evaluate(`editor.input.setSelection(${mixedFrom+2},${mixedTo})`);
  const mixedTabs=await capture(()=>key('Tab'),{trace:true});
  assert.equal(mixedTabs.pending.value,mixedRows.replace('>>\n>>> 内容\n> - 列表\n> [普通正文]','>> \t\n>>> \t内容\n>   - 列表\n> \t[普通正文]'),'multiline indent preserves quote/list structure');
  stable(mixedTabs);
  const mixedUndo=await capture(()=>key('z',mod),{trace:true});
  assert.equal(mixedUndo.pending.value,mixedRows,'one Undo restores all selected quote rows');stable(mixedUndo);
  const mixedRedo=await capture(()=>key('z',mod|8),{trace:true});
  assert.equal(mixedRedo.pending.value,mixedTabs.pending.value,'Redo reapplies all selected quote indents');stable(mixedRedo);

  const mixedOutdentRows='前文\n\n>>\n>>> 内容\n> - 列表\n> 普通正文\n\n尾部';
  const mixedOutdentFrom=mixedOutdentRows.indexOf('>>\n'),mixedOutdentTo=mixedOutdentRows.indexOf('普通正文')+4;
  await load(mixedOutdentRows,mixedOutdentFrom+2);await c.evaluate(`editor.input.setSelection(${mixedOutdentFrom+2},${mixedOutdentTo})`);
  const mixedOutdent=await capture(()=>key('Tab',8),{trace:true});
  assert.equal(mixedOutdent.pending.value,mixedOutdentRows.replace('>>\n>>> 内容\n> - 列表\n> 普通正文','>\n>> 内容\n> - 列表\n普通正文'));
  stable(mixedOutdent);
  const undoMixedOutdent=await capture(()=>key('z',mod),{trace:true});
  assert.equal(undoMixedOutdent.pending.value,mixedOutdentRows);stable(undoMixedOutdent);

  const mixedPlain='前文\n\n普通段落\n> 引用正文\n\n末尾段落';
  const mixedPlainFrom=mixedPlain.indexOf('普通段落'),mixedPlainTo=mixedPlain.indexOf('末尾段落')+4;
  await load(mixedPlain,mixedPlainFrom);await c.evaluate(`editor.input.setSelection(${mixedPlainFrom},${mixedPlainTo})`);
  const mixedPlainTab=await capture(()=>key('Tab'),{trace:true});
  assert.equal(mixedPlainTab.pending.value,'前文\n\n  普通段落\n> \t引用正文\n  \n  末尾段落',
    'a mixed selection indents normal paragraphs and the quote body at their own positions');
  stable(mixedPlainTab);
  const mixedPlainUndo=await capture(()=>key('z',mod),{trace:true});
  assert.equal(mixedPlainUndo.pending.value,mixedPlain);stable(mixedPlainUndo);
  await load(mixedPlain,mixedPlainFrom);await c.evaluate(`editor.input.setSelection(${mixedPlainFrom},${mixedPlainTo})`);
  const mixedPlainOutdent=await capture(()=>key('Tab',8),{trace:true});
  assert.equal(mixedPlainOutdent.pending.value,mixedPlain.replace('> 引用正文','引用正文'),
    'Shift+Tab removes the quote level while leaving unindented paragraphs unchanged');
  stable(mixedPlainOutdent);

  const outdentRows='前文\n\n>>> 第一\n>> 第二\n> 最后\n\n尾部';
  const outdentFrom=outdentRows.indexOf('第一'),outdentTo=outdentRows.indexOf('最后')+2;
  await load(outdentRows,outdentFrom);await c.evaluate(`editor.input.setSelection(${outdentFrom},${outdentTo})`);
  const multiOutdent=await capture(()=>key('Tab',8),{trace:true});
  assert.equal(multiOutdent.pending.value,outdentRows.replace('>>> 第一\n>> 第二\n> 最后','>> 第一\n> 第二\n最后'),'Shift+Tab outdents each selected ordinary quote row');
  stable(multiOutdent);
  const undoMultiOutdent=await capture(()=>key('z',mod),{trace:true});
  assert.equal(undoMultiOutdent.pending.value,outdentRows,'Undo restores all outdented quote levels');stable(undoMultiOutdent);

  // Only a middle slice is selected: the first and last quote lines outside
  // the selection must retain their own open/close edges and geometry.
  const partialRows='前文\n\n> 上邻\n>>>> 第一\n>>> 第二\n>> 下邻\n> 尾邻\n\n尾部';
  const partialFrom=partialRows.indexOf('第一'),partialTo=partialRows.indexOf('第二')+2;
  await load(partialRows,partialFrom);await c.evaluate(`editor.input.setSelection(${partialFrom},${partialTo})`);
  const partialOutdent=await capture(()=>key('Tab',8),{trace:true});
  assert.equal(partialOutdent.pending.value,partialRows.replace('>>>> 第一\n>>> 第二','>>> 第一\n>> 第二'));
  stable(partialOutdent);
  const undoPartialOutdent=await capture(()=>key('z',mod),{trace:true});
  assert.equal(undoPartialOutdent.pending.value,partialRows);stable(undoPartialOutdent);
  const redoPartialOutdent=await capture(()=>key('z',mod|8),{trace:true});
  assert.equal(redoPartialOutdent.pending.value,partialOutdent.pending.value);stable(redoPartialOutdent);

  const multiCaret='前文\n\n> 第一个\n>> 第二个\n\n尾部';
  const multiCaretA=multiCaret.indexOf('第一个')+1,multiCaretB=multiCaret.indexOf('第二个')+1;
  await load(multiCaret,multiCaretA);
  await c.evaluate(`(()=>{const S=view.state.selection.constructor;view.dispatch({selection:S.create([S.cursor(${multiCaretA}),S.cursor(${multiCaretB})])})})()`);
  assert.equal(await c.evaluate('view.state.selection.ranges.length'),2);
  const multiCaretTab=await capture(()=>key('Tab'),{trace:true});
  assert.equal(multiCaretTab.pending.value,multiCaret.replace('第一个','第\t一个').replace('第二个','第\t二个'));
  assert.equal(await c.evaluate('view.state.selection.ranges.length'),2,'Tab keeps both source carets');stable(multiCaretTab);
  const multiCaretOutdent=await capture(()=>key('Tab',8),{trace:true});
  assert.equal(multiCaretOutdent.pending.value,multiCaretTab.pending.value.replace('> 第\t一个','第\t一个').replace('>> 第\t二个','> 第\t二个'));
  assert.equal(await c.evaluate('view.state.selection.ranges.length'),2,'Shift+Tab keeps both source carets');stable(multiCaretOutdent);
  const undoMultiCaretOutdent=await capture(()=>key('z',mod),{trace:true});
  assert.equal(undoMultiCaretOutdent.pending.value,multiCaretTab.pending.value);stable(undoMultiCaretOutdent);

  const sameLineCarets='前文\n\n>> 多光标文本\n\n尾部',sameA=sameLineCarets.indexOf('多光标文本')+1,sameB=sameA+2;
  await load(sameLineCarets,sameA);
  await c.evaluate(`(()=>{const S=view.state.selection.constructor;view.dispatch({selection:S.create([S.cursor(${sameA}),S.cursor(${sameB})])})})()`);
  const sameLineOutdent=await capture(()=>key('Tab',8),{trace:true});
  assert.equal(sameLineOutdent.pending.value,sameLineCarets.replace('>> 多','> 多'),'one physical quote line is outdented only once');
  assert.equal(await c.evaluate('view.state.selection.ranges.length'),2);stable(sameLineOutdent);

  const mixedCarets='普通正文\n\n> 引用正文\n\n尾部',plainCaret=mixedCarets.indexOf('普通正文')+1,quoteCaret=mixedCarets.indexOf('引用正文')+1;
  await load(mixedCarets,plainCaret);
  await c.evaluate(`(()=>{const S=view.state.selection.constructor;view.dispatch({selection:S.create([S.cursor(${plainCaret}),S.cursor(${quoteCaret})])})})()`);
  await key('Tab');await frame();
  assert.equal(await c.evaluate('editor.value'),mixedCarets,'a mixed multi-caret selection cannot indent before a quote marker');
  assert.equal(await c.evaluate('view.state.selection.ranges.length'),2,'the guarded multi-caret selection is retained');

  const distantRows=Array.from({length:1600},(_,index)=>`> 引用行 ${index}`).join('\n');
  const distantSource=`前文\n\n${distantRows}\n\n尾部`,distantFrom=distantSource.indexOf('引用行 0'),distantTo=distantSource.indexOf('引用行 1599')+'引用行 1599'.length;
  await load(distantSource,distantFrom);await c.evaluate(`editor.input.setSelection(${distantFrom},${distantTo})`);await frame();
  await key('Tab');await frame();
  const distantAfter=await c.evaluate('editor.value'),allDistantIndented=distantSource.replace(/^> /gmu,'> \t');
  assert(distantAfter===distantSource||distantAfter===allDistantIndented,
    'a selection extending outside the viewport must either indent every row or leave all of them unchanged');

  await load(tabText,tabTextAt);await c.evaluate(`editor.setReadOnly(true)`);
  await key('Tab');await frame();assert.equal(await c.evaluate('editor.value'),tabText,'read-only Tab cannot change a quote');
  await c.evaluate(`editor.setReadOnly(false);editor.focus();editor.commands.configureShortcuts({'table.next-cell':null,'search.open':'Tab'})`);
  await key('Tab');await wait(`document.activeElement.matches('.cm-search input[name=search]')`);
  assert.equal(await c.evaluate('editor.value'),tabText,'an explicitly configured Tab command takes precedence');
  await c.evaluate(`editor.input.closeSearch();editor.commands.resetShortcuts();editor.focus()`);
  await c.evaluate(`editor.setLayoutStyle({metrics:{paragraphLineHeight:28,blankLineHeight:28}})`);

  const mixed = '前文\n\n> 上层\n>>>> 文本\n> 下层\n\n尾部';
  await load(mixed, mixed.indexOf('文本'));
  const mixedEdit = await capture(() => key('Backspace'));
  assert.equal(mixedEdit.pending.value, mixed.replace('>>>> ', '>>> '));
  stable(mixedEdit);
  const firstMarker = mixed.indexOf('>>>> ');
  await load(mixed, mixed.indexOf('文本'));
  const firstMarkerEdit = await capture(() => c.evaluate(`editor.input.replaceRange(${firstMarker},${firstMarker+1},'')`));
  assert.equal(firstMarkerEdit.pending.value, mixed.slice(0, firstMarker) + mixed.slice(firstMarker + 1));
  stable(firstMarkerEdit);

  // A native deletion inside a hidden prefix must delete the intended first
  // marker as well as keep the rest of the quote rendered while pending.
  await load(mixed, firstMarker + 1);
  const firstMarkerBackspace = await capture(() => key('Backspace'));
  assert.equal(firstMarkerBackspace.pending.value, mixed.slice(0, firstMarker) + mixed.slice(firstMarker + 1), 'native Backspace removes only the first marker');
  stable(firstMarkerBackspace);

  const rich = '前文\n\n> 上层\n>>>> **文本** 与 `> 字面代码`\n> 下层\n\n尾部';
  const richMarker = rich.indexOf('>>>> ');
  await load(rich, rich.indexOf('文本'));
  const richEdit = await capture(() => c.evaluate(`editor.input.replaceRange(${richMarker},${richMarker+1},'')`));
  assert.equal(richEdit.pending.value, rich.slice(0, richMarker) + rich.slice(richMarker + 1));
  stable(richEdit);
  assert(richEdit.pending.rows.some(row => row.text.includes('> 字面代码')), 'an inline-code > remains literal after a quote-depth edit');

  const spaced = '前文\n\n> > > 文本\n\n尾部';
  await load(spaced, spaced.indexOf('文本'));
  const spacedEdit = await capture(() => key('Backspace'));
  assert.equal(spacedEdit.pending.value, spaced.replace('> > > 文本', '> > 文本'), 'spaced markers do not acquire a duplicate separator');
  assert.equal(spacedEdit.pending.rows.find(row => row.raw.includes('文本'))?.depth, '2');
  assert(spacedEdit.pending.value.endsWith('文本\n\n尾部'), 'outdenting never removes the paragraph body');
  stable(spacedEdit);

  for (const [prefix, expected] of [['>>>>\t', '>>>\t'], ['> >\t', '> ']]) {
    const tabbed = `前文\n\n${prefix}文本\n\n尾部`;
    await load(tabbed, tabbed.indexOf('文本'));
    const tabbedEdit = await capture(() => key('Backspace'));
    assert.equal(tabbedEdit.pending.value, tabbed.replace(prefix + '文本', expected + '文本'), 'outdent preserves one separator with tabs and spaced markers');
    stable(tabbedEdit);
  }

  const splitRoot = '前文\n\n> 上层\n> 文本\n> 下层\n\n尾部';
  await load(splitRoot, splitRoot.indexOf('文本'));
  const leaveMiddle = await capture(() => key('Backspace'));
  assert.equal(leaveMiddle.pending.value, splitRoot.replace('> 文本', '文本'));
  stable(leaveMiddle);
  const rejoinMiddle = await capture(() => key('z', mod));
  assert.equal(rejoinMiddle.pending.value, splitRoot, 'Undo rejoins the quote after a middle row leaves it');
  stable(rejoinMiddle);

  await load(source, caret);
  const rapid = await capture(async () => { for (let i = 0; i < 4; i++) await key('Backspace'); });
  assert.equal(rapid.pending.value, source.replace('>>>> ', ''), 'repeated Backspace exits the last quote level without removing text');
  stable(rapid);
  let restoredRapid = rapid.pending.value;
  for (let i = 0; i < 4 && restoredRapid !== source; i++) {
    const rapidUndo = await capture(() => key('z', mod));
    stable(rapidUndo);
    restoredRapid = rapidUndo.pending.value;
  }
  assert.equal(restoredRapid, source, 'Undo restores every level after exiting the quote');

  const end = caret + '文本'.length;
  await load(source, end);
  const continued = await capture(() => key('Enter'));
  assert.equal(continued.pending.value, source.slice(0,end) + '\n>>>> ' + source.slice(end), 'Enter continues the quote on the next physical line');
  stable(continued);
  const undoEnter = await capture(() => key('z', mod));
  assert.equal(undoEnter.pending.value, source, 'Undo joins the quoted lines and removes only the added prefix');
  stable(undoEnter);
  const redoEnter = await capture(() => key('z', mod | 8));
  assert.equal(redoEnter.pending.value, continued.pending.value, 'Redo restores the quoted continuation');
  stable(redoEnter);

  await load(source, end);
  const shifted = await capture(() => key('Enter', 8));
  if (process.env.JOT_QUOTE_CONTRACT_DIAG === '1') console.log(JSON.stringify({ shifted:{pending:shifted.pending.value,rows:shifted.pending.rows.map(({raw,text,depth})=>({raw,text,depth})),confirmed:shifted.after.value} }));
  assert.equal(shifted.pending.value, continued.pending.value, 'Shift+Enter continues an ordinary quote instead of exiting it');
  stable(shifted);

  await load(source, caret + 1);
  const splitText = await capture(() => key('Enter'));
  assert.equal(splitText.pending.value, source.slice(0,caret+1) + '\n>>>> ' + source.slice(caret+1), 'Enter in the middle of text continues the same quote');
  stable(splitText);

  await load(source, end);
  const rapidEnter = await capture(async () => { for (let i = 0; i < 3; i++) await key('Enter'); });
  assert.equal(rapidEnter.pending.value, source.slice(0,end) + '\n>>>> '.repeat(3) + source.slice(end), 'repeated Enter adds quote rows without changing depth');
  stable(rapidEnter);

  await load(source, caret);
  const spaceInput = await capture(() => c.command('Input.insertText', { text: ' ' }));
  assert.equal(spaceInput.pending.value, source.slice(0,caret) + ' ' + source.slice(caret));
  stable(spaceInput);

  const emptyEdit = '前文\n\n>>>> \n\n尾部', emptyAt = emptyEdit.indexOf('>>>> ') + '>>>> '.length;
  await load(emptyEdit, emptyAt);
  const emptyShift = await capture(() => key('Enter', 8));
  assert.equal(emptyShift.pending.value, emptyEdit.slice(0,emptyAt) + '\n>>>> ' + emptyEdit.slice(emptyAt), 'Shift+Enter on an empty quote keeps an empty continuation');
  stable(emptyShift);
  await load(emptyEdit, emptyAt);
  const emptyEnter = await capture(() => key('Enter'));
  assert.equal(emptyEnter.pending.value, emptyEdit.slice(0,emptyAt) + '\n>>>> ' + emptyEdit.slice(emptyAt), 'Enter on an empty quote preserves its depth');
  stable(emptyEnter);

  for (const depth of [1, 5, 12]) {
    const empty = `前文\n\n${'>'.repeat(depth)}\n\n尾部`;
    await load(empty, 0, 'split');
    try { await wait(`document.querySelectorAll('.jot-editor-surface blockquote').length===${depth}`); }
    catch (error) {
      console.error('empty quote split diagnosis', await c.evaluate(`({value:editor.value,html:document.querySelector('.jot-editor-surface')?.innerHTML.slice(0,4000)})`));
      throw error;
    }
    const previewHeight = await c.evaluate(`document.querySelector('.jot-editor-surface blockquote').getBoundingClientRect().height`);
    if (depth === 12) await screenshot('empty-depth12-split');
    await load(empty, 0);
    await wait(`!!view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="${depth}"]')`);
    const liveHeight = await c.evaluate(`view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="${depth}"]').getBoundingClientRect().height`);
    near(previewHeight, 52, `empty split quote height at depth ${depth}`);
    near(liveHeight, 52, `empty live quote height at depth ${depth}`);
  }

  await c.evaluate(`editor.setLayoutStyle({metrics:{headingLineHeights:[18,18,18,18,18,18]}})`);
  const quotedHeading = '前文\n\n>>>> # 标题\n\n尾部';
  await load(quotedHeading, 0, 'preview');
  await wait(`document.querySelector('.jot-editor-surface blockquote h1')?.innerText.includes('标题')`);
  const headingPreview = await c.evaluate(`document.querySelector('.jot-editor-surface blockquote').getBoundingClientRect().height`);
  await load(quotedHeading, 0);
  await wait(`!!view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="4"].jot-live-preview-source-heading')`);
  const headingLive = await c.evaluate(`view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="4"]').getBoundingClientRect().height`);
  near(headingPreview, headingLive, 'nested quote honors a short customized heading line height');

  const longQuote = `前文\n\n${'>'.repeat(9)} ${'文本'.repeat(70)}\n\n尾部`;
  await load(longQuote, 0, 'preview');const longPreview = await geometry('preview');
  await load(longQuote, 0, 'pretext');
  const longPretextHeight = await c.evaluate(`document.querySelector('.jot-pretext-block--block-quote').getBoundingClientRect().height`);
  assert(Math.abs(longPretextHeight-longPreview.height) <= 28, `a wrapped quote's estimate stays within one text row: ${JSON.stringify({longPretextHeight,longPreview})}`);

  const literal = `前文\n\n${'>'.repeat(9)} \`> literal\`\n\n尾部`;
  await load(literal, 0, 'pretext');
  await wait(`document.querySelector('.jot-pretext-block--block-quote .jot-pretext-block__preview')?.textContent.includes('> literal')`);

  const longBody = 'x'.repeat(4096) + '😀文本';
  const longEditSource = `前文\n\n>>>> ${longBody}\n\n尾部`, longAt = longEditSource.indexOf(longBody);
  await load(longEditSource, longAt);
  const longEdit = await capture(() => key('Backspace'));
  assert.equal(longEdit.pending.value, longEditSource.replace('>>>> ', '>>> '));
  stable(longEdit);

  // Reproducible mixed-depth cases exercise changes to the edited row and
  // both adjacent quote edges, including leaving the final quote level.
  let randomState = 0x41c64e6d;
  const randomDepth = () => { randomState = (Math.imul(randomState,1664525) + 1013904223) >>> 0;return 1 + randomState % 7; };
  for (let i = 0; i < 24; i++) {
    const depths = [randomDepth(), randomDepth(), randomDepth()];
    const bodies = [`前邻${i}`, `正文${i}😀`, `后邻${i}`];
    const rows = bodies.map((body,index) => '>'.repeat(depths[index]) + ' ' + body);
    const sample = '前文\n\n' + rows.join('\n') + '\n\n尾部';
    await load(sample, sample.indexOf(bodies[1]));
    const change = await capture(() => key('Backspace'));
    const editedRow = change.pending.rows.find(row => row.raw.includes(bodies[1]));
    assert.equal(editedRow?.depth, depths[1] === 1 ? null : String(depths[1]-1), `mixed depth ${depths.join('/')} outdents the selected row: ${JSON.stringify(change)}`);
    assert(editedRow?.text.includes(bodies[1]), 'mixed-depth outdent preserves the entire body');
    stable(change);
    const restored = await capture(() => key('z', mod));
    assert.equal(restored.pending.value, sample, 'mixed-depth undo restores the original source');
    stable(restored);
  }

  // Very deep indentation cannot consume the entire viewport, and both
  // rendering modes must use the same remaining content width.
  await c.evaluate(`document.querySelector('#quote-contract').style.width='240px'`);
  const narrow = `前文\n\n${'>'.repeat(30)} 文本\n\n尾部`;
  await load(narrow, 0, 'preview');const narrowPreview = await geometry('preview');
  await load(narrow, 0);const narrowLive = await geometry('live-preview');
  near(narrowLive.start, narrowPreview.start, 'narrow preview/live indentation');
  near(narrowPreview.end, 12, 'narrow preview right inset');
  assert(narrowLive.width - narrowLive.paddingStart - narrowLive.paddingEnd >= 63, `a narrow deep quote retains a readable content column: ${JSON.stringify(narrowLive)}`);
  await c.evaluate(`editor.setLayoutStyle({metrics:{quoteMinContentWidth:120}})`);
  await load(narrow, 0, 'preview');const customPreview = await geometry('preview');
  await load(narrow, 0);const customLive = await geometry('live-preview');
  near(customLive.start, customPreview.start, 'custom minimum width matches in both renderers');
  assert(customLive.width - customLive.paddingStart - customLive.paddingEnd >= 119, 'the configured minimum text width is respected');

  await c.evaluate(`document.querySelector('#quote-contract').style.width='800px';document.querySelector('#quote-contract').dir='rtl'`);
  const rtl = 'قبل\n\n>>>> نص\n\nبعد';
  await load(rtl, 0, 'preview');
  await wait(`document.querySelector('.jot-editor-surface blockquote')?.innerText.includes('نص')`);
  const rtlPreview = await c.evaluate(`(()=>{const q=document.querySelector('.jot-editor-surface blockquote'),w=document.createTreeWalker(q,NodeFilter.SHOW_TEXT);let t;while((t=w.nextNode()))if(t.nodeValue.includes('نص'))break;const r=new Range();r.setStart(t,t.nodeValue.indexOf('نص'));r.setEnd(t,t.nodeValue.indexOf('نص')+1);return{start:q.getBoundingClientRect().right-r.getBoundingClientRect().right,shadow:getComputedStyle(q).boxShadow}})()`);
  await load(rtl, 0);
  await wait(`!!view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="4"]')`);
  const rtlLive = await c.evaluate(`(()=>{const q=view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="4"]'),w=document.createTreeWalker(q,NodeFilter.SHOW_TEXT);let t;while((t=w.nextNode()))if(t.nodeValue.includes('نص'))break;const r=new Range();r.setStart(t,t.nodeValue.indexOf('نص'));r.setEnd(t,t.nodeValue.indexOf('نص')+1);return{start:q.getBoundingClientRect().right-r.getBoundingClientRect().right,position:getComputedStyle(q).backgroundPosition}})()`);
  near(rtlLive.start, rtlPreview.start, 'RTL preview/live indentation');
  assert(rtlPreview.shadow.includes('-3px'), 'RTL semantic quote places its rule at the right edge');

  // Consumers can supply a CodeMirror indent unit; quoted lists and code
  // must honor it while ordinary quote bodies keep their own Tab behavior.
  await c.evaluate(`(async()=>{document.querySelector('#quote-contract').dir='ltr';
    const {StateEffect,indentUnit}=await import('/@fs${process.cwd()}/packages/editor/tests/browser-support/quote-browser-fixture.ts');
    view.dispatch({effects:StateEffect.appendConfig.of(indentUnit.of('\\t'))})})()`);
  await load(quoteList,listAt);
  const customListIndent=await capture(()=>key('Tab'),{trace:true});
  assert.equal(customListIndent.pending.value,quoteList.replace('> - 列表','> \t- 列表'),'a configured tab indent unit applies inside quoted lists');
  stable(customListIndent);
  const customListOutdent=await capture(()=>key('Tab',8),{trace:true});
  assert.equal(customListOutdent.pending.value,quoteList,'the configured indent unit can be removed');stable(customListOutdent);
  await load(quoteCode,codeAt);
  const customCodeIndent=await capture(()=>key('Tab'));
  assert.equal(customCodeIndent.pending.value,quoteCode.replace('> let value','> \tlet value'),'a configured tab indent unit applies inside quoted code');
  stable(customCodeIndent);
  const customCodeOutdent=await capture(()=>key('Tab',8));
  assert.equal(customCodeOutdent.pending.value,quoteCode,'the configured code indentation can be removed');stable(customCodeOutdent);
  assert.deepEqual(errors, []);assert.deepEqual(await c.evaluate('editorErrors'), []);
  console.log('PASS: quote geometry and text-prefix editing match the shared contract');
} finally {
  try { if (c) { await c.evaluate('(async()=>{await releaseWorker();editor?.dispose();worker?.terminate()})()');c.socket.close(); } } catch {}
  await stopProcess(chrome);await stopProcess(server);rmSync(profile, { recursive: true, force: true });
}
