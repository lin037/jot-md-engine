// Consumer E2E: exported MarkdownEditor + bootstrapEditorWorker + release Wasm.
// No demo startup, source selection API, direct transaction, or DOM edit is used
// as an interaction. Re-run with JOT_FUZZ_SEED / JOT_FUZZ_STEPS; baseline mode
// records every directed failure before exiting, so one bug cannot hide others.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { findChrome, connectCdp, waitForHttp, waitForEvaluation, stopProcess, keyboardEventKey } from '../support/browser-test-utils.mjs';
const seed = Number(process.env.JOT_FUZZ_SEED ?? 0x51ea2026) >>> 0;
const harnessSha256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const target = Number(process.env.JOT_FUZZ_STEPS ?? 1000);
assert(Number.isInteger(target) && target >= 0, 'JOT_FUZZ_STEPS must be a nonnegative integer');
const port=Number(process.env.JOT_FUZZ_PORT??4192),debugPort=Number(process.env.JOT_FUZZ_DEBUG_PORT??9341);
assert([port,debugPort].every(value=>Number.isInteger(value)&&value>=1024&&value<=65535)&&port!==debugPort,'fuzz HTTP/CDP ports must be distinct valid unprivileged ports');
const origin=`http://127.0.0.1:${port}`,debugOrigin=`http://127.0.0.1:${debugPort}`;
const baseline = process.env.JOT_FUZZ_BASELINE === '1';
const traceFocus=process.env.JOT_FUZZ_TRACE_FOCUS==='1';
const traceGeometry=process.env.JOT_FUZZ_TRACE_GEOMETRY==='1';
const parsedScripts=[],geometryBreakpoints=[];
const output = resolve(process.env.JOT_FUZZ_OUTPUT ?? `dist/search-pointer-fuzz-report/${seed.toString(16)}`);
const fixture = resolve(`.tmp/search-pointer-fuzz-${port}`);
mkdirSync(output, { recursive: true });
mkdirSync(fixture, { recursive: true });
const fsUrl = path => '/@fs' + path;
const boot = fsUrl(resolve('packages/editor/src/worker/index.ts'));
const wasm = fsUrl(resolve('apps/demo/src/generated/editor_wasm.js'));
writeFileSync(resolve(fixture, 'worker.mjs'), `import {bootstrapEditorWorker} from ${JSON.stringify(boot)};\nawait bootstrapEditorWorker({endpoint:self,loadWasm:()=>import(${JSON.stringify(wasm)}),onError:e=>self.postMessage({type:'consumer-fatal',message:String(e)}),onFatalError:e=>self.postMessage({type:'consumer-fatal',message:String(e)})});\n`);
writeFileSync(resolve(fixture, 'vite.config.mjs'), `export default {root:${JSON.stringify(process.cwd())},cacheDir:${JSON.stringify(resolve(fixture, 'vite-cache'))},optimizeDeps:{noDiscovery:true},worker:{format:'es'},server:{host:'127.0.0.1',port:${port},strictPort:true,fs:{allow:[${JSON.stringify(process.cwd())}]}}};\n`);
const profile = mkdtempSync(resolve(tmpdir(), 'jot-search-pointer-fuzz-'));
const start = performance.now();
let server, chrome, c, mod = 4, randomState = seed || 1, operationIndex = 0, lastRevision = 0, currentSetup, activeBeforeState;
const operations = [], inputEvents = [], failures = [], directed = [], browserErrors = [], setups = [];
const counts = { randomOperations: 0, inputCommands: 0, keyDowns: 0, pointerPresses: 0, pointerMoves: 0, wheels: 0, textInsertions: 0, compositionUpdates: 0, searches: 0, replacements: 0, drags: 0, historyCycles: 0, bursts: 0, sourceOracleChecks: 0, viewportResizes:0 };
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) / 4294967296; };
const choose = values => values[Math.floor(random() * values.length)];
let activeOperation;
async function input(method, params) {
    const event = { index: inputEvents.length, operation: operationIndex, method, params, atMs: Math.round(performance.now() - start) };
    inputEvents.push(event);
    counts.inputCommands++;
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown')
        counts.keyDowns++;
    if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed')
            counts.pointerPresses++;
        if (params.type === 'mouseMoved')
            counts.pointerMoves++;
        if (params.type === 'mouseWheel')
            counts.wheels++;
    }
    if (method === 'Input.insertText')
        counts.textInsertions++;
    if (method === 'Input.imeSetComposition')
        counts.compositionUpdates++;
    const response=await c.command(method, params);event.completedAtMs=Math.round(performance.now()-start);return response;
}
async function key(name, modifiers = 0) {
    const code = /^[a-z]$/i.test(name) ? 'Key' + name.toUpperCase() : name === ' ' ? 'Space' : name;
    const virtual = { Enter: 13, Escape: 27, Tab: 9, ' ': 32, Backspace: 8, Delete: 46, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F3: 114 }[name] ?? (/^[a-z]$/i.test(name) ? name.toUpperCase().charCodeAt(0) : undefined);
    const key = keyboardEventKey(name, modifiers);
    await input('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, ...(virtual === undefined ? {} : { windowsVirtualKeyCode: virtual }), ...(name === 'Enter' && modifiers === 0 ? { text: '\r', unmodifiedText: '\r' } : {}), ...(name === 'a' && modifiers === mod ? { commands: ['selectAll'] } : {}) });
    await input('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
}
const settle = () => c.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,20))))`);
async function stable() { await waitForEvaluation(c, `editor.session.adapter.analysis?.state==='complete'&&editor.confirmedValue===view.state.doc.toString()`, 15000); await settle(); await c.evaluate('editor.livePreview.settled()'); }
async function state() { return c.evaluate(`(()=>{const s=view.state.selection;return {source:editor.confirmedValue,mirror:view.state.doc.toString(),revision:Number(editor.revision),ranges:s.ranges.map(r=>({from:r.from,to:r.to,anchor:r.anchor,head:r.head})),main:s.mainIndex,focus:document.activeElement?.className,query:editor.searchQuery,scroll:{top:view.scrollDOM.scrollTop,left:view.scrollDOM.scrollLeft},errors:[...window.fuzzErrors],composing:view.composing};})()`); }
function summary(s) { return { hash: hash(s.source), length: s.source.length, revision: s.revision, ranges: s.ranges, focus: s.focus, query: s.query, scroll: s.scroll }; }
function validPosition(source, pos) { return Number.isSafeInteger(pos) && pos >= 0 && pos <= source.length && !(pos > 0 && pos < source.length && /[\uD800-\uDBFF]/u.test(source[pos - 1]) && /[\uDC00-\uDFFF]/u.test(source[pos])); }
async function verify(label) { await stable(); const s = await state(); assert.equal(s.mirror, s.source, label + ': confirmed source equals CodeMirror'); assert(s.source.isWellFormed(), label + ': source is valid UTF-16'); assert(Number.isSafeInteger(s.revision) && s.revision >= lastRevision, label + ': monotonic legal revision'); lastRevision = s.revision; for (const r of s.ranges) {
    assert(validPosition(s.source, r.anchor) && validPosition(s.source, r.head), label + ': legal UTF-16 selection boundary');
} assert.deepEqual(s.errors, [], label + ': no uncaught/worker/editor errors'); assert.deepEqual(browserErrors, [], label + ': no Runtime exceptions'); return s; }
async function point(selector) { await waitForEvaluation(c, `!!document.querySelector(${JSON.stringify(selector)})`, 10000); return c.evaluate(`(()=>{const pane=view.dom.getBoundingClientRect();const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>{const r=n.getBoundingClientRect();return r.width>1&&r.height>1&&r.top>=pane.top&&r.bottom<=pane.bottom;});if(!n)throw Error('no visible target '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`); }
async function clickPoint(p, modifiers = 0, clickCount = 1) { await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, modifiers }); for (const type of ['mousePressed', 'mouseReleased'])
    await input('Input.dispatchMouseEvent', { type, button: 'left', clickCount, ...p, modifiers }); await settle(); }
async function click(selector, modifiers = 0, clickCount = 1) { await clickPoint(await point(selector), modifiers, clickCount); }
async function closeSearch() { if (await c.evaluate(`!!document.querySelector('.cm-search')`)) {
    await key('Escape');
    await settle();
} }
async function plainPoints({requireInterior=false}={}) {
    return c.evaluate(`(()=>{
      const pane=view.scrollDOM.getBoundingClientRect(),out=[];
      const clip={left:Math.max(1,pane.left+2),right:Math.min(innerWidth-1,pane.right-2),top:Math.max(1,pane.top+2),bottom:Math.min(innerHeight-1,pane.bottom-2)};
      for(const line of view.contentDOM.querySelectorAll('.cm-line')){
        const marker=line.textContent.match(/target[^\\s|]*/u)?.[0];
        if(!marker||line.querySelector('.jot-live-preview-widget'))continue;
        const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let text;
        while(text=walker.nextNode()){
          if(!text.nodeValue.trim())continue;
          const range=document.createRange();range.selectNodeContents(text);
          for(const rect of range.getClientRects()){
            const left=Math.max(rect.left,clip.left),right=Math.min(rect.right,clip.right),top=Math.max(rect.top,clip.top),bottom=Math.min(rect.bottom,clip.bottom);
            // Search marks split one real source line into short text nodes.
            // A 12px intersection still leaves each sampled point at least
            // 3px inside the text; the exact source-coordinate checks follow.
            if(right-left<=12||bottom-top<=5)continue;
            // Chromium retains fractions on PointerEvent but truncates them on
            // the MouseEvent consumed by CodeMirror. Sample and send the same
            // integer pixel, so glyph midpoint rounding cannot change the oracle.
            const y=Math.round((top+bottom)/2),a={x:Math.round(left+3),y},b={x:Math.round(left+Math.min(right-left-3,130)),y};
            let interior={x:Math.round(left+Math.min((right-left)/3,16)),y};
            if(![a,b,interior].every(point=>document.elementFromPoint(point.x,point.y)?.closest('.cm-line')===line))continue;
            const from=view.posAtCoords(a),to=view.posAtCoords(b);let interiorFrom=view.posAtCoords(interior);
            if([from,to,interiorFrom].some(offset=>offset===null))continue;
            const physical=view.state.doc.lineAt(from);
            // A short first text node can be one wide CJK glyph plus a space.
            // Its left-third pixel may still map to the physical line start.
            // Use the already sampled right point only if its source boundary
            // is strictly interior; otherwise inspect the next real text node.
            if(${requireInterior}){
                if(interiorFrom<=physical.from||interiorFrom>=physical.to){interior={...b};interiorFrom=to;}
                if(interiorFrom<=physical.from||interiorFrom>=physical.to)continue;
            }
            out.push({a,b,interior,from,to,interiorFrom,sourceLineFrom:view.state.doc.lineAt(from).from,sourceLineTo:view.state.doc.lineAt(from).to,text:line.textContent,marker,clip,rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}});
            break;
          }
          if(out.at(-1)?.marker===marker)break;
        }
      }
      return out;
    })()`);
}
async function assertNativePoint(point,expected,marker){
    const actual=await c.evaluate(`(()=>{const point=${JSON.stringify(point)},hit=document.elementFromPoint(point.x,point.y),line=hit?.closest('.cm-line'),pane=view.scrollDOM.getBoundingClientRect();return{visible:point.x>Math.max(0,pane.left)&&point.x<Math.min(innerWidth,pane.right)&&point.y>Math.max(0,pane.top)&&point.y<Math.min(innerHeight,pane.bottom),inside:!!hit&&view.contentDOM.contains(hit),text:line?.textContent,offset:view.posAtCoords(point),target:hit?.className};})()`);
    activeOperation.pointerSample={point,expected,marker,actual};
    assert(actual.visible&&actual.inside&&actual.text?.includes(marker),'pointer target is inside the actual visible native text/pane/browser intersection');
    assert.equal(actual.offset,expected,'sampled native source coordinate remains valid immediately before real pointer input');
}
async function focusPlain({requireInterior=false}={}) { const original=(await state()).source; await closeSearch(); let points = await plainPoints({requireInterior}); for (let tries = 0; points.length === 0 && tries < 12; tries++) {
    const p = await point('.cm-scroller');
    await input('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY: tries < 6 ? -400 : 400 });
    await settle();
    points = await plainPoints({requireInterior});
}
// Syntax edits can legitimately place a marker inside a large rendered owner.
// Reach that real source line through the user's search UI, rather than using
// a selection API or assuming the marker remains an ordinary paragraph.
if(!points.length){
    await openQuery('target');const paint=await searchNext('target');points=await plainPoints({requireInterior});
    // A search may correctly keep a same-text Runtime projection. Enter that
    // source through its real painted text before sampling native edit points.
    if(!points.length){
        const rect=paint.rects.find(rect=>rect.kind==='runtime'&&rect.text==='target'&&rect.x+rect.width>paint.pane.x&&rect.x<paint.pane.x+paint.pane.width&&rect.y+rect.height>paint.pane.y&&rect.y<paint.pane.y+paint.pane.height);
        assert(rect,'search provides an actual same-text Runtime hit to enter through the pointer');
        const point={x:Math.round((Math.max(rect.x,paint.pane.x+2)+Math.min(rect.x+rect.width,paint.pane.x+paint.pane.width-2))/2),y:Math.round((Math.max(rect.y,paint.pane.y+2)+Math.min(rect.y+rect.height,paint.pane.y+paint.pane.height-2))/2)};
        const component=await c.evaluate(`(()=>{const node=document.elementFromPoint(${point.x},${point.y})?.closest('[data-jot-kind]');return node?{kind:node.getAttribute('data-jot-kind'),contentFrom:node.hasAttribute('data-jot-source-content-from')?Number(node.getAttribute('data-jot-source-content-from')):null}:null;})()`);
        activeOperation.runtimeNativeEntry={range:paint.range,point,component};
        await clickPoint(point);await stable();const entered=(await state()).ranges[(await state()).main];
        assert.equal(entered.anchor,entered.head,'real Runtime text pointer enters a collapsed source caret');
        if(component&&['math-block','inline-math'].includes(component.kind)){
            assert(Number.isSafeInteger(component.contentFrom)&&validPosition(original,component.contentFrom),'opaque math exposes a legal source-content activation boundary');
            assert.equal(entered.head,component.contentFrom,'opaque math activates exactly at its declared source-content start');
        }else assert(entered.head>=paint.range.from&&entered.head<=paint.range.to,'Runtime pointer caret remains inside the exact known source hit');
        await expectSource(original,'Runtime pointer entry preserves the independent source model');
        points=await plainPoints({requireInterior});
    }
}
assert(points.length, 'fixture has a reachable native marker after real scrolling/search'); const selected = choose(points); await assertNativePoint(selected.a,selected.from,selected.marker); await clickPoint(selected.a); const s = await state(); assert.equal(s.ranges[s.main].head, selected.from, 'real plain-text pointer agrees with CodeMirror coordinate mapping'); await expectSource(original,'native pointer/focus leaves Markdown unchanged');
// The first real click can activate source and closing Search removes its
// header. Never return coordinates sampled before either UI transition.
await closeSearch();await stable();
const refreshed=(await plainPoints({requireInterior})).find(point=>point.sourceLineFrom===selected.sourceLineFrom);
assert(refreshed,'the clicked physical source line has a fresh visible native target after presentation settles');
activeOperation.refreshedPointer={sourceLineFrom:refreshed.sourceLineFrom,marker:refreshed.marker,from:refreshed.from,point:refreshed.a};
return refreshed; }
async function focusNativeInterior() {
    const selected=await focusPlain({requireInterior:true});
    await assertNativePoint(selected.interior,selected.interiorFrom,selected.marker);
    await clickPoint(selected.interior);
    const location=await c.evaluate(`(()=>{const r=view.state.selection.main,line=view.state.doc.lineAt(r.head);return{anchor:r.anchor,head:r.head,lineFrom:line.from,lineTo:line.to,text:line.text};})()`);
    activeOperation.editLocation=location;
    assert.equal(location.head,selected.interiorFrom,'real interior pointer agrees with source coordinate oracle');
    assert.equal(location.head,location.anchor,'interior native edit begins at a collapsed caret');
    assert(location.lineFrom<location.head&&location.head<location.lineTo,'grapheme edit oracle is inside a physical source line, away from component deletion boundaries');
    return selected;
}
async function dragToNative(selector) {
    const original = (await state()).source, startPoint = await point(selector);
    activeOperation.startPoint = startPoint;
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...startPoint });
    await input('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...startPoint });
    await settle();
    const pressed = await state(), anchor = pressed.ranges[pressed.main].anchor;
    const candidates = await plainPoints(), end = candidates.find(p => p.text.includes('targetEND'));
    assert(end, 'drag destination is an actually visible native END marker');
    activeOperation.drag = { anchor, expectedHead: end.from, endPoint: end.a };
    counts.drags++;
    for (let k = 1; k <= 8; k++)
        await input('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: startPoint.x + (end.a.x - startPoint.x) * k / 8, y: startPoint.y + (end.a.y - startPoint.y) * k / 8 });
    await input('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...end.a });
    await stable();
    const after = await state(), r = after.ranges[after.main];
    assert.equal(r.anchor, anchor, 'widget-to-native drag preserves the press anchor');
    assert.equal(r.head, end.from, 'widget-to-native drag reaches the actual source coordinate of native marker');
    assert(r.from < r.to, 'widget-to-native drag creates a real range');
    await expectSource(original, 'widget-to-native drag never edits source');
}
async function inputBurst() {
    await focusPlain();
    const before = await state(), r = before.ranges[before.main];
    let model = before.source, from = r.from, to = r.to;
    counts.bursts++;
    // Deliberately no stable()/rAF/Worker acknowledgement inside this loop.
    for (let n = 0; n < 10; n++) {
        const text = 'b' + n;
        await input('Input.insertText', { text });
        model = model.slice(0, from) + text + model.slice(to);
        from += text.length;
        to = from;
        if (n % 3 === 2) {
            await key('ArrowLeft');
            from--;
            to = from;
        }
        if (n === 4) {
            const p = await point('.cm-scroller');
            await input('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY: 120 });
        }
    }
    const burstEnd = await state();
    activeOperation.burst = {kind:'native-input',startRevision:before.revision,endRevision:burstEnd.revision,confirmedHash:hash(burstEnd.source),mirrorHash:hash(burstEnd.mirror),pendingConfirmation:burstEnd.source!==burstEnd.mirror};
    await stable();
    await expectSource(model, 'rapid native input/arrow/wheel burst matches independent string model');
}
async function replaceBurst() {
    const s = await state(), tokens = s.source.match(/needle[a-zA-Z0-9]+/gu) ?? s.source.match(/[a-zA-Z]{4,12}/gu);
    const query = s.source.includes('needle') ? 'needle' : choose(tokens);
    await openQuery(query);
    await searchNext(query);
    await field('.cm-search input[name=replace]', 'burstvalue');
    let model = (await state()).source, at = (await state()).ranges[(await state()).main].from;
    const button = await point('.cm-search button[name=replace]'), scroll = await point('.cm-scroller');
    counts.bursts++;
    for (let n = 0; n < 3; n++) {
        const hits = literalHits(model, query);
        if (!hits.length)
            break;
        assert.equal(model.slice(at, at + query.length), query, 'burst replacement model owns current literal match');
        model = model.slice(0, at) + 'burstvalue' + model.slice(at + query.length);
        at = literalHits(model, query).find(p => p >= at + 'burstvalue'.length) ?? literalHits(model, query)[0];
        for (const type of ['mousePressed', 'mouseReleased'])
            await input('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...button });
        await input('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scroll, deltaX: 0, deltaY: 40 });
    }
    const burstEnd = await state();
    activeOperation.burst = {kind:'replace-next',endRevision:burstEnd.revision,confirmedHash:hash(burstEnd.source),mirrorHash:hash(burstEnd.mirror),pendingConfirmation:burstEnd.source!==burstEnd.mirror};
    await stable();
    await expectSource(model, 'rapid ReplaceNext/wheel burst matches independent source-index model');
    await closeSearch();
}
async function load(source) { await closeSearch(); currentSetup = { operation: operationIndex, source }; setups.push(currentSetup); await c.evaluate(`editor.setValue(${JSON.stringify(source)})`); await stable(); await c.evaluate('document.fonts.ready.then(()=>true)'); await settle(); lastRevision = Number(await c.evaluate('editor.revision')); }
async function field(selector, value) { await click(selector); await key('a', mod); assert(await c.evaluate(`document.activeElement instanceof HTMLInputElement&&document.activeElement.selectionStart===0&&document.activeElement.selectionEnd===document.activeElement.value.length`), 'native field select-all'); await input('Input.insertText', { text: value }); await settle(); }
async function assertSearchPanelLayout(){
    const layout=await c.evaluate(`(()=>{const panel=view.dom.querySelector('.cm-search');const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return{panel:rect(panel),controls:[...panel.querySelectorAll('input,button')].map(node=>({name:node.name,type:node.type,...rect(node)}))};})()`);
    activeOperation.searchPanelLayout=layout;
    for(const control of layout.controls){
        assert(control.width>0&&control.height>0,'every native search control has a visible box');
        assert(control.left>=layout.panel.left-0.5&&control.right<=layout.panel.right+0.5&&control.top>=layout.panel.top-0.5&&control.bottom<=layout.panel.bottom+0.5,'wrapped search controls remain inside the actual panel');
    }
    for(let left=0;left<layout.controls.length;left++)for(let right=left+1;right<layout.controls.length;right++){
        const a=layout.controls[left],b=layout.controls[right];
        assert(!(Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0.5),'native search controls never overlap: '+a.name+' / '+b.name);
    }
}
async function openQuery(query) { counts.searches++; await closeSearch(); await key('f', mod); assert(await c.evaluate(`document.activeElement?.matches('.cm-search input[name=search]')`), 'Mod-f focuses real search input'); await field('.cm-search input[name=search]', query); for (const [name, wanted] of [['case', true], ['re', false], ['word', false]])
    if (await c.evaluate(`document.querySelector('.cm-search input[name=${name}]').checked!==${wanted}`))
        await click(`.cm-search input[name=${name}]`); await click('.cm-search input[name=search]'); await settle(); await assertSearchPanelLayout(); }
async function paintedMatch(query) {
    const paint = await c.evaluate(`(()=>{const pane=view.scrollDOM.getBoundingClientRect();const result=[];for(const n of view.dom.querySelectorAll('.cm-searchMatch-selected')){const style=getComputedStyle(n);for(const r of n.getClientRects())result.push({x:r.x,y:r.y,width:r.width,height:r.height,text:n.textContent,background:style.backgroundColor,kind:'native'});}for(const n of view.dom.querySelectorAll('.jot-search-current-node,.jot-search-match-node[data-jot-search-current]')){const r=n.getBoundingClientRect();result.push({x:r.x,y:r.y,width:r.width,height:r.height,text:n.textContent,background:getComputedStyle(n).backgroundColor,kind:'fallback'});}const custom=CSS.highlights?.get('jot-search-current');if(custom)for(const range of custom)for(const r of range.getClientRects()){const node=range.startContainer.parentElement,table=node?.closest('.jot-table'),clip=table?.getBoundingClientRect();result.push({x:r.x,y:r.y,width:r.width,height:r.height,text:range.toString(),background:node?getComputedStyle(node,'::highlight(jot-search-current)').backgroundColor:'',kind:'runtime',clip:clip?{x:clip.x,y:clip.y,width:clip.width,height:clip.height}:undefined});}return {rects:result,pane:{x:pane.x,y:pane.y,width:pane.width,height:pane.height},selected:view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to),range:{from:view.state.selection.main.from,to:view.state.selection.main.to}};})()`);
    assert.equal(paint.selected, query, 'search chooses exact source text');
    const visible = paint.rects.filter(r => r.width > 0 && r.height > 0 && r.y + r.height > paint.pane.y && r.y < paint.pane.y + paint.pane.height && r.x + r.width > Math.max(paint.pane.x,r.clip?.x??paint.pane.x) && r.x < Math.min(paint.pane.x + paint.pane.width,r.clip?r.clip.x+r.clip.width:Infinity) && r.y+r.height>Math.max(paint.pane.y,r.clip?.y??paint.pane.y) && r.y<Math.min(paint.pane.y+paint.pane.height,r.clip?r.clip.y+r.clip.height:Infinity));
    activeOperation.coloredRects = paint;
    if(!visible.length)activeOperation.decorationCoverage=await c.evaluate(`(async()=>{
      const url=performance.getEntriesByType('resource').find(entry=>entry.name.includes('/node_modules/@codemirror/view/dist/index.js'))?.name;
      if(!url)return{error:'existing CodeMirror view module URL missing'};
      const {EditorView}=await import(url),selection=view.state.selection.main,covers=[];
      for(const input of view.state.facet(EditorView.decorations)){
        const set=typeof input==='function'?input(view):input;if(!set?.between)continue;
        set.between(selection.from,selection.to,(from,to,value)=>{if(from<selection.to&&selection.from<to)covers.push({from,to,widget:value.spec.widget?.constructor.name,estimatedHeight:value.spec.widget?.estimatedHeight,node:value.spec.jotLiveNode,structural:value.spec.jotLiveStructural,selection:value.spec.jotLiveSelection,block:value.spec.block,className:value.spec.class,keys:Object.keys(value.spec)});});
      }
      return{timeStamp:performance.now(),selection:{from:selection.from,to:selection.to},covers,scrollTop:view.scrollDOM.scrollTop,viewport:view.viewport,visibleRanges:view.visibleRanges,geometryNodes:[...view.contentDOM.querySelectorAll('[data-jot-geometry]')].map(node=>({className:node.className,renderKey:node.dataset.jotRenderKey,style:node.getAttribute('style')}))};
    })()`);
    assert(visible.length, 'current hit has an actual painted highlight range inside viewport ' + JSON.stringify(paint));
    assert(visible.some(r => r.background && r.background !== 'rgba(0, 0, 0, 0)' && r.background !== 'transparent'), 'current highlight has a nontransparent CSS color');
    return paint;
}
async function paintedPointerSelection({requireTextRange=false}={}) {
    const paint=await c.evaluate(`(()=>{
      const selection=view.state.selection.main,pane=view.scrollDOM.getBoundingClientRect(),source=view.state.doc.toString(),ranges=[],fallback=[];
      const anchor=n=>{const e=(n instanceof Element?n:n.parentElement)?.closest('[data-jot-source-from][data-jot-source-to]');return e?{from:Number(e.getAttribute('data-jot-source-from')),to:Number(e.getAttribute('data-jot-source-to')),text:e.textContent}:undefined;};
      const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height});
      for(const range of CSS.highlights?.get('jot-preview-selection')??[]){const node=range.startContainer.parentElement;for(const r of range.getClientRects())ranges.push({...rect(r),text:range.toString(),anchor:anchor(range.startContainer),background:node?getComputedStyle(node,'::highlight(jot-preview-selection)').backgroundColor:''});}
      for(const node of view.contentDOM.querySelectorAll('.jot-preview-selection-node'))fallback.push({...rect(node.getBoundingClientRect()),anchor:anchor(node),background:getComputedStyle(node).backgroundColor});
      return {selection:{from:selection.from,to:selection.to,anchor:selection.anchor,head:selection.head},selectedText:source.slice(selection.from,selection.to),source,ranges,fallback,pane:rect(pane)};
    })()`);
    activeOperation.pointerSelectionPaint={...paint,source:undefined};
    assert(paint.selection.from<paint.selection.to,'pointer highlight corresponds to a real noncollapsed native selection');
    const visible=rect=>rect.width>0&&rect.height>0&&rect.y+rect.height>paint.pane.y&&rect.y<paint.pane.y+paint.pane.height;
    const colored=rect=>rect.background&&rect.background!=='transparent'&&rect.background!=='rgba(0, 0, 0, 0)';
    assert([...paint.ranges,...paint.fallback].some(rect=>visible(rect)&&colored(rect)),'pointer selection has an actual colored runtime range or opaque component shell');
    if(requireTextRange)assert(paint.ranges.some(rect=>visible(rect)&&colored(rect)&&rect.text),'textual table selection uses an exact CSS Highlight text range');
    for(const rect of [...paint.ranges,...paint.fallback]) {
        assert(rect.anchor&&Number.isSafeInteger(rect.anchor.from)&&Number.isSafeInteger(rect.anchor.to),'runtime selection paint has a semantic source anchor');
        assert(rect.anchor.from<paint.selection.to&&rect.anchor.to>paint.selection.from,'painted runtime anchor intersects the actual native source range');
        if(rect.text)assert(paint.selectedText.includes(rect.text),'painted text belongs to the actual selected source substring');
        if(rect.text&&paint.source.slice(rect.anchor.from,rect.anchor.to)===rect.anchor.text) {
            assert.equal(rect.text,paint.source.slice(Math.max(paint.selection.from,rect.anchor.from),Math.min(paint.selection.to,rect.anchor.to)),'same-text runtime highlight matches the exact selected source intersection');
        }
    }
    return paint;
}
function literalHits(source, query) { const result = []; for (let at = source.indexOf(query); at >= 0; at = source.indexOf(query, at + Math.max(1, query.length)))
    result.push(at); return result; }
async function searchNext(query, previous = false) { const before = await state(), r = before.ranges[before.main], hits = literalHits(before.source, query); assert(hits.length, 'search oracle query exists'); const expected = previous ? (hits.filter(at => at + query.length <= r.from).at(-1) ?? hits.at(-1)) : (hits.find(at => at >= r.to) ?? hits[0]); await key('Enter', previous ? 8 : 0); await stable(); const paint = await paintedMatch(query); assert.equal(paint.range.from, expected, 'search next/previous follows full source index and wraps'); return paint; }
async function indexedSearchNext(matches,previous=false) {
    const before=await state(),range=before.ranges[before.main];
    const expected=previous?(matches.filter(match=>match.index+match.text.length<=range.from).at(-1)??matches.at(-1)):(matches.find(match=>match.index>=range.to)??matches[0]);
    assert(expected,'JS search oracle has at least one match');
    await key('Enter',previous?8:0);await stable();
    const paint=await paintedMatch(expected.text);
    assert.equal(paint.range.from,expected.index,'real regex/whole-word search follows independent JS match indexes');
}
async function screenshot(name) { const { data } = await c.command('Page.captureScreenshot', { format: 'png' }); writeFileSync(resolve(output, name + '.png'), Buffer.from(data, 'base64')); }
async function expectSource(expected, label) { counts.sourceOracleChecks++; assert.equal((await state()).source, expected, label); }
async function saveFailure(error, name) { const safe = name.replace(/[^a-zA-Z0-9_-]/gu, '-'); let s; try {
    s = await state();
    writeFileSync(resolve(output, safe + '-source.md'), s.source);
    writeFileSync(resolve(output, safe + '-dom.html'), await c.evaluate('view.dom.outerHTML'));
    await screenshot(safe);
}
catch { } const detail = { name, seed, operationIndex, focusEvents:traceFocus?await c.evaluate('window.fuzzFocusEvents'):undefined, error: String(error.stack ?? error), expected: error.expected, actual: error.actual, state: s, coloredRects: activeOperation?.coloredRects, context: { setup: currentSetup, beforeSource: activeBeforeState?.source, beforeSelection: activeBeforeState?.ranges, nearSelection: s?.ranges.map(r => ({ range: r, text: s.source.slice(Math.max(0, r.from - 150), Math.min(s.source.length, r.to + 150)) })), events: inputEvents.slice(activeOperation?.eventStart ?? 0) }, events: await c.evaluate('window.fuzzEvents').catch(() => []), activeOperation }; failures.push(detail); writeFileSync(resolve(output, safe + '-repro.json'), JSON.stringify({ seed,harnessSha256,initialSource: currentSetup?.source, target, operationIndex, replayCommand: `JOT_FUZZ_SEED=${seed} JOT_FUZZ_STEPS=${target} node scripts/browser/diagnostics/editor-search-pointer-fuzz.mjs`, setups, operations, inputEvents, failure: detail }, null, 2)); }
async function run(name, body, { direct = false } = {}) { if (direct && process.env.JOT_FUZZ_CASE && !process.env.JOT_FUZZ_CASE.split(',').includes(name))
    return; activeOperation = { index: operationIndex++, name, eventStart: inputEvents.length }; operations.push(activeOperation); try {
    activeBeforeState = await state();
    activeOperation.before = summary(activeBeforeState);
    await body();
    activeOperation.after = summary(await verify(name));
    activeOperation.eventEnd = inputEvents.length;
    if (direct)
        directed.push({ name, passed: true });
}
catch (error) {
    activeOperation.error = String(error);
    await saveFailure(error, name);
    if (direct)
        directed.push({ name, passed: false, error: String(error) });
    if (!baseline || !direct)
        throw error;
} }
const initialCorpus = Array.from({ length: 36 }, (_, i) => {
    const id = String(i).padStart(3, '0');
    return [`Plain target${id} needleparagraph${id} alpha beta gamma 中文🙂 e\u0301. ${'Soft wrapped words '.repeat(i % 4 + 1)}`, `## Heading needleheading${id}`, `- list needlelist${id}\n- second item`, `> quoted needlequote${id}`, `Text **strong${id}** and $inline${id}+x$.`, ...(process.env.JOT_FUZZ_INLINE_TASK ? [`- [ ] task${id}\n- [x] done${id}`, `~~deleted *italic${id}*~~ \\~literal\\~`, `<https://example.com/item${id}>`] : []), `\`\`\` js begin\nconst needlecode${id} = 1;\n\`\`\` end`, `$$\nneedlemath${id} + x\n$$`, `| needletable${id} | Second |\n| --- | --- |\n| $cell${id}+x$ | needlecell${id} |`].join('\n\n');
}).join('\n\n') + '\n\nPlain targetEND final needleend 针 end.';
try {
    server = spawn(resolve('node_modules/.bin/vite'), ['--config', resolve(fixture, 'vite.config.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    for (const stream of [server.stdout, server.stderr])
        stream.on('data', chunk => { serverLog += String(chunk); writeFileSync(resolve(output, 'vite.log'), serverLog); });
    const fixtureUrl = origin + fsUrl(resolve('scripts/browser/support/editor-browser-fixture.html'));
    await waitForHttp(fixtureUrl, 15000);
    chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, fixtureUrl], { stdio: 'ignore' });
    await waitForHttp(debugOrigin+'/json/version', 15000);
    const pages = await fetch(debugOrigin+'/json/list').then(r => r.json());
    c = await connectCdp(pages.find(p => p.type === 'page' && p.url.startsWith(origin+'/')).webSocketDebuggerUrl);
    c.socket.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if(m.method==='Debugger.scriptParsed')parsedScripts.push(m.params);if (m.method === 'Runtime.exceptionThrown')
        browserErrors.push(m.params); });
    if(traceGeometry)await c.command('Debugger.enable');
    await c.command('Runtime.enable');
    await c.command('Page.enable');
    await c.command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
    await waitForEvaluation(c, `document.readyState==='complete'&&document.title==='Jot native component integration fixture'`, 15000);
    await c.evaluate(`(async()=>{window.fuzzErrors=[];window.fuzzEvents=[];window.fuzzEventCounts={};addEventListener('error',e=>fuzzErrors.push(String(e.error?.stack??e.message)));addEventListener('unhandledrejection',e=>fuzzErrors.push(String(e.reason?.stack??e.reason)));const {MarkdownEditor,createKaTeXRenderer}=await import(${JSON.stringify(fsUrl(resolve('packages/editor/src/index.ts')))});await import(${JSON.stringify(fsUrl(resolve('packages/editor/node_modules/katex/dist/katex.min.css')))});const root=document.createElement('div');root.id='integration';root.style.cssText='width:min(900px,calc(100vw - 20px));height:700px;margin:10px';document.body.replaceChildren(root);window.worker=new Worker(${JSON.stringify(fsUrl(resolve(fixture, 'worker.mjs')))},{type:'module'});worker.addEventListener('error',e=>fuzzErrors.push('worker:'+e.message));worker.addEventListener('message',e=>{if(e.data?.type==='consumer-fatal')fuzzErrors.push(e.data.message);});window.editor=new MarkdownEditor({root,mode:'live-preview',surface:{renderMath:createKaTeXRenderer()},session:{endpoint:worker,documentId:'consumer-search-pointer-fuzz',generation:1,source:'ready',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>fuzzErrors.push(String(e.stack??e))});await editor.open();window.view=editor.input.view;window.fuzzFocusEvents=[];if(${traceFocus}){
const label=node=>node?{tag:node.tagName,className:node.className,name:node.getAttribute?.('name'),text:node.nodeType===3?node.nodeValue?.slice(0,70):undefined}:null;
const record=event=>{fuzzFocusEvents.push(event);if(fuzzFocusEvents.length>4000)fuzzFocusEvents.shift();};
const originalFocus=HTMLElement.prototype.focus;
HTMLElement.prototype.focus=function(...args){record({type:'focus-call',timeStamp:performance.now(),target:label(this),active:label(document.activeElement),stack:new Error().stack});return Reflect.apply(originalFocus,this,args);};
for(const name of ['collapse','setPosition','modify','extend','setBaseAndExtent','addRange','removeAllRanges','empty','collapseToStart','collapseToEnd','selectAllChildren','deleteFromDocument']){
 const original=Selection.prototype[name];if(typeof original!=='function')continue;
 Selection.prototype[name]=function(...args){record({type:'Selection.'+name,timeStamp:performance.now(),active:label(document.activeElement),args:args.map(arg=>arg instanceof Node?label(arg):arg instanceof Range?{start:label(arg.startContainer),startOffset:arg.startOffset,end:label(arg.endContainer),endOffset:arg.endOffset}:arg),stack:new Error().stack});return Reflect.apply(original,this,args);};
}
for(const type of ['focusin','focusout','selectionchange'])document.addEventListener(type,event=>{const domSelection=document.getSelection();record({type,timeStamp:event.timeStamp,target:label(event.target),related:label(event.relatedTarget),active:label(document.activeElement),selection:{from:view.state.selection.main.from,to:view.state.selection.main.to},domSelection:domSelection?{anchor:label(domSelection.anchorNode),anchorOffset:domSelection.anchorOffset,focus:label(domSelection.focusNode),focusOffset:domSelection.focusOffset}:undefined});},true);
const stateUrl=performance.getEntriesByType('resource').find(entry=>entry.name.includes('/node_modules/@codemirror/state/dist/index.js'))?.name;
if(!stateUrl)throw Error('trace requires the already loaded CodeMirror state module URL');
const {Transaction}=await import(stateUrl);
const originalDispatch=view.dispatch;
view.dispatch=function(...args){record({type:'view.dispatch',timeStamp:performance.now(),active:label(document.activeElement),transactions:args.map(tr=>({userEvent:typeof tr.annotation==='function'?tr.annotation(Transaction.userEvent):tr.userEvent,annotationValues:tr.annotations?.map?.(a=>a.value),selection:tr.selection?{anchor:tr.selection.anchor,head:tr.selection.head}:undefined})),stack:new Error().stack});return Reflect.apply(originalDispatch,this,args);};
const originalTransactions=view.dispatchTransactions;
view.dispatchTransactions=function(transactions,...rest){record({type:'dispatchTransactions',timeStamp:performance.now(),active:label(document.activeElement),transactions:transactions.map(tr=>({userEvent:tr.annotation(Transaction.userEvent),selection:{from:tr.state.selection.main.from,to:tr.state.selection.main.to},docChanged:tr.docChanged,selectionSet:tr.selection!==undefined})),stack:new Error().stack});return Reflect.apply(originalTransactions,this,[transactions,...rest]);};
}for(const type of ['keydown','pointerdown','beforeinput','compositionstart','compositionupdate','compositionend'])root.addEventListener(type,event=>{fuzzEventCounts[type]=(fuzzEventCounts[type]??0)+1;fuzzEvents.push({type,timeStamp:event.timeStamp,data:event.data,inputType:event.inputType,isTrusted:event.isTrusted,isComposing:event.isComposing,target:event.target.className});if(fuzzEvents.length>300)fuzzEvents.shift();},{capture:true});})()`);
    if(traceGeometry){
        const script=parsedScripts.find(script=>script.url.includes('/hosts/live-preview/controller.ts'));
        assert(script,'diagnostic debugger observes the actual consumer controller module');
        const {scriptSource}=await c.command('Debugger.getScriptSource',{scriptId:script.scriptId});
        const lines=scriptSource.split('\n'),start=lines.findIndex(line=>/^\s*#revealMeasuredSearchTarget\s*\(/u.test(line));
        assert(start>=0,'diagnostic finds current compiled search measure method');
        const end=lines.findIndex((line,index)=>index>start&&/^\s*#onKeyDown\s*\(/u.test(line));
        let phase=0;
        for(let index=start;index<end;index++)if(lines[index].includes('if (!current()')){
            const label=['entry','read','write','microtask'][phase++]??'guard';
            const condition="(globalThis.fuzzFocusEvents.push({type:'search-reveal-"+label+"',timeStamp:performance.now(),current:current(),attempt,target:{from:target.from,to:target.to,epoch:target.epoch},epoch:this.#userScrollEpoch,pointer:this.#pointerSelecting,intent:this.#searchSelectionActive,confirmed:this.#sourceIsConfirmed(),sourceReveal:this.#searchSourceReveal,sameDoc:target.doc===view.state.doc,selection:{from:view.state.selection.main.from,to:view.state.selection.main.to},scrollTop:view.scrollDOM.scrollTop,visible:typeof visible==='undefined'?null:visible,measured:typeof measured==='undefined'?null:measured,runtimeVisible:"+(label==='read'?"canPaintRuntimeSearchRange(view,target)":"null")+"}),false)";
            const breakpoint=await c.command('Debugger.setBreakpoint',{location:{scriptId:script.scriptId,lineNumber:index},condition});geometryBreakpoints.push({label,line:index+1,...breakpoint});
        }
        const nativeReturn=lines.findIndex((line,index)=>index>start&&index<end&&line.includes('return { visible: Math.abs(dx)'));
        if(nativeReturn>=0){
            const condition="(globalThis.fuzzFocusEvents.push({type:'search-native-range',timeStamp:performance.now(),current:current(),attempt,target:{from:target.from,to:target.to,epoch:target.epoch},epoch:this.#userScrollEpoch,sourceReveal:this.#searchSourceReveal,intent:this.#searchSelectionActive,rangeText:range.toString(),expectedText:view.state.sliceDoc(target.from,target.to),start:{offset:from.offset,text:from.node.textContent?.slice(Math.max(0,from.offset-30),from.offset+40),line:from.node.parentElement?.closest('.cm-line')?.textContent},end:{offset:to.offset,text:to.node.textContent?.slice(Math.max(0,to.offset-30),to.offset+40),line:to.node.parentElement?.closest('.cm-line')?.textContent},bounds:{left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom,width:bounds.width,height:bounds.height},pane:{left:pane.left,right:pane.right,top:pane.top,bottom:pane.bottom},dx,dy,scrollTop:view.scrollDOM.scrollTop,coloredRects:[...view.contentDOM.querySelectorAll('.cm-searchMatch-selected')].flatMap(node=>[...node.getClientRects()].map(rect=>({text:node.textContent,top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right})))}),false)";
            const breakpoint=await c.command('Debugger.setBreakpoint',{location:{scriptId:script.scriptId,lineNumber:nativeReturn},condition});geometryBreakpoints.push({label:'native-range',line:nativeReturn+1,...breakpoint});
        }
        const apply=lines.findIndex(line=>line.includes('const searchTarget = this.#pendingSearchScroll;'));
        assert(apply>=0,'diagnostic finds apply-plan search target consumption');
        const condition="(globalThis.fuzzFocusEvents.push({type:'search-apply',timeStamp:performance.now(),pending:this.#pendingSearchScroll?{from:this.#pendingSearchScroll.from,to:this.#pendingSearchScroll.to,epoch:this.#pendingSearchScroll.epoch}:null,epoch:this.#userScrollEpoch,pointer:this.#pointerSelecting,intent:this.#searchSelectionActive,confirmed:this.#sourceIsConfirmed(),sourceReveal:this.#searchSourceReveal,selection:{from:this.#view.state.selection.main.from,to:this.#view.state.selection.main.to},scrollTop:this.#view.scrollDOM.scrollTop}),false)";
        const breakpoint=await c.command('Debugger.setBreakpoint',{location:{scriptId:script.scriptId,lineNumber:apply},condition});geometryBreakpoints.push({label:'apply',line:apply+1,...breakpoint});
    }
    mod = await c.evaluate('/Mac|iPhone|iPad/.test(navigator.platform)') ? 4 : 2;
    if(process.env.JOT_FUZZ_CAPTURED_REPRO)await run('diagnostic-captured-owner-transition',async()=>{
        const capture=JSON.parse(readFileSync(resolve(process.env.JOT_FUZZ_CAPTURED_REPRO),'utf8'));
        const source=capture.failure.context.beforeSource;
        assert(typeof source==='string','captured diagnostic has the exact pre-failure document');
        if(capture.failure.name==='random-689-key'){
            await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});await load(source);
            const start=(await plainPoints()).find(point=>point.marker==='target000');
            assert(start,'captured gap case begins from actual visible native text');await assertNativePoint(start.a,start.from,start.marker);await clickPoint(start.a);
            await openQuery('value5595');await searchNext('value5595');
            await openQuery('target');const current=await searchNext('target');
            assert.equal(current.range.from,3850,'captured search transition reaches the exact hidden-gap destination');
            await expectSource(source,'captured geometry exclusion search preserves exact Markdown');return;
        }
        await c.command('Emulation.setDeviceMetricsOverride',{width:700,height:850,deviceScaleFactor:1,mobile:false});await load(source);
        const start=(await plainPoints()).find(point=>point.marker==='target000');
        assert(start,'captured diagnostic begins from a visible native source line');await assertNativePoint(start.a,start.from,start.marker);await clickPoint(start.a);
        await openQuery('target017');const previous=await searchNext('target017');
        const expectedPrevious=source.indexOf('target017'),expectedNext=source.indexOf('target',expectedPrevious+'target017'.length);
        assert.equal(previous.range.from,expectedPrevious,'short diagnostic first reveals the previous math owner');
        await field('.cm-search input[name=search]','target');
        await waitForEvaluation(c,`view.state.selection.main.from===${expectedPrevious}&&view.state.selection.main.to===${expectedPrevious+6}`,5000);
        activeOperation.ownerTransition={previous,expectedPrevious,expectedNext};
        const current=await searchNext('target');assert.equal(current.range.from,expectedNext,'real FindNext crosses to the next source owner');await expectSource(source,'captured two-owner transition never edits source');
    },{direct:true});
    await run('direct-table-katex-pointer', async () => { await load('Plain targetSTART introduction\n\n| A | B |\n| --- | --- |\n| $needle+x$ | stable |\n\nPlain targetEND'); const cell = await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-body .jot-table-cell');return{from:Number(n.dataset.jotSourceFrom),to:Number(n.dataset.jotSourceTo)};})()`); await click('.jot-table-grid-body .katex-html .katex-base'); const s = await state(), r = s.ranges[s.main]; assert(r.head >= cell.from && r.head <= cell.to, 'nested KaTeX pointer maps into its confirmed cell, never document zero'); }, { direct: true });
    await run('direct-math-widget-shift-click', async () => { await load('Plain targetSTART introduction\n\n$$\nneedle + x\n$$\n\nPlain targetEND'); await focusPlain(); const before = await state(), anchor = before.ranges[before.main].anchor; await click('.jot-live-preview-widget--math-block .katex-html', 8); const after = await state(), r = after.ranges[after.main]; assert.equal(r.anchor, anchor, 'Shift-click rendered widget preserves original native selection anchor'); assert(r.from < r.to, 'Shift-click extends native selection into widget'); }, { direct: true });
    await run('direct-replace-next-hidden-hit', async () => { const source = 'Plain targetSTART needle\n\n$$\nneedle + x\n$$\n\n| H |\n| --- |\n| needle |\n\nPlain targetEND'; await load(source); await focusPlain(); await openQuery('needle'); await searchNext('needle'); const selected = await state(), r = selected.ranges[selected.main]; await field('.cm-search input[name=replace]', 'changed'); await click('.cm-search button[name=replace]'); await stable(); const after = await state(); assert.equal(after.source, source.slice(0, r.from) + 'changed' + source.slice(r.to), 'ReplaceNext changes only selected source occurrence'); await paintedMatch('needle'); await closeSearch(); await key('z', mod); await stable(); await expectSource(source, 'ReplaceNext single undo'); await key('z', mod | 8); await stable(); await expectSource(after.source, 'ReplaceNext redo'); }, { direct: true });
    await run('direct-query-input-ime', async () => { const source = 'Plain targetSTART needle 针\n\nPlain targetEND'; await load(source); await focusPlain(); await openQuery('needle'); await click('.cm-search input[name=search]'); await key('a', mod); const before = await state(); await input('Input.imeSetComposition', { text: 'zhen', selectionStart: 4, selectionEnd: 4 }); await settle(); assert.equal(await c.evaluate(`document.querySelector('.cm-search input[name=search]').value`), 'zhen', 'browser retains native query composition candidate'); assert.equal((await state()).query.search, before.query.search, 'uncommitted query IME does not rewrite SearchQuery'); await input('Input.insertText', { text: '针' }); await settle(); assert.equal((await state()).query.search, '针', 'committed query IME updates search once'); await expectSource(source, 'query composition never edits Markdown'); }, { direct: true });
    await run('direct-runtime-query-highlight', async () => {
        const source='Plain targetSTART introduction\n\n| A | B |\n| --- | --- |\n| needlewidget | secondwidget |\n\nPlain targetEND';
        await load(source);await focusPlain();await openQuery('needlewidget');
        for(const query of ['needlewidget','secondwidget']) {
            if(query!=='needlewidget')await field('.cm-search input[name=search]',query);
            await settle();
            const ranges=await c.evaluate(`(()=>{const result=[];for(const range of CSS.highlights?.get('jot-search-match')??[]){const n=range.startContainer.parentElement;for(const r of range.getClientRects())if(r.width>0&&r.height>0)result.push({text:range.toString(),x:r.x,y:r.y,width:r.width,height:r.height,background:n?getComputedStyle(n,'::highlight(jot-search-match)').backgroundColor:''});}return result;})()`);
            activeOperation.coloredRects={query,ranges};
            assert(ranges.some(r=>r.text===query&&r.background&&r.background!=='rgba(0, 0, 0, 0)'&&r.background!=='transparent'),'query input paints exact visible runtime text before Enter');
            assert(ranges.every(r=>r.text===query),'query change removes obsolete runtime highlight ranges');
        }
        await expectSource(source,'query highlight updates never edit Markdown');await closeSearch();
    },{direct:true});
    for (const kind of ['math', 'table'])
        await run('direct-' + kind + '-drag-to-native', async () => {
            const source = kind === 'math' ? 'Plain targetSTART introduction\n\n$$\nneedle + x\n$$\n\nPlain targetEND' : 'Plain targetSTART introduction\n\n| A | B |\n| --- | --- |\n| $needle+x$ | stable |\n\nPlain targetEND';
            await load(source);
            await dragToNative(kind === 'math' ? '.jot-live-preview-widget--math-block .katex-html' : '.jot-table-grid-body .katex-html .katex-base');
            assert(await c.evaluate(`!!view.contentDOM.querySelector('.jot-live-preview-widget--selected,.jot-live-preview-table-cell--selected')`), 'dragged range has a painted selected widget/cell state');
            await paintedPointerSelection();
        }, { direct: true });
    for (const kind of ['math', 'table'])
        for (const clickCount of [2, 3])
            await run('direct-' + kind + '-' + clickCount + '-click-shift-extend', async () => {
                const source = kind === 'math' ? 'Plain targetSTART introduction\n\n$$\nneedle + x\n$$\n\nPlain targetEND' : 'Plain targetSTART introduction\n\n| A | B |\n| --- | --- |\n| needleword | stable |\n\nPlain targetEND';
                await load(source);
                await click(kind === 'math' ? '.jot-live-preview-widget--math-block .katex-html' : '.jot-table-grid-body .jot-inline-text', 0, clickCount);
                await stable();
                const selected = await state(), r = selected.ranges[selected.main];
                assert(r.from < r.to, 'real multi-click selects source text in ' + kind);
                assert(selected.source.slice(r.from, r.to).length > 0, 'multi-click selected substring is nonempty');
                await paintedPointerSelection({requireTextRange:kind==='table'});
                const anchor = r.anchor;
                await key('ArrowRight', 8);
                await stable();
                const extended = await state(), next = extended.ranges[extended.main];
                assert.equal(next.anchor, anchor, 'Shift+Arrow keeps multi-click anchor');
                assert(next.head !== r.head, 'Shift+Arrow continues extending rather than getting trapped at widget');
                assert(await c.evaluate(`!!view.contentDOM.querySelector('.jot-live-preview-widget--selected,.jot-live-preview-table-cell--selected')`), 'extended range keeps a painted selected widget/cell state');
                await paintedPointerSelection({requireTextRange:kind==='table'});
                await expectSource(source, 'multi-click and keyboard extension preserve Markdown');
            }, { direct: true });
    await run('direct-regex-capture-replace-unicode',async()=>{
        const source='Plain targetSTART 针🙂 alpha1 alpha2 ALPHA3\n\n## alpha4\n\n> alpha5\n\n$$\nalpha6+x\n$$\n\n| H |\n| --- |\n| alpha7 |\n\nPlain targetEND';
        await load(source);await focusPlain();await openQuery('alpha(\\d)');
        await click('.cm-search input[name=re]');await click('.cm-search input[name=search]');
        const matches=[...source.matchAll(/alpha(\d)/gu)].map(match=>({index:match.index,text:match[0]}));
        await indexedSearchNext(matches);
        await field('.cm-search input[name=replace]','value-$1');await click('.cm-search button[name=replaceAll]');await stable();
        const expected=source.replace(/alpha(\d)/gu,'value-$1');await expectSource(expected,'real regex capture ReplaceAll follows JS string model across Unicode and block types');
        await closeSearch();await key('z',mod);await stable();await expectSource(source,'regex capture replace one undo');await key('z',mod|8);await stable();await expectSource(expected,'regex capture replace redo');
    },{direct:true});
    await run('direct-cjk-enter-whitespace-and-history',async()=>{
        const source='文 targetSTART unchanged\n\nPlain targetEND',expected='文\ntargetSTART unchanged\n\nPlain targetEND';
        await load(source);const start=(await plainPoints()).find(point=>point.marker==='targetSTART');assert(start,'CJK Enter fixture has an actual visible native line');
        await assertNativePoint(start.a,start.from,start.marker);assert.equal(start.from,0,'CJK fixture pointer begins before its first glyph');await clickPoint(start.a);await key('ArrowRight');
        assert.deepEqual((await state()).ranges.map(range=>({from:range.from,to:range.to})),[{from:1,to:1}],'real ArrowRight places caret exactly between CJK and its following space');
        await key('Enter');await stable();await expectSource(expected,'standard Enter replaces following horizontal whitespace with the newline');
        await key('z',mod);await stable();await expectSource(source,'CJK Enter Undo restores the exact original space');await key('z',mod|8);await stable();await expectSource(expected,'CJK Enter Redo restores exact whitespace normalization');
    },{direct:true});
    await run('direct-whole-word-case-unicode-search',async()=>{
        const source='Plain targetSTART alpha ALPHA alphabet alpha_1 (alpha) alpha-omega 针🙂\n\n| H |\n| --- |\n| 针🙂 alpha |\n\nPlain targetEND';
        await load(source);await focusPlain();await openQuery('alpha');await click('.cm-search input[name=word]');await click('.cm-search input[name=search]');
        const sensitive=[...source.matchAll(/\balpha\b/gu)].map(match=>({index:match.index,text:match[0]}));
        for(let n=0;n<sensitive.length+1;n++)await indexedSearchNext(sensitive);
        await click('.cm-search input[name=case]');await click('.cm-search input[name=search]');
        const insensitive=[...source.matchAll(/\balpha\b/giu)].map(match=>({index:match.index,text:match[0]}));
        for(let n=0;n<insensitive.length+1;n++)await indexedSearchNext(insensitive);
        await openQuery('针🙂');await searchNext('针🙂');await searchNext('针🙂');
        await openQuery('🙂');await searchNext('🙂');await searchNext('🙂');
        await expectSource(source,'word/case/Unicode search leaves exact Markdown intact');await closeSearch();
    },{direct:true});
    await run('direct-invalid-and-zero-width-regex',async()=>{
        const source='Plain targetSTART aaa\n\nPlain targetEND aaa';
        await load(source);await focusPlain();
        // Start strictly inside the first visible paragraph so the next ^ hit
        // is the genuinely empty physical line, not another text line.
        const first=(await plainPoints({requireInterior:true})).find(point=>point.marker==='targetSTART');
        assert(first,'zero-width fixture exposes the first real native text row');
        await assertNativePoint(first.interior,first.interiorFrom,first.marker);await clickPoint(first.interior);
        assert(first.interiorFrom>0&&first.interiorFrom<source.indexOf('\n'),'zero-width search starts inside the first physical line');
        await openQuery('[');await click('.cm-search input[name=re]');await click('.cm-search input[name=search]');
        assert.equal(await c.evaluate(`document.querySelector('.cm-search input[name=search]').getAttribute('aria-invalid')`),'true','invalid regex is visible in the real form');
        const invalid=await state();await key('Enter');await click('.cm-search button[name=next]');await field('.cm-search input[name=replace]','Z');await click('.cm-search button[name=replaceAll]');
        const ignored=await state();assert.equal(ignored.query.search,'[','invalid input stays intact after next/replace actions');assert.deepEqual(ignored.ranges,invalid.ranges,'invalid query never overwrites the true source selection');await expectSource(source,'invalid regex cannot alter source');
        await field('.cm-search input[name=search]','^');assert.equal((await state()).query.valid,true,'zero-width regex is a valid query');
        await key('Enter');await stable();const zero=await state(),range=zero.ranges[zero.main],starts=[...source.matchAll(/^/gmu)].map(match=>match.index);
        assert.equal(range.from,range.to,'zero-width hit owns an empty native source range');assert(starts.includes(range.from),'zero-width search hit matches an actual JS line-start index');assert.equal(range.from,source.indexOf('\n')+1,'zero-width match reaches the actual empty physical line');
        const geometry=await c.evaluate(`(()=>{const rect=value=>value?{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}:null,pos=view.state.selection.main.head,caret=rect(view.coordsAtPos(pos)),at=view.domAtPos(pos),owner=at.node.nodeType===1?at.node:at.node.parentElement,line=owner?.closest('.cm-line'),style=line&&getComputedStyle(line),br=line?.querySelector('br'),selection=document.getSelection(),range=document.createRange();let nativeRect=null,nativeError=null;try{range.setStart(at.node,at.offset);range.collapse(true);nativeRect=rect(range.getBoundingClientRect())}catch(e){nativeError=String(e)}return{caret,before:rect(view.coordsAtPos(pos,-1)),after:rect(view.coordsAtPos(pos,1)),domAt:{name:at.node.nodeName,text:at.node.nodeType===3?at.node.nodeValue:at.node.textContent,offset:at.offset},line:line&&{html:line.outerHTML,rect:rect(line.getBoundingClientRect()),display:style.display,lineHeight:style.lineHeight,visibility:style.visibility,fontSize:style.fontSize,overflow:style.overflow},br:br&&rect(br.getBoundingClientRect()),nativeRect,nativeError,focused:document.activeElement?.className,nativeSelection:selection&&{anchorName:selection.anchorNode?.nodeName,anchorOffset:selection.anchorOffset,focusName:selection.focusNode?.nodeName,focusOffset:selection.focusOffset},searchMarks:[...view.dom.querySelectorAll('[class*=searchMatch]')].map(n=>({html:n.outerHTML,rect:rect(n.getBoundingClientRect())})),viewport:view.viewport}})()`);
        const caret=geometry.caret;activeOperation.zeroWidth={range,caret,geometry};assert(caret&&caret.bottom>caret.top,'zero-width hit still has real caret line geometry');
        await click('.cm-search button[name=replaceAll]');await stable();const expected=source.replace(/^/gmu,'Z');await expectSource(expected,'zero-width ReplaceAll completes and matches the JS model without a loop');
        await closeSearch();await key('z',mod);await stable();await expectSource(source,'zero-width ReplaceAll undo');await key('z',mod|8);await stable();await expectSource(expected,'zero-width ReplaceAll redo');
    },{direct:true});
    await run('direct-wrapped-end-wheel-search-focus',async()=>{
        const source='Plain targetSTART '+('soft wrapped words '.repeat(60))+'\n\nPlain targetEND '+('tail '.repeat(600));
        await load(source);
        // This case deliberately consumes no RNG, so existing failing random
        // sequences remain reproducible after this fixed regression is added.
        const target=(await plainPoints()).find(point=>point.marker==='targetSTART');
        assert(target,'wrapped paragraph has a visible native pointer target');
        await assertNativePoint(target.a,target.from,target.marker);await clickPoint(target.a);await key('End');
        const scroll=await point('.cm-scroller');await input('Input.dispatchMouseEvent',{type:'mouseWheel',...scroll,deltaX:0,deltaY:50});await settle();
        const before=await c.evaluate(`(()=>{const r=view.state.selection.main,line=view.state.doc.lineAt(r.head),before=view.coordsAtPos(r.head,-1),after=view.coordsAtPos(r.head,1);return{assoc:r.assoc,head:r.head,lineFrom:line.from,lineTo:line.to,before,after,scrollTop:view.scrollDOM.scrollTop};})()`);
        activeOperation.wrappedAffinity=before;
        assert.notEqual(before.assoc,0,'real End creates a nonzero native cursor affinity');
        assert(before.lineFrom<before.head&&before.head<before.lineTo,'End stops at an interior visual line boundary');
        assert(before.before&&before.after&&before.before.bottom<=before.after.top,'caret is at an actual soft wrap, not a physical line end');
        await key('f',mod);await click('.cm-search input[name=search]');await key('a',mod);
        assert(await c.evaluate(`document.activeElement?.matches('.cm-search input[name=search]')&&document.activeElement.selectionStart===0&&document.activeElement.selectionEnd===document.activeElement.value.length`),'wrapped-line End + wheel cannot make field select-all select the document');
        await new Promise(resolve=>setTimeout(resolve,100));
        assert(await c.evaluate(`document.activeElement?.matches('.cm-search input[name=search]')`),'pending cursor-affinity measurement cannot steal search field focus');
        await expectSource(source,'wrapped-line affinity neutralization leaves exact source unchanged');await closeSearch();
    },{direct:true});
    await run('direct-query-click-before-navigation-timer',async()=>{
        const source='Plain targetSTART raceNeedle\n\nPlain targetEND preserve native caret';
        await load(source);await focusPlain();await key('f',mod);await click('.cm-search input[name=search]');await key('a',mod);
        const destination=(await plainPoints()).find(point=>point.text.includes('targetEND'));
        assert(destination,'query race has an actually visible native destination');
        const typedIndex=inputEvents.length;
        await input('Input.insertText',{text:'raceNeedle'});
        await input('Input.dispatchMouseEvent',{type:'mouseMoved',...destination.interior});
        await input('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...destination.interior});
        await input('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...destination.interior});
        await new Promise(resolve=>setTimeout(resolve,120));await stable();
        const events=await c.evaluate('window.fuzzEvents');
        const inputEvent=events.findLast(event=>event.type==='beforeinput'&&event.data==='raceNeedle');
        const pointerEvent=events.findLast(event=>event.type==='pointerdown');
        const elapsed=pointerEvent?.timeStamp-inputEvent?.timeStamp;
        activeOperation.focusRace={elapsedMs:elapsed,expectedCaret:destination.interiorFrom,inputCommands:inputEvents.slice(typedIndex)};
        assert(Number.isFinite(elapsed)&&elapsed>=0&&elapsed<50,'real query input → body pointerdown occurs inside the 50ms navigation window');
        const after=await state(),range=after.ranges[after.main];
        assert.equal(range.from,destination.interiorFrom,'delayed search navigation cannot steal the clicked native caret');
        assert.equal(range.to,destination.interiorFrom,'body pointer remains collapsed after the timer expires');
        assert(await c.evaluate('view.hasFocus'),'body pointer retains real editor focus after the search timer');
        await expectSource(source,'query timer race cannot edit Markdown');await closeSearch();
    },{direct:true});
    for(const budget of ['source-units','match-count'])await run('direct-current-hit-beyond-'+budget,async()=>{
        const prefix=budget==='source-units'?'x'.repeat(270000):'sameNeedle '.repeat(1100);
        const targetText=budget==='source-units'?'farNeedleTail':'sameNeedleTail';
        const query=budget==='source-units'?'farNeedle(?=Tail)':'sameNeedle(?=Tail| )';
        const source='Plain targetSTART introduction\n\n| Long prefix | Far column |\n| --- | --- |\n| '+prefix+' | '+targetText+' |\n\nPlain targetEND';
        await load(source);await focusPlain();await openQuery(query);await click('.cm-search input[name=re]');await click('.cm-search input[name=search]');
        const expression=new RegExp(query,'gu'),matches=[...source.matchAll(expression)].map(match=>({index:match.index,text:match[0]}));
        activeOperation.giantEvidence={budget,sourceLength:source.length,physicalRowLength:prefix.length+targetText.length+7,hitCount:matches.length,lastMatch:matches.at(-1)};
        if(budget==='source-units'){assert(matches[0].index>262144,'selected query is beyond the background UTF-16 paint budget');await indexedSearchNext(matches);}
        else {
            assert(matches.length>1000,'fixture has more than the background match limit in one table row');
            // From the intro/first match, native Shift-Enter wraps to the last
            // occurrence without dispatching 1,100 artificial selection APIs.
            let reachedLast=false;
            for(let attempt=0;attempt<5;attempt++) {
                await indexedSearchNext(matches,true);
                if(activeOperation.coloredRects.range.from===matches.at(-1).index){reachedLast=true;break;}
            }
            assert(reachedLast,'real FindPrevious reaches the last far-column match beyond the background hit cap');
        }
        assert(activeOperation.coloredRects.rects.some(rect=>rect.kind==='runtime'&&rect.width>0&&rect.height>0),'budget test keeps the current hit rendered in a precise Runtime CSS Highlight rather than falling back to source');
        activeOperation.giantEvidence.renderedCell=await c.evaluate(`(()=>{const range=[...(CSS.highlights?.get('jot-search-current')??[])][0];const cell=range?.startContainer.parentElement?.closest('.jot-table-cell');return cell?{text:cell.textContent,from:Number(cell.dataset.jotSourceFrom),to:Number(cell.dataset.jotSourceTo)}:undefined;})()`);
        assert(activeOperation.giantEvidence.renderedCell?.text.includes(targetText),'current runtime range belongs to the mounted far table cell');
        await expectSource(source,'large-row lookahead search leaves exact source intact');await closeSearch();
    },{direct:true});
    await run('direct-table-current-hit-resize-and-wheel',async()=>{
        const query='middleCellNeedle',source='Plain targetSTART introduction\n\n| Long cell | Other |\n| --- | --- |\n| '+'prefix'.repeat(25)+query+'suffix'.repeat(25)+' | stable |\n\nPlain targetEND';
        await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});await load(source);
        const start=(await plainPoints()).find(point=>point.marker==='targetSTART');assert(start,'horizontal fixture begins at actual native intro');await assertNativePoint(start.a,start.from,start.marker);await clickPoint(start.a);
        await click('.jot-table-grid-body .jot-table-cell');await expectSource(source,'real long-cell pointer preserves source');
        await openQuery(query);await searchNext(query);
        const stages=[];
        for(const width of[380,1100,700]){
            await c.command('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});counts.viewportResizes++;await stable();
            const paint=await paintedMatch(query),rect=paint.rects.find(rect=>rect.kind==='runtime'&&rect.clip);
            assert(rect,'resized long-cell hit remains a precise Runtime table range');
            const left=Math.max(paint.pane.x,rect.clip.x),right=Math.min(paint.pane.x+paint.pane.width,rect.clip.x+rect.clip.width),top=Math.max(paint.pane.y,rect.clip.y),bottom=Math.min(paint.pane.y+paint.pane.height,rect.clip.y+rect.clip.height);
            assert(rect.x>=left-1&&rect.x+rect.width<=right+1&&rect.y>=top-1&&rect.y+rect.height<=bottom+1,'short current hit is fully painted inside pane and table clipping bounds after real resize');
            stages.push({width,rect,pane:paint.pane});
            const tablePoint={x:Math.round((left+right)/2),y:Math.round(rect.y+rect.height/2)};
            await input('Input.dispatchMouseEvent',{type:'mouseWheel',...tablePoint,deltaX:-160,deltaY:0});await settle();
            await openQuery(query);await searchNext(query);await expectSource(source,'horizontal wheel and fresh search preserve exact source');
        }
        activeOperation.horizontalStages=stages;await closeSearch();await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});await stable();
    },{direct:true});
    await run('direct-large-math-owner-search-reveal',async()=>{
        const body=Array.from({length:64},(_,index)=>{
            const id=String(index).padStart(3,'0');
            return '## contained heading '+id+'\n\n| H | V |\n| --- | --- |\n| mathOwnerTarget'+id+' | data |\n- contained list row\n> contained quote row\nx + y';
        }).join('\n\n');
        const source='Plain targetSTART introduction\n\n$$\n'+body+'\n$$\n\nPlain targetEND';
        await load(source);
        const roots=await c.evaluate(`editor.session.adapter.blocks.blocks.filter(node=>node.kind==='math-block').map(node=>({from:Number(node.sourceRange.from),to:Number(node.sourceRange.to)}))`);
        assert.equal(roots.length,1,'balanced dollar fences create one confirmed large math owner around internal Markdown lines');
        const target=(await plainPoints()).find(point=>point.marker==='targetSTART');
        assert(target,'large-owner search begins from an actual visible native intro');
        await assertNativePoint(target.a,target.from,target.marker);await clickPoint(target.a);
        const query='mathOwnerTarget063';await openQuery(query);const paint=await searchNext(query);
        activeOperation.largeOwner={root:roots[0],sourceLength:source.length,target:source.indexOf(query),paint};
        assert(paint.rects.some(rect=>rect.kind==='native'&&rect.width>0&&rect.height>0),'opaque large math content is revealed as actual native searchable source');
        assert(await c.evaluate(`!![...view.contentDOM.querySelectorAll('.cm-searchMatch-selected')].find(node=>node.textContent===${JSON.stringify(query)}&&node.closest('.cm-line')?.textContent.includes(${JSON.stringify(query)}))`),'current hit is painted on the native source line after presentation-height measurement');
        await expectSource(source,'large math owner search leaves exact Markdown intact');await closeSearch();
    },{direct:true});
    if (target > 0) {
        await closeSearch();
        await load(initialCorpus);
        for (const query of ['needleparagraph000', 'needleheading000', 'needlelist000', 'needlequote000', 'needlecode000', 'needlemath000', 'needletable000', 'js begin', '$$'])
            await run('coverage-search-' + query, async () => { await openQuery(query); await searchNext(query); await closeSearch(); }, { direct: true });
    }
    if (target > 0) {
        await run('burst-native-input', inputBurst, { direct: true });
        await run('burst-replace-next', replaceBurst, { direct: true });
    }
    for (let i = 0; i < target; i++) {
        if(i>0&&i%100===0){await c.command('Emulation.setDeviceMetricsOverride',{width:choose([380,700,1100]),height:850,deviceScaleFactor:1,mobile:false});counts.viewportResizes++;await settle();}
        const roll = Math.floor(random() * 100);
        const action = roll < 12 ? 'pointer' : roll < 22 ? 'drag' : roll < 40 ? 'key' : roll < 53 ? 'type' : roll < 68 ? 'search' : roll < 73 ? 'replace' : roll < 78 ? 'ime' : roll < 88 ? 'wheel' : roll < 93 ? 'history' : 'burst';
        await run('random-' + i + '-' + action, async () => {
            if (action === 'pointer') {
                await closeSearch();
                if (random() < 0.25) {
                    const cells = await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect();return [...view.contentDOM.querySelectorAll('.jot-table-cell[data-jot-source-from]')].map(n=>{const r=n.getBoundingClientRect();return{x:r.left+7,y:r.top+r.height/2,from:Number(n.dataset.jotSourceFrom),to:Number(n.dataset.jotSourceTo),height:r.height};}).filter(r=>r.y>p.top&&r.y<p.bottom&&r.height>1);})()`);
                    if (cells.length) {
                        const cell = choose(cells), before = await state();
                        await clickPoint({ x: cell.x, y: cell.y });
                        const after = await state();
                        assert.equal(after.source, before.source, 'table pointer preserves Markdown');
                        const r = after.ranges[after.main];
                        assert(r.head >= cell.from && r.head <= cell.to, 'table pointer stays in confirmed cell');
                        return;
                    }
                }
                const p = await focusPlain(); const original=(await state()).source;
                if (random() < 0.25)
                    await clickPoint(p.b, 0, 2);
                await expectSource(original,'native pointer/double-click preserves Markdown');
            }
            else if (action === 'drag') {
                const p = await focusPlain(), before = await state();
                counts.drags++;
                await input('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...p.a });
                for (let k = 1; k <= 5; k++)
                    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: p.a.x + (p.b.x - p.a.x) * k / 5, y: p.a.y + (p.b.y - p.a.y) * k / 5 });
                await input('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...p.b });
                await settle();
                const after = await state();
                assert.equal(after.source, before.source, 'drag selection preserves source');
                assert(after.ranges[after.main].from < after.ranges[after.main].to, 'real drag creates a noncollapsed native range');
            }
            else if (action === 'key') {
                await closeSearch();
                const name = choose(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete', 'Enter']);
                if (['Backspace', 'Delete', 'Enter'].includes(name)) {
                    await focusNativeInterior();
                    const before = await state(), r = before.ranges[before.main];
                    let from = r.from, to = r.to, insert = '';
                    if (name === 'Enter') {
                        const lineFrom=before.source.lastIndexOf('\n',from-1)+1,lineEnd=before.source.indexOf('\n',from),lineTo=lineEnd<0?before.source.length:lineEnd;
                        const indentation=/^[\t ]*/u.exec(before.source.slice(lineFrom,lineTo))[0];
                        while(to<lineTo&&/\s/u.test(before.source[to]))to++;
                        insert='\n'+indentation;
                    }
                    else if (from === to) {
                        const segments = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(before.source)];
                        if (name === 'Backspace') {
                            // CM's backward character command removes the last
                            // combining mark separately (forward Delete groups
                            // it). The corpus inserts decomposed e + U+0301;
                            // preserve that editing contract in our JS model.
                            const previous=[...before.source.slice(0,from)].at(-1);
                            from=previous&&/\p{Mark}/u.test(previous)&&!/[\ufe00-\ufe0f]/u.test(previous)
                                ?from-previous.length
                                :segments.filter(s => s.index < from).at(-1)?.index ?? 0;
                        } else
                            to = segments.find(s => s.index > to)?.index ?? before.source.length;
                    }
                    await key(name);
                    await stable();
                    await expectSource(before.source.slice(0, from) + insert + before.source.slice(to), 'native edit key matches independent JS character-delete source model');
                }
                else {
                    const source = (await state()).source;
                    await key(name, random() < 0.3 ? 8 : 0);
                    await expectSource(source, 'navigation key preserves source');
                }
            }
            else if (action === 'type') {
                await focusPlain();
                const before = await state(), r = before.ranges[before.main], text = choose(['q', 'Ω', '中', '🙂', '**', '$$', 'e\u0301']);
                await input('Input.insertText', { text });
                await stable();
                await expectSource(before.source.slice(0, r.from) + text + before.source.slice(r.to), 'native plain input changes the exact coordinate-selected source span');
            }
            else if (action === 'search' || action === 'replace') {
                const before = await state(), tokens = before.source.match(/needle[a-zA-Z0-9]+/gu) ?? before.source.match(/[a-zA-Z]{4,12}/gu);
                assert(tokens?.length, 'fixture retains searchable literal tokens');
                const query = choose(tokens);
                await openQuery(query);
                await searchNext(query);
                if (action === 'search') {
                    for (let n = 0; n < 1 + Math.floor(random() * 3); n++)
                        await searchNext(query, random() < 0.4);
                    await closeSearch();
                }
                else {
                    counts.replacements++;
                    const original = (await state()).source, replacement = 'value' + Math.floor(random() * 10000);
                    await field('.cm-search input[name=replace]', replacement);
                    await click('.cm-search button[name=replaceAll]');
                    await stable();
                    const expected = original.split(query).join(replacement);
                    await expectSource(expected, 'literal ReplaceAll matches full source oracle');
                    await closeSearch();
                    await key('z', mod);
                    await stable();
                    await expectSource(original, 'ReplaceAll one undo restores exact source');
                    await key('z', mod | 8);
                    await stable();
                    await expectSource(expected, 'ReplaceAll redo restores exact source');
                }
            }
            else if (action === 'ime') {
                await focusPlain();
                const before = await state(), r = before.ranges[before.main];
                await input('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
                await settle();
                const during = await state();
                assert.equal(during.source, before.source, 'ordinary IME candidate stays unconfirmed');
                assert.equal(during.revision, before.revision, 'ordinary IME does not commit an intermediate revision');
                await input('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
                await input('Input.insertText', { text: '中文' });
                await stable();
                await expectSource(before.source.slice(0, r.from) + '中文' + before.source.slice(r.to), 'ordinary IME commits final text exactly once');
            }
            else if (action === 'wheel') {
                await closeSearch();
                const before = await state(), p = await point('.cm-scroller');
                await input('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY: choose([-1200, -400, 400, 1200]) });
                await settle();
                const after = await state();
                assert.equal(after.source, before.source, 'wheel preserves source');
                assert.deepEqual(after.ranges, before.ranges, 'wheel preserves source selection');
            }
            else if (action === 'burst') {
                await (random() < 0.6 ? inputBurst() : replaceBurst());
            }
            else {
                await focusPlain();
                const original = (await state()).source;
                await new Promise(r => setTimeout(r, 550));
                await input('Input.insertText', { text: 'historyprobe' });
                await stable();
                const edited = (await state()).source;
                counts.historyCycles++;
                await key('z', mod);
                await stable();
                await expectSource(original, 'isolated history probe undo');
                await key('z', mod | 8);
                await stable();
                await expectSource(edited, 'isolated history probe redo');
            }
        });
        counts.randomOperations++;
        if ((i + 1) % 50 === 0)
            console.log(JSON.stringify({ seed, completed: i + 1, inputCommands: counts.inputCommands, elapsedMs: Math.round(performance.now() - start) }));
    }
    if (failures.length)
        process.exitCode = 1;
}
catch (error) {
    if (!failures.length) {
        failures.push({ name: 'startup-or-cleanup', error: String(error.stack ?? error) });
    }
    console.error(error.stack ?? error);
    process.exitCode = 1;
}
finally {
    let finalState, eventCounts;
    try {
        finalState = await state();
        eventCounts = await c.evaluate('window.fuzzEventCounts');
    }
    catch { }
    counts.humanGestures=counts.keyDowns+counts.pointerPresses+counts.wheels+counts.textInsertions+counts.compositionUpdates;
    const report = { seed, harnessSha256,geometryBreakpoints,target, baseline, setups: setups.map(({ source, ...setup }) => ({ ...setup, length: source.length, hash: hash(source) })), passed: failures.length === 0, elapsedMs: Math.round(performance.now() - start), counts, directed, failures: failures.map(({ state, ...failure }) => ({ ...failure, state: state ? summary(state) : undefined })), operations, final: finalState ? summary(finalState) : undefined, eventCounts, browserErrors, focusEvents:traceFocus?await c.evaluate('window.fuzzFocusEvents').catch(()=>[]):undefined, consumer: { ports:{http:port,cdp:debugPort},fixtureDirectory:fixture,editor: 'packages/editor/src/index.ts', worker: 'bootstrapEditorWorker', wasm: 'apps/demo/src/generated/editor_wasm.js', fixture: 'scripts/browser/support/editor-browser-fixture.html' } };
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(resolve(output, 'input-events.jsonl'), inputEvents.map(e => JSON.stringify(e)).join('\n') + '\n');
    console.log(JSON.stringify({ seed, target, passed: report.passed, elapsedMs: report.elapsedMs, counts, failures: failures.map(f => ({ name: f.name, error: f.error })), output }));
    if (c) {
        try {
            await c.evaluate('editor?.dispose();worker?.terminate()');
        }
        catch { }
        c.socket.close();
    }
    await stopProcess(chrome);
    await stopProcess(server);
    rmSync(profile, { recursive: true, force: true });
}
