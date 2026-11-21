// Real component, keyboard, Worker and browser geometry for empty quotes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, keyboardEventKey, stopProcess, waitForEvaluation, waitForHttp } from '../../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_QUOTE_ADAPTIVE_PORT??4324),debugPort=Number(process.env.JOT_QUOTE_ADAPTIVE_DEBUG_PORT??9524);
const profile=mkdtempSync(resolve(tmpdir(),'jot-quote-adaptive-'));
const diagnostic=process.env.JOT_QUOTE_ADAPTIVE_DIAG==='1';
let server,chrome,c;
const errors=[];
try {
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',
    `--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response=>response.json());
  c=await connectCdp(pages.find(page=>page.type==='page'&&page.url.includes(`:${port}`)).webSocketDebuggerUrl);
  c.socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text)});
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1200,height:850,deviceScaleFactor:1,mobile:false});
  const wait=(expression,timeout=30000)=>waitForEvaluation(c,expression,timeout);
  const frame=()=>c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await wait(`document.readyState==='complete' && document.title==='Jot native component integration fixture'`);
  await c.evaluate(`(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.id='quote-adaptive';root.style.cssText='width:720px;height:700px;margin:10px';document.body.replaceChildren(root);
    window.worker=new Worker('/src/worker.ts',{type:'module'});window.editorErrors=[];window.holdWorker=false;window.heldMessages=[];window.workerTrace=[];
    const record=(direction,value)=>{workerTrace.push({direction,requestId:value.requestId,type:value.body?.type,revision:value.body?.analysis?.targetRevision??value.body?.patch?.revision});if(workerTrace.length>40)workerTrace.shift()};
    const listeners=new Map(),endpoint={postMessage(value){record('out',value);worker.postMessage(value)},
      addEventListener(type,listener){const wrapped=event=>{if(type==='message')record('in',event.data);if(type==='message'&&holdWorker)heldMessages.push(()=>listener(event));else listener(event)};listeners.set(listener,wrapped);worker.addEventListener(type,wrapped)},
      removeEventListener(type,listener){const wrapped=listeners.get(listener);if(wrapped)worker.removeEventListener(type,wrapped);listeners.delete(listener)}};
    // Worker messages are separate browser tasks. Let promise continuations
    // from one message run before releasing the next, as they do in reality.
    window.releaseWorker=async()=>{while(heldMessages.length){heldMessages.shift()();await Promise.resolve()}holdWorker=false};
    window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint,documentId:'quote-adaptive',generation:1,source:'',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:error=>editorErrors.push(String(error))});
    await editor.open();window.view=editor.input.view;
  })()`);
  const load=async(source,position=0,mode='live-preview')=>{
    await c.evaluate(`(async()=>{await editor.setMode(${JSON.stringify(mode)});editor.setValue(${JSON.stringify(source)});editor.input.setSelection(${position});editor.focus()})()`);
    await wait(`editor.value===${JSON.stringify(source)}&&editor.value===editor.confirmedValue&&editor.session.adapter.analysis?.state==='complete'`);
    if(mode==='live-preview')await c.evaluate('editor.livePreview.settled()');else await c.evaluate('editor.surface.settled()');
    await frame();
  };
  const key=async(name,modifiers=0)=>{
    const code=name==='z'?'KeyZ':name,number={Backspace:8,Delete:46,Enter:13,z:90}[name]??0;
    for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:keyboardEventKey(name,modifiers),code,windowsVirtualKeyCode:number,modifiers});
  };
  const snapshot=()=>c.evaluate(`(()=>({value:editor.value,confirmed:editor.confirmedValue,head:view.state.selection.main.head,
    caret:(()=>{const r=view.coordsAtPos(view.state.selection.main.head);return r?{left:r.left,top:r.top,bottom:r.bottom}:null})(),
    rows:[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>{const l=view.state.doc.lineAt(view.posAtDOM(n,0)),r=n.getBoundingClientRect(),s=getComputedStyle(n),w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let text,glyph=null;
      while((text=w.nextNode()))if(text.nodeValue.includes('内容')){const range=document.createRange();range.setStart(text,text.nodeValue.indexOf('内容'));range.setEnd(text,text.nodeValue.indexOf('内容')+2);const box=range.getBoundingClientRect();glyph={top:box.top,bottom:box.bottom};break}
      return{raw:l.text,text:n.innerText,depth:n.dataset.jotQuoteDepth??null,markerOnly:n.dataset.jotQuoteMarkerOnly??null,top:r.top,height:r.height,lineHeight:parseFloat(s.lineHeight),fontSize:parseFloat(s.fontSize),start:parseFloat(s.paddingInlineStart),background:s.backgroundColor,ruleImage:s.backgroundImage,ruleSize:s.backgroundSize,glyph,html:n.outerHTML.slice(0,900)}})}))()`);
  const capture=async(action,{trace=false}={})=>{
    const before=await snapshot();await c.evaluate('holdWorker=true');
    try{
      await action();await wait('editor.value!==editor.confirmedValue',5000);await frame();const pending=await snapshot();
      if(trace)await c.evaluate(`(()=>{window.quoteFrames=[];window.quoteTraceActive=true;function record(){if(!quoteTraceActive)return;quoteFrames.push([...view.contentDOM.querySelectorAll('.cm-line')].map(n=>{const l=view.state.doc.lineAt(view.posAtDOM(n,0)),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{raw:l.text,depth:n.dataset.jotQuoteDepth??null,top:r.top,height:r.height,start:parseFloat(s.paddingInlineStart),background:s.backgroundColor,ruleImage:s.backgroundImage,ruleSize:s.backgroundSize}}));if(quoteFrames.length<120)requestAnimationFrame(record)}requestAnimationFrame(record)})()`);
      await c.evaluate('releaseWorker()');await wait(`editor.value===editor.confirmedValue&&editor.session.adapter.analysis?.state==='complete'`);
      await c.evaluate('editor.livePreview.settled()');await frame();const after=await snapshot();
      const frames=trace?await c.evaluate(`(()=>{quoteTraceActive=false;return quoteFrames})()`):[];
      return {before,pending,after,frames};
    }catch(error){
      if(process.env.JOT_QUOTE_ADAPTIVE_TRACE==='1')console.error('capture failed',JSON.stringify(await c.evaluate(`({value:editor.value,confirmed:editor.confirmedValue,analysis:editor.session.adapter.analysis?.state,errors:editorErrors,held:heldMessages.length,trace:workerTrace})`)));
      throw error;
    }finally{await c.evaluate('(async()=>{await releaseWorker();window.quoteTraceActive=false})()')}
  };
  const near=(a,b,label)=>assert(Math.abs(a-b)<=1,`${label}: ${a} versus ${b}`);
  const stable=result=>{
    assert.deepEqual(result.pending.rows.map(row=>[row.raw,row.text,row.depth]),result.after.rows.map(row=>[row.raw,row.text,row.depth]),'confirmation must not reveal quote source');
    assert.equal(result.pending.head,result.after.head,'confirmation retains the source caret');
    for(let i=0;i<result.pending.rows.length;i++){
      const a=result.pending.rows[i],b=result.after.rows[i];
      near(a.top,b.top,'row top before confirmation');near(a.height,b.height,'row height before confirmation');near(a.start,b.start,'quote inset before confirmation');
      if(a.depth!==null){assert.equal(a.background,b.background,`quote background before confirmation: ${a.raw}`);assert.equal(a.ruleImage,b.ruleImage,`quote rule before confirmation: ${a.raw}`);assert.equal(a.ruleSize,b.ruleSize,`quote rule width before confirmation: ${a.raw}`)}
    }
    if(result.pending.caret&&result.after.caret){near(result.pending.caret.top,result.after.caret.top,'caret top before confirmation');near(result.pending.caret.left,result.after.caret.left,'caret left before confirmation')}
    for(const frame of result.frames??[]){
      assert.deepEqual(frame.map(row=>[row.raw,row.depth]),result.after.rows.map(row=>[row.raw,row.depth]),'intermediate frame keeps quote presentation');
      for(let i=0;i<frame.length;i++){near(frame[i].top,result.after.rows[i].top,'intermediate row top');near(frame[i].height,result.after.rows[i].height,'intermediate row height');near(frame[i].start,result.after.rows[i].start,'intermediate quote inset');if(frame[i].depth!==null){assert.equal(frame[i].background,result.after.rows[i].background,`intermediate quote background: ${frame[i].raw}`);assert.equal(frame[i].ruleImage,result.after.rows[i].ruleImage,`intermediate quote rule: ${frame[i].raw}`);assert.equal(frame[i].ruleSize,result.after.rows[i].ruleSize,`intermediate quote rule width: ${frame[i].raw}`)}}
    }
  };
  const mod=await c.evaluate('/Mac|iPhone|iPad/.test(navigator.platform)')?4:2;

  const sizes=[];
  for(const fontSize of [14,24,36]){
    await c.evaluate(`editor.setLayoutStyle({fontSize:${fontSize}})`);
    const rowSource='前文\n\n> 顶部\n> 内容\n>\n> 尾行\n\n结束';await load(rowSource,rowSource.indexOf('内容'));
    const snap=await snapshot(),empty=snap.rows.find(row=>row.raw==='>'),text=snap.rows.find(row=>row.raw==='> 内容');
    sizes.push({fontSize,empty:{height:empty.height,lineHeight:empty.lineHeight},text:{height:text.height,lineHeight:text.lineHeight}});
    if(!diagnostic){near(empty.height,text.height,'empty and populated quote rows share the body line height');assert(text.lineHeight>=fontSize*1.2,`body line height follows font size ${fontSize}: ${JSON.stringify(text)}`);
      assert(text.glyph && text.glyph.top>=text.top-1 && text.glyph.bottom<=text.top+text.height+1,`quote glyphs fit within their row at ${fontSize}px`)}
  }
  const crossMode=[];
  for(const [fontSize,fontFamily] of [[14,'sans-serif'],[24,'serif'],[36,'monospace']]){
    await c.evaluate(`editor.setLayoutStyle({fontSize:${fontSize},fontFamily:${JSON.stringify(fontFamily)}})`);
    const boxes={};
    for(const [kind,body] of [['empty',''],['whitespace','   '],['text',' 内容']]){
      const source=`前文\n\n>>>>${body}\n\n结束`;
      for(const mode of ['live-preview','preview','pretext']){
        await load(source,0,mode);
        const box=await c.evaluate(`(()=>{const n=${mode==='live-preview'?"view.contentDOM.querySelector('.cm-line[data-jot-quote-depth]')":mode==='preview'?"document.querySelector('.jot-editor-surface blockquote')":"document.querySelector('.jot-pretext-block--block-quote')"};if(!n)throw Error('missing quote projection');const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{height:r.height,fontSize:parseFloat(s.fontSize)}})()`);
        boxes[`${kind}-${mode}`]=box;
        if(!diagnostic)near(box.fontSize,fontSize,`${mode} inherits the requested font size`);
      }
    }
    crossMode.push({fontSize,fontFamily,boxes});
    if(!diagnostic){
      for(const mode of ['live-preview','preview','pretext']){
        near(boxes[`empty-${mode}`].height,boxes[`text-${mode}`].height,`${mode} empty and text quote heights`);
        near(boxes[`whitespace-${mode}`].height,boxes[`text-${mode}`].height,`${mode} whitespace and text quote heights`);
      }
      near(boxes['empty-preview'].height,boxes['empty-live-preview'].height,'Preview and Live Preview empty quote geometry');
      near(boxes['empty-pretext'].height,boxes['empty-live-preview'].height,'PreText and Live Preview empty quote geometry');
      const boundary='前文\n\n>>>>\n\n结束',blankAt=boundary.indexOf('>>>>\n\n')+5;
      await load(boundary,blankAt);const deletion=await capture(()=>key('Backspace'),{trace:true});
      assert.equal(deletion.pending.value,boundary.replace('>>>>\n\n','>>>>\n'));stable(deletion);
      const undo=await capture(()=>key('z',mod),{trace:true});assert.equal(undo.pending.value,boundary);stable(undo);
    }
  }
  if(diagnostic)console.log(JSON.stringify({case:'cross-mode-fonts',crossMode}));
  await c.evaluate(`editor.setLayoutStyle({fontSize:16,metrics:{paragraphLineHeight:26,blankLineHeight:22}})`);
  const equalSource='前文\n\n> 顶部\n> 内容\n>\n> 尾行\n\n结束';await load(equalSource,equalSource.indexOf('内容'));
  const equal=await snapshot();
  if(diagnostic)console.log(JSON.stringify({case:'font-and-line-height',sizes,rows:equal.rows.map(({raw,height,lineHeight})=>({raw,height,lineHeight}))}));
  else near(equal.rows.find(row=>row.raw==='>').height,equal.rows.find(row=>row.raw==='> 内容').height,'quote uses paragraph metrics even when top-level blank metrics differ');
  if(!diagnostic)near(equal.rows.find(row=>row.raw==='').height,22,'a top-level blank retains its separate explicit metric');

  const scenarios=[
    {name:'single-blank-after-quote',source:'前文\n\n>\n\n尾部',marker:'>',key:'Backspace'},
    {name:'whitespace-after-marker',source:'前文\n\n>>   \n\n尾部',marker:'>>   ',key:'Backspace'},
    {name:'multiple-blanks-after-quote',source:'前文\n\n> 上层\n>>\n>>>\n\n尾部',marker:'>>>',key:'Backspace'},
    {name:'forward-delete-before-blank',source:'前文\n\n>>\n\n尾部',marker:'>>',key:'Delete'},
    {name:'one-of-two-plain-blanks',source:'前文\n\n>>\n\n\n尾部',marker:'>>',key:'Backspace'},
    {name:'blank-between-empty-quotes',source:'前文\n\n>>\n>>>\n\n>\n>>\n\n尾部',marker:'>>>',key:'Backspace'},
    {name:'blank-between-whitespace-quotes',source:'前文\n\n>>   \n\n>  \n>>\n\n尾部',marker:'>>   ',key:'Backspace'},
    {name:'blank-at-document-end',source:'前文\n\n>>\n',marker:'>>',key:'Backspace'},
    {name:'whitespace-quote-at-document-end',source:'前文\n\n>>   \n',marker:'>>   ',key:'Backspace'},
  ];
  for(const scenario of scenarios){
    if(process.env.JOT_QUOTE_ADAPTIVE_SCENARIO && process.env.JOT_QUOTE_ADAPTIVE_SCENARIO!==scenario.name)continue;
    if(process.env.JOT_QUOTE_ADAPTIVE_TRACE==='1')console.log(`quote scenario: ${scenario.name}`);
    const markerEnd=scenario.source.indexOf(scenario.marker+'\n')+scenario.marker.length;
    const at=markerEnd+(scenario.key==='Backspace'?1:0);
    await load(scenario.source,at);const result=await capture(()=>key(scenario.key),{trace:true});
    if(process.env.JOT_QUOTE_ADAPTIVE_TRACE==='1')console.log(`quote scenario delete confirmed: ${scenario.name}`);
    if(diagnostic)console.log(JSON.stringify({case:scenario.name,pending:result.pending,after:result.after}));
    else{
      assert.equal(result.pending.value,scenario.source.slice(0,markerEnd)+scenario.source.slice(markerEnd+1));
      stable(result);
      const undo=await capture(()=>key('z',mod),{trace:true});assert.equal(undo.pending.value,scenario.source);stable(undo);
      if(process.env.JOT_QUOTE_ADAPTIVE_TRACE==='1')console.log(`quote scenario undo confirmed: ${scenario.name}`);
      const redo=await capture(()=>key('z',mod|8),{trace:true});assert.equal(redo.pending.value,result.pending.value);stable(redo);
    }
  }

  if(!diagnostic){
    const source='前文\n\n>>\n\n尾部',blankAt=source.indexOf('>>\n\n')+3;
    await load(source,0);
    const point=await c.evaluate(`(()=>{const r=view.coordsAtPos(${blankAt});return{x:r.left+.5,y:(r.top+r.bottom)/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    await wait(`view.state.selection.main.head===${blankAt}`);await frame();
    const clickedDelete=await capture(()=>key('Backspace'),{trace:true});
    assert.equal(clickedDelete.pending.value,source.replace('>>\n\n','>>\n'));stable(clickedDelete);
    const undoClickedDelete=await capture(()=>key('z',mod),{trace:true});assert.equal(undoClickedDelete.pending.value,source);stable(undoClickedDelete);
  }

  // Fixed seed exercises root joins and splits at many combinations of quote
  // depths; every physical row here is an empty, confirmed quote row.
  let random=0x4717c0de;
  const depth=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return 1+random%9};
  for(let iteration=0;iteration<16&&!diagnostic;iteration++){
    const left=Array.from({length:3},()=>'>'.repeat(depth())).join('\n');
    const right=Array.from({length:3},()=>'>'.repeat(depth())).join('\n');
    const source=`前文\n\n${left}\n\n${right}\n\n尾部`,at=source.indexOf('\n\n',source.indexOf(left))+1;
    await load(source,at);const joined=await capture(()=>key('Backspace'),{trace:true});
    assert.equal(joined.pending.value,source.slice(0,at-1)+source.slice(at),`mixed-depth join ${iteration}`);stable(joined);
    const undo=await capture(()=>key('z',mod),{trace:true});assert.equal(undo.pending.value,source);stable(undo);
    const redo=await capture(()=>key('z',mod|8),{trace:true});assert.equal(redo.pending.value,joined.pending.value);stable(redo);
  }

  if(!diagnostic){
    // Joining roots may complete a fenced block. Do not reuse an empty-quote
    // projection over that structural change; the final Rust parse must win.
    const ticks='```',source=`前文\n\n>> ${ticks} ts\n>>\n\n>> ${ticks}\n\n尾部`,at=source.indexOf('>>\n\n')+3;
    await load(source,at);await key('Backspace');
    const joined=source.replace('>>\n\n','>>\n');
    await wait(`editor.value===${JSON.stringify(joined)}&&editor.value===editor.confirmedValue&&editor.session.adapter.analysis?.state==='complete'`);
    await c.evaluate('editor.livePreview.settled()');
    await wait(`!!view.contentDOM.querySelector('.cm-line.jot-live-preview-source-fenced-code[data-jot-quote-depth]')`);
    await key('z',mod);await wait(`editor.value===${JSON.stringify(source)}&&editor.value===editor.confirmedValue`);
    await c.evaluate('editor.livePreview.settled()');
    assert.equal(await c.evaluate(`!!view.contentDOM.querySelector('.cm-line.jot-live-preview-source-fenced-code[data-jot-quote-depth]')`),false,
      'Undo restores two incomplete quoted fences instead of retaining a stale code block');
  }

  for(const prefix of ['>','>>','>>> ','> > > ','>>>  ']){
    const source=`前文\n\n${prefix}\n\n尾部`,at=source.indexOf(prefix)+prefix.length;
    await load(source,at);const result=await capture(()=>key('Enter'));
    if(diagnostic)console.log(JSON.stringify({case:'empty-enter',prefix,pending:result.pending.value,after:result.after.value}));
    else{
      const continuedPrefix=prefix==='>>>  '?'>>> ':prefix;
      assert.equal(result.pending.value,source.slice(0,at)+'\n'+continuedPrefix+source.slice(at),'Enter inserts an empty quote line at the same depth');
      assert.equal(result.pending.head,at+1+continuedPrefix.length,'the caret enters the new quote row');stable(result);
      const undo=await capture(()=>key('z',mod));assert.equal(undo.pending.value,source);stable(undo);
      const redo=await capture(()=>key('z',mod|8));assert.equal(redo.pending.value,result.pending.value);stable(redo);
    }
  }
  if(!diagnostic){
    const source='前文\n\n\n尾部',at=source.indexOf('\n\n')+2;
    await load(source,at);await c.evaluate('holdWorker=true');let pending;
    try{
      await c.command('Input.insertText',{text:'>>>'});await wait('editor.value!==editor.confirmedValue');
      await key('Enter');await key('Enter');await frame();pending=await snapshot();
      assert.equal(pending.value,source.slice(0,at)+'>>>\n>>>\n>>>'+source.slice(at),
        'repeated Enter preserves a freshly typed quote before Worker confirmation');
    }finally{await c.evaluate('releaseWorker()')}
    await wait(`editor.value===editor.confirmedValue&&editor.session.adapter.analysis?.state==='complete'`);
    await c.evaluate('editor.livePreview.settled()');await frame();stable({pending,after:await snapshot()});
  }
  // A consumer can change inherited CSS typography and invalidate layout.
  // Test this with a separate editor that has no inline font-size override.
  await c.evaluate(`(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.id='quote-external-font';root.style.cssText='width:620px;height:400px;font-size:30px';document.body.append(root);
    window.externalWorker=new Worker('/src/worker.ts',{type:'module'});
    window.externalEditor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint:externalWorker,documentId:'quote-external-font',generation:1,source:'> 内容\\n>\\n> 尾部',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:error=>editorErrors.push(String(error))});
    await externalEditor.open();await externalEditor.livePreview.settled();
  })()`);
  try{
    const readExternal=()=>c.evaluate(`(()=>{const n=externalEditor.input.view.contentDOM.querySelector('.cm-line[data-jot-quote-depth]'),s=getComputedStyle(n);return{fontSize:parseFloat(s.fontSize),lineHeight:parseFloat(s.lineHeight)}})()`);
    let external=await readExternal();
    if(!diagnostic){near(external.fontSize,30,'initial external CSS font size');assert(external.lineHeight>=36,'initial CSS font size drives default quote line height')}
    await c.evaluate(`(async()=>{document.querySelector('#quote-external-font').style.fontSize='36px';await externalEditor.invalidateLayout();await externalEditor.livePreview.settled()})()`);
    external=await readExternal();
    if(!diagnostic){near(external.fontSize,36,'updated external CSS font size');assert(external.lineHeight>=43.2,'layout invalidation recomputes default metrics for CSS font changes')}
    const liveHeight=await c.evaluate(`(()=>{const a=[...externalEditor.input.view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth]')].map(n=>n.getBoundingClientRect());return a.at(-1).bottom-a[0].top})()`);
    await c.evaluate(`(async()=>{await externalEditor.setMode('preview');await externalEditor.surface.settled()})()`);
    const previewHeight=await c.evaluate(`document.querySelector('#quote-external-font blockquote').getBoundingClientRect().height`);
    await c.evaluate(`(async()=>{await externalEditor.setMode('pretext');await externalEditor.surface.settled()})()`);
    const pretextHeight=await c.evaluate(`document.querySelector('#quote-external-font .jot-pretext-block--block-quote').getBoundingClientRect().height`);
    if(!diagnostic){near(previewHeight,liveHeight,'external CSS font keeps preview quote geometry');near(pretextHeight,liveHeight,'external CSS font keeps pretext quote estimate')}
    await c.evaluate(`(async()=>{await externalEditor.setMode('live-preview');await externalEditor.livePreview.settled()})()`);
    await c.evaluate(`(async()=>{await externalEditor.setLayoutStyle({fontSize:30,metrics:{paragraphLineHeight:48,blankLineHeight:18}});await externalEditor.setLayoutStyle({fontSize:36});await externalEditor.livePreview.settled()})()`);
    external=await readExternal();
    if(!diagnostic){near(external.fontSize,36,'font size updates after explicit metrics');near(external.lineHeight,48,'explicit paragraph line height remains an absolute override')}
    if(diagnostic)console.log(JSON.stringify({case:'external-font-and-override',external}));
  }finally{await c.evaluate(`externalEditor.dispose();externalWorker.terminate();document.querySelector('#quote-external-font').remove()`)}

  // Constructor-level theme typography must reach both rendering hosts before
  // their first measurement, without requiring a later setLayoutStyle call.
  await c.evaluate(`(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.id='quote-initial-theme';root.style.cssText='width:620px;height:400px';document.body.append(root);
    window.themeWorker=new Worker('/src/worker.ts',{type:'module'});
    window.themeEditor=new MarkdownEditor({root,mode:'live-preview',theme:{layout:{fontSize:30}},session:{endpoint:themeWorker,documentId:'quote-initial-theme',generation:1,source:'>>>>',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:error=>editorErrors.push(String(error))});
    await themeEditor.open();await themeEditor.livePreview.settled();
  })()`);
  try{
    const initialLive=await c.evaluate(`(()=>{const n=themeEditor.input.view.contentDOM.querySelector('.cm-line[data-jot-quote-depth]'),s=getComputedStyle(n);return{fontSize:parseFloat(s.fontSize),lineHeight:parseFloat(s.lineHeight),height:n.getBoundingClientRect().height}})()`);
    await c.evaluate(`(async()=>{await themeEditor.setMode('preview');await themeEditor.surface.settled()})()`);
    const initialPreview=await c.evaluate(`(()=>{const n=document.querySelector('#quote-initial-theme blockquote'),s=getComputedStyle(n);return{fontSize:parseFloat(s.fontSize),height:n.getBoundingClientRect().height}})()`);
    await c.evaluate(`(async()=>{await themeEditor.setMode('pretext');await themeEditor.surface.settled()})()`);
    const initialPretext=await c.evaluate(`(()=>{const n=document.querySelector('#quote-initial-theme .jot-pretext-block--block-quote'),s=getComputedStyle(n);return{fontSize:parseFloat(s.fontSize),height:n.getBoundingClientRect().height}})()`);
    if(!diagnostic){
      near(initialLive.fontSize,30,'initial theme applies live font size');assert(initialLive.lineHeight>=36,'initial theme computes the live line height');
      near(initialPreview.fontSize,30,'initial theme applies preview font size');near(initialPreview.height,initialLive.height,'initial theme preview geometry');
      near(initialPretext.fontSize,30,'initial theme applies pretext font size');near(initialPretext.height,initialLive.height,'initial theme pretext geometry');
    }
    if(diagnostic)console.log(JSON.stringify({case:'initial-theme-font',initialLive,initialPreview,initialPretext}));
  }finally{await c.evaluate(`themeEditor.dispose();themeWorker.terminate();document.querySelector('#quote-initial-theme').remove()`)}
  for(const mode of ['source','split']){
    for(const prefix of ['>>>','> > > ']){
      const source=`前文\n\n${prefix}\n\n尾部`,at=source.indexOf(prefix)+prefix.length;
      await load(source,at,mode);await key('Enter');
      await wait(`editor.value===editor.confirmedValue&&editor.session.adapter.analysis?.state==='complete'`);
      const changed=await c.evaluate('editor.value');
      assert(changed.includes(prefix.trimEnd()+'\n'+prefix),`${mode}: Enter continues the same quote depth`);
      await key('z',mod);await wait(`editor.value===${JSON.stringify(source)}&&editor.value===editor.confirmedValue`);
    }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(await c.evaluate('editorErrors'),[]);
  console.log('PASS: adaptive quote line geometry and empty-line keyboard operations');
}finally{
  try{if(c){await c.evaluate('(async()=>{await releaseWorker();editor?.dispose();worker?.terminate()})()');c.socket.close()}}catch{}
  await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true});
}
