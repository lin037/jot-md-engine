import assert from 'node:assert/strict';

// The initial document is fixture setup; every focus, edit, composition and
// Undo below uses browser input events rather than a programmatic selection.
export async function runEmptyBlockScenarios({c,load,settle,confirmed,results,screenshot}) {
 const mac=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`),mod=mac?4:2;
 const onlyKind=process.env.JOT_EMPTY_BLOCK_KIND??'',onlyCase=process.env.JOT_EMPTY_CASE??'',traceInput=process.env.JOT_EMPTY_TRACE==='1';
 async function press(name,modifiers=0) {
  const code=name.length===1?'Key'+name.toUpperCase():name;
  const virtual={End:35,Home:36,Enter:13,Delete:46,ArrowRight:39,ArrowDown:40,ArrowUp:38,z:90}[name];
  await c.command('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,modifiers,windowsVirtualKeyCode:virtual});
  await c.command('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,modifiers,windowsVirtualKeyCode:virtual});
  await settle();
 }
 // These cases deliberately build adjacent delimiters without a physical body row.
 async function manualNewline() {
  for (const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',
    {type,key:'Enter',code:'Enter',modifiers:8,windowsVirtualKeyCode:13});
 }
 async function inspect() {
  return c.evaluate(`(()=>{const s=view.state.selection.main,p=view.scrollDOM.getBoundingClientRect(),r=view.coordsAtPos(s.head),active=document.activeElement;
   let visibleCandidate=false;const walker=document.createTreeWalker(view.dom,NodeFilter.SHOW_TEXT);
   while(walker.nextNode()){const node=walker.currentNode;if(!node.nodeValue.includes('shi'))continue;const parent=node.parentElement,style=parent&&getComputedStyle(parent),line=parent?.closest('.cm-line'),lineBox=line?.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(node);if(style&&style.visibility!=='hidden'&&style.display!=='none'&&Number(style.opacity)>0&&style.color!=='transparent'&&style.color!=='rgba(0, 0, 0, 0)'&&(!lineBox||lineBox.height>0)&&[...range.getClientRects()].some(q=>q.width>0&&q.height>0&&q.right>p.left&&q.left<p.right&&q.bottom>p.top&&q.top<p.bottom&&(!lineBox||(q.bottom>lineBox.top&&q.top<lineBox.bottom))))visibleCandidate=true;}
   if(active?.value?.includes('shi')){const style=getComputedStyle(active),box=active.getBoundingClientRect();if(style.visibility!=='hidden'&&style.display!=='none'&&Number(style.opacity)>0&&style.color!=='transparent'&&style.color!=='rgba(0, 0, 0, 0)'&&box.width>8&&box.height>0&&active.scrollWidth<=active.clientWidth+1&&box.right>p.left&&box.left<p.right&&box.bottom>p.top&&box.top<p.bottom)visibleCandidate=true;}
   return {
   source:editor.value,mirror:view.state.doc.toString(),confirmed:editor.confirmedValue,adapter:editor.session.adapter.text.text,
   revision:Number(editor.revision),analysis:editor.session.adapter.analysis?.state,composing:view.composing,
   errors:window.errors??[],gateActive:!!window.__jotWorkerGate,queued:window.__jotWorkerGate?.pending.length??0,
   nativeSelection:(()=>{const q=document.getSelection(),describe=n=>n?{name:n.nodeName,text:n.nodeType===3?n.nodeValue:n.textContent?.slice(0,80)}:null;return q&&{anchor:describe(q.anchorNode),anchorOffset:q.anchorOffset,focus:describe(q.focusNode),focusOffset:q.focusOffset}})(),anchor:s.anchor,head:s.head,
   caret:r&&{top:r.top,bottom:r.bottom,left:r.left},viewport:{top:p.top,bottom:p.bottom},
   focused:!!active&&view.dom.contains(active),visibleCandidate,
   lines:[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>({text:n.textContent,height:n.getBoundingClientRect().height,className:n.className}))
  }})()`);
 }
 async function clickBefore() {
  const point=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent==='before');if(!n)throw Error('missing visible prefix');const r=n.getBoundingClientRect();return{x:r.left+Math.min(20,r.width/2),y:r.top+r.height/2}})()`);
  await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await settle();
 }
 async function enter(source,position,label,sentinel='') {
  await load(source);await clickBefore();
  await press('End');
  if(sentinel){
   await c.command('Input.insertText',{text:sentinel});await confirmed();
   source=source.slice(0,6)+sentinel+source.slice(6);position+=sentinel.length;
  }
  await press('ArrowDown');await press('ArrowDown');
  const state=await inspect();
  assert.equal(state.source,source,label+': navigation must not add a newline');
  assert.equal(state.confirmed,source,label+': navigation must not commit an edit');
  assert.equal(state.head,position,label+': real mouse/Down gestures enter the zero-width body');
  assert.equal(state.anchor,position,label+': empty body has a collapsed caret');
  assert(state.focused,label+': actual keyboard focus belongs to the editor');
  assert(state.caret&&state.caret.bottom>state.caret.top&&state.caret.top>=state.viewport.top-1&&state.caret.bottom<=state.viewport.bottom+1,label+': empty body exposes a visible caret');
  return state;
 }
 async function fencedRoots() {
  await c.evaluate('editor.livePreview.settled()');
  return c.evaluate(`editor.session.adapter.blocks.blocks.filter(node=>node.kind==='fenced-code').map(node=>({from:Number(node.sourceRange.from),to:Number(node.sourceRange.to)}))`);
 }
 async function holdWorkerGate() {
  await c.evaluate(`(()=>{if(window.__jotWorkerGate)throw Error('worker gate already active');const target=window.worker,original=target.postMessage,own=Object.hasOwn(target,'postMessage'),pending=[];target.postMessage=function(...args){pending.push(args);window.__recordWorker?.('hold',args[0])};window.__jotWorkerGate={pending,release(){if(own)target.postMessage=original;else delete target.postMessage;const count=pending.length;window.__recordWorker?.('release',{count});for(const args of pending)original.apply(target,args);pending.length=0;delete window.__jotWorkerGate;return count}}})()`);
 }
 async function typePairFast(opening,closing,holdWorker=false,recordTiming=false,waitBeforeHome=false) {
  await load('before\n\nafter');await clickBefore();await press('End');await press('ArrowDown');
  if(recordTiming)await installTrace();
  if(holdWorker) await holdWorkerGate();
  for(const char of opening)await c.command('Input.insertText',{text:char});
  await manualNewline();
  for(const char of closing)await c.command('Input.insertText',{text:char});
  if(waitBeforeHome)await confirmed();
  await c.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
  await c.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
  return c.evaluate(`(()=>({source:editor.value,confirmed:editor.confirmedValue,revision:Number(editor.revision),analysis:editor.session.adapter.analysis?.state,anchor:view.state.selection.main.anchor,head:view.state.selection.main.head,roots:editor.session.adapter.blocks.blocks.map(n=>({kind:n.kind,from:Number(n.sourceRange.from),to:Number(n.sourceRange.to),dirty:n.dirty}))}))()`);
 }
 async function releaseWorkerGate() {
  return c.evaluate(`window.__jotWorkerGate?.release()??0`);
 }
 async function installTrace() {
  const traceUrl='/@fs'+process.cwd()+'/packages/editor/tests/browser-support/browser-transaction-trace.ts';
  await c.evaluate(`(async()=>{window.__emptyTraceStop?.();const m=await import(${JSON.stringify(traceUrl)});window.__emptyTrace=m.traceBrowserTransactions(view);window.__emptyEvents=[];window.__workerEvents=[];const types=['beforeinput','input','compositionstart','compositionupdate','compositionend'];const snapshot=()=>({source:editor.value,confirmed:editor.confirmedValue,revision:Number(editor.revision),viewComposing:view.composing});const record=e=>{const s=view.state.selection.main,item={timeMs:performance.now(),type:e.type,inputType:e.inputType,data:e.data,trusted:e.isTrusted,cancelable:e.cancelable,composing:e.isComposing,target:e.target?.className,anchor:s.anchor,head:s.head,...snapshot()};window.__emptyEvents.push(item);queueMicrotask(()=>{item.defaultPrevented=e.defaultPrevented;item.headAfter=view.state.selection.main.head;item.after=snapshot()})};for(const type of types)view.dom.addEventListener(type,record,true);const target=window.worker,original=target.postMessage,own=Object.hasOwn(target,'postMessage');window.__recordWorker=(direction,message)=>{let body;try{body=JSON.stringify(message,(_key,value)=>typeof value==='bigint'?String(value):value)?.slice(0,3000)}catch{body=String(message)}window.__workerEvents.push({timeMs:performance.now(),direction,body,...snapshot()})};target.postMessage=function(...args){window.__recordWorker('send',args[0]);return original.apply(target,args)};const receive=e=>{window.__recordWorker('receive',e.data);queueMicrotask(()=>window.__recordWorker('after-receive',e.data))};target.addEventListener('message',receive);window.__emptyTraceStop=()=>{window.__emptyTrace.stop();for(const type of types)view.dom.removeEventListener(type,record,true);target.removeEventListener('message',receive);if(own)target.postMessage=original;else delete target.postMessage;delete window.__recordWorker;delete window.__emptyTraceStop}})()`);
 }

 try {
 if(process.env.JOT_EMPTY_RAPID_ONLY) {
  const iterations=Number(process.env.JOT_EMPTY_RAPID_ONLY);
  for(const [kind,opening,closing] of [['code-bare','```','```'],['math-bracket','\\[','\\]']]) {
   for(let i=0;i<iterations;i++) {
    const before=await typePairFast(opening,closing,false,false,true);
    const paired=`before\n${opening}\n${closing}\nafter`;
    assert.equal(before.source,paired,kind+': confirmed pair preserves source');
    assert.equal(before.head,paired.lastIndexOf(closing),kind+': Home returns to the body after confirmation');
    await c.command('Input.insertText',{text:'A'});await confirmed();
    assert.equal((await inspect()).source,`before\n${opening}\nA\n${closing}\nafter`,kind+': first input stays inside the pair');
   }
   results.push({case:'confirmed-empty-pair-home-'+kind,iterations});
  }
  return;
 }
 if(!onlyCase) {
 // Compare the bounded front-end candidate classifier with the actual
 // Rust-confirmed root kinds; fixtures are the only programmatic source load.
 const helperUrl='/@fs'+process.cwd()+'/packages/editor/src/hosts/shared/markdown-markers.ts';
 if(!onlyKind) for(const [opening,closing,expectedFast,expectedRoot] of [
  ['```','```','code-bare','fenced-code'],['``` ts','```','code-bare','fenced-code'],
  ['  ``` 是🙂',' ```  ','code-bare','fenced-code'],['``` begin','``` end','code-end','fenced-code'],
  ['``` rust begin','``` end','code-end','fenced-code'],['``` rust begin','``` other end','code-end','fenced-code'],
  ['$$','$$','math-dollar','math-block'],['\\[','\\]','math-bracket','math-block'],
  ['```rust','```',null,null],['```begin','``` end',null,null],['```\tts','```',null,null],
  ['```` ts','```',null,null],['    ```','```',null,null],['``` ts','``` end',null,null],
  ['``` begin','```',null,null],['``` end','``` end',null,null],['$$','\\]',null,null],
  ['\\[','$$',null,null],['``` '+ 'x'.repeat(513),'```',null,'fenced-code'],
 ]) {
  await load(`${opening}\n${closing}`);
  const fast=await c.evaluate(`(async()=>{const m=await import(${JSON.stringify(helperUrl)});return m.resolveOptimisticEmptyMarkerKind(${JSON.stringify(opening)},${JSON.stringify(closing)})??null})()`);
  const roots=await c.evaluate(`editor.session.adapter.blocks.blocks.filter(n=>n.kind==='fenced-code'||n.kind==='math-block').map(n=>n.kind)`);
  assert.equal(fast,expectedFast,JSON.stringify(opening)+': bounded candidate classification');
  assert.deepEqual(roots,expectedRoot===null?[]:[expectedRoot],JSON.stringify(opening)+': actual Rust-confirmed block classification');
  results.push({case:'marker-fast-path-rust-comparison',opening,closing,fast,roots});
 }
 for(const [kind,opening,closing] of [
  ['bare-code','```','```'],
  ['explicit-code','``` rust begin','``` end'],
  ['math','$$','$$'],
  ['math-bracket','\\[','\\]'],
 ]) {
  if(onlyKind&&kind!==onlyKind)continue;
  const source=`before\n\n${opening}\n${closing}\n\nafter`;
  const position=source.indexOf(opening)+opening.length+1;
  const expected=text=>source.slice(0,position)+text+'\n'+source.slice(position);

  const entered=await enter(source,position,kind);
  await c.command('Input.insertText',{text:'A'});await confirmed();
  let state=await inspect();
  assert.equal(state.source,expected('A'),kind+': first typed character creates one body row and preserves the closer');
  assert.equal(state.confirmed,state.source,kind+': worker confirms the exact first input');
  assert.equal(state.head,position+1,kind+': caret stays after the typed character');
  await press('z',mod);await confirmed();
  assert.equal((await inspect()).source,source,kind+': one Undo restores the original adjacent markers');

  await enter(source,position,kind+' IME');
  await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
  state=await inspect();
  assert.equal(state.confirmed,source,kind+': uncommitted IME leaves the confirmed source untouched');
  assert(state.visibleCandidate,kind+': IME candidate has visible, unclipped text geometry inside the editor');
  const markers=kind==='math'?['$$']:kind==='math-bracket'?['\\[','\\]']:['```'];
  assert(!state.lines.some(line=>markers.some(marker=>line.text.includes(marker))),kind+': composition keeps both raw markers hidden');
  const candidateLine=state.lines.find(line=>line.text.includes('shi'));
  assert(candidateLine?.className.includes(kind.startsWith('math')?'jot-live-preview-source-math-block':'jot-live-preview-source-fenced-code'),kind+': candidate retains the active block line style');
  await c.command('Input.imeSetComposition',{text:'shishi',selectionStart:6,selectionEnd:6});await settle();
  state=await inspect();
  assert.equal(state.source,expected('shishi'),kind+': subsequent IME candidate replaces the prior candidate exactly');
  assert.equal(state.confirmed,source,kind+': subsequent candidate remains unconfirmed');
  assert(state.visibleCandidate&&!state.lines.some(line=>markers.some(marker=>line.text.includes(marker))),kind+': updated candidate stays visible without exposing either marker');
  await c.command('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await settle();await confirmed();
  state=await inspect();
  assert.equal(state.source,source,kind+': cancelling composition leaves no synthetic newline');
  assert.equal(state.confirmed,source,kind+': cancellation does not create a confirmed edit');
  assert(state.focused,kind+': cancellation keeps the input surface focused');
  await c.command('Input.imeSetComposition',{text:'zhen',selectionStart:4,selectionEnd:4});await settle();
  assert.equal((await inspect()).confirmed,source,kind+': a second candidate also remains unconfirmed');
  await c.command('Input.imeSetComposition',{text:'zhenshi',selectionStart:7,selectionEnd:7});await settle();
  state=await inspect();
  assert.equal(state.source,expected('zhenshi'),kind+': candidate update before commit replaces instead of appending');
  assert.equal(state.confirmed,source,kind+': updated candidate before commit remains unconfirmed');
  await c.command('Input.insertText',{text:'针'});await confirmed();
  state=await inspect();
  assert.equal(state.source,expected('针'),kind+': composition commits once with a distinct closing row');
  await press('z',mod);await confirmed();
  assert.equal((await inspect()).source,source,kind+': one Undo restores the original after IME');

  await enter(source,position,kind+' multiline');
  let traceRecord;
  if(traceInput) {
   await installTrace();
   traceRecord={case:'empty-block-input-diagnostic-'+kind,before:await inspect()};results.push(traceRecord);
  }
  await c.command('Input.insertText',{text:'x\n'});await confirmed();
  state=await inspect();
  if(traceRecord){traceRecord.after=state;traceRecord.events=await c.evaluate('window.__emptyEvents');traceRecord.transactions=await c.evaluate('window.__emptyTrace.events');await c.evaluate('window.__emptyTrace.stop()');}
  assert.equal(state.source,expected('x\n'),kind+': trailing newline keeps a subsequent editable empty row before the closer');
  assert.equal(state.head,position+2,kind+': cursor remains after the complete multiline input');
  await c.command('Input.insertText',{text:'y'});await confirmed();
  state=await inspect();
  assert.equal(state.source,expected('x\ny'),kind+': typing after trailing LF remains inside the body');
  results.push({case:'adjacent-empty-block-'+kind,entered,after:state});
 }

 if(onlyKind)return;

 const source='before\n\n```\n```\n\nafter',position=source.indexOf('```')+4;
 const before=await enter(source,position,'cancel-history','Z');
 await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
 await c.command('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await settle();await confirmed();
 assert.equal((await inspect()).source,before.source,'cancelled IME preserves the preceding real edit');
 await press('z',mod);await confirmed();
 assert.equal((await inspect()).source,source,'one Undo reaches the preceding real edit rather than a synthetic cancellation step');
 results.push({case:'adjacent-empty-block-cancel-history',...await inspect()});

 // Build both delimiters through real input while starting with ordinary text.
 // This exercises parsing when an incomplete opener gains its actual closer.
 await load('before\n\nafter');await clickBefore();await press('End');await press('ArrowDown');
 for(let i=0;i<3;i++)await c.command('Input.insertText',{text:'`'});
 await confirmed();await manualNewline();await confirmed();
 for(let i=0;i<3;i++)await c.command('Input.insertText',{text:'`'});
 await confirmed();
 let typed=await inspect();
 assert.equal(typed.source,'before\n```\n```\nafter','three individually typed ticks form each bare marker');
 assert.equal((await fencedRoots()).length,1,'a real typed bare pair becomes one confirmed code block');
 await clickBefore();await press('End');await press('ArrowDown');
 assert.equal((await inspect()).source,typed.source,'entering a freshly typed empty block does not edit source');
 await c.command('Input.insertText',{text:'X'});await confirmed();
 assert.equal((await inspect()).source,'before\n```\nX\n```\nafter','a freshly typed pair accepts content without merging the closer');
 results.push({case:'typed-bare-pair',...await inspect()});

 for(const [suffix,closing] of [['rust','```'],['begin','``` end']]) {
  await load('before\n\nafter');await clickBefore();await press('End');await press('ArrowDown');
  for(let i=0;i<3;i++)await c.command('Input.insertText',{text:'`'});
  await c.command('Input.insertText',{text:suffix});await confirmed();await manualNewline();await confirmed();
  await c.command('Input.insertText',{text:closing});await confirmed();
  const invalid=`before\n\`\`\`${suffix}\n${closing}\nafter`,valid=`before\n\`\`\` ${suffix}\n${closing}\nafter`;
  assert.equal((await inspect()).source,invalid,suffix+': invalid opening remains exact ordinary source');
  assert.equal((await fencedRoots()).length,0,suffix+': metadata without a separating space cannot open a fence');
  await press('ArrowUp');await press('Home');
  for(let i=0;i<3;i++)await press('ArrowRight');
  assert.equal((await inspect()).head,invalid.indexOf('```')+3,suffix+': real arrows reach the gap after the three ticks');
  await c.command('Input.insertText',{text:' '});await confirmed();
  assert.equal((await inspect()).source,valid,suffix+': inserting the missing space changes only the opening');
  assert.equal((await fencedRoots()).length,1,suffix+': valid opening reclassifies with its existing closer');
  results.push({case:'typed-space-required-'+suffix,...await inspect()});
 }

 // Deliver an entire typed pair and its first body character without waiting
 // for the worker between events. Record whether confirmation had actually
 // caught up instead of assuming a particular scheduler timing.
 for(const [kind,opening,closing] of [
  ['code-bare','```','```'],['code-language','``` ts','```'],
  ['code-begin','``` rust begin','``` end'],['math-dollar','$$','$$'],
  ['math-bracket','\\[','\\]'],
 ]) {
  const rapidBefore=await typePairFast(opening,closing);
  const rapid={case:'rapid-typed-pair-and-first-input-'+kind,before:rapidBefore};results.push(rapid);
  const paired=`before\n${opening}\n${closing}\nafter`;
  assert.equal(rapidBefore.source,paired,kind+': rapid input creates the exact marker pair');
  assert.equal(rapidBefore.head,paired.lastIndexOf(closing),kind+': Home places the actual caret at the empty body boundary');
  await c.command('Input.insertText',{text:'A'});await confirmed();
  rapid.after=await inspect();rapid.dom=await c.evaluate('view.contentDOM.outerHTML');
  await screenshot('rapid-typed-pair-first-input-'+kind);
  assert.equal(rapid.after.source,`before\n${opening}\nA\n${closing}\nafter`,kind+': rapid first input preserves a standalone closer');
  assert.equal(rapid.after.confirmed,rapid.after.source,kind+': rapid input eventually agrees with the worker');
  const rootKind=kind.startsWith('math')?'math-block':'fenced-code';
  await c.evaluate('editor.livePreview.settled()');
  assert.equal(await c.evaluate(`editor.session.adapter.blocks.blocks.filter(node=>node.kind===${JSON.stringify(rootKind)}).length`),1,kind+': rapid sequence recovers one confirmed block');
  assert(rapid.after.lines.some(line=>line.text.includes('A')&&line.height>0),kind+': rapid first content is actually painted');
 }

 // Empty document is a distinct parser boundary: capture its real confirmed
 // roots, then deliberately hold Worker messages while typing the pair and
 // first body character through CDP input events.
 await load('');
 const emptyPoint=await c.evaluate(`(()=>{const line=view.contentDOM.querySelector('.cm-line');if(!line)throw Error('empty document has no input row');const r=line.getBoundingClientRect();return{x:r.left+2,y:r.top+r.height/2}})()`);
 await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',...emptyPoint});
 await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...emptyPoint});
 await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...emptyPoint});await settle();
 const emptyInitial=await c.evaluate(`(()=>({source:editor.value,confirmed:editor.confirmedValue,revision:Number(editor.revision),totalRoots:editor.session.adapter.projection.totalBlocks,roots:editor.session.adapter.blocks.blocks.map(n=>({kind:n.kind,from:Number(n.sourceRange.from),to:Number(n.sourceRange.to),dirty:n.dirty}))}))()`);
 await holdWorkerGate();
 for(let i=0;i<3;i++)await c.command('Input.insertText',{text:'`'});
 await manualNewline();
 for(let i=0;i<3;i++)await c.command('Input.insertText',{text:'`'});
 await c.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
 await c.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
 const emptyBefore=await inspect();
 const emptyRapid={case:'controlled-worker-delay-empty-document-pair',initial:emptyInitial,before:emptyBefore};results.push(emptyRapid);
 assert.equal(emptyInitial.source,'','empty-document fixture has no pre-existing content');
 assert.equal(emptyBefore.source,'```\n```','empty-document rapid pair uses exact source');
 assert.notEqual(emptyBefore.confirmed,emptyBefore.source,'Worker gate genuinely holds the pair unconfirmed');
 assert.equal(emptyBefore.head,4,'Home reaches the empty body before its closer');
 await c.command('Input.insertText',{text:'A'});await settle();
 emptyRapid.preRelease=await inspect();emptyRapid.dom=await c.evaluate('view.contentDOM.outerHTML');
 await screenshot('controlled-worker-delay-empty-document-pair');
 emptyRapid.queuedMessages=await releaseWorkerGate();
 assert(emptyRapid.queuedMessages>0,'the controlled delay captured actual Worker messages');await confirmed();
 emptyRapid.after=await inspect();
 assert.equal(emptyRapid.after.source,'```\nA\n```','empty-document first input retains the standalone closer');
 assert.equal(emptyRapid.after.confirmed,emptyRapid.after.source,'Worker confirms the empty-document edit');
 assert.equal((await fencedRoots()).length,1,'empty-document pair becomes one confirmed fenced block');
 assert(emptyRapid.after.lines.some(line=>line.text.includes('A')&&line.height>0),'empty-document first input is painted');
 await press('z',mod);await confirmed();
 assert.equal((await inspect()).source,'```\n```','one undo restores the empty-document pair');
 }

 // The optimistic empty-body path needs proof of the marker's ownership.
 // These fixtures are loaded only to establish a confirmed starting state;
 // entering the target, typing every delimiter, Home and the first character
 // all use real browser input while the real Worker is held in FIFO order.
 if(!onlyCase||onlyCase==='prefix-risks') {
  const cases=[
   {name:'old-bare-code',prefix:'```',opening:'```',closing:'```',kind:'fenced-code',rootAt:'prefix',separate:false},
   {name:'old-explicit-code',prefix:'``` begin',opening:'``` begin',closing:'``` end',kind:null,separate:false},
   {name:'old-dollar-math',prefix:'$$',opening:'$$',closing:'$$',kind:'math-block',rootAt:'prefix',separate:false},
   {name:'old-math-new-code',prefix:'$$',opening:'```',closing:'```',kind:'fenced-code',rootAt:'target',separate:true},
   {name:'old-code-new-math',prefix:'```',opening:'$$',closing:'$$',kind:'math-block',rootAt:'target',separate:true},
   {name:'literal-code-pair-in-code',outerOpen:'``` rust begin',outerClose:'``` end',opening:'```',closing:'```',kind:'fenced-code',rootAt:'outer',separate:false},
   {name:'literal-math-pair-in-math',outerOpen:'\\[',outerClose:'\\]',opening:'$$',closing:'$$',kind:'math-block',rootAt:'outer',separate:false},
  ];
  for(const scenario of cases) {
   const inside=scenario.outerOpen!==undefined;
   const source=inside?`before\n\n${scenario.outerOpen}\nanchor\n\n${scenario.outerClose}\n\nafter`:`before\n${scenario.prefix}\n\nafter`;
   const target=inside?source.indexOf('anchor')+'anchor'.length+1:source.indexOf('\n\nafter')+1;
   await load(source);await c.evaluate('editor.livePreview.settled()');
   const initialRoots=await c.evaluate(`editor.session.adapter.blocks.blocks.map(n=>({kind:n.kind,from:Number(n.sourceRange.from),to:Number(n.sourceRange.to)}))`);
   if(inside)assert(initialRoots.some(root=>root.kind===scenario.kind&&root.from===source.indexOf(scenario.outerOpen)),scenario.name+': fixture starts inside an actual confirmed container');
   await clickBefore();await press('End');await press('ArrowDown');await press('ArrowDown');
   if(inside){await press('End');await press('ArrowDown')}
   const entered=await inspect();
   assert.equal(entered.source,source,scenario.name+': navigation never changes source');
   assert.equal(entered.confirmed,source,scenario.name+': target belongs to the confirmed starting state');
   assert.equal(entered.head,target,scenario.name+': real pointer and arrows reach the intended empty physical row');
   assert(entered.focused,scenario.name+': real editor surface has focus');
   await holdWorkerGate();
   for(const char of scenario.opening)await c.command('Input.insertText',{text:char});
   await manualNewline();
   for(const char of scenario.closing)await c.command('Input.insertText',{text:char});
   await c.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
   await c.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
   const pairState=await inspect();
   const expectedPair=source.slice(0,target)+scenario.opening+'\n'+scenario.closing+source.slice(target);
   const expected=source.slice(0,target)+scenario.opening+'\nA'+(scenario.separate?'\n':'')+scenario.closing+source.slice(target);
   const item={case:'controlled-prefix-risk-'+scenario.name,source,initialRoots,entered,pairState};results.push(item);
   assert.equal(pairState.source,expectedPair,scenario.name+': rapid markers are typed exactly');
   assert.notEqual(pairState.confirmed,pairState.source,scenario.name+': FIFO gate leaves the typed pair genuinely unconfirmed');
   await c.command('Input.insertText',{text:'A'});await settle();
   item.beforeRelease=await inspect();item.dom=await c.evaluate('view.contentDOM.outerHTML');
   assert.equal(item.beforeRelease.source,expected,scenario.name+': first input obeys confirmed ownership without a spurious separator');
   item.queuedMessages=await releaseWorkerGate();assert(item.queuedMessages>0,scenario.name+': the gate held an actual Worker request');
   await confirmed();await c.evaluate('editor.livePreview.settled()');
   item.after=await inspect();
   item.roots=await c.evaluate(`editor.session.adapter.blocks.blocks.filter(n=>n.kind==='fenced-code'||n.kind==='math-block').map(n=>({kind:n.kind,from:Number(n.sourceRange.from),to:Number(n.sourceRange.to)}))`);
   assert.equal(item.after.source,expected,scenario.name+': exact source survives Worker confirmation');
   assert.equal(item.after.confirmed,expected,scenario.name+': Worker and editor converge to the exact source');
   assert.deepEqual(item.roots.map(root=>root.kind),scenario.kind===null?[]:[scenario.kind],scenario.name+': actual Rust roots respect preceding/container marker ownership');
   if(scenario.kind!==null) {
    const expectedFrom=scenario.rootAt==='target'?target:source.indexOf(scenario.rootAt==='outer'?scenario.outerOpen:scenario.prefix);
    assert.equal(item.roots[0].from,expectedFrom,scenario.name+': root starts at the actual owning opener');
   }
  }
 }

 if(!onlyCase||onlyCase==='pending-opener') {
  const opening='``` rust begin',closing='``` end',paired=`before\n${opening}\n${closing}\nafter`;
  for(const mode of ['language-edit-and-leave','delete-marker']) {
   const before=await typePairFast(opening,closing,true);
   const item={case:'controlled-worker-delay-opening-'+mode,before};results.push(item);
   assert.equal(before.source,paired,mode+': pending pair is exact');
   assert.notEqual(before.confirmed,before.source,mode+': Worker has not confirmed the pending pair');
   const from=paired.indexOf(opening),end=from+opening.length;
   assert.equal(before.head,paired.indexOf(closing),mode+': Home begins at the empty content boundary');
   await press('ArrowUp');item.afterUp=await inspect();
   assert.equal(item.afterUp.source,paired,mode+': moving into the opening never changes source');
   assert.equal(item.afterUp.head,end,mode+': Up enters the actual opening row');
   assert(item.afterUp.lines.some(line=>line.text===opening&&line.height>0),mode+': pending opening source is visible');
   await press('Home');
   if(mode==='language-edit-and-leave') {
    for(let i=0;i<4;i++)await press('ArrowRight');
    assert.equal((await inspect()).head,from+4,'pending opener arrows reach its language');
    await c.command('Input.insertText',{text:'X'});await settle();item.afterEdit=await inspect();
    const edited=paired.replace('``` rust','``` Xrust');
    assert.equal(item.afterEdit.source,edited,'pending opener accepts an exact language edit');
    assert(item.afterEdit.lines.some(line=>line.text==='``` Xrust begin'&&line.height>0),'edited pending opening remains visible');
    await press('ArrowUp');item.afterLeave=await inspect();
    assert(item.afterLeave.head<from,'Up from the opening returns to the preceding physical row');
    item.domAfterLeave=await c.evaluate('view.contentDOM.outerHTML');
    assert(!item.domAfterLeave.includes('jot-pending-empty:'),'leaving the root clears the pending decoration');
    item.queuedMessages=await releaseWorkerGate();assert(item.queuedMessages>0,'pending opener test delayed real Worker messages');await confirmed();
    item.after=await inspect();assert.equal(item.after.source,edited,'worker confirms the unchanged language edit');
    assert.equal((await fencedRoots()).length,1,'language edit preserves one confirmed code block');
   } else {
    await press('Delete');item.afterEdit=await inspect();
    const edited=paired.slice(0,from)+paired.slice(from+1);
    assert.equal(item.afterEdit.source,edited,'Delete changes one opening marker rather than deleting the block');
    item.domAfterEdit=await c.evaluate('view.contentDOM.outerHTML');
    assert(!item.domAfterEdit.includes('jot-pending-empty:'),'editing a marker clears the obsolete pending decoration');
    item.queuedMessages=await releaseWorkerGate();assert(item.queuedMessages>0,'marker test delayed real Worker messages');await confirmed();
    item.after=await inspect();assert.equal(item.after.source,edited,'worker confirms the exact marker edit');
    assert.equal((await fencedRoots()).length,0,'a damaged marker is no longer a code block');
   }
  }
 }

 for(const phase of ['cancel','commit']) {
  if(onlyCase&&onlyCase!==`rapid-ime-${phase}`)continue;
  const before=await typePairFast('```','```',false,traceInput),paired='before\n```\n```\nafter';
  const item={case:'rapid-unconfirmed-pair-ime-'+phase,before,unconfirmedAtStart:before.source!==before.confirmed};results.push(item);
  assert.equal(before.source,paired,phase+': rapid pair is exact before composition');
  assert.equal(before.head,paired.lastIndexOf('```'),phase+': caret is on the empty body boundary');
  await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
  item.during=await inspect();item.dom=await c.evaluate('view.contentDOM.outerHTML');
  await screenshot('rapid-pair-ime-'+phase);
  assert(!item.during.confirmed.includes('shi'),phase+': the IME candidate is not committed to the Rust document');
  assert(item.during.visibleCandidate,phase+': fast IME candidate has actual visible text geometry');
  assert(!item.during.lines.some(line=>line.text.includes('```')),phase+': fast IME does not flash either raw fence');
  assert(item.during.lines.some(line=>line.text.includes('shi')&&line.className.includes('jot-live-preview-source-fenced-code')),phase+': fast IME keeps the code editing surface');
  if(phase==='cancel') {
   await c.command('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
   if(traceInput)item.immediatelyAfterCancel=await inspect();
   await settle();
   if(traceInput){item.settledAfterCancel=await inspect();item.events=await c.evaluate('window.__emptyEvents');item.transactions=await c.evaluate('window.__emptyTrace.events');assert.equal(item.events.filter(event=>event.type==='compositionstart').length,1,'fast cancellation retains one continuous composition session');}
   await confirmed();
   item.after=await inspect();assert.equal(item.after.source,paired,'fast IME cancellation preserves the exact paired source');
  } else {
   await c.command('Input.insertText',{text:'是'});await confirmed();item.after=await inspect();
   assert.equal(item.after.source,'before\n```\n是\n```\nafter','fast IME commits once while retaining a standalone closer');
   await press('z',mod);await confirmed();assert.equal((await inspect()).source,paired,'one undo restores the paired source after fast IME');
  }
 }
 // Freeze only the test fixture's outbound Worker messages in FIFO order.
 // This is a controlled scheduling test against the real Worker and Wasm,
 // not a performance measurement or a mocked response.
 for(const phase of ['cancel','commit']) {
  if(onlyCase&&onlyCase!==`controlled-ime-${phase}`)continue;
  const before=await typePairFast('```','```',true,traceInput),paired='before\n```\n```\nafter';
  const item={case:'controlled-worker-delay-pair-ime-'+phase,before,unconfirmedAtStart:before.source!==before.confirmed};results.push(item);
  assert.equal(before.source,paired,phase+': controlled-delay pair has the exact source');
  assert(item.unconfirmedAtStart,phase+': Worker gate must actually leave the pair unconfirmed');
  assert.equal(before.head,paired.lastIndexOf('```'),phase+': controlled-delay caret is at the empty body');
  await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
  item.during=await inspect();item.dom=await c.evaluate('view.contentDOM.outerHTML');
  await screenshot('controlled-worker-delay-ime-'+phase);
  assert(item.during.visibleCandidate,phase+': controlled-delay candidate has visible text geometry');
  assert(!item.during.lines.some(line=>line.text.includes('```')),phase+': controlled-delay candidate does not expose raw fences');
  assert(item.during.lines.some(line=>line.text.includes('shi')&&line.className.includes('jot-live-preview-source-fenced-code')),phase+': controlled-delay candidate retains the code surface');
  await c.command('Input.imeSetComposition',{text:'shishi',selectionStart:6,selectionEnd:6});await settle();
  const updated=await inspect();
  assert(updated.visibleCandidate&&!updated.lines.some(line=>line.text.includes('```')),phase+': replacement candidate remains visible without exposing fence source');
  if(phase==='cancel') {
   await c.command('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
   if(traceInput)item.immediatelyAfterCancel=await inspect();
   await settle();
   if(traceInput){item.settledAfterCancel=await inspect();item.events=await c.evaluate('window.__emptyEvents');item.transactions=await c.evaluate('window.__emptyTrace.events');assert.equal(item.events.filter(event=>event.type==='compositionstart').length,1,'controlled delayed cancellation retains one continuous composition session');}
   item.queuedMessages=await releaseWorkerGate();assert(item.queuedMessages>0,'controlled delay captured actual Worker messages');await confirmed();
   item.after=await inspect();assert.equal(item.after.source,paired,'controlled-delay cancellation preserves the exact paired source');
  } else {
   await c.command('Input.insertText',{text:'是'});await settle();item.preRelease=await inspect();
   if(traceInput){item.events=await c.evaluate('window.__emptyEvents');item.transactions=await c.evaluate('window.__emptyTrace.events');assert.equal(item.events.filter(event=>event.type==='compositionstart').length,1,'controlled delayed commit retains one continuous composition session');}
   assert.equal(item.preRelease.source,'before\n```\n是\n```\nafter','controlled-delay commit is one body edit before Worker catch-up');
   item.queuedMessages=await releaseWorkerGate();assert(item.queuedMessages>0,'controlled delay captured actual Worker messages');await confirmed();
   item.after=await inspect();assert.equal(item.after.source,item.preRelease.source,'Worker confirms the same composition commit');
   await press('z',mod);await confirmed();assert.equal((await inspect()).source,paired,'one undo restores the paired source after delayed IME');
  }
 }
 // Release an actual in-flight pair while the next IME composition remains
 // active. This deterministically covers a prior confirmation racing a later
 // candidate, unlike releasing the gate only after the composition ends.
 for(const phase of ['cancel','commit']) {
  if(onlyCase&&onlyCase!==`controlled-release-composing-${phase}`)continue;
  const before=await typePairFast('```','```',true,true),paired='before\n```\n```\nafter';
  const item={case:'controlled-worker-release-during-composition-'+phase,before};results.push(item);
  assert.equal(before.source,paired,phase+': pair source is exact before composition');
  assert.notEqual(before.confirmed,paired,phase+': the preceding pair is genuinely unconfirmed');
  assert.equal(before.head,paired.lastIndexOf('```'),phase+': real Home places the caret at the body boundary');
  await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
  await c.command('Input.imeSetComposition',{text:'shishi',selectionStart:6,selectionEnd:6});await settle();
  item.beforeRelease=await inspect();item.domBeforeRelease=await c.evaluate('view.contentDOM.outerHTML');
  assert.equal(item.beforeRelease.source,'before\n```\nshishi\n```\nafter',phase+': candidate update replaces the preceding candidate');
  assert(item.beforeRelease.composing&&item.beforeRelease.visibleCandidate,phase+': composition is active and candidate is visible before releasing the gate');
  assert(!item.beforeRelease.lines.some(line=>line.text.includes('```')),phase+': no raw fence appears during composition');
  item.queuedMessages=await releaseWorkerGate();assert(item.queuedMessages>0,phase+': gate held an actual Worker request');
  item.priorRequestConfirmed=await c.evaluate(`(async()=>{const deadline=performance.now()+10000;while(performance.now()<deadline){if(Number(editor.revision)>${before.revision})return true;await new Promise(resolve=>setTimeout(resolve,5))}return false})()`);
  await settle();
  item.afterRelease=await inspect();item.domAfterRelease=await c.evaluate('view.contentDOM.outerHTML');
  item.workerWhileComposing=await c.evaluate('window.__workerEvents');
  await screenshot('controlled-worker-release-during-composition-'+phase);
  assert(item.priorRequestConfirmed,phase+': an already-sent Worker transaction confirms while composition is active');
  assert.notEqual(item.afterRelease.confirmed,before.confirmed,phase+': the already-sent transaction advances confirmed source');
  assert(!item.afterRelease.confirmed.includes('shi'),phase+': confirmed Rust source excludes the active IME candidate');
  assert(item.workerWhileComposing.filter(event=>event.viewComposing).every(event=>!event.confirmed.includes('shi')),phase+': no observed Worker event confirms a candidate during composition');
  assert(item.workerWhileComposing.filter(event=>event.viewComposing&&event.direction==='send').every(event=>{let message;try{message=JSON.parse(event.body)}catch{return false}return !message.body?.transaction?.edits?.some(edit=>edit.insert.includes('shi'))}),phase+': no active-composition Worker request contains the candidate');
  assert.equal(item.afterRelease.source,item.beforeRelease.source,phase+': confirming a prior request does not alter the candidate source');
  assert(item.afterRelease.composing&&item.afterRelease.visibleCandidate,phase+': confirmation leaves the native composition active and visible');
  assert(!item.afterRelease.lines.some(line=>line.text.includes('```')),phase+': confirming the pair does not expose raw fences');
  if(phase==='cancel') {
   await c.command('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await settle();await confirmed();
   item.after=await inspect();assert.equal(item.after.source,paired,'cancel after preceding confirmation restores exact paired source');
   await press('z',mod);await confirmed();item.afterUndo=await inspect();
   assert.notEqual(item.afterUndo.source,paired,'one Undo after cancel reaches a preceding real edit');
   assert(!item.afterUndo.source.includes('shi'),'Undo after cancellation cannot restore the candidate');
  } else {
   await c.command('Input.insertText',{text:'是'});await confirmed();item.after=await inspect();
   assert.equal(item.after.source,'before\n```\n是\n```\nafter','commit after preceding confirmation edits the body exactly once');
   await press('z',mod);await confirmed();item.afterUndo=await inspect();
   assert.equal(item.afterUndo.source,paired,'one Undo after commit restores the exact paired source');
  }
  item.events=await c.evaluate('window.__emptyEvents');item.transactions=await c.evaluate('window.__emptyTrace.events');item.workerEvents=await c.evaluate('window.__workerEvents');
  assert.equal(item.events.filter(event=>event.type==='compositionstart').length,1,phase+': gate release retains one continuous native composition');
 }
 } catch(error) {
  try {
   const state=await inspect(),dom=await c.evaluate('view.contentDOM.outerHTML');
   const trace=traceInput?await c.evaluate(`({events:window.__emptyEvents??[],transactions:window.__emptyTrace?.events??[],workerEvents:window.__workerEvents??[]})`):undefined;
   results.push({case:'empty-block-failure-evidence',message:String(error),state,dom,...(trace===undefined?{}:{trace})});
   await screenshot('empty-block-failure');
  } catch(captureError) {
   results.push({case:'empty-block-evidence-capture-failure',message:String(captureError)});
  }
  try { await releaseWorkerGate(); } catch {}
  throw error;
 }
}
