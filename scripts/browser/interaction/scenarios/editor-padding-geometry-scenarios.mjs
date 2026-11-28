import assert from 'node:assert/strict';
import { waitForEvaluation } from '../../support/browser-test-utils.mjs';

// A separate component consumer configures an inset and adaptive table. The
// page never installs a Demo-specific renderer or edit handler.
export async function runPaddingGeometryScenarios({c,results}) {
 const image='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120"><rect width="1200" height="120" fill="#789"/></svg>').toString('base64');
 const fence='`'.repeat(3);
 const source=`before\n\n| 名称 | 说明 |\n| --- | --- |\n| 文本 | 编辑内容 |\n| 表格 | 保持对齐 |\n\n![示意](${image})\n\nafter\n\n${fence}\n${'x'.repeat(80)}\n${fence}`;
 await c.evaluate(`(async()=>{
   document.querySelector('#integration').style.display='none';
   const style=document.createElement('style');style.id='padding-fixture-style';style.textContent='#padding-fixture .cm-content{padding:20px 40px}#padding-fixture .jot-markdown-editor__surface{padding:20px 40px}';document.head.append(style);
   const root=document.createElement('div');root.id='padding-fixture';root.style.cssText='height:540px;width:680px';document.body.append(root);
   const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');window.paddingWorker=new Worker('/src/worker.ts',{type:'module'});window.paddingErrors=[];
   window.paddingEditor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint:paddingWorker,documentId:'padding-test',generation:1,source:${JSON.stringify(source)},syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},surface:{table:{mode:'adaptive'}},theme:{layout:{fontSize:16,metrics:{paragraphLineHeight:26,blankLineHeight:22}}},onError:e=>paddingErrors.push(String(e))});
   await paddingEditor.open();await paddingEditor.livePreview.settled();
 })()`);
 try {
  const read=async()=>c.evaluate(`(()=>{const root=document.querySelector('#padding-fixture'),mode=paddingEditor.mode,pane=root.querySelector(mode==='preview'?'.jot-markdown-editor__surface':'.cm-scroller'),content=root.querySelector(mode==='preview'?'.jot-editor-content':'.cm-content'),table=root.querySelector('.jot-table'),image=root.querySelector('.jot-image'),pr=pane.getBoundingClientRect(),cr=content.getBoundingClientRect(),tr=table?.getBoundingClientRect(),ir=image?.getBoundingClientRect(),style=getComputedStyle(content);return{mode,source:paddingEditor.value,confirmed:paddingEditor.confirmedValue,scroll:pane.scrollTop,pane:{left:pr.left,right:pr.left+pane.clientWidth},content:{left:cr.left,right:cr.right,paddingLeft:parseFloat(style.paddingLeft),paddingRight:parseFloat(style.paddingRight)},table:table&&{left:tr.left,right:tr.right,width:table.clientWidth,scrollWidth:table.scrollWidth,headers:[...table.querySelectorAll('.jot-table-grid-header .jot-table-cell')].map(n=>{const a=n.getBoundingClientRect(),b=table.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="'+n.dataset.jotColumnIndex+'"]')?.getBoundingClientRect();return{text:n.textContent,left:a.left,right:a.right,bodyLeft:b?.left,bodyRight:b?.right}})},image:image&&{left:ir.left,right:ir.right,top:ir.top,bottom:ir.bottom,width:ir.width,height:ir.height,loaded:image.complete&&image.naturalWidth>0},errors:paddingErrors}})()`);
  for(const width of [680,360]) {
   await c.evaluate(`document.querySelector('#padding-fixture').style.width=${JSON.stringify(width+'px')}`);
   for(const mode of ['live-preview','preview']) {
    await c.evaluate(`paddingEditor.setMode(${JSON.stringify(mode)})`);
    await c.evaluate(`paddingEditor.${mode==='preview'?'surface':'livePreview'}.settled()`);
    await waitForEvaluation(c,`(()=>{const t=document.querySelector('#padding-fixture .jot-table'),i=document.querySelector('#padding-fixture .jot-image');return t&&t.querySelectorAll('.jot-table-grid-body .jot-table-cell').length>=2&&i?.complete&&i.naturalWidth>0})()`,15000);
    // ResizeObserver and column measurements are asynchronous. Wait for the
    // actual aligned result rather than assuming a fixed delay.
    await waitForEvaluation(c,`(()=>{const t=document.querySelector('#padding-fixture .jot-table');return t.scrollWidth<=t.clientWidth+1})()`,10000);
    const state=await read();assert.equal(state.source,source);assert.equal(state.confirmed,source);assert.deepEqual(state.errors,[]);
    assert.deepEqual(state.table.headers.map(h=>h.text),['名称','说明']);
    for(const h of state.table.headers)assert(Math.abs(h.left-h.bodyLeft)<1&&Math.abs(h.right-h.bodyRight)<1,`${mode}/${width}: table columns align`);
    assert(state.table.left>=state.pane.left-1&&state.table.right<=state.pane.right+1,`${mode}/${width}: padded table fits its viewport`);
    assert(state.image.loaded&&state.image.left>=state.pane.left-1&&state.image.right<=state.pane.right+1,`${mode}/${width}: image is not horizontally clipped`);
    const contentLeft=state.content.left+state.content.paddingLeft,contentRight=state.content.right-state.content.paddingRight;
    assert(Math.abs((state.image.left+state.image.right-contentLeft-contentRight)/2)<2,`${mode}/${width}: image stays centered in the content area`);
    evidence(state,width);
   }
  }
  await c.evaluate(`paddingEditor.setMode('live-preview')`);await c.evaluate(`paddingEditor.livePreview.settled()`);
  await c.evaluate(`document.querySelector('#padding-fixture .jot-image').scrollIntoView({block:'center'})`);
  await c.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const before=await c.evaluate(`(()=>{const v=paddingEditor.input.view,line=document.querySelector('#padding-fixture .jot-image').closest('.cm-line'),blank=line.previousElementSibling,r=blank.getBoundingClientRect(),ir=line.getBoundingClientRect(),x=r.left+8,y=(r.top+r.bottom)/2,hit=document.elementFromPoint(x,y);window.paddingPointerEvents=[];for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])v.contentDOM.addEventListener(type,e=>window.paddingPointerEvents.push({type,target:e.target?.className,head:v.state.selection.main.head,x:e.clientX,y:e.clientY}),{capture:true,once:true});return{x,y,top:r.top,height:r.height,imageTop:ir.top,imageBottom:ir.bottom,scroll:v.scrollDOM.scrollTop,from:v.posAtDOM(blank,0),hit:hit?.className,blank:blank.outerHTML}})()`);
  // Capture every paint after the real click, not only the eventual settled
  // state: a temporary row expansion is visible as a flicker too.
  await c.evaluate(`(()=>{window.blankFramesDone=new Promise(resolve=>{const frames=[];function sample(){const v=paddingEditor.input.view,line=document.querySelector('#padding-fixture .jot-image')?.closest('.cm-line'),blank=line?.previousElementSibling,r=blank?.getBoundingClientRect(),ir=line?.getBoundingClientRect();frames.push({top:r?.top,height:r?.height,imageTop:ir?.top,imageBottom:ir?.bottom,scroll:v.scrollDOM.scrollTop});if(frames.length<12)requestAnimationFrame(sample);else resolve(frames)}requestAnimationFrame(sample)});return true})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:before.x,y:before.y});
  const frames=await c.evaluate(`window.blankFramesDone`);
  await c.evaluate(`paddingEditor.livePreview.settled()`);
  const after=await c.evaluate(`(()=>{const v=paddingEditor.input.view,line=document.querySelector('#padding-fixture .jot-image')?.closest('.cm-line'),blank=line?.previousElementSibling,r=blank?.getBoundingClientRect(),ir=line?.getBoundingClientRect();return{top:r?.top,height:r?.height,imageTop:ir?.top,imageBottom:ir?.bottom,scroll:v.scrollDOM.scrollTop,head:v.state.selection.main.head,active:blank?.classList.contains('jot-live-preview-active-line'),source:paddingEditor.value,events:paddingPointerEvents,dom:v.contentDOM.outerHTML}})()`);
  results.push({case:'component-padded-blank-image-diagnostic',before,frames,after});
  assert(after.active,'the blank above the image receives the real click');assert.equal(after.head,before.from);assert.equal(after.source,source);
  for(const [index,frame] of frames.entries())for(const field of ['top','height','imageTop','imageBottom','scroll'])assert(Number.isFinite(frame[field])&&Math.abs(frame[field]-before[field])<1,`component blank activation must not change ${field} on frame ${index+1}`);
  for(const field of ['top','height','imageTop','imageBottom','scroll'])assert(Math.abs(after[field]-before[field])<1,`component blank activation must not change ${field}`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:2,x:before.x,y:before.y});
  await c.evaluate(`paddingEditor.livePreview.settled()`);
  const doubleClick=await c.evaluate(`(()=>{const v=paddingEditor.input.view,s=v.state.selection.main,line=document.querySelector('#padding-fixture .jot-image')?.closest('.cm-line');return{from:s.from,to:s.to,head:s.head,activeImage:line?.classList.contains('jot-live-preview-active-line'),source:paddingEditor.value}})()`);
  assert(!doubleClick.activeImage,'double-clicking an empty row must not activate the adjacent image');assert.equal(doubleClick.source,source);
  const first=await c.evaluate(`(()=>{const n=[...paddingEditor.input.view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent==='before'),r=n.getBoundingClientRect();return{x:r.left+8,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...first});
  const anchor=await c.evaluate(`paddingEditor.input.view.state.selection.main.head`);
  const blankPoint=await c.evaluate(`(()=>{const line=document.querySelector('#padding-fixture .jot-image').closest('.cm-line').previousElementSibling,r=line.getBoundingClientRect();return{x:r.left+8,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,modifiers:8,...blankPoint});
  const shifted=await c.evaluate(`(()=>{const s=paddingEditor.input.view.state.selection.main;return{anchor:s.anchor,head:s.head,source:paddingEditor.value}})()`);
  assert.equal(shifted.anchor,anchor,'Shift-click keeps the existing source anchor');assert.equal(shifted.head,before.from,'Shift-click extends to the blank line');assert.equal(shifted.source,source);
  const target=await c.evaluate(`(()=>{const n=[...paddingEditor.input.view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent==='after'),r=n.getBoundingClientRect();return{x:r.left+8,y:(r.top+r.bottom)/2}})()`);
  await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...blankPoint});
  await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...target});
  await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...target});
  const dragged=await c.evaluate(`(()=>{const s=paddingEditor.input.view.state.selection.main;return{anchor:s.anchor,head:s.head,source:paddingEditor.value}})()`);
  assert.equal(dragged.anchor,before.from,'dragging from a blank starts at its source position');assert(dragged.head>dragged.anchor,'dragging from a blank extends the selection');assert.equal(dragged.source,source);
  const imagePoint=await c.evaluate(`(()=>{const r=document.querySelector('#padding-fixture .jot-image').getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...imagePoint});
  await c.evaluate(`paddingEditor.livePreview.settled()`);
  const imageActive=await c.evaluate(`(()=>{const v=paddingEditor.input.view,s=v.state.selection.main;return{head:s.head,source:paddingEditor.value,active:!!v.contentDOM.querySelector('.jot-live-preview-active-line .jot-image')}})()`);
  assert(imageActive.active,'clicking the image enters its editable source');assert.equal(imageActive.source,source);
  const returnPoint=await c.evaluate(`(()=>{const v=paddingEditor.input.view,n=[...v.contentDOM.querySelectorAll('.jot-live-preview-blank-line')].find(n=>v.posAtDOM(n,0)===${before.from});if(!n)throw Error('original blank line missing');const r=n.getBoundingClientRect();return{x:r.left+8,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...returnPoint});
  await c.evaluate(`paddingEditor.livePreview.settled()`);
  const returned=await c.evaluate(`(()=>{const v=paddingEditor.input.view,line=document.querySelector('#padding-fixture .jot-image').closest('.cm-line'),r=line.getBoundingClientRect();return{head:v.state.selection.main.head,source:paddingEditor.value,imageTop:r.top,imageBottom:r.bottom,scroll:v.scrollDOM.scrollTop}})()`);
  assert.equal(returned.head,before.from,'clicking the blank leaves image editing');assert.equal(returned.source,source);
  for(const field of ['imageTop','imageBottom','scroll'])assert(Math.abs(returned[field]-before[field])<1,`leaving image editing restores ${field}`);
  results.push({case:'component-padded-blank-image-table',before,after});

  // A whitespace-only row is also visually blank, but must retain native
  // character-level hit testing rather than forcing a caret to its start.
  const spacedSource=source.replace('\n\nafter','\n  \nafter');
  await c.evaluate(`paddingEditor.setValue(${JSON.stringify(spacedSource)})`);
  await waitForEvaluation(c,`paddingEditor.confirmedValue===${JSON.stringify(spacedSource)}&&paddingEditor.session.adapter.analysis?.state==='complete'`,15000);
  await c.evaluate(`paddingEditor.livePreview.settled()`);
  await c.evaluate(`document.querySelector('#padding-fixture .jot-image').scrollIntoView({block:'center'})`);
  await c.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const spacedBefore=await c.evaluate(`(()=>{const v=paddingEditor.input.view,line=document.querySelector('#padding-fixture .jot-image').closest('.cm-line'),blank=line.nextElementSibling,r=blank.getBoundingClientRect(),ir=line.getBoundingClientRect(),physical=v.state.doc.lineAt(v.posAtDOM(blank,0)),positions=[];for(let p=physical.from;p<=physical.to;p++){const q=v.coordsAtPos(p);positions.push({p,left:q?.left,right:q?.right,top:q?.top,bottom:q?.bottom})}const x=positions[0].left+.3,y=(r.top+r.bottom)/2,caret=document.caretPositionFromPoint?.(x,y);return{x,y,top:r.top,height:r.height,imageTop:ir.top,imageBottom:ir.bottom,scroll:v.scrollDOM.scrollTop,from:physical.from,to:physical.to,text:physical.text,dom:blank.outerHTML,hit:document.elementFromPoint(x,y)?.outerHTML,atCoords:v.posAtCoords({x,y}),positions,caret:caret&&{node:caret.offsetNode.parentElement?.outerHTML,offset:caret.offset,source:v.posAtDOM(caret.offsetNode,caret.offset)}}})()`);
  assert.equal(spacedBefore.text,'  ','fixture contains a whitespace-only physical line');
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:spacedBefore.x,y:spacedBefore.y});
  await c.evaluate(`paddingEditor.livePreview.settled()`);
  const spacedAfter=await c.evaluate(`(()=>{const v=paddingEditor.input.view,line=document.querySelector('#padding-fixture .jot-image')?.closest('.cm-line'),blank=line?.nextElementSibling,r=blank?.getBoundingClientRect(),ir=line?.getBoundingClientRect();return{head:v.state.selection.main.head,source:paddingEditor.value,active:blank?.classList.contains('jot-live-preview-active-line'),top:r?.top,height:r?.height,imageTop:ir?.top,imageBottom:ir?.bottom,scroll:v.scrollDOM.scrollTop}})()`);
  results.push({case:'component-padded-whitespace-blank',before:spacedBefore,after:spacedAfter});
  assert(spacedAfter.active&&spacedAfter.head===spacedBefore.from,'a click at the start of a whitespace-only line targets its first character boundary');
  assert.equal(spacedAfter.source,spacedSource);
  for(const field of ['top','height','imageTop','imageBottom','scroll'])assert(Math.abs(spacedAfter[field]-spacedBefore[field])<1,`whitespace-only blank activation must not change ${field}`);
  const spacedEnd={x:spacedBefore.positions.at(-1).left+.3,y:spacedBefore.y};
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...spacedEnd});
  assert.equal(await c.evaluate(`paddingEditor.input.view.state.selection.main.head`),spacedBefore.to,'clicking after the spaces preserves their final character boundary');
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,modifiers:8,x:spacedBefore.x,y:spacedBefore.y});
  const spacedShift=await c.evaluate(`(()=>{const s=paddingEditor.input.view.state.selection.main;return{anchor:s.anchor,head:s.head}})()`);
  assert.deepEqual(spacedShift,{anchor:spacedBefore.to,head:spacedBefore.from},'Shift-click extends from the existing character boundary');
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:spacedBefore.x,y:spacedBefore.y});
  await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:spacedBefore.x,y:spacedBefore.y});
  await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...spacedEnd});
  await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...spacedEnd});
  const spacedDrag=await c.evaluate(`(()=>{const s=paddingEditor.input.view.state.selection.main;return{anchor:s.anchor,head:s.head}})()`);
  assert.deepEqual(spacedDrag,{anchor:spacedBefore.from,head:spacedBefore.to},'dragging across the spaces retains their character-level range');
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...first});
  // Force the already-observed missed-row mapping to exercise the geometry
  // fallback even after CM has refreshed its measurements for this row.
  await c.evaluate(`(()=>{const names=['caretPositionFromPoint','caretRangeFromPoint'],old=names.map(n=>Object.getOwnPropertyDescriptor(document,n)),v=paddingEditor.input.view,own=Object.getOwnPropertyDescriptor(v,'posAtCoords');for(const n of names)Object.defineProperty(document,n,{configurable:true,value:undefined});window.blankFallbackCalls=0;Object.defineProperty(v,'posAtCoords',{configurable:true,value:function(){blankFallbackCalls++;return ${spacedBefore.to+1}}});window.restoreCaretPointAPIs=()=>{names.forEach((n,i)=>old[i]?Object.defineProperty(document,n,old[i]):delete document[n]);if(own)Object.defineProperty(v,'posAtCoords',own);else delete v.posAtCoords}})()`);
  try {
   const hit=await c.evaluate(`document.elementFromPoint(${spacedEnd.x},${spacedEnd.y})?.outerHTML`);
   for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...spacedEnd});
   const fallback=await c.evaluate(`({calls:blankFallbackCalls,head:paddingEditor.input.view.state.selection.main.head})`);
   results.push({case:'component-whitespace-geometry-fallback',hit,fallback});
   assert(fallback.calls>0,'the controlled missed-row mapping was used');
   assert.equal(await c.evaluate(`paddingEditor.input.view.state.selection.main.head`),spacedBefore.to,'the geometry fallback keeps the correct boundary without browser caret-point APIs');
  } finally {await c.evaluate(`restoreCaretPointAPIs()`)}

  const tabSource=source.replace('\n\nafter','\n\t\nafter');
  await c.evaluate(`paddingEditor.setValue(${JSON.stringify(tabSource)})`);
  await waitForEvaluation(c,`paddingEditor.confirmedValue===${JSON.stringify(tabSource)}&&paddingEditor.session.adapter.analysis?.state==='complete'`,15000);
  await c.evaluate(`paddingEditor.livePreview.settled()`);
  const tabBefore=await c.evaluate(`(()=>{const v=paddingEditor.input.view,line=document.querySelector('#padding-fixture .jot-image').closest('.cm-line'),blank=line.nextElementSibling,r=blank.getBoundingClientRect(),ir=line.getBoundingClientRect(),physical=v.state.doc.lineAt(v.posAtDOM(blank,0)),start=v.coordsAtPos(physical.from),end=v.coordsAtPos(physical.to);return{from:physical.from,to:physical.to,text:physical.text,startX:start.left+.3,endX:end.left-.3,y:(r.top+r.bottom)/2,top:r.top,height:r.height,imageTop:ir.top,imageBottom:ir.bottom,scroll:v.scrollDOM.scrollTop}})()`);
  assert.equal(tabBefore.text,'\t','fixture contains a tab-only physical line');
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:tabBefore.endX,y:tabBefore.y});
  await c.evaluate(`paddingEditor.livePreview.settled()`);
  const tabAfter=await c.evaluate(`(()=>{const v=paddingEditor.input.view,line=document.querySelector('#padding-fixture .jot-image')?.closest('.cm-line'),blank=line?.nextElementSibling,r=blank?.getBoundingClientRect(),ir=line?.getBoundingClientRect();return{head:v.state.selection.main.head,source:paddingEditor.value,active:blank?.classList.contains('jot-live-preview-active-line'),top:r?.top,height:r?.height,imageTop:ir?.top,imageBottom:ir?.bottom,scroll:v.scrollDOM.scrollTop}})()`);
  results.push({case:'component-padded-tab-blank',before:tabBefore,after:tabAfter});
  assert(tabAfter.active&&tabAfter.head===tabBefore.to,'clicking after a tab reaches its final source boundary');
  assert.equal(tabAfter.source,tabSource);
  for(const field of ['top','height','imageTop','imageBottom','scroll'])assert(Math.abs(tabAfter[field]-tabBefore[field])<1,`tab-only blank activation must not change ${field}`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,modifiers:8,x:tabBefore.startX,y:tabBefore.y});
  const tabShift=await c.evaluate(`(()=>{const s=paddingEditor.input.view.state.selection.main;return{anchor:s.anchor,head:s.head}})()`);
  assert.deepEqual(tabShift,{anchor:tabBefore.to,head:tabBefore.from},'Shift-click selects exactly the tab character');

  const listCases=[
   {name:'bullet', lines:['- ITEM  ', '  FOLLOW'], insertAfter:'ITEM'},
   {name:'nested', lines:['- Parent', '  - ITEM  ', '    FOLLOW'], insertAfter:'ITEM'},
   {name:'ordered', lines:['10. ITEM  ', '    FOLLOW'], insertAfter:'ITEM'},
   {name:'task', lines:['- [ ] ITEM  ', '  FOLLOW'], insertAfter:'ITEM'},
   {name:'continuation', lines:['- Parent', '  - ITEM  ', '    FOLLOW  ', '    '], insertAfter:'    '},
   {name:'quoted', lines:['> - ITEM', '> unrelated'], insertAfter:'ITEM'},
  ];
  const lists=await c.evaluate(`(async(cases,destination)=>{
   const editor=paddingEditor;
   const view=editor.input.view;
   document.querySelector('#padding-fixture').style.width='360px';
   const read=()=>{
    const rows=[...view.contentDOM.querySelectorAll('.cm-line')];
    const image=view.contentDOM.querySelector('.jot-image');
    const wordLeft=label=>{
     for(const row of rows){
      const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
      let text;
      while((text=walker.nextNode())){
       const start=text.data.indexOf(label);
       if(start<0)continue;
       const range=new Range();
       range.setStart(text,start);
       range.setEnd(text,start+1);
       return range.getBoundingClientRect().left;
      }
     }
     return null;
    };
    return {
     item:wordLeft('ITEM'), follow:wordLeft('FOLLOW'),
     imageLeft:image?.getBoundingClientRect().left??null,
     imageLine:image?.closest('.cm-line')?.textContent??null,
     companion:image?.classList.contains('jot-live-preview-widget--source-companion')??false,
    };
   };
   const focus=async offset=>{
    editor.input.setSelection(offset);
    editor.focus();
    await editor.settled();
   };
   const results=[];
   for(const {name,lines,insertAfter} of cases){
    const markdown='outside\\n\\n'+lines.join('\\n')+'\\n\\nend';
    const insertAt=markdown.lastIndexOf(insertAfter)+insertAfter.length;
    editor.setValue(markdown);
    await editor.settled();
    await focus(insertAt);
    const before=read();
    const inserted=editor.insertImage({destination,alt:'layout'});
    await editor.settled();
    const after=read();
    await focus(insertAt+3);
    const editing=read();
    await focus(0);
    const inactive=read();
    const expected=markdown.slice(0,insertAt)+'![layout]('+destination+')'+markdown.slice(insertAt);
    results.push({name,sourceUnchanged:inserted&&editor.confirmedValue===expected,before,after,editing,inactive});
   }
   return results;
  })(${JSON.stringify(listCases)},${JSON.stringify(image)})`);
  for(const {name,sourceUnchanged,before,after,editing,inactive} of lists){
   assert(sourceUnchanged,`${name}: insertion preserves the Markdown list syntax`);
   assert(editing.companion,`${name}: editing exposes the image companion`);
   if(name==='quoted'){
    assert(editing.imageLine?.includes('ITEM'),`the quoted image stays on its list line: ${JSON.stringify(editing)}`);
   }
   for(const state of [after,editing,inactive]){
    assert(Number.isFinite(state.item)&&Math.abs(state.item-before.item)<=1,
      `${name}: list text keeps its initial column: ${JSON.stringify({before,state})}`);
    if(before.follow!==null){
     assert(Number.isFinite(state.follow)&&Math.abs(state.follow-before.follow)<=1,
       `${name}: continuation keeps its initial column: ${JSON.stringify({before,state})}`);
    }
   }
   if(name==='continuation'||name==='quoted'){
    assert(Number.isFinite(editing.imageLeft)&&Math.abs(editing.imageLeft-before.item)<=1,
      `${name}: image companion stays in the list content column: ${JSON.stringify({before,editing})}`);
   }
  }
  results.push({case:'component-list-image-alignment',lists});
  assert.deepEqual(await c.evaluate('paddingErrors'),[]);
 } finally {
  await c.evaluate(`(()=>{paddingEditor.dispose();paddingWorker.terminate();document.querySelector('#padding-fixture').remove();document.querySelector('#padding-fixture-style').remove();document.querySelector('#integration').style.display=''})()`);
 }
 function evidence(state,width){results.push({case:'component-padded-layout',width,...state})}
}
