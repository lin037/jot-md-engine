// Exercise the real Demo controls and CodeMirror input through Chrome/CDP.
// Reading the view from its DOM tile is only an assertion aid; interactions
// below use browser pointer, wheel and keyboard events.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_PAPER_PORT??4253),debugPort=Number(process.env.JOT_PAPER_DEBUG_PORT??9453);
const output=resolve(process.env.JOT_PAPER_REPORT??'dist/demo-paper-browser-report');
const profile=mkdtempSync(resolve(tmpdir(),'jot-paper-browser-'));
mkdirSync(output,{recursive:true});
let server,chrome,c; const evidence=[],errors=[];
try {
 server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
 await waitForHttp(`http://127.0.0.1:${port}/`,15000);
 chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/`],{stdio:'ignore'});
 await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
 const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
 c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.includes(`:${port}`)).webSocketDebuggerUrl);
 c.socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text)});
 await c.command('Runtime.enable');
 await c.command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await waitForEvaluation(c,`document.querySelector('#mode')?.disabled===false`,30000);
 await settle();
 assert.equal(await c.evaluate(`document.querySelector('#mode').value`),'live-preview','Demo defaults to live preview');
 assert.equal(await c.evaluate(`document.querySelector('#editor-root').dataset.jotEditorMode`),'live-preview','the selected default is the actual editor mode');
 assert.equal(await c.evaluate(`document.querySelector('#font').value`),'sans');
 assert.match(await c.evaluate(`getComputedStyle(document.querySelector('.cm-content')).fontFamily`),/system-ui.*PingFang/);
 const headings=await c.evaluate(`[...document.querySelectorAll('.cm-line[data-jot-heading-level]')].slice(0,2).map(line=>parseFloat(getComputedStyle(line).fontSize))`);
 assert.deepEqual(headings,[28,22],'default H1 and H2 follow the Demo type scale');
 const initialSource=await source();
 assert(initialSource.includes('![布局示意图](./pretext-layout.svg)'),'fixture contains a real image');
 const mac=await c.evaluate('/Mac|iPhone|iPad/u.test(navigator.platform)');
 const shortcutLabel=(name)=>c.evaluate(`document.querySelector('#shortcuts input[name="'+${JSON.stringify(name)}+'"]').value`);
 await click('#open-shortcuts');
 assert.equal(await shortcutLabel('table.delete-column'),
   mac?'Command-Option-Shift-Delete（⌫）':'Ctrl-Alt-Shift-Backspace');
 assert.equal(await shortcutLabel('table.clear-cell'),mac?'Option-Shift-Delete（⌫）':'Alt-Shift-Backspace');
 await c.evaluate("document.querySelector('#shortcuts form').requestSubmit()");
 assert.equal(await c.evaluate("document.querySelector('#shortcuts [role=alert]')?.textContent"),'已保存');
 assert.equal(await shortcutLabel('table.clear-cell'),mac?'Option-Shift-Delete（⌫）':'Alt-Shift-Backspace');
 await c.evaluate(`(() => {
   const search = document.querySelector('#shortcut-search');
   search.value = 'command.palette';
   search.dispatchEvent(new Event('input', { bubbles: true }));
 })()`);
 assert.equal(await c.evaluate("document.querySelectorAll('#shortcuts label:not([hidden])').length"),1);
 await c.evaluate(`document.querySelector('#shortcuts input[name="command.palette"]').value='Ctrl-Shift-Y';
   document.querySelector('#shortcuts form').requestSubmit();true`);
 await waitForEvaluation(c,"document.querySelector('#shortcut-storage-status').textContent.includes('已保存到此浏览器')",5000);
 await c.evaluate("window.workbenchBeforeReload = true");
 await c.command('Page.reload');
 await waitForEvaluation(c,"!window.workbenchBeforeReload && document.querySelector('#open-shortcuts')?.disabled===false",30000);
 await click('#open-shortcuts');
 assert.equal(await shortcutLabel('command.palette'), mac?'Control-Shift-y':'Ctrl-Shift-y');
 await click('#shortcut-dialog .panel-header button');
 await waitForEvaluation(c,"document.activeElement.id==='open-shortcuts' && !document.querySelector('#shortcut-dialog').open",5000);
 await c.evaluate("document.querySelector('.cm-content').focus()");
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Y',code:'KeyY',windowsVirtualKeyCode:89,modifiers:10});
 await waitForEvaluation(c,`!document.querySelector('.jot-command-overlay').hidden`,5000);
 await c.evaluate("document.querySelector('.jot-command-overlay button').click()");
 await click('#open-shortcuts');
 await c.evaluate(`document.querySelector('#shortcuts input[name="table.clear-cell"]').value =
   document.querySelector('#shortcuts input[name="table.delete-column"]').value;
   document.querySelector('#shortcuts form').requestSubmit();true`);
 assert.match(await c.evaluate("document.querySelector('#shortcuts [role=alert]').textContent"),/快捷键冲突/);
 await click('#shortcuts button[type="button"]');
 assert.equal(await c.evaluate(`localStorage.getItem('jot-demo.shortcuts.'+(${mac}?'mac':'other'))`),null);
 assert(await c.evaluate(`(()=>{
   const dialog=document.querySelector('#shortcut-dialog');
   return dialog.scrollWidth<=dialog.clientWidth+1;
 })()`),'shortcut dialog fits without horizontal scrolling');
 const pressPalette=async(key,modifiers,shortcut)=>{
   await c.evaluate("document.querySelector('.cm-content').focus()");
   for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key,code:'Key'+key,windowsVirtualKeyCode:key.charCodeAt(0),modifiers});
   await waitForEvaluation(c,`!document.querySelector('.jot-command-overlay').hidden`,5000);
   assert.equal(await c.evaluate(`document.querySelector('[data-jot-command="table.delete-column"] kbd').textContent`),shortcut);
 };
 await choose('#shortcut-platform',1);
 assert.equal(await shortcutLabel('format.heading-2'),'Ctrl-Alt-2');
 await c.evaluate(`document.querySelector('#shortcuts input[name="command.palette"]').value='Mod-Shift-Y';
   document.querySelector('#shortcuts input[name="toolbar.open-table"]').value='F8';
   document.querySelector('#shortcuts form').requestSubmit();true`);
 assert.equal(await shortcutLabel('command.palette'),'Ctrl-Shift-y');
 await click('#shortcut-dialog .panel-header button');
 await pressPalette('Y',10,'Ctrl-Alt-Shift-Backspace');
 await c.evaluate(`document.querySelector('[data-jot-command="shortcut.settings"]').click()`);
 await waitForEvaluation(c,`document.querySelector('#shortcut-dialog').open`,5000);
 await choose('#shortcut-platform',0);
 assert.equal(await shortcutLabel('command.palette'),'Control-Shift-p');
 assert.equal(await shortcutLabel('format.heading-2'),'Control-Shift-2');
 await click('#shortcut-dialog .panel-header button');
 await pressPalette('P',10,'Command-Option-Shift-Delete（⌫）');
 await c.evaluate("document.querySelector('.jot-command-overlay button').click()");
 await click('#open-shortcuts');
 await choose('#shortcut-platform',1);
 assert.equal(await shortcutLabel('command.palette'),'Ctrl-Shift-y','Windows custom settings survive switching profiles');
 await c.evaluate("window.workbenchBeforeReload = true");
 await c.command('Page.reload');
 await waitForEvaluation(c,"!window.workbenchBeforeReload && document.querySelector('#open-shortcuts')?.disabled===false",30000);
 await click('#open-shortcuts');
 assert.equal(await c.evaluate(`document.querySelector('#shortcut-platform').value`),'windows');
 assert.equal(await shortcutLabel('command.palette'),'Ctrl-Shift-y');
 assert.equal(await shortcutLabel('toolbar.open-table'),'F8','unassigned toolbar command survives reload');
 await click('#shortcut-dialog .panel-header button');
 await c.evaluate("document.querySelector('.cm-content').focus()");
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'F8',code:'F8',windowsVirtualKeyCode:119});
 assert(await c.evaluate(`!!document.querySelector('.jot-editor-toolbar__picker--table:popover-open')`),'saved toolbar shortcut opens the table picker after reload');
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await click('#open-shortcuts');
 await click('#shortcuts button[type="button"]');
 await screenshot('workbench-shortcuts');
 await click('#shortcut-dialog .panel-header button');
 evidence.push({case:'shortcut-dialog-save-reload-conflict-reset'});

 await click('#open-style');
 await click('#css-example');
 const headingColor=()=>c.evaluate(`getComputedStyle(document.querySelector('#editor-root .jot-md-heading')).color`);
 assert.equal(await headingColor(),'rgb(16, 138, 118)','CSS applied to editor headings');
 await c.evaluate(`document.querySelector('#css-declarations').value='height: 0';
   document.querySelector('#css-declarations').dispatchEvent(new Event('input'));true`);
 assert.equal(await c.evaluate("document.querySelector('#css-declarations').getAttribute('aria-invalid')"),'true');
 assert.equal(await headingColor(),'rgb(16, 138, 118)','invalid geometry preserves last valid rule');
 await click('#css-example');
 await settle();
 assert(await c.evaluate(`(()=>{
   const track=[...document.querySelectorAll('.jot-direct-scrollbar')].find(element=>element.getBoundingClientRect().width>0);
   return !track || track.getBoundingClientRect().right<document.querySelector('#inspector').getBoundingClientRect().left;
 })()`),'editor scrollbar stays outside the CSS inspector');
 await screenshot('workbench-style');
 await click('#css-reset');
 assert.notEqual(await headingColor(),'rgb(16, 138, 118)','reset removes the component override');
 await click('#close-inspector');
 assert.equal(await source(),initialSource);
 evidence.push({case:'scoped-css-preview-rejects-geometry'});

 await click('#open-performance');
 await c.command('Emulation.setDeviceMetricsOverride',{width:1837,height:1014,deviceScaleFactor:1,mobile:false});
 await settle();
 assert.equal(await c.evaluate(`document.querySelector('#metric-parse').textContent`),'—','opening a document alone has no post-edit parse duration');
 await screenshot('workspace-wide');
 await click('#load-large');
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认' &&
   document.querySelector('.cm-content').cmTile.root.view.state.doc.length>400000 &&
   /ms$/.test(document.querySelector('#metric-confirm').textContent) &&
   /ms$/.test(document.querySelector('#metric-parse').textContent)`,90000);
 const runtime=await c.evaluate(`(()=>{
   const [mounted,total]=document.querySelector('#metric-rows').textContent.replaceAll(',','').split(' / ').map(Number);
   return {mounted,total,log:document.querySelectorAll('#runtime-log li').length,heap:document.querySelector('#metric-heap').textContent};
 })()`);
 assert(runtime.mounted>0 && runtime.mounted<350 && runtime.total>5000 && runtime.log>0 && runtime.log<=12,JSON.stringify(runtime));
 assert.match(runtime.heap,/MiB|浏览器未提供/);
 const pos=await c.evaluate(`(()=>{const box=document.querySelector('#metric-cards button').getBoundingClientRect();return{x:box.x+6,y:box.y+box.height/2}})()`);
 await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',...pos});
 assert(await c.evaluate(`document.querySelector('#hint-confirm').checkVisibility()`),'hover opens the local metric hint');
 await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
 assert(!await c.evaluate(`document.querySelector('#hint-confirm').checkVisibility()`),'leaving the metric hides the hint');
 const term = '#metric-cards button[aria-describedby="hint-confirm"]';
 await c.evaluate(`document.querySelector('${term}').focus()`);
 assert(await c.evaluate(`document.querySelector('#hint-confirm').checkVisibility()`),'keyboard focus explains what the Worker confirmed');
 await c.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await c.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 assert(await c.evaluate(`!document.querySelector('#hint-confirm').checkVisibility() && !document.querySelector('#inspector').hidden`),'Escape dismisses the hint first');
 await click('#metric-cards button[aria-describedby="hint-parse"]');
 assert(await c.evaluate(`document.querySelector('#hint-parse').checkVisibility() && document.querySelector('#hint-parse').textContent.includes('仍能保存')`));
 await click('#metric-cards button[aria-describedby="hint-parse"]');
 for (const width of [1837, 1024]) {
   await c.command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await settle();
   const frame = await c.evaluate(`(()=>{const box=s=>document.querySelector(s).getBoundingClientRect();
     return {left:[box('.identity').left,box('.toolbar label').left,box('#editor-root').left,box('#status').left],
       right:[box('.header-actions').right,box('.command-trigger').right,box('#inspector').right],gap:box('#inspector').left-box('#editor-root').right}})()`);
   assert(Math.max(...frame.left)-Math.min(...frame.left)<=1 && Math.max(...frame.right)-Math.min(...frame.right)<=1 && frame.gap===12,JSON.stringify(frame));
   evidence.push({case:'workspace-alignment',width,...frame});
 }
 await screenshot('workbench-runtime');
 await c.command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await c.command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 await settle();
 const tap=await c.evaluate(`(()=>{const r=document.querySelector('${term}').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
 for(const open of [true,false]) {
   await c.command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[tap]});
   await c.command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await waitForEvaluation(c,`document.querySelector('#hint-confirm').checkVisibility()===${open}`,3000);
 }
 await c.command('Emulation.setTouchEmulationEnabled',{enabled:false});
 await click('#close-inspector');
 await choose('#sample',0);await click('#load');
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认' &&
   document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()===${JSON.stringify(initialSource)}`,30000);
 evidence.push({case:'large-document-runtime-panel',...runtime});

 for(const scenario of [
  {width:1440,height:900,font:'sans',theme:'light'},
  {width:1440,height:900,font:'serif',theme:'dark'},
  {width:1440,height:900,font:'mono',theme:'light'},
  {width:390,height:844,font:'sans',theme:'dark'},
  {width:390,height:844,font:'serif',theme:'light'},
  {width:390,height:844,font:'mono',theme:'dark'},
  {width:320,height:740,font:'sans',theme:'light'},
 ]) {
  await c.command('Emulation.setDeviceMetricsOverride',{width:scenario.width,height:scenario.height,deviceScaleFactor:1,mobile:false});
  await choose('#font',['sans','serif','mono'].indexOf(scenario.font));
  await chooseTheme(scenario.theme);
  await settle();
  await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认'`,20000);
  assert.equal(await source(),initialSource,`${scenario.font}/${scenario.theme}: appearance changes preserve Markdown`);
  const presentation=await c.evaluate(`(()=>{const root=document.querySelector('#editor-root'),content=root.querySelector('.cm-content'),s=getComputedStyle(root),t=getComputedStyle(content),toolbar=getComputedStyle(document.querySelector('.toolbar label'));return{mode:root.dataset.jotEditorMode,font:t.fontFamily,size:parseFloat(t.fontSize),color:s.color,background:s.backgroundColor,muted:toolbar.color,surround:getComputedStyle(document.documentElement).backgroundColor,pageOverflow:document.documentElement.scrollWidth-innerWidth,scroller:root.querySelector('.cm-scroller').clientWidth,scrollWidth:root.querySelector('.cm-scroller').scrollWidth,wideNonCodeLines:[...content.querySelectorAll('.cm-line:not(.jot-live-preview-native-block--fenced-code)')].filter(line=>line.scrollWidth>line.clientWidth+1).map(line=>({text:line.textContent.slice(0,60),client:line.clientWidth,scroll:line.scrollWidth}))}})()`);
  assert.equal(presentation.mode,'live-preview');assert.equal(presentation.size,17);
  assert(presentation.font.toLowerCase().includes(scenario.font==='sans'?'system':scenario.font==='serif'?'songti':'monospace'),`font option applies ${scenario.font}`);
  assert(presentation.pageOverflow<=1,'the page must not overflow horizontally');
  // Long code lines intentionally retain whitespace and can scroll horizontally.
  // Prose, images and tables must not introduce an unintended wider surface.
  assert.deepEqual(presentation.wideNonCodeLines,[],`${scenario.width}: non-code lines must fit the editing surface`);
  assert(contrast(presentation.color,presentation.background)>=4.5,'editor foreground has readable contrast');
  assert(contrast(presentation.muted,presentation.surround)>=4.5,'toolbar labels have readable contrast');
  await wheelToImage();
  const image=await imageGeometry();
  assert(image.loaded&&image.width>0&&image.height>0,'real image is loaded and visible');
  assert(image.left>=image.paneLeft-1&&image.right<=image.paneRight+1,'image is not clipped by the editor viewport');
  assert(Math.abs(image.center-image.contentCenter)<2,'image is centered inside the content area');
  assert(image.top>=image.paneTop-1&&image.bottom<=image.paneBottom+1,'image is vertically visible in the viewport');
  await screenshot(`image-${scenario.width}-${scenario.theme}-${scenario.font}`);
  for(const side of ['before','after','before']) await clickImageBlank(side,initialSource);
  const afterImage=await imageGeometry();
  assert(Math.abs(afterImage.top-image.top)<1&&Math.abs(afterImage.bottom-image.bottom)<1,'blank clicks must not move or resize the image');
  await wheel(-5000);
  await waitForEvaluation(c,`[...document.querySelectorAll('.jot-table-grid-header .jot-table-cell')].some(n=>n.textContent==='名称')`,15000);
  await settle();
  const table=await tableGeometry();
  assert.deepEqual(table.headers.map(x=>x.text),['名称','说明']);
  assert(table.scrollWidth<=table.clientWidth+1,'the two-column table should fit the paper width');
  for(const column of table.headers) assert(Math.abs(column.left-column.bodyLeft)<1&&Math.abs(column.right-column.bodyRight)<1,'table header and body columns stay aligned');
  assert(table.right<=table.paneRight+1&&table.left>=table.paneLeft-1,'table is inside the editor viewport');
  await screenshot(`${scenario.width}-${scenario.theme}-${scenario.font}`);
  evidence.push({case:'theme-font-geometry',...scenario,presentation,image,table});
 }

 // Real table pointer + command clicks: insert a column, select the new cell,
 // then remove it again. Selection and edits remain owned by CodeMirror.
 await c.command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await choose('#font',0);await chooseTheme('light');await wheel(-5000);await settle();
 await click('.jot-table-grid-body .jot-table-cell[data-jot-column-index="0"]');
 await waitForEvaluation(c,`!document.querySelector('[data-jot-table-command="table.insert-column-after"]')?.disabled`,10000);
 await click('[data-jot-table-command="table.insert-column-after"]');
 await waitForEvaluation(c,`document.querySelector('.jot-table')?.getAttribute('aria-colcount')==='3' && document.querySelector('#status').textContent==='正文已确认'`,20000);
 await click('.jot-table-grid-body .jot-table-cell[data-jot-column-index="1"]');
 await waitForEvaluation(c,`!document.querySelector('[data-jot-table-command="table.delete-column"]')?.disabled`,10000);
 await click('[data-jot-table-command="table.delete-column"]');
 await waitForEvaluation(c,`document.querySelector('.jot-table')?.getAttribute('aria-colcount')==='2' && document.querySelector('#status').textContent==='正文已确认'`,20000);
 assert.equal(await source(),initialSource,'inserting then deleting the new column restores the exact original Markdown');
 evidence.push({case:'table-column-round-trip',table:await tableGeometry()});

 // Rapid native-select change events emulate a user choosing modes before an
 // earlier async transition finishes. The last requested mode must win.
 await choose('#mode',1);await choose('#mode',3);await choose('#mode',0);
 await waitForEvaluation(c,`document.querySelector('#mode').value==='live-preview' && document.querySelector('#editor-root').dataset.jotEditorMode==='live-preview'`,20000);
 assert.equal(await c.evaluate(`document.querySelector('#insert').disabled`),false,'insert is enabled only after the editable mode is ready');
 assert.equal(await source(),initialSource,'mode changes preserve the document');
 await c.evaluate(`document.querySelector('#mode').focus()`);
 await c.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 await c.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 const focus=await c.evaluate(`(()=>{const e=document.activeElement,s=getComputedStyle(e);return{id:e.id,visible:e.matches(':focus-visible'),outline:s.outlineStyle,width:parseFloat(s.outlineWidth)}})()`);
 assert.equal(focus.id,'sample','Tab reaches the next control');assert(focus.visible&&focus.outline!=='none'&&focus.width>=2,'keyboard focus is visibly indicated');
 // Exercise the bundled example through the same public component that is
 // used by consumers, including the real checkbox pointer interaction.
 const taskSampleIndex=await c.evaluate(`[...document.querySelector('#sample').options].findIndex(option=>option.value==='inline-task')`);
 assert(taskSampleIndex>=0,'the inline syntax example is available');
 await choose('#sample',taskSampleIndex);await click('#load');
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认' && !!document.querySelector('.jot-live-preview-task-checkbox')`,20000);
 await wheel(-5000);
 assert((await source()).includes('- [ ] 整理资料'),'the example loads through the demo controls');
 await click('.jot-live-preview-task-checkbox');
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认'`,20000);
 assert((await source()).includes('- [x] 整理资料'),'the task checkbox writes back to Markdown');
 evidence.push({case:'inline-task-example',mode:await c.evaluate(`document.querySelector('#editor-root').dataset.jotEditorMode`)});
 await click('.jot-live-preview-task-checkbox');
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认'`,20000);
 assert((await source()).includes('- [ ] 整理资料'),'the task can be unchecked again');
 await choose('#mode',4);
 await waitForEvaluation(c,`document.querySelector('#editor-root').dataset.jotEditorMode==='pretext' && [...document.querySelectorAll('.jot-pretext-block__preview')].some(n=>n.textContent.includes('☐ 整理资料')) && [...document.querySelectorAll('.jot-pretext-block__preview')].some(n=>n.textContent.includes('☑ 完成初稿'))`,20000);
 evidence.push({case:'pretext-task-state',previews:await c.evaluate(`[...document.querySelectorAll('.jot-pretext-block__preview')].map(n=>n.textContent).filter(s=>s.includes('☐')||s.includes('☑'))`)});
 await choose('#mode',0);
 await waitForEvaluation(c,`document.querySelector('#editor-root').dataset.jotEditorMode==='live-preview'`,20000);
 const mermaidIndex=await c.evaluate(`[...document.querySelector('#sample').options].findIndex(option=>option.value==='mermaid')`);
 assert(mermaidIndex>=0,'the diagram example is available');
 await choose('#sample',mermaidIndex);await click('#load');
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认' && !!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 const mermaidSource=await source();
 assert(mermaidSource.includes('```mermaid'),'the external-style unspaced fence is preserved');
 assert.equal(await c.evaluate(`document.querySelector('#mermaid').checked`),true,'the demo plugin starts enabled');
 assert(await c.evaluate(`[...document.querySelectorAll('.jot-live-preview-source-heading')].some(n=>n.textContent.includes('图表后的章节'))`),'the next heading must not become part of the diagram code');
 await styleClick('#mermaid');
 await waitForEvaluation(c,`!document.querySelector('.jot-mermaid') && !!document.querySelector('.jot-code-line')`,20000);
 assert.equal(await source(),mermaidSource,'disabling the demo plugin preserves source');
 await styleClick('#mermaid');
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 assert.equal(await source(),mermaidSource,'enabling the demo plugin preserves source');
 evidence.push({case:'mermaid-toggle'});

 // Paste a genuinely long editable line, then move the real caret and type.
 // A code block has its own horizontal viewport; the document itself must not
 // slide sideways or paint the overflowing text into the paper margins.
 const longLine=`const message = "${'中文 abc '.repeat(160)}"; // line-end`;
 const longSource=`# 横向滚动\n\n\`\`\` ts\n${longLine}\nconst second = 2;\n\`\`\`\n\n## 后续标题\n`;
 await c.evaluate(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.focus();v.dispatch({selection:{anchor:0,head:v.state.doc.length}})})()`);
 await c.command('Input.insertText',{text:longSource});
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认' && !!document.querySelector('.jot-live-preview-code-scroll .jot-code-line')`,30000);
 await wheel(-5000);
 const beforeCode=await codeGeometry();
 assert(beforeCode.codeWidth>beforeCode.codeClient+500,'the fixture must overflow the code viewport');
 assert(beforeCode.outerWidth<=beforeCode.outerClient+1,'a long code line must not widen the document');
 await c.evaluate(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view,p=v.state.doc.toString().indexOf('// line-end');v.focus();v.dispatch({selection:{anchor:p},scrollIntoView:true})})()`);
 await waitForEvaluation(c,`document.querySelector('.jot-live-preview-code-scroll')?.scrollLeft>500`,10000);
 await settle();
 const atEnd=await codeGeometry();
 assert(atEnd.caretLeft>=atEnd.codeLeft-1&&atEnd.caretRight<=atEnd.codeRight+1,'moving the caret scrolls the code block into view');
 assert(Math.abs(atEnd.headingTop-beforeCode.headingTop)<1,'entering the code block must not move the following heading');
 const codePoint=await c.evaluate(`(()=>{const r=document.querySelector('.jot-live-preview-code-scroll').getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
 await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...codePoint,deltaX:-400,deltaY:0});
 await waitForEvaluation(c,`document.querySelector('.jot-live-preview-code-scroll').scrollLeft<${atEnd.codeScroll-100}`,10000);
 assert.equal(await c.evaluate(`document.querySelector('.cm-scroller').scrollLeft`),0,'horizontal wheel gestures stay inside the code block');
 const userScroll=await c.evaluate(`document.querySelector('.jot-live-preview-code-scroll').scrollLeft`);
 await c.command('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});
 await settle();
 assert(Math.abs(await c.evaluate(`document.querySelector('.jot-live-preview-code-scroll').scrollLeft`)-userScroll)<2,
   'layout changes must preserve a user-selected horizontal code position');
 await c.command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await settle();
 await c.command('Input.insertText',{text:'测'});
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认'`,20000);
 assert((await source()).includes('测// line-end'),'typing at the scrolled caret changes the intended source');
 const afterTyping=await codeGeometry();
 assert(afterTyping.codeScroll>500 && afterTyping.outerScroll===0,'typing keeps the code viewport and the outer document in place');
 assert(afterTyping.caretLeft>=afterTyping.codeLeft-1&&afterTyping.caretRight<=afterTyping.codeRight+1,'the caret remains visible after typing');
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认' && document.querySelectorAll('.jot-live-preview-code-scroll .jot-code-line').length===3`,20000);
 assert((await source()).includes('测\n// line-end'),'Enter keeps editing inside the same code block');
 assert.equal(await c.evaluate(`document.querySelectorAll('.jot-live-preview-code-scroll').length`),1,'the edited code lines stay in one block');
 evidence.push({case:'long-code-horizontal-edit',beforeCode,atEnd,afterTyping});

 const wrapSource=`# 代码换行\n\n\`\`\` ts\nconst value = "${'中文abc  '.repeat(55)}";\n第二行\n\`\`\`\n\n## 之后\n`;
 await c.evaluate(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.focus();v.dispatch({selection:{anchor:0,head:v.state.doc.length}})})()`);
 await c.command('Input.insertText',{text:wrapSource});
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认' && !!document.querySelector('.jot-code-line')`,30000);
 await choose('#code-wrap',1);
 await waitForEvaluation(c,`document.querySelector('.cm-content').dataset.jotCodeWrap==='wrap' && document.querySelector('.jot-code-line')?.getBoundingClientRect().height>40`,20000);
 assert.equal(await source(),wrapSource,'switching to wrap does not change Markdown');
 const wrapped=await c.evaluate(`(()=>{const l=document.querySelector('.jot-code-line'),w=document.querySelector('.jot-live-preview-code-scroll'),r=l.getBoundingClientRect();return{height:r.height,whiteSpace:getComputedStyle(l).whiteSpace,client:w.clientWidth,scroll:w.scrollWidth,x:r.left+100,y:r.top+36}})()`);
 assert.equal(wrapped.whiteSpace,'pre-wrap');assert(wrapped.scroll<=wrapped.client+1,'wrapped code does not overflow horizontally');
 for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:wrapped.x,y:wrapped.y});
 const insertion=await c.evaluate(`document.querySelector('.cm-content').cmTile.root.view.state.selection.main.head`);
 await c.command('Input.insertText',{text:'测'});await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认'`,20000);
 const editedWrap=wrapSource.slice(0,insertion)+'测'+wrapSource.slice(insertion);
 assert.equal(await source(),editedWrap,'clicking a visual continuation line edits its real source position');
 await choose('#mode',3);
 await waitForEvaluation(c,`document.querySelector('#editor-root').dataset.jotEditorMode==='preview' && !!document.querySelector('.jot-code .jot-source-line')`,30000);
 await settle();
 const previewWrap=await c.evaluate(`(()=>{const h=document.querySelector('.jot-code'),l=h.querySelector('.jot-source-line');return{height:l.getBoundingClientRect().height,client:h.clientWidth,scroll:h.scrollWidth,whiteSpace:getComputedStyle(l).whiteSpace}})()`);
 assert(previewWrap.height>40 && previewWrap.whiteSpace==='pre-wrap' && previewWrap.scroll<=previewWrap.client+1,'preview shares the wrapped code layout');
 await choose('#mode',0);await waitForEvaluation(c,`document.querySelector('#editor-root').dataset.jotEditorMode==='live-preview'`,20000);
 await choose('#code-wrap',0);
 await waitForEvaluation(c,`(()=>{
   const line=document.querySelector('.jot-code-line');
   return document.querySelector('.cm-content').dataset.jotCodeWrap==='scroll' && line &&
     Math.abs(line.getBoundingClientRect().height-parseFloat(getComputedStyle(line).lineHeight))<1;
 })()`,20000);
 assert.equal(await source(),editedWrap,'returning to horizontal scrolling preserves the edit');
 evidence.push({case:'code-wrap-live-edit-and-preview',wrapped,previewWrap});

 const codeIndex=await c.evaluate(`[...document.querySelector('#sample').options].findIndex(option=>option.value==='code')`);
 await choose('#sample',codeIndex);await click('#load');
 await waitForEvaluation(c,`document.querySelector('#status').textContent==='正文已确认' && (document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.lines ?? 0)>10000`,60000);
 for(const ratio of [0,.5,1]) {
  if(ratio===1) {
   const point=await c.evaluate(`(()=>{const t=[...document.querySelectorAll('.jot-direct-scrollbar')].find(n=>getComputedStyle(n).display!=='none'),r=t.getBoundingClientRect();return{x:(r.left+r.right)/2,y:r.bottom-4}})()`);
   for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
  } else await c.evaluate(`(()=>{const s=document.querySelector('.cm-scroller');s.scrollTop=(s.scrollHeight-s.clientHeight)*${ratio}})()`);
  await settle();
  await waitForEvaluation(c,`(()=>{const s=document.querySelector('.cm-scroller'),r=s.getBoundingClientRect();return [...s.querySelectorAll('.cm-line')].some(n=>{const b=n.getBoundingClientRect();return b.height>0&&b.bottom>r.top&&b.top<r.bottom&&/value|大代码块|代码结束/.test(n.textContent)})})()`,30000);
  const visible=await c.evaluate(`(()=>{const s=document.querySelector('.cm-scroller'),r=s.getBoundingClientRect();return{count:s.querySelectorAll('.cm-line').length,text:[...s.querySelectorAll('.cm-line')].filter(n=>{const b=n.getBoundingClientRect();return b.height>0&&b.bottom>r.top&&b.top<r.bottom}).map(n=>n.textContent).join(' '),top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight}})()`);
  assert(visible.count<1000,'a 10,000-line block must keep the live DOM bounded');
  if(ratio===1) {
   assert(visible.text.includes('代码结束。'),'the end of a large code block remains reachable');
   const number=await c.evaluate(`(()=>{const line=document.querySelector('.jot-code-line[data-jot-line-number="10000"]');if(!line)return null;return{width:parseFloat(getComputedStyle(line,'::before').width),padding:parseFloat(getComputedStyle(line).paddingInlineStart),digits:getComputedStyle(line).getPropertyValue('--jot-code-number-width').trim()}})()`);
   assert(number!==null && number.digits==='5ch' && number.padding-number.width>=5,'five-digit line numbers retain a gap before code');
  }
  evidence.push({case:'large-code-live-scroll',ratio,...visible});
 }
 const atBottom=await c.evaluate(`document.querySelector('.cm-scroller').scrollTop`);
 await wheel(-1600);await settle();
 assert(await c.evaluate(`document.querySelector('.cm-scroller').scrollTop`) < atBottom-500,
   'a new wheel gesture must cancel the temporary end anchor');
 assert.deepEqual(errors,[],'the browser reports no uncaught exceptions');
 evidence.push({case:'rapid-mode-selection',mode:'live-preview'});
 writeFileSync(resolve(output,'report.json'),JSON.stringify({passed:true,evidence},null,2));
 console.log(`Demo paper browser checks passed: ${output}`);
} catch(error) {
 try { await screenshot('failure'); } catch {}
 let state;try{state=await c?.evaluate(`(()=>({mode:document.querySelector('#mode')?.value,status:document.querySelector('#status')?.textContent,error:document.querySelector('#status')?.dataset.error,html:document.querySelector('#editor-root')?.outerHTML.slice(0,12000)}))()`)}catch{}
 writeFileSync(resolve(output,'report.json'),JSON.stringify({passed:false,error:String(error.stack??error),state,evidence,errors},null,2));
 throw error;
} finally {
 c?.socket.close();await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}

async function settle(){await c.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))`)}
async function source(){return c.evaluate(`(()=>{const view=document.querySelector('.cm-content')?.cmTile?.root?.view;if(!view)throw Error('missing CodeMirror view');return view.state.doc.toString()})()`)}
async function click(selector){const p=await c.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p})}
async function choose(selector,index){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e.selectedIndex!==${index}){e.selectedIndex=${index};e.dispatchEvent(new Event('change',{bubbles:true}))}})()`)}
async function styleClick(selector){await click('#open-style');await click(selector);await click('#close-inspector')}
async function chooseTheme(theme){if(await c.evaluate(`document.documentElement.dataset.theme`)!==theme){await styleClick('#theme');await waitForEvaluation(c,`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,5000)}}
async function wheel(deltaY){const p=await c.evaluate(`(()=>{const r=document.querySelector('.cm-scroller').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY});await settle()}
async function wheelToImage(){for(let i=0;i<8;i++){const state=await c.evaluate(`(()=>{const i=document.querySelector('.jot-image'),p=document.querySelector('.cm-scroller');if(!i||!p)return null;const r=i.getBoundingClientRect(),s=p.getBoundingClientRect();return{loaded:i.complete&&i.naturalWidth>0,top:r.top,bottom:r.bottom,paneTop:s.top,paneBottom:s.bottom,delta:r.top-(s.top+(s.height-r.height)/2)}})()`);if(state?.loaded&&state.top>=state.paneTop+25&&state.bottom<=state.paneBottom-25)return;await wheel(Math.max(-700,Math.min(700,state?.delta??500)))}throw Error('image could not be brought into view by real wheel input')}
async function imageGeometry(){return c.evaluate(`(()=>{const i=document.querySelector('.jot-image'),p=document.querySelector('.cm-scroller'),content=document.querySelector('.cm-content'),r=i.getBoundingClientRect(),s=p.getBoundingClientRect(),cr=content.getBoundingClientRect(),cs=getComputedStyle(content),left=cr.left+parseFloat(cs.paddingLeft),right=cr.right-parseFloat(cs.paddingRight);return{loaded:i.complete&&i.naturalWidth>0,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,center:(r.left+r.right)/2,contentCenter:(left+right)/2,paneLeft:s.left,paneRight:s.left+p.clientWidth,paneTop:s.top,paneBottom:s.bottom}})()`)}
async function clickImageBlank(side,expected){const info=await c.evaluate(`(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,line=document.querySelector('.jot-image').closest('.cm-line'),blank=${JSON.stringify(side)}==='before'?line.previousElementSibling:line.nextElementSibling;if(!blank?.classList.contains('jot-live-preview-blank-line'))throw Error('image-adjacent blank line missing');const r=blank.getBoundingClientRect(),next=blank.nextElementSibling?.getBoundingClientRect();return{x:r.left+8,y:(r.top+r.bottom)/2,top:r.top,height:r.height,nextTop:next?.top,scroll:view.scrollDOM.scrollTop,from:view.posAtDOM(blank,0)}})()`);for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:info.x,y:info.y});await settle();const after=await c.evaluate(`(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,line=document.querySelector('.jot-image').closest('.cm-line'),blank=${JSON.stringify(side)}==='before'?line.previousElementSibling:line.nextElementSibling,r=blank.getBoundingClientRect(),next=blank.nextElementSibling?.getBoundingClientRect();return{top:r.top,height:r.height,nextTop:next?.top,scroll:view.scrollDOM.scrollTop,head:view.state.selection.main.head,active:blank.classList.contains('jot-live-preview-active-line'),source:view.state.doc.toString()}})()`);assert(after.active,`${side}: the blank line is actually active`);assert.equal(after.head,info.from,`${side}: caret maps to the blank source line`);assert.equal(after.source,expected,`${side}: clicking a blank does not mutate Markdown`);for(const key of ['top','height','nextTop','scroll'])if(info[key]!==undefined&&after[key]!==undefined)assert(Math.abs(info[key]-after[key])<1,`${side}: ${key} must not jump after blank activation (${info[key]} → ${after[key]}, scroll ${info.scroll} → ${after.scroll})`)}
async function tableGeometry(){return c.evaluate(`(()=>{const t=document.querySelector('.jot-table'),pane=document.querySelector('.cm-scroller'),r=t.getBoundingClientRect(),p=pane.getBoundingClientRect();return{left:r.left,right:r.right,paneLeft:p.left,paneRight:p.left+pane.clientWidth,clientWidth:t.clientWidth,scrollWidth:t.scrollWidth,headers:[...t.querySelectorAll('.jot-table-grid-header .jot-table-cell')].map(n=>{const a=n.getBoundingClientRect(),b=t.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="'+n.dataset.jotColumnIndex+'"]')?.getBoundingClientRect();return{text:n.textContent,left:a.left,right:a.right,bodyLeft:b?.left,bodyRight:b?.right}})}})()`)}
async function codeGeometry(){return c.evaluate(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view,w=document.querySelector('.jot-live-preview-code-scroll'),r=w.getBoundingClientRect(),caret=v.coordsAtPos(v.state.selection.main.head),heading=[...document.querySelectorAll('.jot-live-preview-source-heading')].find(n=>n.textContent.includes('后续标题'));return{codeLeft:r.left,codeRight:r.right,codeWidth:w.scrollWidth,codeClient:w.clientWidth,codeScroll:w.scrollLeft,outerWidth:v.scrollDOM.scrollWidth,outerClient:v.scrollDOM.clientWidth,outerScroll:v.scrollDOM.scrollLeft,caretLeft:caret?.left,caretRight:caret?.right,headingTop:heading?.getBoundingClientRect().top}})()`)}
async function screenshot(name){const result=await c.command('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,name+'.png'),Buffer.from(result.data,'base64'))}
function contrast(foreground,background){const rgb=s=>s.match(/\d+(?:\.\d+)?/gu).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4});const lum=s=>{const [r,g,b]=rgb(s);return .2126*r+.7152*g+.0722*b};const a=lum(foreground),b=lum(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}
