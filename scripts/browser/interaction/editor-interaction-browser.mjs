// Integration harness mounts the exported component; the Demo has no test hooks.
import assert from 'node:assert/strict';
import { runNavigationScenarios } from './scenarios/editor-navigation-scenarios.mjs';
import { runKeyboardScenarios } from './scenarios/editor-keyboard-scenarios.mjs';
import { runShortcutScenarios } from './scenarios/editor-shortcut-scenarios.mjs';
import { runHistoryScenarios } from './scenarios/editor-history-scenarios.mjs';
import { runTreeEditScenarios } from './scenarios/editor-tree-edit-scenarios.mjs';
import { runImeShellScenarios } from './scenarios/editor-ime-shell-scenarios.mjs';
import { runListKeyboardScenarios } from './scenarios/editor-list-keyboard-scenarios.mjs';
import { runTableDeleteScenarios } from './scenarios/editor-table-delete-scenarios.mjs';
import { runThemeScenarios } from './scenarios/editor-theme-scenarios.mjs';
import { runPaddingGeometryScenarios } from './scenarios/editor-padding-geometry-scenarios.mjs';
import { runEmptyBlockScenarios } from './scenarios/editor-empty-block-scenarios.mjs';
import { runInlineTaskScenarios } from './scenarios/editor-inline-task-scenarios.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { findChrome, waitForHttp, connectCdp, waitForEvaluation, stopProcess } from '../support/browser-test-utils.mjs';
const profile=mkdtempSync(resolve(tmpdir(),'jot-interaction-'));
const port=Number(process.env.JOT_INTERACTION_PORT??4182);
const debugPort=Number(process.env.JOT_INTERACTION_DEBUG_PORT??9335);
const inputVisualOnly=Boolean(process.env.JOT_INPUT_VISUAL_ONLY);
const tableDeleteOnly=Boolean(process.env.JOT_TABLE_DELETE_ONLY);
const listEditOnly=Boolean(process.env.JOT_LIST_EDIT_ONLY);
const themeOnly=Boolean(process.env.JOT_THEME_ONLY);
const emptyOnly=Boolean(process.env.JOT_EMPTY_ONLY);
const inlineTaskOnly=Boolean(process.env.JOT_INLINE_TASK_ONLY);
const shortcutOnly=Boolean(process.env.JOT_SHORTCUT_ONLY);
const specialOnly=inputVisualOnly||tableDeleteOnly||listEditOnly||themeOnly||emptyOnly||inlineTaskOnly||shortcutOnly;
const fullRun=!specialOnly&&!process.env.JOT_TREE_EDIT_ONLY&&!process.env.JOT_ACTIVATION_ONLY&&!process.env.JOT_KEYBOARD_ONLY&&!process.env.JOT_NAVIGATION_ONLY;
const output=resolve(shortcutOnly?'dist/shortcut-browser-report':inputVisualOnly?'dist/input-visual-browser-report':tableDeleteOnly?'dist/table-delete-browser-report':listEditOnly?'dist/list-edit-browser-report':themeOnly?'dist/theme-browser-report':emptyOnly?'dist/empty-block-browser-report':inlineTaskOnly?'dist/inline-task-browser-report':process.env.JOT_TREE_EDIT_ONLY?'dist/tree-edit-browser-report':(process.env.JOT_KEYBOARD_ONLY||process.env.JOT_NAVIGATION_ONLY)?'dist/keyboard-browser-report':'dist/interaction-browser-report'); mkdirSync(output,{recursive:true});
let server,chrome,c,imageServer;
const results=[];
try {
 let releaseImage;
 const imageReady=new Promise(resolve=>{releaseImage=resolve});
 imageServer=createServer(async(_req,res)=>{
  await imageReady;
  if(res.destroyed)return;
  res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'max-age=3600'});
  res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#a7c5d5"/></svg>');
 });
 await new Promise((resolve,reject)=>{imageServer.once('error',reject);imageServer.listen(port+1,'127.0.0.1',resolve)});
 server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port)],{stdio:'ignore'});
 await waitForHttp(`http://127.0.0.1:${port}/`,15000);
 chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
 await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
 const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
 c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.includes(`:${port}/`)).webSocketDebuggerUrl);
 await c.command('Runtime.enable');
 await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
 await waitForEvaluation(c,`document.readyState==='complete' && document.title==='Jot native component integration fixture'`,15000);
 await c.evaluate(`(async()=>{
  const {MarkdownEditor,createHeadingFoldPlugin}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
  const root=document.createElement('div');root.id='integration';root.style.cssText='height:700px;width:900px;margin:10px';document.body.replaceChildren(root);
  window.worker=new Worker('/src/worker.ts',{type:'module'});
  window.errors=[];
  window.editor=new MarkdownEditor({root,mode:'live-preview',plugins:[createHeadingFoldPlugin({enabled:false})],session:{endpoint:worker,documentId:'integration',generation:1,source:'ready',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>errors.push(String(e))});
  await editor.open();window.view=editor.input.view;
 })()`);
 if (!specialOnly && !process.env.JOT_TREE_EDIT_ONLY && !process.env.JOT_KEYBOARD_ONLY && !process.env.JOT_NAVIGATION_ONLY) {
 // Real pointer activation: include inline formula reserves, trailing empty
 // code rows, wrapped paragraphs and EOF. Check all following physical boxes.
 for (const [name, text, selector] of [
  ['paragraph', 'intro\n\nordinary paragraph\n\nend', '.cm-line:nth-child(3)'],
  ['heading-1', 'intro\n\n# Compact title\n\nend', '.cm-line:nth-child(3)'],
  ['heading-2', 'intro\n\n## Compact subtitle\n\nend', '.cm-line:nth-child(3)'],
  ['wrapped', 'intro\n\n'+ '普通文本需要保持折行和高度。'.repeat(16)+'\n\nend', '.cm-line:nth-child(3)'],
  ['paragraph-eof', 'intro\n\nordinary paragraph', '.cm-line:nth-child(3)'],
  ['mixed-narrow', 'intro\n\n文字 $x$ 继续。\n\nend', '.cm-line:nth-child(3)'],
  ['mixed', 'intro\n\n在这里编辑 **加粗**、*斜体*、`行内代码` 和 $E = mc^2$。\n\nend', '.cm-line:nth-child(3)'],
  ['quote-nested', 'intro\n\n> > nested quotation\n\nend', '.jot-live-preview-block-quote'],
  ['quote', 'intro\n\n> quoted text\n> second line\n\nend', '.jot-live-preview-block-quote'],
  ['code-empty-tail', 'intro\n\n``` js begin\nconst a = 1;\n\n``` end\n\nend', '.jot-code-line'],
  ['code-eof', 'intro\n\n``` js begin\nconst a = 1;\n``` end', '.jot-code-line'],
  ['code', 'intro\n\n``` js begin\nconst a = 1;\nconst b = 2;\n``` end\n\nend', '.jot-code-line'],
 ]) {
  await c.evaluate(`document.querySelector('#integration').style.width=${JSON.stringify(name==='mixed-narrow'?'360px':'900px')}`);
  await load(text);await c.evaluate('editor.input.setSelection(0)');await settle();
  const before=await lineBoxes();
  await clickLine(selector);
  const after=await lineBoxes();
  if(name==='paragraph') assert.equal(after.lines[2].fontSize,14,'default body typography is compact');
  if(name.startsWith('heading-')) for(const state of [before,after]) {
   assert(Math.abs(state.lines[2].fontSize-(name==='heading-1'?24:20))<0.01,'heading uses compact editor-relative typography before and after activation');
  }
  assert(after.lines.some(n=>n.active&&n.text!=='intro'),name+': click must actually activate the target');
  assert.equal(await c.evaluate('editor.value'),text,'activation must preserve source');
  assert.equal(after.lines.length,before.lines.length,name+': physical line count');
  for(let i=0;i<before.lines.length;i++) {
   assert(Math.abs(after.lines[i].top-before.lines[i].top)<1,name+': activation must preserve each subsequent row position');
  }
  assert(Math.abs((after.lines.at(-1).top+after.lines.at(-1).height)-(before.lines.at(-1).top+before.lines.at(-1).height))<1,name+': complete block extent');
  if(name.startsWith('quote')) for(const state of [before,after]) {
   assert(state.lines.every(n=>!n.text.trimStart().startsWith('>')&&!n.marker.includes('>')),'quote syntax stays hidden in painted DOM and pseudo-elements');
  }
  if(name==='code-empty-tail') assert.deepEqual(after.lines.filter(n=>n.number).map(n=>n.number),['1','2'],'empty code tail has a numbered, editable line');
  results.push({case:'pointer-activation-'+name,before,after});
  await screenshot('activation-'+name);
  if(name==='mixed'||name==='mixed-narrow') {
   for(let cycle=0;cycle<3;cycle++) {
    await clickLine('.cm-line:first-child');await clickLine(selector);
    const repeated=await lineBoxes();
    assert(Math.abs(repeated.lines.at(-1).top-before.lines.at(-1).top)<1,'repeated activation must not accumulate reserved height');
   }
  }
  if(name==='code') {
   // The first ArrowUp reveals the editable opener. The next ArrowUp leaves
   // the block, while Down from the previous row enters content directly.
   await key('ArrowUp');await settle();
   assert.equal(await c.evaluate('view.state.selection.main.head'),text.indexOf('``` js begin')+'``` js begin'.length,'up enters opening fence');
   assert(await c.evaluate(`Array.from(view.contentDOM.querySelectorAll('.cm-line')).some(n=>n.textContent.includes('\`\`\` js begin')&&n.getBoundingClientRect().height>0)`),'opening fence is visible and has a physical line');
   await key('ArrowUp');await settle();
   assert.equal(await c.evaluate('view.state.selection.main.head'),text.indexOf('``` js begin')-1,'next up moves to the previous blank line');
   await key('ArrowDown');await settle();
   assert.equal(await c.evaluate('view.state.selection.main.head'),text.indexOf('const a'),'down enters editable code');
   // Clicking the bottom padding must choose content, not the protected closing fence.
   await click('.jot-live-preview-code-boundary.jot-live-preview-native-block--last');
   assert.equal(await c.evaluate('view.state.selection.main.head'),text.indexOf('const b')+'const b = 2;'.length,'padding click retains editable caret');
   await key('Enter');await confirmed();
   assert.deepEqual(await codeNumbers(),['1','2','3'],'Enter paints exactly one numbered empty code row');
   const entered=await lineBoxes();
   assert.equal(entered.lines.at(-1).top-after.lines.at(-1).top,20,'Enter adds one code row, no extra fence/paragraph gap');
   await c.command('Input.insertText',{text:'x'});await confirmed();
   assert(await c.evaluate(`editor.value.includes('const b = 2;\\nx\\n')`),'new empty row accepts text');
   await key('Backspace');await confirmed();await key('Backspace');await confirmed();
   assert.equal(await c.evaluate('editor.value'),text,'Backspace joins code rows without deleting the closing fence');
   assert.deepEqual(await codeNumbers(),['1','2']);
   await key('ArrowDown');await settle();
   assert.equal(await c.evaluate('view.state.selection.main.head'),text.indexOf('``` end')+'``` end\n'.length,'down exits code past hidden closing fence');
   await clickLine('.cm-line:first-child');
   const blurred=await lineBoxes();
   assert.equal(blurred.lines.at(-1).top,before.lines.at(-1).top,'editing and blur restore full block geometry');
   results.push({case:'code-edit-cycle',entered,blurred});
  }
 }
 if (!process.env.JOT_ACTIVATION_ONLY) {
 const source=Array.from({length:1500},(_,i)=>`paragraph ${String(i).padStart(4,'0')} content for cursor`).join('\n\n');
 await load(source);
 await c.evaluate(`editor.input.setSelection(editor.input.value.indexOf('paragraph 0200')+10);editor.focus()`);
 await settle();
 await c.command('Input.insertText',{text:'X'});await confirmed();
 assert(await c.evaluate(`editor.value.includes('paragraph X0200')`),'initial edit must target original caret');
 const before=await c.evaluate(`({head:view.state.selection.main.head,top:view.scrollDOM.scrollTop})`);
 await c.evaluate(`window.track=[...document.querySelectorAll('.jot-direct-scrollbar')].find(n=>n.getBoundingClientRect().height>0)`);
 const track=await c.evaluate(`(()=>{const r=track.getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-2}})()`);
 await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...track});
 await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...track});await settle();
 const scrolled=await c.evaluate(`({head:view.state.selection.main.head,top:view.scrollDOM.scrollTop,focus:document.activeElement.className})`);
 await key('ArrowDown');await settle();
 const after=await c.evaluate(`(()=>{const r=view.coordsAtPos(view.state.selection.main.head),p=view.scrollDOM.getBoundingClientRect();return {head:view.state.selection.main.head,top:view.scrollDOM.scrollTop,caret:r&&{top:r.top,bottom:r.bottom,left:r.left},pane:{top:p.top,bottom:p.bottom}}})()`);
 results.push({case:'offscreen-caret',before,scrolled,after});console.log(JSON.stringify(results.at(-1)));
 assert.equal(scrolled.head,before.head,'scroll must preserve selection');
 assert(after.head>=before.head&&after.head-before.head<100,'arrow must move relative to original caret');
 assert(after.caret&&after.caret.top>=after.pane.top&&after.caret.bottom<=after.pane.bottom,'arrow must reveal caret box');
 await screenshot('caret-restored');
 // Every toolbar action is exercised through real mouse input and painted cells.
 await load('before\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n\nafter');
 await waitForEvaluation(c, `document.querySelectorAll('#integration .jot-table-grid-body .jot-table-cell').length===4`,10000);
 await click('#integration .jot-table-grid-body .jot-table-cell[data-jot-column-index="1"]');
 await click('[data-jot-table-command="table.clear-cell"]');
 await confirmed();
 assert((await c.evaluate('editor.value')).includes('| one |  |'),'clear selected cell');
 await click('[data-jot-table-command="table.insert-row-below"]');await confirmed();
 await c.command('Input.insertText',{text:'inserted-row'});await confirmed();
 assert(await c.evaluate(`document.querySelector('#integration .jot-table-grid-body').textContent.includes('inserted-row')`),'insert row selects an editable painted cell');
 await click('[data-jot-table-command="table.delete-row"]');await confirmed();
 assert(!(await c.evaluate('editor.value')).includes('inserted-row'),'delete inserted row');
 await click('[data-jot-table-command="table.insert-column-after"]');await confirmed();
 assert.equal(await c.evaluate(`document.querySelectorAll('#integration .jot-table-grid-header .jot-table-cell').length`),3,'insert column paints header');
 await c.command('Input.insertText',{text:'inserted-column'});await confirmed();
 assert(await c.evaluate(`document.querySelector('#integration .jot-table-grid-body').textContent.includes('inserted-column')`),'insert column retains cell input');
 await click('[data-jot-table-command="table.delete-column"]');await confirmed();
 assert.equal(await c.evaluate(`document.querySelectorAll('#integration .jot-table-grid-header .jot-table-cell').length`),2);
 assert(!(await c.evaluate('editor.value')).includes('inserted-column'));
 // Shift the table's source range while reusing its view, then operate again.
 await c.evaluate(`editor.input.replaceRange(0,0,'new prefix\\n\\n')`);await confirmed();
 await click('#integration .jot-table-grid-body .jot-table-cell');
 await click('[data-jot-table-command="table.clear-cell"]');await confirmed();
 assert(await c.evaluate(`!editor.value.includes('one') && editor.value.startsWith('new prefix') && document.querySelector('#integration .jot-table-grid-body .jot-table-cell').textContent===''`),'toolbar must use updated source range and current cell');
 await click('#integration .jot-table-grid-header .jot-table-cell');await settle();
 assert(await c.evaluate(`document.querySelector('[data-jot-table-command="table.delete-row"]').disabled`),'header deletion is unavailable');
 results.push({case:'table-toolbar',source:await c.evaluate('editor.value')});await screenshot('table-toolbar');
 await load('| A |\n| --- |\n| value |');
 await click('#integration .jot-table-grid-body .jot-table-cell');
 assert(await c.evaluate(`document.querySelector('[data-jot-table-command="table.delete-column"]').disabled`),'only column cannot be deleted');
 await click('[data-jot-table-command="table.delete-row"]');await confirmed();
 assert(await c.evaluate(`document.querySelectorAll('#integration .jot-table-grid-body .jot-table-cell').length===0&&document.querySelectorAll('#integration .jot-table-grid-header .jot-table-cell').length===1`),'deleting last data row preserves the header');

 // Native list markers and stable physical-line boxes while activating a row.
 await load('intro\n\n- first item\n- second item\n  - nested item\n\nend');
 await c.evaluate(`editor.input.setSelection(0)`);await settle();
 const listBefore=await listBoxes();
 await c.evaluate(`editor.input.setSelection(editor.value.indexOf('second item')+3)`);await settle();
 const listAfter=await listBoxes();
 assert(listBefore.length>=3&&listAfter.length>=3,'all lists painted');
 for(let i=0;i<listBefore.length;i++) {
  assert.equal(listBefore[i].marker,'"•"');assert.equal(listAfter[i].marker,'"•"');
  assert(!listAfter[i].text.trimStart().startsWith('-'),'active row hides syntax marker');
  assert(Math.abs(listBefore[i].height-listAfter[i].height)<1&&Math.abs(listBefore[i].top-listAfter[i].top)<1,'list activation preserves boxes');
 }
 results.push({case:'list-geometry',before:listBefore,after:listAfter});await screenshot('list-markers');
 await load('intro\n\n``` js begin\nconst a = 1;\nconst b = '+ '1'.repeat(300)+';\n``` end\n\nend');
 await c.evaluate('editor.input.setSelection(0)');await settle();
 const code=await c.evaluate(`Array.from(document.querySelectorAll('#integration .jot-code-line')).map(n=>({number:n.dataset.jotLineNumber,height:n.getBoundingClientRect().height,background:getComputedStyle(n).backgroundColor,text:n.textContent}))`);

 assert.deepEqual(code.map(n=>n.number),['1','2'],'code content has stable line numbers');
 assert(code.every(n=>n.height===20),'code line height matches PreText metrics');
 results.push({case:'code-lines',code});await screenshot('code-lines');
 await c.evaluate(`editor.input.setSelection(editor.value.indexOf('const b')+4)`);await settle();
 const activeCode=await c.evaluate(`Array.from(document.querySelectorAll('#integration .jot-code-line')).map(n=>({number:n.dataset.jotLineNumber,height:n.getBoundingClientRect().height}))`);
 assert.deepEqual(activeCode,code.map(({number,height})=>({number,height})),'code activation retains line geometry');
 await c.evaluate(`editor.setLayoutStyle({fontSize:18,metrics:{paragraphLineHeight:32,blankLineHeight:32,codeLineHeight:25}})`);await settle();
 assert.equal(await c.evaluate(`parseFloat(getComputedStyle(view.contentDOM).fontSize)`),18,'Live Preview inherits the configured editor font size');
 assert(await c.evaluate(`Array.from(document.querySelectorAll('#integration .jot-code-line')).every(n=>Math.abs(n.getBoundingClientRect().height-25)<1)`),'layout API updates painted code heights');
 await c.evaluate(`editor.setMode('preview')`);await settle();
 const previewCode=await c.evaluate(`Array.from(document.querySelectorAll('#integration .jot-source-line')).map(n=>({number:n.dataset.jotLineNumber,height:n.getBoundingClientRect().height}))`);
 assert.deepEqual(previewCode,[{number:'1',height:25},{number:'2',height:25}],'Preview uses the same numbered code geometry');
 await screenshot('code-preview');
 await c.evaluate(`editor.setLayoutStyle({fontSize:14,metrics:{paragraphLineHeight:22,blankLineHeight:22,codeLineHeight:20}})`);await settle();

 // Delay a real network image: test the reserved box before and after decoding.
 await c.evaluate(`editor.setMode('preview')`);
 await load(`before image\n\n![delayed](http://127.0.0.1:${port+1}/image.svg)\n\nafter image`);
 const reserved=await c.evaluate(`(()=>{const i=document.querySelector('#integration .jot-editor-surface img');return {complete:i.complete,height:i.getBoundingClientRect().height}})()`);
 assert.deepEqual(reserved,{complete:false,height:220},'unknown image reserves the shared fallback height');
 releaseImage();
 await waitForEvaluation(c,`document.querySelector('#integration img')?.naturalWidth===1200`,10000);await settle();
 const decoded=await c.evaluate(`(()=>{const i=document.querySelector('#integration img');return {height:i.getBoundingClientRect().height,aspect:i.dataset.jotImageAspectRatio}})()`);
 assert.equal(decoded.height,480);assert.equal(decoded.aspect,'1.5');
 results.push({case:'delayed-image',reserved,decoded});
 // Repeat viewport eviction/re-entry around decoded images in both hosts.
 const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#a7c5d5"/><text x="60" y="120" font-size="50">Image geometry</text></svg>');
 await c.evaluate(`editor.setMode('preview')`);
 await load(`before ![first](${svg}) between ![second](${svg}) after`);
 await waitForEvaluation(c,`document.querySelectorAll('#integration img').length===2&&[...document.querySelectorAll('#integration img')].every(i=>i.complete&&i.naturalWidth>0)`,10000);await settle();
 const mixedHeight=await c.evaluate(`document.querySelector('#integration .jot-editor-content > [data-jot-kind="paragraph"]').getBoundingClientRect().height`);
 await c.evaluate(`editor.setMode('pretext')`);await settle();
 const estimatedHeight=await c.evaluate(`document.querySelector('#integration .jot-pretext-block').getBoundingClientRect().height`);
 assert(Math.abs(mixedHeight-estimatedHeight)<2,`mixed image paragraph estimate ${estimatedHeight} must match painted ${mixedHeight}`);
 results.push({case:'mixed-images-height',mixedHeight,estimatedHeight});
 const images=Array.from({length:35},(_,i)=>`image ${i}\n\n![diagram](${svg})`).join('\n\n')+'\n\nimage document end';
 for(const mode of ['preview','live-preview']) {
  await c.evaluate(`editor.setMode(${JSON.stringify(mode)})`);await load(images);
  const pane=mode==='preview'?'.jot-markdown-editor__surface':'.cm-scroller';
  await c.evaluate(`window.imagePane=document.querySelector(${JSON.stringify(pane)});imagePane.scrollTop=0`);await settle();
  await waitForEvaluation(c,`[...imagePane.querySelectorAll('img')].some(i=>i.complete&&i.naturalWidth>0)`,10000);
  const frames=[];
  for(let i=0;i<3;i++) {
   await c.evaluate('imagePane.scrollTop=imagePane.scrollHeight');await settle();
   await c.evaluate('imagePane.scrollTop=0');await settle();
   frames.push(await c.evaluate(`new Promise(resolve=>{const frames=[];let count=0;function tick(){frames.push({top:imagePane.scrollTop,height:imagePane.scrollHeight,image:imagePane.querySelector('img')?.getBoundingClientRect().height});if(++count===12)resolve(frames);else requestAnimationFrame(tick);}tick();})`));
  }
  for(const cycle of frames) {
   assert(Math.max(...cycle.map(x=>x.top))-Math.min(...cycle.map(x=>x.top))<=1,'image re-entry must not oscillate scroll');
   assert(Math.max(...cycle.map(x=>x.height))-Math.min(...cycle.map(x=>x.height))<=1,'image re-entry geometry must settle');
   assert(cycle.every(x=>x.image>0&&x.image<=480),'image height is bounded by the shared metric');
  }
  results.push({case:'image-reentry',mode,frames});await screenshot('images-'+mode);
 }
 }
 }
 if (!specialOnly && !process.env.JOT_TREE_EDIT_ONLY && !process.env.JOT_ACTIVATION_ONLY && !process.env.JOT_NAVIGATION_ONLY) await runKeyboardScenarios({c,load,settle,confirmed,key,screenshot,results});
 if (shortcutOnly || fullRun) await runShortcutScenarios({c,load,confirmed,results});
 if (!specialOnly && !process.env.JOT_TREE_EDIT_ONLY && !process.env.JOT_ACTIVATION_ONLY) await runNavigationScenarios({c,load,settle,confirmed,key,screenshot,results});
 if (emptyOnly || (!specialOnly && !process.env.JOT_TREE_EDIT_ONLY && !process.env.JOT_ACTIVATION_ONLY)) await runEmptyBlockScenarios({c,load,settle,confirmed,results,screenshot});
 if (!specialOnly && (process.env.JOT_TREE_EDIT_ONLY || fullRun)) await runTreeEditScenarios({c,load,settle,confirmed,key,screenshot,results});
 if (inputVisualOnly || fullRun) await runImeShellScenarios({c,load,settle,confirmed,key,screenshot,results});
 if (tableDeleteOnly || fullRun) await runTableDeleteScenarios({c,load,settle,confirmed,key,screenshot,results});
 if (listEditOnly || fullRun) await runListKeyboardScenarios({c,load,settle,confirmed,key,screenshot,results});
 if (inlineTaskOnly || fullRun) await runInlineTaskScenarios({c,load,settle,confirmed,results});
 if (themeOnly || fullRun) {
  await runThemeScenarios({c,results});
  await runPaddingGeometryScenarios({c,results});
 }
 if (fullRun) await runHistoryScenarios({c,results});
 assert.deepEqual(await c.evaluate('errors'),[]);
 writeFileSync(resolve(output,'report.json'),JSON.stringify(results,null,2));
 console.log('Interaction browser checks passed');
} finally {c?.socket.close();await stopProcess(chrome);await stopProcess(server);imageServer?.closeAllConnections();if(imageServer)await new Promise(r=>imageServer.close(r));rmSync(profile,{recursive:true,force:true});writeFileSync(resolve(output,'report.json'),JSON.stringify(results,null,2));}
async function settle(){
 if(!process.env.JOT_FRAME_DIAG){await c.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,400))))`);return;}
 const watchdog=setTimeout(()=>{
  const probe=c.evaluate(`({frame:window.jotFrameProbe,visibility:document.visibilityState,focus:document.hasFocus(),length:window.editor?.value.length,analysis:window.editor?.session.adapter.analysis?.state,composing:window.view?.composing})`).catch(error=>({error:String(error)}));
  void Promise.race([probe,new Promise(resolve=>setTimeout(()=>resolve({error:'renderer did not answer within 2s'}),2000))]).then(value=>console.log(JSON.stringify({case:'frame-watchdog',value})));
 },5000);
 try { await c.evaluate(`new Promise(r=>{window.jotFrameProbe={stage:'first',at:performance.now()};requestAnimationFrame(()=>{jotFrameProbe.stage='second';requestAnimationFrame(()=>{jotFrameProbe.stage='timer';setTimeout(r,400)})})})`); }
 finally {clearTimeout(watchdog)}
}
async function load(source){await c.evaluate(`editor.setValue(${JSON.stringify(source)})`);await waitForEvaluation(c,`editor.session.adapter.analysis?.state==='complete'&&editor.session.adapter.text.text===editor.input.value`,20000);await settle();}
async function key(key){await c.command('Input.dispatchKeyEvent',{type:'keyDown',key,code:key});await c.command('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});}
async function screenshot(name){const r=await c.command('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,`${name}.png`),Buffer.from(r.data,'base64'));}

async function confirmed(){await waitForEvaluation(c,`editor.session.adapter.text.text===editor.input.value&&editor.session.adapter.analysis?.state==='complete'`,15000);await settle();}
async function click(selector){const p=await c.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await settle();}
async function listBoxes(){return c.evaluate(`Array.from(document.querySelectorAll('#integration .jot-live-preview-list-item')).map(n=>({marker:getComputedStyle(n,'::before').content,text:n.textContent,top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height}))`);}

async function lineBoxes(){return c.evaluate(`({head:view.state.selection.main.head,lines:[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>({text:n.textContent,fontSize:parseFloat(getComputedStyle(n).fontSize),top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height,active:n.classList.contains('jot-live-preview-active-line'),number:n.dataset.jotLineNumber,marker:getComputedStyle(n,'::before').content}))})`);}
async function codeNumbers(){return c.evaluate(`Array.from(document.querySelectorAll('#integration .jot-code-line'),n=>n.dataset.jotLineNumber)`);}

async function clickLine(selector){const p=await c.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const r=n.getBoundingClientRect();return {x:r.left+parseFloat(getComputedStyle(n).paddingLeft)+35,y:r.top+10}})()`);await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await settle();}
