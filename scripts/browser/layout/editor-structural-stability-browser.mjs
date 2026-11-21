// Exercise the exported component with real keyboard/pointer input. Holding
// Worker responses exposes the paint between the local edit and Rust's answer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, keyboardEventKey, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_STRUCTURAL_PORT??4311),debugPort=Number(process.env.JOT_STRUCTURAL_DEBUG_PORT??9511);
const profile=mkdtempSync(resolve(tmpdir(),'jot-structural-browser-'));
let server,chrome,c;
const errors=[];
try {
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.includes(`:${port}`)).webSocketDebuggerUrl);
  c.socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text)});
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1300,height:900,deviceScaleFactor:1,mobile:false});
  const wait=(expression,timeout=30000)=>waitForEvaluation(c,expression,timeout);
  await wait(`document.readyState==='complete' && document.title==='Jot native component integration fixture'`);
  await c.evaluate(`(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.id='structural-test';root.style.cssText='width:1000px;height:700px;margin:10px';document.body.replaceChildren(root);
    window.worker=new Worker('/src/worker.ts',{type:'module'});window.editorErrors=[];window.holdWorker=false;window.heldMessages=[];
    const listeners=new Map(),endpoint={
      postMessage(value){worker.postMessage(value)},
      addEventListener(type,listener){const wrapped=event=>{if(type==='message'&&holdWorker)heldMessages.push(()=>listener(event));else listener(event)};listeners.set(listener,wrapped);worker.addEventListener(type,wrapped)},
      removeEventListener(type,listener){const wrapped=listeners.get(listener);if(wrapped)worker.removeEventListener(type,wrapped);listeners.delete(listener)},
    };
    // Preserve the microtask checkpoint between normal Worker message events.
    window.releaseWorker=async()=>{while(heldMessages.length){heldMessages.shift()();await Promise.resolve()}holdWorker=false};
    window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint,documentId:'structural-test',generation:1,source:'',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:error=>editorErrors.push(String(error))});
    await editor.open();window.view=editor.input.view;
  })()`);
  const frame=()=>c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const load=async(source,position,timeout=30000)=>{
    await c.evaluate(`(async()=>{await editor.setMode('live-preview');editor.setValue(${JSON.stringify(source)});editor.input.setSelection(${position});editor.focus()})()`);
    await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,timeout);
    await c.evaluate('editor.livePreview.settled()');await frame();
  };
  const key=async(name,modifiers=0)=>{
    const code=name===' '?'Space':/^[a-z]$/iu.test(name)?`Key${name.toUpperCase()}`:name;
    const number={Enter:13,Backspace:8,Delete:46,z:90,' ':32}[name]??0;
    for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:keyboardEventKey(name,modifiers),code,windowsVirtualKeyCode:number,modifiers,...(type==='keyDown'&&name===' '?{text:' '}: {})});
  };
  const snapshot=()=>c.evaluate(`(()=>{
    const rows=[...view.contentDOM.querySelectorAll('.cm-line')].map(element=>{
      const position=view.posAtDOM(element,0),line=view.state.doc.lineAt(position),rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return{from:line.from,raw:line.text,visible:element.innerText,depth:element.dataset.jotQuoteDepth??null,open:element.dataset.jotQuoteOpen??null,close:element.dataset.jotQuoteClose??null,number:element.dataset.jotLineNumber??null,codeOwner:element.dataset.jotCodeOwner??null,classes:element.className,left:rect.left,top:rect.top,height:rect.height,padding:parseFloat(style.paddingInlineStart),lineHeight:style.lineHeight,backgroundColor:style.backgroundColor,numberWidth:style.getPropertyValue('--jot-code-number-width').trim()};
    });const caret=view.coordsAtPos(view.state.selection.main.head);return{value:editor.value,confirmed:editor.confirmedValue,head:view.state.selection.main.head,caret:caret?{left:caret.left,top:caret.top,bottom:caret.bottom}:null,scroll:view.scrollDOM.scrollTop,rows};
  })()`);
  const capture=async(action,timeout=30000)=>{
    const before=await snapshot();await c.evaluate('holdWorker=true');
    try {
      await action();await wait('editor.value!==editor.confirmedValue',5000);await frame();
      const pending=await snapshot();await c.evaluate('releaseWorker()');
      await wait(`editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,timeout);
      await c.evaluate('editor.livePreview.settled()');await frame();
      return{before,pending,after:await snapshot()};
    } finally {await c.evaluate('releaseWorker()')}
  };
  const close=(a,b,label)=>assert(Math.abs(a-b)<=1,`${label}: ${a} vs ${b}`);
  const compareCaret=(pending,after)=>{
    assert.equal(pending.head,after.head,'confirmation must preserve the source selection');
    assert(pending.caret && after.caret,'the edited caret must remain measurable');
    close(pending.caret.left,after.caret.left,'caret horizontal position');
    close(pending.caret.top,after.caret.top,'caret vertical position');
  };
  const compareQuote=(pending,after)=>{
    compareCaret(pending,after);
    const actual=pending.rows.filter(row=>row.raw.startsWith('>'));
    const expected=after.rows.filter(row=>row.raw.startsWith('>'));
    assert.deepEqual(actual.map(row=>[row.raw,row.depth,row.open,row.close]),expected.map(row=>[row.raw,row.depth,row.open,row.close]),'pending quote hierarchy must agree with confirmed Rust projection');
    for(let i=0;i<actual.length;i++) {
      assert(!actual[i].visible.startsWith('>'),'an unaffected quote prefix must stay hidden');
      close(actual[i].top,expected[i].top,'quote row top');close(actual[i].height,expected[i].height,'quote row height');close(actual[i].padding,expected[i].padding,'quote row indentation');
    }
  };
  const quote='开头\n\n> 状态：上层引用。\n> >>>\n> >>>>适用范围：**多层引用** 与 `inline`。\n> >>>>>>七层引用\n> > - [ ] 引用任务\n> 回到第一层。\n\n尾部';
  const quoteLine=quote.indexOf('> >>>\n'),quotePosition=quoteLine+'> >>>'.length;
  await load(quote,quotePosition);
  const outdent=await capture(()=>key('Backspace'));
  assert.equal(outdent.pending.value,quote.slice(0,quotePosition-1)+quote.slice(quotePosition));
  compareQuote(outdent.pending,outdent.after);
  assert.equal(outdent.pending.rows.find(row=>row.raw==='> >>')?.depth,'3');

  await load(quote,quotePosition);
  const space=await capture(()=>key(' '));
  assert.equal(space.pending.value,quote.slice(0,quotePosition)+' '+quote.slice(quotePosition));
  compareQuote(space.pending,space.after);
  assert.equal(space.pending.rows.find(row=>row.raw==='> >>> ')?.depth,'4');

  // Even if a programmatic source selection lies inside a hidden prefix, a
  // real Space key at the visual caret must not split the atomic marker.
  const spacedQuote='开头\n\n> 上层\n>    >\n> 结束\n\n尾部';
  const spacedLine=spacedQuote.indexOf('>    >'),spacedPosition=spacedLine+5;
  await load(spacedQuote,spacedPosition);
  const snappedSpace=await capture(()=>key(' '));
  const snappedPosition=spacedLine+'>    >'.length;
  assert.equal(snappedSpace.pending.value,spacedQuote.slice(0,snappedPosition)+' '+spacedQuote.slice(snappedPosition));
  compareQuote(snappedSpace.pending,snappedSpace.after);
  assert.equal(snappedSpace.pending.rows.find(row=>row.raw==='>    > ')?.depth,'2');

  await load(quote,quotePosition);
  const forwardDelete=await capture(()=>key('Delete'));
  assert.equal(forwardDelete.pending.value,quote.slice(0,quoteLine)+quote.slice(quotePosition+1),'Delete removes the empty quote row without concatenating two prefixes');
  compareQuote(forwardDelete.pending,forwardDelete.after);
  assert.equal(forwardDelete.pending.rows.find(row=>row.raw.includes('适用范围'))?.depth,'5','the next quote keeps its original level');
  const mod=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`)?4:2;
  const undoForwardDelete=await capture(()=>key('z',mod));
  assert.equal(undoForwardDelete.pending.value,quote,'deleting an empty quote row is undoable');
  compareQuote(undoForwardDelete.pending,undoForwardDelete.after);
  const redoForwardDelete=await capture(()=>key('z',mod|8));
  assert.equal(redoForwardDelete.pending.value,forwardDelete.pending.value,'the quote row deletion can also be redone');
  compareQuote(redoForwardDelete.pending,redoForwardDelete.after);

  const quoteSeam='前文\n\n> 上一段 **保留**\n\n>> 下一段 `保留`\n\n尾部';
  const seam=quoteSeam.indexOf('\n\n>>')+1;
  await load(quoteSeam,seam);
  const mergeQuote=await capture(()=>key('Backspace'));
  assert.equal(mergeQuote.pending.value,quoteSeam.slice(0,seam-1)+quoteSeam.slice(seam));
  for(const [name,phase] of Object.entries({pending:mergeQuote.pending,confirmed:mergeQuote.after})) {
    assert.deepEqual(phase.rows.filter(row=>row.raw.startsWith('>')).map(row=>[row.depth,row.visible]),
      [['1','上一段 保留'],['2','下一段 保留']], `a physical quote line keeps its styling across a blank-line deletion (${name})`);
  }
  const undoMergeQuote=await capture(()=>key('z',mod));
  assert.equal(undoMergeQuote.pending.value,quoteSeam);
  for(const phase of [undoMergeQuote.pending,undoMergeQuote.after]){
    assert.deepEqual(phase.rows.filter(row=>row.raw.startsWith('>')).map(row=>row.depth),['1','2']);
  }

  await load(quote,quotePosition);
  const rapid=await capture(async()=>{for(let i=0;i<4;i++)await key('Backspace')});
  assert.equal(rapid.pending.value,quote.slice(0,quoteLine)+quote.slice(quotePosition));
  compareQuote(rapid.pending,rapid.after);
  const blankQuote=rapid.pending.rows.find(row=>row.from===quoteLine);
  assert(blankQuote && blankQuote.raw==='' && blankQuote.depth===null && blankQuote.classes.includes('jot-live-preview-blank-line'),'removing the last quote level produces a normal physical blank line immediately');
  const blankConfirmed=rapid.after.rows.find(row=>row.from===quoteLine);
  close(blankQuote.top,blankConfirmed.top,'quote exit blank top');close(blankQuote.height,blankConfirmed.height,'quote exit blank height');

  await c.evaluate(`editor.setLayoutStyle({fontSize:16,metrics:{paragraphLineHeight:26,blankLineHeight:26}})`);
  for(const [inset,fontFamily] of [[0,'Georgia, serif'],[12,'ui-monospace, monospace'],[20,'system-ui, sans-serif']]) {
    await c.evaluate(`editor.setLayoutStyle({fontFamily:${JSON.stringify(fontFamily)},metrics:{paragraphPaddingX:${inset}}})`);
    const source='上方正文\n\n下方正文',position=source.indexOf('\n\n')+1;
    await load(source,position);
    const point=await c.evaluate(`(()=>{const r=view.coordsAtPos(${position});return{x:r.left+.5,y:(r.top+r.bottom)/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    await wait(`view.state.selection.main.head===${position}`);
    const insertion=await capture(()=>c.command('Input.insertText',{text:'字'}));
    const start=await c.evaluate(`view.coordsAtPos(${position})?.left`);
    close(insertion.before.caret.left,start,`blank-to-text caret alignment at inset ${inset}`);
    const pendingRow=insertion.pending.rows.find(row=>row.from===position),confirmedRow=insertion.after.rows.find(row=>row.from===position);
    assert.equal(pendingRow.raw,'字');close(pendingRow.padding,inset,'pending blank paragraph inset');close(confirmedRow.padding,inset,'confirmed paragraph inset');
    close(pendingRow.top,confirmedRow.top,'blank input row top');close(pendingRow.height,confirmedRow.height,'blank input row height');
    await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');
    await wait(`document.querySelector('.jot-editor-surface')?.textContent.includes('字')`);
    const previewLeft=await c.evaluate(`(()=>{const root=document.querySelector('.jot-editor-surface'),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode()))if(node.nodeValue.includes('字'))break;const range=new Range(),index=node.nodeValue.indexOf('字');range.setStart(node,index);range.setEnd(node,index+1);return range.getBoundingClientRect().left})()`);
    close(start,previewLeft,`Preview and Live Preview paragraph start at inset ${inset}`);
    await load(source,position);
    const longText='汉字Mixed文字'.repeat(40);
    const pasted=await capture(()=>c.command('Input.insertText',{text:longText}));
    const pendingLong=pasted.pending.rows.find(row=>row.from===position),afterLong=pasted.after.rows.find(row=>row.from===position);
    close(pendingLong.height,afterLong.height,`pasted paragraph wrapping before confirmation at inset ${inset}`);
    await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');
    await wait(`document.querySelector('.jot-editor-surface')?.textContent.includes(${JSON.stringify(longText)})`);
    const previewHeight=await c.evaluate(`(()=>{const p=[...document.querySelectorAll('.jot-editor-surface [data-jot-kind="paragraph"]')].find(n=>n.textContent.includes(${JSON.stringify(longText)}));return p.getBoundingClientRect().height})()`);
    close(afterLong.height,previewHeight,`Preview and Live Preview wrapping at inset ${inset}`);
  }

  const compareCode=(pending,after)=>{
    compareCaret(pending,after);
    const actual=pending.rows.filter(row=>row.number!==null),expected=after.rows.filter(row=>row.number!==null);
    assert.deepEqual(actual.map(row=>[row.raw,row.number]),expected.map(row=>[row.raw,row.number]),'pending code rows and numbers must match the confirmed projection');
    for(let i=0;i<actual.length;i++) {
      close(actual[i].top,expected[i].top,'code row top');close(actual[i].height,expected[i].height,'code row height');close(actual[i].padding,expected[i].padding,'code gutter width');
      assert(actual[i].classes.includes('jot-code-line'),'a pending code row retains its code styling');
      assert.equal(actual[i].lineHeight,expected[i].lineHeight,'code row line height stays stable');
      assert.equal(actual[i].backgroundColor,expected[i].backgroundColor,`code row background stays stable: ${JSON.stringify({actual:actual[i],expected:expected[i]})}`);
    }
  };
  await c.evaluate(`editor.setLayoutStyle({metrics:{paragraphPaddingX:0,paragraphLineHeight:26,blankLineHeight:26,codeLineHeight:20}})`);
  const fence='```';
  const code='顶部\n\n'+fence+' ts\n'+Array.from({length:160},(_,i)=>`const codeLine${i+1} = "第 ${i+1} 行: 中文 😀";`).join('\n')+'\n'+fence+'\n\n尾部';
  const line150=`const codeLine150 = "第 150 行: 中文 😀";`,position=code.indexOf(line150)+line150.length;
  await load(code,position,60000);
  await wait(`!!view.contentDOM.querySelector('.jot-code-line[data-jot-line-number="150"]')`,30000);
  assert.equal(await c.evaluate('view.hasFocus'),true,'code input surface has keyboard focus');
  assert.equal(await c.evaluate('view.state.selection.main.head'),position,'code caret remains on the requested source line');
  const entered=await capture(()=>key('Enter'),60000);
  assert.equal(entered.pending.value,code.slice(0,position)+'\n'+code.slice(position));
  compareCode(entered.pending,entered.after);
  assert(entered.pending.rows.some(row=>row.raw===''&&row.number==='151'),'new empty code row receives its number before confirmation');
  const joined=await capture(()=>key('Backspace'),60000);
  assert.equal(joined.pending.value,code);compareCode(joined.pending,joined.after);

  await load(code,position,60000);
  const rapidCode=await capture(async()=>{await key('Enter');await key('Enter');await key('Enter')},60000);
  assert.equal(rapidCode.pending.value,code.slice(0,position)+'\n\n\n'+code.slice(position));
  compareCode(rapidCode.pending,rapidCode.after);
  const rapidCodeJoin=await capture(async()=>{await key('Backspace');await key('Backspace');await key('Backspace')},60000);
  assert.equal(rapidCodeJoin.pending.value,code);compareCode(rapidCodeJoin.pending,rapidCodeJoin.after);

  await load(code,position,60000);
  const deleted=await capture(()=>key('Delete'),60000);
  assert.equal(deleted.pending.value,code.slice(0,position)+code.slice(position+1));compareCode(deleted.pending,deleted.after);
  const undone=await capture(()=>key('z',mod),60000);
  assert.equal(undone.pending.value,code);compareCode(undone.pending,undone.after);
  const wholeLineFrom=code.indexOf('const codeLine151 = '),wholeLineTo=code.indexOf('const codeLine152 = ');
  await load(code,wholeLineFrom,60000);
  await c.evaluate(`editor.input.setSelection(${wholeLineFrom},${wholeLineTo});editor.focus()`);
  const wholeLineDelete=await capture(()=>key('Delete'),60000);
  assert.equal(wholeLineDelete.pending.value,code.slice(0,wholeLineFrom)+code.slice(wholeLineTo));
  compareCode(wholeLineDelete.pending,wholeLineDelete.after);

  await c.evaluate(`editor.setLayoutStyle({codeBlockWrap:'wrap'})`);
  const longCode='前文\n\n'+fence+' ts\nconst wrapped = "'+('x'.repeat(800))+'";\nconst following = 2;\n'+fence+'\n\n尾部';
  const longAt=longCode.indexOf('x'.repeat(10))+400;
  await load(longCode,longAt);
  const wrappedEnter=await capture(()=>key('Enter'));
  assert.equal(wrappedEnter.pending.value,longCode.slice(0,longAt)+'\n'+longCode.slice(longAt));
  compareCode(wrappedEnter.pending,wrappedEnter.after);
  await c.evaluate(`editor.setLayoutStyle({codeBlockWrap:'scroll'})`);

  // The quote marker belongs to the code container, so splitting or joining
  // a code row must retain the original fenced block and its source prefix.
  for(const depth of [1,3,7]) {
    const prefix='> '.repeat(depth),body=Array.from({length:5},(_,i)=>`${prefix}const q${i} = ${i};`);
    const source='前文\n\n'+prefix+fence+' ts\n'+body.join('\n')+'\n'+prefix+fence+'\n\n尾部';
    const token='const q2 = 2;',at=source.indexOf(token)+token.length;
    await load(source,at);
    const quotedEnter=await capture(()=>key('Enter'));
    const withLine=source.slice(0,at)+'\n'+prefix+source.slice(at);
    assert.equal(quotedEnter.pending.value,withLine,`a depth ${depth} quote continues its prefix on code Enter`);
    compareCode(quotedEnter.pending,quotedEnter.after);compareQuote(quotedEnter.pending,quotedEnter.after);
    assert(quotedEnter.pending.rows.some(row=>row.raw===prefix&&row.number==='4'&&Number(row.depth)===depth),'the new quoted code row has a hidden prefix and its code number');
    const quotedJoin=await capture(()=>key('Backspace'));
    assert.equal(quotedJoin.pending.value,source,'Backspace removes the separator and the second prefix together');
    compareCode(quotedJoin.pending,quotedJoin.after);compareQuote(quotedJoin.pending,quotedJoin.after);
    await load(source,at);
    const shiftEnter=await capture(()=>key('Enter',8));
    assert.equal(shiftEnter.pending.value,withLine,'Shift-Enter also continues the quoted code prefix');
    compareCode(shiftEnter.pending,shiftEnter.after);compareQuote(shiftEnter.pending,shiftEnter.after);
    await load(source,at);
    const quotedDelete=await capture(()=>key('Delete'));
    assert.equal(quotedDelete.pending.value,source.slice(0,at)+source.slice(at+1+prefix.length),'Delete joins quoted code rows without leaving a prefix in the body');
    compareCode(quotedDelete.pending,quotedDelete.after);compareQuote(quotedDelete.pending,quotedDelete.after);
    const quoteUndo=await capture(()=>key('z',mod));
    assert.equal(quoteUndo.pending.value,source,'quoted code joins remain undoable');
    compareCode(quoteUndo.pending,quoteUndo.after);compareQuote(quoteUndo.pending,quoteUndo.after);
    if(depth===3) {
      await load(source,at);
      const rapidEnter=await capture(async()=>{await key('Enter');await key('Enter')});
      assert.equal(rapidEnter.pending.value,source.slice(0,at)+(`\n${prefix}`).repeat(2)+source.slice(at));
      compareCode(rapidEnter.pending,rapidEnter.after);compareQuote(rapidEnter.pending,rapidEnter.after);
      const rapidJoin=await capture(async()=>{await key('Backspace');await key('Backspace')});
      assert.equal(rapidJoin.pending.value,source,'multiple unconfirmed quoted code joins preserve the fence');
      compareCode(rapidJoin.pending,rapidJoin.after);compareQuote(rapidJoin.pending,rapidJoin.after);
      const selectionFrom=source.indexOf('q2 ='),selectionTo=selectionFrom+2;
      await load(source,selectionFrom);
      await c.evaluate(`editor.input.setSelection(${selectionFrom},${selectionTo});editor.focus()`);
      const replaceWithLine=await capture(()=>key('Enter'));
      assert.equal(replaceWithLine.pending.value,source.slice(0,selectionFrom)+'\n'+prefix+source.slice(selectionTo),'Enter replaces an ordinary selection without losing the quote prefix');
      compareCode(replaceWithLine.pending,replaceWithLine.after);compareQuote(replaceWithLine.pending,replaceWithLine.after);
      const firstBody=source.indexOf('const q0 = 0;'),lastBody=source.indexOf('const q4 = 4;')+'const q4 = 4;'.length;
      await load(source,firstBody);await key('Backspace');await frame();
      assert.equal(await c.evaluate('editor.value'),source,'Backspace at the first quoted code row does not remove the opening fence');
      await load(source,lastBody);await key('Delete');await frame();
      assert.equal(await c.evaluate('editor.value'),source,'Delete at the last quoted code row does not remove the closing fence');
    }
  }

  const indented='前文\n\n> ``` ts\n>     const indented = 1;\n> ```\n\n尾部';
  const indentedAt=indented.indexOf('const indented = 1;')+'const indented = 1;'.length;
  await load(indented,indentedAt);
  const indentedEnter=await capture(()=>key('Enter'));
  assert.equal(indentedEnter.pending.value,indented.slice(0,indentedAt)+'\n>     '+indented.slice(indentedAt),'quoted code retains the same indentation as the normal code editor');
  compareCode(indentedEnter.pending,indentedEnter.after);compareQuote(indentedEnter.pending,indentedEnter.after);

  const deepIndent=' '.repeat(300),deeplyIndented='前文\n\n> ``` ts\n> '+deepIndent+'const value = 1;\n> ```\n\n尾部';
  const deepAt=deeplyIndented.indexOf('const value = 1;')+'const value = 1;'.length;
  await load(deeplyIndented,deepAt);
  const deepEnter=await capture(()=>key('Enter'));
  assert.equal(deepEnter.pending.value,deeplyIndented.slice(0,deepAt)+'\n> '+deepIndent+deeplyIndented.slice(deepAt),'quoted code preserves indentation longer than 256 characters');
  compareCode(deepEnter.pending,deepEnter.after);compareQuote(deepEnter.pending,deepEnter.after);

  const literalPrefix='> '.repeat(3),literal='前文\n\n'+literalPrefix+fence+' ts\n'+literalPrefix+'> literal code\n'+literalPrefix+fence+'\n\n尾部';
  const literalAt=literal.indexOf('literal code')+'literal code'.length;
  await load(literal,literalAt);
  const literalEnter=await capture(()=>key('Enter'));
  assert.equal(literalEnter.pending.value,literal.slice(0,literalAt)+'\n'+literalPrefix+literal.slice(literalAt));
  compareCode(literalEnter.pending,literalEnter.after);
  assert(literalEnter.pending.rows.some(row=>row.raw.includes('> literal code')&&row.visible.startsWith('> literal code')),'a literal > in quoted code remains visible');

  // A split may create a closer; the local fast path must not present the
  // following line as confirmed code once Rust has changed the topology.
  for(const prefix of ['', '> ']) {
    const source='前文\n\n'+prefix+fence+' ts\n'+prefix+'hello```\n'+prefix+'after closer\n'+prefix+fence+'\n\n尾部';
    const at=source.indexOf('hello```')+'hello'.length;
    await load(source,at);
    const split=await capture(()=>key('Enter'));
    const expected=source.slice(0,at)+'\n'+prefix+source.slice(at);
    assert.equal(split.after.value,expected);
    const following=split.after.rows.find(row=>row.raw.includes('after closer'));
    assert(following && following.number===null && !following.classes.includes('jot-live-preview-source-fenced-code'),'a newly created closer releases the following line from the code block');
  }

  if(process.env.JOT_STRUCTURAL_STRESS==='1') {
    const large='前文\n\n'+fence+' ts\n'+Array.from({length:9999},(_,i)=>`code${i+1}`).join('\n')+'\n'+fence+'\n\n尾部';
    const at=large.indexOf('code9998')+'code9998'.length;
    await load(large,at,90000);
    await wait(`!!view.contentDOM.querySelector('.jot-code-line[data-jot-line-number="9998"]')`,60000);
    const digitBoundary=await capture(()=>key('Enter'),90000);
    assert.equal(digitBoundary.pending.value,large.slice(0,at)+'\n'+large.slice(at));
    compareCode(digitBoundary.pending,digitBoundary.after);
    assert(digitBoundary.pending.rows.some(row=>row.number==='10000'),'the five-digit code number is visible before confirmation');
    const restored=await capture(()=>key('Backspace'),90000);
    assert.equal(restored.pending.value,large);compareCode(restored.pending,restored.after);
    console.log('PASS: 9,999-to-10,000 code line transition retains gutter geometry');
  }

  assert.deepEqual(await c.evaluate('editorErrors'),[]);assert.deepEqual(errors,[]);
  console.log('PASS: quote outdent, blank alignment and code line edits stay stable before Rust confirmation');
} finally {
  try {await c?.evaluate('(async()=>{await releaseWorker();editor?.dispose();worker?.terminate()})()')} catch {}
  c?.socket.close();await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
