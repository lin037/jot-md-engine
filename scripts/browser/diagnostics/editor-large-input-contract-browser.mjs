// Real browser regression for the shared CodeMirror large-input fast path.
// API selections are fixture setup; all edit/undo actions use CDP Input.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { connectCdp, findChrome, keyboardEventKey, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port = Number(process.env.JOT_INPUT_CONTRACT_PORT ?? 4200), debugPort = Number(process.env.JOT_INPUT_CONTRACT_DEBUG_PORT ?? 9349);
const origin = `http://127.0.0.1:${port}`, debugOrigin = `http://127.0.0.1:${debugPort}`;
const output = resolve(process.env.JOT_INPUT_CONTRACT_REPORT ?? 'dist/large-input-contract-report');
const fixture = resolve(`.tmp/large-input-contract-${port}`);
mkdirSync(output,{recursive:true});mkdirSync(fixture,{recursive:true});
const fsUrl = path => '/@fs' + path;
const boot = fsUrl(resolve('packages/editor/src/worker/index.ts')), wasm = fsUrl(resolve('apps/demo/src/generated/editor_wasm.js'));
writeFileSync(resolve(fixture,'worker.mjs'), `import {bootstrapEditorWorker} from ${JSON.stringify(boot)};\nawait bootstrapEditorWorker({endpoint:self,loadWasm:()=>import(${JSON.stringify(wasm)}),onError:e=>self.postMessage({type:'consumer-fatal',message:String(e)}),onFatalError:e=>self.postMessage({type:'consumer-fatal',message:String(e)})});\n`);
writeFileSync(resolve(fixture,'vite.config.mjs'), `export default {root:${JSON.stringify(process.cwd())},cacheDir:${JSON.stringify(resolve(fixture,'vite-cache'))},optimizeDeps:{noDiscovery:true},worker:{format:'es'},server:{host:'127.0.0.1',port:${port},strictPort:true,fs:{allow:[${JSON.stringify(process.cwd())}]}}};\n`);
const profile=mkdtempSync(resolve(tmpdir(),'jot-large-contract-'));
let server,chrome,c;const cases=[],browserErrors=[];
const report={cases,browserErrors};
const tiny='字',below='x'.repeat(16383),large='x'.repeat(16382)+'😀';
assert.equal(below.length,16383);assert.equal(large.length,16384);
async function stable(){await waitForEvaluation(c,`editor.session.adapter.analysis?.state==='complete' && editor.confirmedValue===view.state.doc.toString()`,30000);await c.evaluate('editor.livePreview.settled()');await c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');}
async function setup(name,mode,readOnly,positions,initial='abcdef'){
 await c.evaluate(`(async()=>{if(window.editor){editor.dispose();worker.terminate();}const root=document.querySelector('#integration');root.replaceChildren();window.caseErrors=[];window.caseEvents=[];
  window.worker=new Worker(${JSON.stringify(fsUrl(resolve(fixture,'worker.mjs')))},{type:'module'});worker.addEventListener('error',e=>caseErrors.push(e.message));worker.addEventListener('message',e=>{if(e.data?.type==='consumer-fatal')caseErrors.push(e.data.message)});
  window.editor=new MarkdownEditor({root,mode:${JSON.stringify(mode)},input:{readOnly:${readOnly}},session:{endpoint:worker,documentId:${JSON.stringify(name)},generation:1,source:${JSON.stringify(initial)},syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>caseErrors.push(String(e.stack??e))});await editor.open();window.view=editor.input.view;
  root.addEventListener('beforeinput',event=>{const item={type:event.inputType,length:event.data?.length??0,isTrusted:event.isTrusted,cancelable:event.cancelable,composing:event.isComposing};caseEvents.push(item);
    // Observe after dispatch has completed. A microtask from a capture
    // listener can run before the target's CodeMirror handler prevents it.
    setTimeout(()=>item.prevented=event.defaultPrevented,0);},{capture:true,once:true});
  // Use the selection class already installed in this EditorView. Loading the
  // same package through a second Vite URL creates a different constructor,
  // which CM interprets as an ordinary {anchor, head} selection spec.
  const EditorSelection=view.state.selection.constructor;
  view.dispatch({selection:EditorSelection.create(${JSON.stringify(positions)}.map(position=>typeof position==='number'?EditorSelection.cursor(position):EditorSelection.range(position.anchor,position.head)))});view.focus();
 })()`);
 await stable();
 const before=await state();assert.equal(before.source,initial,`${name}: exact setup source`);assert.equal(before.readOnly,readOnly,`${name}: requested readonly state`);
 if(!readOnly)assert(await c.evaluate('view.hasFocus'),`${name}: real input target focused`);
}
async function state(){return c.evaluate(`({source:editor.confirmedValue,mirror:view.state.doc.toString(),ranges:view.state.selection.ranges.map(r=>({anchor:r.anchor,head:r.head})),readOnly:view.state.readOnly,errors:[...caseErrors],events:[...caseEvents]})`);}
async function insert(text){await c.command('Input.insertText',{text});await stable();}
async function key(name, modifiers) {
 const letter = name.toUpperCase();
 const event = { key: keyboardEventKey(name, modifiers), code: 'Key' + letter, modifiers };
 await c.command('Input.dispatchKeyEvent', { type: 'keyDown', ...event, windowsVirtualKeyCode: letter.charCodeAt(0) });
 await c.command('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
 await stable();
}
async function verify(name,expected,prevented){const current=await state();assert.equal(current.source,expected,`${name}: exact confirmed text`);assert.equal(current.mirror,expected,`${name}: CM/confirmed source agree`);assert.deepEqual(current.errors,[],`${name}: editor and worker report no errors`);if(prevented!==undefined){assert(current.events.some(e=>e.isTrusted && e.type==='insertText' && e.prevented===prevented),`${name}: trusted beforeinput takes expected native/fast path`);}return {name,sourceLength:current.source.length,ranges:current.ranges,events:current.events};}
try{
 server=spawn(resolve('node_modules/.bin/vite'),['--config',resolve(fixture,'vite.config.mjs')],{stdio:['ignore','pipe','pipe']});
 let viteLog='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{viteLog+=String(chunk);writeFileSync(resolve(output,'vite.log'),viteLog)});
 const fixtureUrl=origin+fsUrl(resolve('scripts/browser/support/editor-browser-fixture.html'));await waitForHttp(fixtureUrl,15000);
 chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-background-timer-throttling',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,fixtureUrl],{stdio:'ignore'});await waitForHttp(debugOrigin+'/json/version',15000);
 const pages=await fetch(debugOrigin+'/json/list').then(r=>r.json());c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.startsWith(origin+'/')).webSocketDebuggerUrl);c.socket.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.method==='Runtime.exceptionThrown')browserErrors.push(m.params)});
 await c.command('Runtime.enable');await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});await waitForEvaluation(c,`document.readyState==='complete'&&document.title==='Jot native component integration fixture'`,15000);
 await c.evaluate(`(async()=>{const m=await import(${JSON.stringify(fsUrl(resolve('packages/editor/src/index.ts')))});window.MarkdownEditor=m.MarkdownEditor;const root=document.createElement('div');root.id='integration';root.style.cssText='width:900px;height:700px;margin:10px';document.body.replaceChildren(root)})()`);
 const mod=await c.evaluate('/Mac|iPhone|iPad/.test(navigator.platform)')?4:2;
 await setup('small','source',false,[2]);await insert(tiny);cases.push(await verify('small-native',`ab${tiny}cdef`,false));
 await setup('below','source',false,[2]);await insert(below);cases.push(await verify('below-threshold-native',`ab${below}cdef`,false));
 await setup('exact','source',false,[2]);await insert(large);cases.push(await verify('exact-threshold-source',`ab${large}cdef`,true));await key('z',mod);cases.push(await verify('exact-undo','abcdef'));await key('z',mod|8);cases.push(await verify('exact-redo',`ab${large}cdef`));
 await setup('multiple','source',false,[1,4]);await insert(large);const multi=await verify('multiple-selections',`a${large}bcd${large}ef`,true);assert.equal(multi.ranges.length,2,'large input retains both cursors');cases.push(multi);await key('z',mod);cases.push(await verify('multiple-undo','abcdef'));
 await setup('live','live-preview',false,[2]);await insert(large);cases.push(await verify('live-preview-fast',`ab${large}cdef`,true));await key('z',mod);cases.push(await verify('live-preview-undo','abcdef'));
 const table='Before\n\n| A | B |\n| --- | --- |\n| first | second |\n\nAfter';
 await setup('protected-table','live-preview',false,[{anchor:table.indexOf('first')+1,head:table.indexOf('second')+3}],table);await insert(large);cases.push(await verify('partial-table-selection-protected',table,true));
 const code='Before\n\n``` rust begin\nbody\n``` end\n\nAfter';
 await setup('protected-code','live-preview',false,[{anchor:code.indexOf('body')+1,head:code.indexOf('``` end')+4}],code);await insert(large);cases.push(await verify('content-into-closer-selection-protected',code,true));
 await setup('readonly','source',true,[2]);await c.command('Input.insertText',{text:large});await stable();cases.push(await verify('readonly-unchanged','abcdef'));
 assert.deepEqual(browserErrors,[],'no browser runtime exceptions');report.passed=true;
}catch(error){report.passed=false;report.failure=String(error.stack??error);process.exitCode=1;if(c){try{report.diagnostic=await state()}catch{}}}
finally{writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');c?.socket.close();await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
if(report.passed)console.log(JSON.stringify({passed:true,cases:cases.length,output}));else console.error(report.failure);
