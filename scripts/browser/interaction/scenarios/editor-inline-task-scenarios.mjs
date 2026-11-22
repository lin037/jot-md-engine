import assert from 'node:assert/strict';
import { waitForEvaluation } from '../../support/browser-test-utils.mjs';

// These cases mount the exported component and use CDP input, not Demo code.
export async function runInlineTaskScenarios({c,load,settle,confirmed,results}) {
 const source='开头\n\n~~删除 *斜体*~~ 和 \\~普通\\~ ~单个~\n\n- [ ] 写文档\n- [x] 已完成\n\n[链接](https://example.com/a_(b))\n<https://example.com>\n<https://example.com/a_~~b~~_*c*>\n<person@example.com>\n<javascript:alert(1)>\n\n结尾';
 await load(source);
 await c.evaluate('editor.input.setSelection(0);editor.focus()');await c.evaluate('editor.livePreview.settled()');
 await waitForEvaluation(c,`document.querySelectorAll('.jot-live-preview-task-checkbox').length===2 && !!document.querySelector('.jot-live-preview-strikethrough')`,15000);
 const rendered=await c.evaluate(`(()=>({lines:[...view.contentDOM.querySelectorAll('.cm-line')].map(x=>x.textContent),strike:[...view.contentDOM.querySelectorAll('.jot-live-preview-strikethrough')].map(x=>x.textContent).join(''),boxes:[...view.contentDOM.querySelectorAll('.jot-live-preview-task-checkbox')].map(x=>({checked:x.checked,disabled:x.disabled})),source:editor.value}))()`);
 assert(rendered.strike.includes('删除')&&rendered.strike.includes('斜体'));
 assert(rendered.lines.some(x=>x.includes('~普通~')&&!x.includes('\\~')),'escaped tildes display literally without the escape marker');
 assert(rendered.lines.some(x=>x.includes('~单个~')),'single tildes are ordinary text');
 assert(rendered.lines.some(x=>x.includes('https://example.com/a_~~b~~_*c*')),'autolink address delimiters remain literal in live preview');
 assert.deepEqual(rendered.boxes,[{checked:false,disabled:false},{checked:true,disabled:false}]);
 assert.equal(rendered.source,source);
 const click=async (selector,index=0)=>{const p=await c.evaluate(`(()=>{const n=document.querySelectorAll(${JSON.stringify(selector)})[${index}],r=n.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p})};
 await click('.jot-live-preview-task-checkbox');
 const immediate=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('写文档'));return{box:!!n?.querySelector('.jot-live-preview-task-checkbox'),line:n?.textContent}})()`);
 assert(immediate.box&&!immediate.line?.includes('[x]'),'toggling does not briefly expose the task marker source');
 await confirmed();await c.evaluate('editor.livePreview.settled()');
 const checked=source.replace('- [ ] 写文档','- [x] 写文档');
 assert.equal(await c.evaluate('editor.value'),checked,'checkbox toggles the single shared Markdown source');
 const mac=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`),mod=mac?4:2;
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:mod});
 await confirmed();await c.evaluate('editor.livePreview.settled()');
 assert.equal(await c.evaluate('editor.value'),source,'one undo restores the original task marker');
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:mod|8});
 await confirmed();assert.equal(await c.evaluate('editor.value'),checked,'redo reapplies the task marker');
 await c.evaluate('editor.setReadOnly(true)');await settle();
 assert(await c.evaluate(`document.querySelector('.jot-live-preview-task-checkbox')?.disabled===true`),'read-only state is exposed on the checkbox');
 await click('.jot-live-preview-task-checkbox');await settle();
 assert.equal(await c.evaluate('editor.value'),checked,'read-only task cannot mutate the document');
 await c.evaluate('editor.setReadOnly(false)');await settle();
 await c.evaluate(`editor.input.setSelection(editor.value.indexOf('写文档'));editor.focus()`);await settle();
 assert(await c.evaluate(`!!document.querySelector('.jot-live-preview-active-line .jot-live-preview-task-checkbox')`),'active task remains a coherent list while editing');
 await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
 const composition=await c.evaluate(`(()=>({source:editor.value,confirmed:editor.confirmedValue,head:view.state.selection.main.head,lines:[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>({text:n.textContent,className:n.className,html:n.innerHTML})),html:view.contentDOM.outerHTML}))()`);
 results.push({case:'task-composition-diagnostic',composition});
 assert(composition.lines.some(n=>n.className.includes('jot-live-preview-active-line')&&n.html.includes('jot-live-preview-task-checkbox')),'IME composition keeps the checkbox visible');
 await c.command('Input.insertText',{text:'是'});await confirmed();
 assert.equal(await c.evaluate('editor.value'),checked.replace('写文档','是写文档'));
 await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');
 const preview=await c.evaluate(`(()=>({text:document.querySelector('.jot-markdown-editor__surface').textContent,boxes:[...document.querySelectorAll('.jot-markdown-editor__surface .jot-task-checkbox')].map(x=>({checked:x.checked,disabled:x.disabled})),links:[...document.querySelectorAll('.jot-markdown-editor__surface a')].map(x=>({text:x.textContent,href:x.getAttribute('href')})),strike:document.querySelector('.jot-markdown-editor__surface del')?.textContent}))()`);
 assert(preview.text.includes('~普通~')&&!preview.text.includes('\\~普通'));
 assert.deepEqual(preview.boxes,[{checked:true,disabled:true},{checked:true,disabled:true}]);
 assert(preview.strike?.includes('删除')&&preview.strike?.includes('斜体'));
 assert(preview.links.some(x=>x.href==='https://example.com/a_(b)'));
 assert(preview.links.some(x=>x.href==='https://example.com'));
 assert(preview.links.some(x=>x.href==='https://example.com/a_~~b~~_*c*'&&x.text==='https://example.com/a_~~b~~_*c*'),'preview preserves autolink address delimiters');
 assert(preview.links.some(x=>x.href==='mailto:person@example.com'));
 assert(preview.links.some(x=>x.text==='javascript:alert(1)'&&x.href===null),'unsafe autolink schemes never get an executable href');
 results.push({case:'inline-task-source-preview-ime-undo',rendered,preview});
 await c.evaluate(`editor.setMode('live-preview')`);await settle();

 const moving='anchor\n\n- [ ] first\n- [ ] second\nend';
 await load(moving);await c.evaluate('editor.input.setSelection(0);editor.focus()');await c.evaluate('editor.livePreview.settled()');
 await waitForEvaluation(c,`document.querySelectorAll('.jot-live-preview-task-checkbox').length===2`,10000);
 await c.evaluate(`(()=>{const original=worker.postMessage,own=Object.hasOwn(worker,'postMessage'),pending=[];worker.postMessage=function(...args){pending.push(args)};window.releaseTaskGate=()=>{if(own)worker.postMessage=original;else delete worker.postMessage;const count=pending.length;for(const args of pending)original.apply(worker,args);pending.length=0;delete window.releaseTaskGate;return count}})()`);
 try {
  await c.command('Input.insertText',{text:'新😀'});
  assert.notEqual(await c.evaluate('editor.value'),await c.evaluate('editor.confirmedValue'),'real Worker confirmation is delayed');
  await click('.jot-live-preview-task-checkbox',1);
  const movingExpected='新😀'+moving.replace('- [ ] second','- [x] second');
  assert.equal(await c.evaluate('editor.value'),movingExpected,'mapped widget toggles the correct task after an unconfirmed offset shift');
  const pending=await c.evaluate(`(()=>{const boxes=[...view.contentDOM.querySelectorAll('.jot-live-preview-task-checkbox')];return boxes.map(x=>({checked:x.checked,line:x.closest('.cm-line')?.textContent}))})()`);
  assert.equal(pending[1]?.checked,true,'the changed task remains checked while Worker confirmation is delayed');
  assert(!pending[1]?.line.includes('[x]'),'the raw task marker does not flash during a delayed confirmation');
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:mod});
  assert.equal(await c.evaluate('editor.value'),'新😀'+moving,'undo changes only the task while Worker is delayed');
  assert.equal(await c.evaluate(`document.querySelectorAll('.jot-live-preview-task-checkbox')[1]?.checked`),false,'undo updates the visible checkbox immediately');
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:mod|8});
  assert.equal(await c.evaluate('editor.value'),movingExpected,'redo restores the task while Worker is delayed');
  assert.equal(await c.evaluate(`document.querySelectorAll('.jot-live-preview-task-checkbox')[1]?.checked`),true,'redo updates the visible checkbox immediately');
  assert((await c.evaluate('releaseTaskGate()'))>0,'the test held actual Worker messages');
  await confirmed();await c.evaluate('editor.livePreview.settled()');
  assert.equal(await c.evaluate('editor.confirmedValue'),movingExpected);
  results.push({case:'task-delayed-worker-offset-and-toggle',pending});
 } finally {await c.evaluate(`typeof releaseTaskGate==='function' && releaseTaskGate()`).catch(()=>{})}

 const longTasks='top\n\n'+Array.from({length:120},(_,i)=>`- [ ] 项目 ${i+1}`).join('\n')+'\n\nend';
 await load(longTasks);await c.evaluate('editor.input.setSelection(0);editor.focus()');await c.evaluate('editor.livePreview.settled()');
 const pane=await c.evaluate(`(()=>{const r=view.scrollDOM.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
 await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...pane,deltaX:0,deltaY:1200});await settle();
 await c.evaluate('editor.livePreview.settled()');
 const scrolled=await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect(),boxes=[...view.contentDOM.querySelectorAll('.jot-live-preview-task-checkbox')],i=boxes.findIndex(n=>{const r=n.getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom});if(i<0)throw Error('no visible task');return{index:i,scroll:view.scrollDOM.scrollTop,from:view.posAtDOM(boxes[i],0)}})()`);
 assert(scrolled.scroll>300,'the task was selected in a scrolled viewport');
 await click('.jot-live-preview-task-checkbox',scrolled.index);
 const scrolledAfter=await c.evaluate(`({scroll:view.scrollDOM.scrollTop,marker:view.state.doc.sliceString(${scrolled.from},${scrolled.from+3})})`);
 assert.equal(scrolledAfter.marker,'[x]','the visible task is toggled after scrolling');
 assert(Math.abs(scrolledAfter.scroll-scrolled.scroll)<2,'clicking a task does not scroll back to the earlier caret');
 await confirmed();results.push({case:'task-scroll-position',before:scrolled,after:scrolledAfter});

 const tilde='start\n\n~~*斜体*~~ \\~~未闭合~~ 与 ~单个~\n\nTAIL';
 await load(tilde);await c.evaluate('editor.input.setSelection(0);editor.focus()');await c.evaluate('editor.livePreview.settled()');
 await waitForEvaluation(c,`!!document.querySelector('.jot-live-preview-strikethrough .jot-live-preview-emphasis')`,10000);
 const tildeBefore=await c.evaluate(`(()=>{const n=document.querySelector('.jot-live-preview-strikethrough'),line=n.closest('.cm-line'),tail=[...view.contentDOM.querySelectorAll('.cm-line')].find(x=>x.textContent==='TAIL'),r=n.getBoundingClientRect();return{text:line.textContent,html:line.innerHTML,tail:tail.getBoundingClientRect().top,x:r.left+r.width/2,y:r.top+r.height/2,scroll:view.scrollDOM.scrollTop}})()`);
 assert(tildeBefore.text.includes('~~未闭合~~')&&tildeBefore.text.includes('~单个~'),'escaped and single tildes stay literal');
 for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:tildeBefore.x,y:tildeBefore.y});
 await settle();
 const tildeActive=await c.evaluate(`(()=>{const n=document.querySelector('.jot-live-preview-active-line'),tail=[...view.contentDOM.querySelectorAll('.cm-line')].find(x=>x.textContent==='TAIL'),italic=n?.querySelector('.jot-live-preview-source-emphasis'),strike=n?.querySelector('.jot-live-preview-source-strikethrough');return{source:editor.value,head:view.state.selection.main.head,text:n?.textContent,italic:italic&&getComputedStyle(italic).fontStyle,strike:strike&&getComputedStyle(strike).textDecorationLine,tail:tail?.getBoundingClientRect().top,scroll:view.scrollDOM.scrollTop}})()`);
 assert.equal(tildeActive.source,tilde,'entering nested formatting does not mutate the source');
 assert(tildeActive.text.includes('~~*斜体*~~')&&tildeActive.italic==='italic'&&tildeActive.strike.includes('line-through'),'editing retains both nested styles and exposes the exact markers');
 assert(Math.abs(tildeActive.tail-tildeBefore.tail)<1&&Math.abs(tildeActive.scroll-tildeBefore.scroll)<1,'activating a short nested span does not move the next block');
 await c.command('Input.insertText',{text:'字'});await confirmed();
 assert.equal(await c.evaluate('editor.value'),tilde.slice(0,tildeActive.head)+'字'+tilde.slice(tildeActive.head),'inserting inside nested syntax changes exactly the caret position');
 results.push({case:'tilde-nesting-escape-real-input',before:tildeBefore,active:tildeActive});

 const nested='首\n\n> - [ ] 引用任务\n  - [ ] 缩进任务\n\n末';
 await load(nested);await c.evaluate('editor.input.setSelection(0);editor.focus()');await c.evaluate('editor.livePreview.settled()');
 await waitForEvaluation(c,`document.querySelectorAll('.jot-live-preview-task-checkbox').length===2`,10000);
 await click('.jot-live-preview-task-checkbox',0);await confirmed();
 assert.equal(await c.evaluate('editor.value'),nested.replace('> - [ ]','> - [x]'),'quoted task toggles its own confirmed marker');
 await c.evaluate('editor.livePreview.settled()');await click('.jot-live-preview-task-checkbox',1);await confirmed();
 assert.equal(await c.evaluate('editor.value'),nested.replace('> - [ ]','> - [x]').replace('  - [ ]','  - [x]'),'indented task toggles without changing its quote or indentation');
 results.push({case:'task-quote-and-indent'});

 const demote='before\n\n- [ ] task\n\nend',prefix=demote.indexOf('- ');
 await load(demote);await c.evaluate('editor.input.setSelection(0);editor.focus()');await c.evaluate('editor.livePreview.settled()');
 await c.evaluate(`editor.input.setSelection(${prefix},${prefix+2});editor.focus()`);await settle();
 await c.evaluate(`(()=>{const original=worker.postMessage,own=Object.hasOwn(worker,'postMessage'),pending=[];worker.postMessage=function(...args){pending.push(args)};window.releaseDemoteGate=()=>{if(own)worker.postMessage=original;else delete worker.postMessage;for(const args of pending)original.apply(worker,args);delete window.releaseDemoteGate}})()`);
 try {
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  const state=await c.evaluate(`({source:editor.value,confirmed:editor.confirmedValue,boxes:document.querySelectorAll('.jot-live-preview-task-checkbox').length})`);
  assert.equal(state.source,demote.replace('- [ ]','[ ]'),'deleting the list prefix leaves plain source');
  assert.notEqual(state.source,state.confirmed,'the old semantic projection is still unconfirmed');
  assert.equal(state.boxes,0,'removing the list prefix immediately retires its checkbox');
  await c.evaluate('releaseDemoteGate()');await confirmed();
  results.push({case:'task-prefix-removal-delayed',state});
 } finally {await c.evaluate(`typeof releaseDemoteGate==='function' && releaseDemoteGate()`).catch(()=>{})}

 const compact='before\n\n- [ ] task\n\nend',boundary=compact.indexOf('[ ]')+3;
 await load(compact);await c.evaluate('editor.input.setSelection(0);editor.focus()');await c.evaluate('editor.livePreview.settled()');
 await c.evaluate(`editor.input.setSelection(${boundary});editor.focus()`);await settle();
 const compactBefore=await c.evaluate(`({head:view.state.selection.main.head,anchor:view.state.selection.main.anchor,focused:view.hasFocus,dom:view.contentDOM.outerHTML})`);
 await c.evaluate(`(()=>{const original=worker.postMessage,own=Object.hasOwn(worker,'postMessage'),pending=[];worker.postMessage=function(...args){pending.push(args)};window.releaseCompactGate=()=>{if(own)worker.postMessage=original;else delete worker.postMessage;for(const args of pending)original.apply(worker,args);delete window.releaseCompactGate}})()`);
 try {
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
  const state=await c.evaluate(`({source:editor.value,confirmed:editor.confirmedValue,boxes:document.querySelectorAll('.jot-live-preview-task-checkbox').length,head:view.state.selection.main.head})`);
  results.push({case:'task-separator-diagnostic',before:compactBefore,state});
  assert.equal(state.source,compact.replace('[ ] task','[ ]task'),'Delete after the checkbox deletes the following separator');
  assert.notEqual(state.source,state.confirmed,'the boundary edit remains unconfirmed');
  assert.equal(state.boxes,0,'invalid task syntax immediately retires its checkbox');
  await c.evaluate('releaseCompactGate()');await confirmed();
  results.push({case:'task-separator-removal-delayed',state});
 } finally {await c.evaluate(`typeof releaseCompactGate==='function' && releaseCompactGate()`).catch(()=>{})}
}
