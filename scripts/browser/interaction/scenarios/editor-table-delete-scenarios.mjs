// Real-browser regressions shared by the full harness and standalone runner.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {findChrome,waitForHttp,connectCdp,waitForEvaluation,stopProcess,keyboardEventKey} from '../../support/browser-test-utils.mjs';

export async function runTableDeleteScenarios({c,load,settle,confirmed,screenshot,results}) {
  const mod=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`) ? 4 : 2;
  async function click(selector){
    const point=await c.evaluate(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getBoundingClientRect().height>0);if(!n)throw Error('missing '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return {x:r.left+Math.min(r.width/2,8),y:r.top+r.height/2};})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    await settle();
  }
  async function undoRedo(redo=false){
    const modifiers=mod|(redo?8:0);
    const key=keyboardEventKey('z',modifiers);
    await c.command('Input.dispatchKeyEvent',{type:'keyDown',key,code:'KeyZ',windowsVirtualKeyCode:90,modifiers});
    await c.command('Input.dispatchKeyEvent',{type:'keyUp',key,code:'KeyZ',modifiers});await confirmed();
  }
  async function snapshot(){return c.evaluate(`(()=>{
    const table=[...document.querySelectorAll('.jot-table')].find(n=>n.getBoundingClientRect().height>0);
    const block=editor.session.adapter.blocks.blocks.find(n=>n.kind==='table');
    const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,style:n.getAttribute('style')}};
    const rows=[...table.querySelectorAll('.jot-table-row')].map(n=>({...rect(n),text:n.textContent,id:n.dataset.jotNodeId,version:n.dataset.jotContentVersion,cells:[...n.querySelectorAll('.jot-table-cell')].map(cell=>({...rect(cell),column:Number(cell.dataset.jotColumnIndex),text:cell.textContent})),insets:[n.style.paddingInlineStart,n.style.paddingInlineEnd].map(Number.parseFloat)}));
    const selection=view.state.selection.main;const toolbar=table.querySelector('.jot-table-toolbar');
    const tail=[...document.querySelectorAll('.cm-line,[data-jot-kind="paragraph"]')].find(n=>n.textContent==='TAIL_ANCHOR'&&n.getBoundingClientRect().height>0);
    return {source:editor.confirmedValue,mirror:editor.input.value,revision:Number(editor.revision),mode:editor.mode,root:block,layout:editor.tableLayout(block.id),host:rect(table),aria:table.getAttribute('aria-colcount'),toolbar:rect(toolbar),buttons:[...toolbar.children].map(n=>({...rect(n),disabled:n.disabled,command:n.dataset.jotTableCommand})),rows,tail:tail?rect(tail):undefined,selection:{from:selection.from,to:selection.to},focus:document.activeElement?.className,errors:[...errors]};
  })()`);}
  function verify(state,count,source,label){
    assert.equal(state.source,source,label+': exact confirmed source');assert.equal(state.mirror,source,label+': CodeMirror mirror');
    assert(Number.isSafeInteger(state.revision)&&state.revision>=0,label+': legal revision');
    assert.equal(state.layout.columnCount,count,label+': column axis');assert.equal(Number(state.aria),count,label+': aria count');
    for(const row of state.rows){
      assert.equal(row.cells.length,count,label+': mounted cell count');const width=row.cells.reduce((sum,cell)=>sum+cell.width,0);
      assert(Math.abs(width-state.layout.totalWidth)<1,label+': cell widths match axis');
      assert(Math.abs(row.width-width)<1,label+': no stale horizontal shell/spacer');
      assert(row.insets.every(width=>width<1),label+': small table has no virtual column tail');
      assert.deepEqual(row.cells.map(cell=>cell.column),Array.from({length:count},(_,i)=>i),label+': contiguous column indexes');
    }
    assert(Math.abs(state.host.clientWidth-state.layout.totalWidth)<1,label+': toolbar cannot widen intrinsic table');
    assert(Math.abs(state.toolbar.width-state.host.clientWidth)<1,label+': toolbar follows table width');
    for(const button of state.buttons){
      assert(button.x>=state.toolbar.x-1&&button.x+button.width<=state.toolbar.x+state.toolbar.width+1,label+': each toolbar command fits the column width');
      assert(button.y>=state.toolbar.y&&button.y+button.height<=state.toolbar.y+state.toolbar.height,label+': wrapped toolbar remains usable');
    }
    assert(state.selection.from>=0&&state.selection.to<=source.length,label+': legal selection');assert.deepEqual(state.errors,[],label+': errors');
    assert(state.tail&&state.tail.y>=state.host.y+state.host.height-1,label+': following block clears the wrapped toolbar and table');
  }
  function sourceFor(columns){
    const rows=[['A','B','C','D'],['---','---','---','---'],['one','two','three','four'],['five','six','seven','eight']];
    return 'before\n\n'+rows.map(row=>'| '+columns.map(column=>row[column]).join(' | ')+' |').join('\n')+'\n\nTAIL_ANCHOR';
  }
  for(const firstColumn of [3,1,0]) {
    console.log('[table-delete] first column '+firstColumn);
    const columns=[0,1,2,3];const source=sourceFor(columns);await load(source);
    await click(`.jot-table-grid-body .jot-table-cell[data-jot-column-index="${firstColumn}"]`);
    const before=await snapshot();const record={case:'table-delete-'+firstColumn,before,stages:[]};results.push(record);
    await screenshot('table-delete-'+firstColumn+'-before');verify(before,4,source,'initial '+firstColumn);
    for(let count=3;count>=1;count--){
      // The command selects the nearest surviving cell. The fixed fixture
      // matrix, rather than a second Markdown parser, defines expected source.
      const selected=await c.evaluate(`Number(document.querySelector('.jot-live-preview-table-cell--active').dataset.jotColumnIndex)`);
      columns.splice(selected,1);const expected=sourceFor(columns);
      if(firstColumn===3&&count===3){
        for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{
          type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8,modifiers:mod|1|8,
        });
      }else await click('[data-jot-table-command="table.delete-column"]');
      await confirmed();await c.evaluate('editor.livePreview.settled()');
      const deleted=await snapshot();record.stages.push({count,deleted});await screenshot('table-delete-'+firstColumn+'-'+count);
      verify(deleted,count,expected,'delete to '+count);
      if(count===1)assert(deleted.buttons.find(n=>n.command==='table.delete-column').disabled,'last column cannot be deleted');
      assert(deleted.focus.includes('jot-live-preview-table-ime')||deleted.focus.includes('cm-content'),'delete retains native editor input focus');
    }
    const single=record.stages.at(-1).deleted;
    await undoRedo();const undone=await snapshot();record.undone=undone;verify(undone,2,record.stages[1].deleted.source,'undo one column');
    await undoRedo(true);const redone=await snapshot();record.redone=redone;verify(redone,1,single.source,'redo one column');
    assert(Math.abs(single.host.height-redone.host.height)<1,'same state restores wrapped toolbar and row height');
    assert(Math.abs(single.tail.y-redone.tail.y)<1,'Undo/Redo cannot accumulate following-block displacement');
    await c.evaluate(`editor.setMode('preview')`);await settle();
    const preview=await snapshot();record.preview=preview;verify(preview,1,single.source,'Preview single column');
    await c.evaluate(`editor.setMode('live-preview')`);await settle();
  }
  const ticks = "`".repeat(3);
  const fence = [ticks + " a|b", "x|y", ticks].join("\n");
  const table = ["| A | B |", "| --- | --- |", "| C | D |", "| --- | --- |", "| X | 　正文\u00a0 |"].join("\n");
  const source = table + "\n" + fence;
  const expectedSource = ["| B |", "| --- |", "| D |", "| --- |", "| 　正文\u00a0 |", fence].join("\n");
  for (const mode of ["live-preview", "split"]) {
    await c.evaluate(`editor.setMode(${JSON.stringify(mode)})`);
    await load(source);
    assert.equal(await c.evaluate(`editor.replaceTableCell(editor.value.indexOf("x|y"), "wrong")`), false);
    const offset = source.indexOf("X");
    if (mode === "live-preview") {
      await click(`.jot-table-grid-body .jot-table-cell[data-jot-source-from="${offset}"]`);
      await click('[data-jot-table-command="table.delete-column"]');
    } else {
      await c.evaluate(`editor.input.setSelection(${offset});editor.focus()`);
      for (const type of ["keyDown", "keyUp"]) await c.command("Input.dispatchKeyEvent", {
        type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: mod | 1 | 8,
      });
    }
    await confirmed();
    assert.equal(await c.evaluate("editor.confirmedValue"), expectedSource, mode + ": exact table bounds and Unicode cell");
    await undoRedo();
    assert.equal(await c.evaluate("editor.confirmedValue"), source);
    await undoRedo(true);
    assert.equal(await c.evaluate("editor.confirmedValue"), expectedSource);
    results.push({ case: "table-delete-confirmed-range-" + mode });
  }
  // The source-only editor never mounts a preview that could populate the block index.
  const cold = await c.evaluate(`(async () => {
    const {MarkdownEditor} = await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root = document.createElement('div');
    document.body.append(root);
    const worker = new Worker('/src/worker.ts', {type:'module'});
    const source = ${JSON.stringify(source)};
    const editor = new MarkdownEditor({root, mode:'source', session:{endpoint:worker,
      documentId:'source-table', generation:1, source, syntaxProfile:{id:'default',version:1,enabledExtensions:[]}}});
    try {
      await editor.open();
      const handled = editor.executeCommand('table.delete-column', source.indexOf('X'));
      await editor.input.settled();
      return { handled, source: editor.confirmedValue };
    } finally {
      editor.dispose(); worker.terminate(); root.remove();
    }
  })()`);
  assert.deepEqual(cold, { handled: true, source: expectedSource });
  results.push({ case: 'table-delete-source-cold-open' });
  await c.evaluate("editor.setMode('live-preview')");
  console.log('[table-delete] ragged rows and pinned column');
  const ragged='before\n\n| A | B | C | D |\n| --- | --- | --- | --- |\n| one | two |\n| five | six | seven | eight |\n\nTAIL_ANCHOR';
  await load(ragged);const initial=await snapshot();verify(initial,4,ragged,'ragged initial window');
  const point=await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-header .jot-table-column-resize[data-jot-column-index="0"]');const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
  await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:point.x+80,y:point.y});
  await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:point.x+80,y:point.y});await settle();
  const resized=await snapshot();verify(resized,4,ragged,'pinned geometry');
  assert(resized.layout.widths[0]>initial.layout.widths[0]+50,'real pointer resize changes first column');assert(resized.layout.pinnedColumns.includes(0),'user width remains pinned');
  // Exceed the axis's existing 0.5px update threshold after the 136px drag.
  await c.evaluate(`editor.setTableColumnWidth(editor.session.adapter.blocks.blocks.find(n=>n.kind==='table').id,0,137.2)`);await settle();
  const fractional=await snapshot();verify(fractional,4,ragged,'fractional pinned geometry');
  assert(Math.abs(fractional.layout.widths[0]-137.2)<0.001,'fractional column width remains supported: '+fractional.layout.widths[0]);
  await click('.jot-table-grid-body .jot-table-cell[data-jot-column-index="0"]');await c.command('Input.insertText',{text:'X'});await confirmed();
  const edited=await snapshot();assert(edited.source.includes('| Xone | two |'),'mapped edit targets ragged cell');verify(edited,4,ragged.replace('one','Xone'),'pinned cell edit');
  assert.deepEqual(edited.layout.widths,fractional.layout.widths,'cell editing preserves every user/auto width');
  await click('.jot-table-grid-body .jot-table-cell[data-jot-column-index="3"][data-jot-source-from]');await click('[data-jot-table-command="table.delete-column"]');await confirmed();
  const deleted=await snapshot();const expected='before\n\n| A | B | C |\n| --- | --- | --- |\n| Xone | two |  |\n| five | six | seven |\n\nTAIL_ANCHOR';
  verify(deleted,3,expected,'ragged delete');results.push({case:'table-delete-ragged-pinned',initial,resized,fractional,edited,deleted});await screenshot('table-delete-ragged-pinned');

  const columns = Array.from({ length: 48 }, (_, i) => String(i));
  const wide = [columns.map(i => 'h' + i), columns.map(() => '---'), columns.map(i => 'c' + i)]
    .map(cells => '| ' + cells.join(' | ') + ' |').join('\n');
  await load(wide);
  for (const mode of ['live-preview', 'preview']) {
    await c.evaluate(`editor.setMode(${JSON.stringify(mode)})`);
    await settle();
    for (const fraction of [0, .5, 1]) {
      await c.evaluate(`(()=>{const table = [...document.querySelectorAll('.jot-table')].find(n => n.clientWidth > 0);
        table.scrollLeft = (table.scrollWidth - table.clientWidth) * ${fraction};})()`);
      await settle();
      const { rows, layout, host } = await snapshot();
      const [header, body] = rows;
      assert(host.scrollWidth > host.clientWidth && body.cells.length < columns.length);
      assert(Math.abs(host.scrollWidth - layout.totalWidth) <= 2, 'horizontal scrollbar spans all columns');
      assert.deepEqual(header.cells.map(cell => cell.column), body.cells.map(cell => cell.column));
      for (const [i, cell] of body.cells.entries()) {
        assert.equal(cell.text, 'c' + cell.column);
        assert(Math.abs(header.cells[i].x - cell.x) < 1, 'header aligns with scrolled body');
      }
      if (fraction === 0) assert.equal(body.cells[0].column, 0);
      if (fraction === 1) assert.equal(body.cells.at(-1).column, columns.length - 1);
      assert(Math.abs(body.insets[0] + body.cells.reduce((sum, c) => sum + c.width, 0) +
        body.insets[1] - layout.totalWidth) < 1, 'row and virtual axis cover the same width');
    }
    results.push({case:'table-horizontal-column-window-' + mode});
  }
  await c.evaluate("editor.setMode('live-preview')");
}

async function runLargeTableDelete({c,load,confirmed,results}, rowCount) {
  const rows = Array.from({length: rowCount}, (_, i) => [
    String(i + 1),
    `项目 ${i + 1}`,
    i % 5 === 0 ? '长内容用于检查换行后的行高与对齐。'.repeat(6) : '可编辑内容',
  ]);
  const makeSource = (columns) => [
    '# 大表格', '',
    ...[['序号','名称','说明'],['---','---','---'],...rows]
      .map(row => `| ${columns.map(column => row[column]).join(' | ')} |`),
    '', 'TAIL_ANCHOR',
  ].join('\n');
  const source = makeSource([0,1,2]);
  const expected = makeSource([0,2]);
  await load(source);
  const originalId = await c.evaluate("editor.session.adapter.blocks.blocks.find(block=>block.kind==='table').id");
  const point = async (selector) => c.evaluate(`(()=>{
    const item=document.querySelector(${JSON.stringify(selector)});
    const rect=item.getBoundingClientRect();
    return {x:rect.left+Math.min(rect.width/2,10),y:rect.top+rect.height/2}
  })()`);
  const click = async (where) => {
    for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{
      type, button:'left', clickCount:1, ...where,
    });
  };
  await click(await point('.jot-table-grid-body .jot-table-cell[data-jot-column-index="1"][data-jot-source-from]'));
  const target = await point('[data-jot-table-command="table.delete-column"]');
  assert.equal(await c.evaluate("!!document.querySelector('.jot-live-preview-table-cell--active[data-jot-column-index=\"1\"]')"),true);
  await c.evaluate(`(()=>{
    window.deleteTiming={started:0,requests:[],responses:[],long:[]};
    const receive=({data})=>{if(deleteTiming.started!==0)deleteTiming.responses.push({
      time:performance.now()-deleteTiming.started,type:data.body?.type??data.type,message:data.message,
      error:data.body?.error,analysis:data.body?.analysis?.state,
    })};
    worker.addEventListener('message',receive);
    const original=worker.postMessage.bind(worker);
    worker.postMessage=(request,...args)=>{
      if(deleteTiming.started!==0)deleteTiming.requests.push({time:performance.now()-deleteTiming.started,type:request.body?.type,edits:request.body?.transaction?.edits?.length,slices:request.body?.projection?.slices?.length});
      original(request,...args)
    };
    const observer=new PerformanceObserver(list=>deleteTiming.long.push(...list.getEntries()
      .filter(entry=>deleteTiming.started!==0&&entry.startTime+entry.duration>deleteTiming.started)
      .map(entry=>({start:entry.startTime-deleteTiming.started,duration:entry.duration}))));
    observer.observe({entryTypes:['longtask']});
    document.querySelector('[data-jot-table-command="table.delete-column"]').addEventListener('click',()=>deleteTiming.started=performance.now(),{capture:true,once:true});
    window.stopDeleteTiming=()=>{observer.disconnect();worker.removeEventListener('message',receive);worker.postMessage=original};
  })()`);
  await click(target);
  try {
    await confirmed();
  } catch (error) {
    console.error('large table delete pending', JSON.stringify(await c.evaluate(`({
      timing:deleteTiming,errors,local:editor.value.length,confirmed:editor.confirmedValue.length,
      analysis:editor.session.adapter.analysis?.state,
      columns:document.querySelector('.jot-table')?.getAttribute('aria-colcount'),
    })`)));
    throw error;
  }
  const timing = await c.evaluate('deleteTiming');
  await c.evaluate('stopDeleteTiming()');
  console.log(JSON.stringify({case:'large-table-delete',rowCount,timing}));
  assert.equal(timing.requests.find(request=>request.type==='apply-transaction')?.slices,1);
  assert.equal(await c.evaluate("editor.session.adapter.blocks.blocks.find(block=>block.kind==='table').id"),originalId);
  assert.equal(await c.evaluate('editor.confirmedValue'),expected);
  await waitForEvaluation(c,"document.querySelector('.jot-table')?.getAttribute('aria-colcount')==='2'",10000);
  const mod=await c.evaluate('/Mac|iPhone|iPad/u.test(navigator.platform)')?4:2;
  for(const [modifiers, expectedSource] of [[mod,source],[mod|8,expected]]) {
    for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{
      type,key:keyboardEventKey('z',modifiers),code:'KeyZ',windowsVirtualKeyCode:90,modifiers,
    });
    await confirmed();
    assert.equal(await c.evaluate('editor.confirmedValue'),expectedSource,'one history step restores the entire column');
  }
  results.push({case:'large-table-delete',rowCount,timing});
}

async function standalone(){
  const output=resolve('dist/table-delete-browser-report');mkdirSync(output,{recursive:true});
  const profile=mkdtempSync(resolve(tmpdir(),'jot-table-delete-'));let server,chrome,c;const results=[];
  try {
    server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port','4188','--strictPort'],{stdio:'ignore'});await waitForHttp('http://127.0.0.1:4188/',15000);
    chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking','--remote-debugging-port=9339',`--user-data-dir=${profile}`,`http://127.0.0.1:4188/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
    await waitForHttp('http://127.0.0.1:9339/json/version',15000);const pages=await fetch('http://127.0.0.1:9339/json/list').then(r=>r.json());c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.includes(':4188')).webSocketDebuggerUrl);
    await c.command('Runtime.enable');await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});await waitForEvaluation(c,`document.readyState==='complete'&&document.title==='Jot native component integration fixture'`,15000);
    await c.evaluate(`(async()=>{const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');const root=document.createElement('div');root.id='integration';root.style.cssText='height:700px;width:900px;margin:10px';document.body.replaceChildren(root);window.worker=new Worker('/src/worker.ts',{type:'module'});window.errors=[];window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint:worker,documentId:'table-delete',generation:1,source:'ready',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>errors.push(String(e))});await editor.open();window.view=editor.input.view;})()`);
    const settle=()=>c.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,250))))`);
    const confirmed=async()=>{await waitForEvaluation(c,`editor.session.adapter.analysis?.state==='complete'&&editor.session.adapter.text.text===editor.input.value`,10000);await settle();await c.evaluate('editor.livePreview.settled()');};
    const load=async text=>{await c.evaluate(`editor.setValue(${JSON.stringify(text)})`);await confirmed();await waitForEvaluation(c,`document.querySelectorAll('.jot-table-grid-header .jot-table-cell:not(.jot-table-cell--empty)').length>0`,10000);await settle();};
    const screenshot=async name=>{const{data}=await c.command('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,name+'.png'),Buffer.from(data,'base64'));};
    if(process.env.JOT_TABLE_DELETE_ROWS) await runLargeTableDelete({c,load,confirmed,results},Number(process.env.JOT_TABLE_DELETE_ROWS));
    else {
      await runLargeTableDelete({c,load,confirmed,results},2000);
      await runTableDeleteScenarios({c,load,settle,confirmed,screenshot,results});
    }
    console.log(JSON.stringify({passed:results.length,report:output}));
  } finally {
    writeFileSync(resolve(output,'report.json'),JSON.stringify(results,null,2));if(c){try{await c.evaluate('editor?.dispose();worker?.terminate()');}catch{}c.socket.close();}
    await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await standalone();
