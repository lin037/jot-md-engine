// Compare Rust-confirmed nested block quotes in the real component's split
// Preview and Live Preview, with native CodeMirror pointer/keyboard input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_QUOTE_PORT??4293), debugPort=Number(process.env.JOT_QUOTE_DEBUG_PORT??9493);
const profile=mkdtempSync(resolve(tmpdir(),'jot-quote-browser-'));
const output=resolve(process.env.JOT_QUOTE_REPORT??'dist/blockquote-browser-report');
mkdirSync(output,{recursive:true});
const source='# 对照\n\n> 上层正文\n> >>>\n> >>>>深层正文 **加粗** 与 `内联`\n> 下方正文\n\n结尾\n';
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
  await c.command('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  await waitForEvaluation(c,`document.readyState==='complete' && document.title==='Jot native component integration fixture'`,15000);
  await c.evaluate(`(async()=>{
    const {MarkdownEditor,createHeadingFoldPlugin}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.id='quote-test';root.style.cssText='width:1200px;height:720px;margin:20px';document.body.replaceChildren(root);
    window.quoteErrors=[];window.quoteLinks=[];window.worker=new Worker('/src/worker.ts',{type:'module'});
    window.quotePluginSources=[];const probe={id:'quote-probe',codeBlocks:[{languages:['quote-probe'],render({document,source}){quotePluginSources.push(source);const result=document.createElement('span');result.className='quote-probe';result.textContent=source;return result}}]};
    window.editor=new MarkdownEditor({root,mode:'split',surface:{onLink:url=>quoteLinks.push(url)},plugins:[createHeadingFoldPlugin({enabled:false}),probe],session:{endpoint:worker,documentId:'quote-test',generation:1,source:${JSON.stringify(source)},syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:error=>quoteErrors.push(String(error))});
    await editor.open();window.view=editor.input.view;
  })()`);
  const wait=(expression,timeout=20000)=>waitForEvaluation(c,expression,timeout);
  const screenshot=async name=>{const image=await c.command('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,`${name}.png`),Buffer.from(image.data,'base64'))};
  const modifier=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`)?4:2;
  await wait(`editor.session.adapter.analysis?.state==='complete' && document.querySelector('.jot-editor-surface')?.innerText.includes('深层正文')`);
  const preview=await c.evaluate(`(()=>{
    const root=document.querySelector('.jot-editor-surface'),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let text;
    while((text=walker.nextNode()))if(text.nodeValue.includes('深层正文'))break;
    let depth=0;for(let parent=text?.parentElement;parent&&parent!==root;parent=parent.parentElement)if(parent.matches('blockquote[data-jot-kind="block-quote"]'))depth++;
    const r=new Range();r.selectNodeContents(text);const rect=r.getBoundingClientRect(),quote=root.querySelector('blockquote').getBoundingClientRect();
    return{depth,text:root.innerText,x:rect.left-quote.left,y:rect.top-quote.top,html:root.innerHTML.slice(0,8000)};
  })()`);
  assert.equal(preview.depth,5,`split Preview must establish the confirmed reference hierarchy: ${JSON.stringify(preview)}`);
  await screenshot('split');
  await c.evaluate(`editor.setMode('live-preview')`);
  await wait(`document.querySelector('.cm-content')?.innerText.includes('深层正文') && editor.value===editor.confirmedValue`);
  await wait(`[...document.querySelectorAll('.cm-content .cm-line')].some(n=>n.textContent.includes('深层正文') && n.dataset.jotQuoteDepth==='5')`);
  await wait(`!![...document.querySelectorAll('.cm-content .cm-line')].find(n=>n.textContent.includes('深层正文'))?.querySelector('.jot-live-preview-strong')`);
  await screenshot('live-preview');
  const live=await c.evaluate(`(()=>{
    const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('深层正文'));
    const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))if(text.nodeValue.includes('深层正文'))break;
    const r=new Range();r.selectNodeContents(text);const rect=r.getBoundingClientRect(),first=view.contentDOM.querySelector('.cm-line.jot-live-preview-native-block--block-quote').getBoundingClientRect();
    const s=getComputedStyle(line);return{depth:line.dataset.jotQuoteDepth??null,text:line.innerText,html:line.outerHTML,x:rect.left-line.getBoundingClientRect().left,y:rect.top-first.top,rows:[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth]')].map(n=>({html:n.outerHTML,top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height})),style:{border:s.borderInlineStartWidth,padding:s.paddingInlineStart,background:s.backgroundImage,shadow:s.boxShadow},plan:editor.livePreview.snapshot};
  })()`);
  if(process.env.JOT_QUOTE_DIAG==='1')console.log(JSON.stringify({preview:{depth:preview.depth,x:preview.x,y:preview.y},live}));
  assert.equal(Number(live.depth),preview.depth,`Live Preview must retain the same semantic quote depth as Preview: ${JSON.stringify({preview,live})}`);
  assert(Math.abs(live.x-preview.x)<=1 && Math.abs(live.y-preview.y)<=1,`quote indentation and vertical spacing must match the rendered Preview: ${JSON.stringify({preview:{x:preview.x,y:preview.y},live:{x:live.x,y:live.y}})}`);
  assert.equal(live.style.border,'0px');assert.equal(live.style.shadow,'none');assert(live.style.background.includes('repeating-linear-gradient'));
  assert.equal(live.text,'深层正文 加粗 与 内联','deep inline formatting must render rather than exposing Markdown markers');

  // Theme metrics are public API, including zero and sub-border-width insets.
  for(const padding of [0,2,18]) {
    await c.evaluate(`(async()=>{await editor.setTheme({layout:{metrics:{quotePaddingX:${padding}}}});await editor.livePreview.settled()})()`);
    await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('深层正文') && n.dataset.jotQuoteDepth==='5' && getComputedStyle(n).getPropertyValue('--jot-quote-padding-x').trim()==='${padding}px')`);
    const insets=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('深层正文')),s=getComputedStyle(n);return{start:parseFloat(s.paddingInlineStart),end:parseFloat(s.paddingInlineEnd)}})()`);
    assert(Math.abs(insets.start-5*padding)<=1 && Math.abs(insets.end-padding)<=1,`nested levels add indentation only at the start; the outer end inset is applied once: ${JSON.stringify({padding,insets})}`);
    await c.evaluate(`editor.setMode('split')`);
    await wait(`document.querySelector('.jot-editor-surface')?.innerText.includes('深层正文')`);
    const splitInset=await c.evaluate(`(()=>{const root=document.querySelector('.jot-editor-surface'),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))if(text.nodeValue.includes('深层正文'))break;const r=new Range();r.selectNodeContents(text);return r.getBoundingClientRect().left-root.querySelector('blockquote').getBoundingClientRect().left})()`);
    assert(Math.abs(splitInset-insets.start)<=1,`custom quote padding matches split Preview: ${JSON.stringify({padding,insets,splitInset})}`);
    await c.evaluate(`editor.setMode('live-preview')`);
    await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('深层正文') && n.dataset.jotQuoteDepth==='5')`);
  }
  await c.evaluate(`editor.setTheme({layout:{metrics:{quotePaddingX:12}}})`);

  const wrapText='长引用内容需要在相同宽度下保持一致的换行。'.repeat(24);
  const wrapSource='前文\n\n> >>>>'+wrapText+'\n> 末尾\n\n尾部\n';
  await c.evaluate(`document.querySelector('#quote-test').style.width='720px';editor.setMode('split');editor.setValue(${JSON.stringify(wrapSource)});editor.input.setSelection(0)`);
  await wait(`editor.value===${JSON.stringify(wrapSource)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && document.querySelector('.jot-editor-surface')?.innerText.includes('长引用内容')`);
  const splitWrap=await c.evaluate(`(()=>{const root=document.querySelector('.jot-editor-surface'),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))if(text.nodeValue.includes('长引用内容'))break;return{width:root.querySelector('blockquote').getBoundingClientRect().width,height:text.parentElement.closest('p').getBoundingClientRect().height}})()`);
  await c.evaluate(`editor.setMode('live-preview')`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('长引用内容') && n.dataset.jotQuoteDepth==='5')`);
  await c.evaluate(`(()=>{const root=document.querySelector('#quote-test'),line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('长引用内容'));root.style.width=(root.getBoundingClientRect().width+${splitWrap.width}-line.getBoundingClientRect().width)+'px'})()`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const liveWrap=await c.evaluate(`(()=>{const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('长引用内容')),s=getComputedStyle(line),r=line.getBoundingClientRect();return{width:r.width,height:r.height-parseFloat(s.paddingBlockStart)-parseFloat(s.paddingBlockEnd),start:s.paddingInlineStart,end:s.paddingInlineEnd}})()`);
  assert(Math.abs(splitWrap.width-liveWrap.width)<=1 && Math.abs(splitWrap.height-liveWrap.height)<=1,`equal-width long quotes wrap equally in both modes: ${JSON.stringify({splitWrap,liveWrap})}`);

  // An unbroken word must begin on the first visual row. A hidden quote
  // marker's zero-width cursor buffers used to occupy that entire row.
  const longText='x'.repeat(500)+'文本、列表与表格都可以直接修改。';
  const longSource='前文\n\n> '+longText+'\n\n尾部\n';
  await c.evaluate(`document.querySelector('#quote-test').style.width='720px';editor.setMode('split');editor.setValue(${JSON.stringify(longSource)});editor.input.setSelection(0)`);
  await wait(`editor.value===${JSON.stringify(longSource)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && document.querySelector('.jot-editor-surface')?.innerText.includes(${JSON.stringify(longText)})`);
  const splitLong=await c.evaluate(`(()=>{const root=document.querySelector('.jot-editor-surface'),quote=root.querySelector('blockquote'),walker=document.createTreeWalker(quote,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))if(text.nodeValue.includes('xxxxxxxxxx'))break;const first=new Range();first.setStart(text,0);first.setEnd(text,1);return{width:quote.getBoundingClientRect().width,top:first.getBoundingClientRect().top-quote.getBoundingClientRect().top,height:text.parentElement.closest('p').getBoundingClientRect().height}})()`);
  await c.evaluate(`editor.setMode('live-preview')`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('xxxxxxxxxx') && n.dataset.jotQuoteDepth==='1')`);
  await c.evaluate(`(()=>{const root=document.querySelector('#quote-test'),line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('xxxxxxxxxx'));root.style.width=(root.getBoundingClientRect().width+${splitLong.width}-line.getBoundingClientRect().width)+'px'})()`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const longGeometry=()=>c.evaluate(`(()=>{const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('xxxxxxxxxx')),walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))if(text.nodeValue.includes('xxxxxxxxxx'))break;const first=new Range();first.setStart(text,0);first.setEnd(text,1);const rect=line.getBoundingClientRect(),s=getComputedStyle(line);return{width:rect.width,top:first.getBoundingClientRect().top-rect.top,height:rect.height-parseFloat(s.paddingBlockStart)-parseFloat(s.paddingBlockEnd),lineHeight:parseFloat(s.lineHeight),html:line.outerHTML.slice(0,300)}})()`);
  const longInactive=await longGeometry();
  assert(Math.abs(splitLong.width-longInactive.width)<=1 && Math.abs(splitLong.top-longInactive.top)<=1 && Math.abs(splitLong.height-longInactive.height)<=1,`an unbroken long quote begins and wraps like the semantic Preview: ${JSON.stringify({splitLong,longInactive})}`);
  const longStart=longSource.indexOf(longText);
  const longPoint=await c.evaluate(`(()=>{const r=view.coordsAtPos(${longStart});return{x:r.left+1,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...longPoint});
  await wait(`view.state.selection.main.head===${longStart}`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const longActive=await longGeometry();
  assert(Math.abs(longActive.top-longInactive.top)<=1 && Math.abs(longActive.height-longInactive.height)<=1,`clicking an unbroken long quote must not move its text: ${JSON.stringify({longInactive,longActive})}`);
  await c.command('Input.insertText',{text:'a'});
  const longEdited=longSource.slice(0,longStart)+'a'+longSource.slice(longStart);
  await wait(`editor.value===${JSON.stringify(longEdited)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  const longAfter=await longGeometry();
  assert(Math.abs(longAfter.top-longInactive.top)<=1,`typing must not create a blank visual row above the quote: ${JSON.stringify({longInactive,longAfter})}`);
  await screenshot('long-unbroken-quote');

  const longImeAt=await c.evaluate('view.state.selection.main.head');
  await c.command('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});
  await wait('view.composing');
  assert.equal(await c.evaluate('editor.confirmedValue'),longEdited,'an IME candidate is not committed while composing a long quote');
  const compositionTop=await c.evaluate(`(()=>{const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('xxxxxxxxxx')),walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))if(text.nodeValue.length)break;const r=new Range();r.setStart(text,0);r.setEnd(text,1);return r.getBoundingClientRect().top-line.getBoundingClientRect().top})()`);
  assert(Math.abs(compositionTop-longInactive.top)<=1,'an IME candidate in a long quote keeps the first visual row in place');
  await c.command('Input.insertText',{text:'你'});
  const longComposed=longEdited.slice(0,longImeAt)+'你'+longEdited.slice(longImeAt);
  await wait(`editor.value===${JSON.stringify(longComposed)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  assert(Math.abs((await longGeometry()).top-longInactive.top)<=1,'committing IME input in a long quote keeps its first row');

  // Exercise the exact transition across multiple wrap boundaries while the
  // user types, including nested quote prefixes and customized font metrics.
  for(const [depth,width,fontSize,lineHeight] of [[1,420,14,22],[5,720,18,30]]) {
    const prefix='> '.repeat(depth), text='文本、列表与表格都可以直接修改。';
    const initial='前文\n\n'+prefix+text+'\n\n尾部\n',start=initial.indexOf(text);
    await c.evaluate(`(async()=>{document.querySelector('#quote-test').style.width='${width}px';await editor.setLayoutStyle({fontSize:${fontSize},metrics:{paragraphLineHeight:${lineHeight},blankLineHeight:${lineHeight}}});editor.setValue(${JSON.stringify(initial)});editor.input.setSelection(${start});editor.focus()})()`);
    await wait(`editor.value===${JSON.stringify(initial)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && [...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('文本、列表与表格') && n.dataset.jotQuoteDepth===${JSON.stringify(String(depth))})`);
    const firstRow=()=>c.evaluate(`(()=>{const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('文本、列表与表格')),walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))if(text.nodeValue.length)break;const r=new Range();r.setStart(text,0);r.setEnd(text,1);const rect=line.getBoundingClientRect();return{top:r.getBoundingClientRect().top-rect.top,height:rect.height,lineHeight:parseFloat(getComputedStyle(line).lineHeight)}})()`);
    const baseline=await firstRow();
    let inserted='';
    for(const count of [1,20,60,60,100,200]) {
      const chunk='x'.repeat(count);inserted+=chunk;
      await c.command('Input.insertText',{text:chunk});
      const immediate=await firstRow();
      const expected=initial.slice(0,start)+inserted+initial.slice(start);
      await wait(`editor.value===${JSON.stringify(expected)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
      const confirmed=await firstRow();
      assert(Math.abs(immediate.top-baseline.top)<=1 && Math.abs(confirmed.top-baseline.top)<=1,`typing across a wrap boundary must keep the first quote row at depth ${depth}: ${JSON.stringify({count,baseline,immediate,confirmed})}`);
    }
    assert.equal(await c.evaluate('editor.value'),initial.slice(0,start)+inserted+initial.slice(start));
  }
  await c.evaluate(`editor.setLayoutStyle({fontSize:14,metrics:{paragraphLineHeight:22,blankLineHeight:22}})`);

  // Leading inline markers or a list marker are adjacent to the quote marker;
  // they must not introduce another hidden, empty first visual row.
  for(const [label,prefix,suffix] of [['strong','**','**'],['strike','~~','~~'],['list','- ',''],['link','[','](https://example.com)'],['heading','# ','']]) {
    const sourceFor=text=>'前文\n\n> '+prefix+text+suffix+'\n\n尾部\n';
    const first=()=>c.evaluate(`(()=>{const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('xxxx')),walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))if(text.nodeValue.includes('xxxx'))break;const r=new Range();r.setStart(text,text.nodeValue.indexOf('xxxx'));r.setEnd(text,text.nodeValue.indexOf('xxxx')+1);return{top:r.getBoundingClientRect().top-line.getBoundingClientRect().top,height:line.getBoundingClientRect().height,innerText:line.innerText,html:line.outerHTML.slice(0,1200)}})()`);
    const short=sourceFor('x'.repeat(5));
    await c.evaluate(`editor.setValue(${JSON.stringify(short)});editor.input.setSelection(0)`);
    await wait(`editor.value===${JSON.stringify(short)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && [...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('xxxxx') && n.dataset.jotQuoteDepth==='1')`);
    const baseline=await first(),long=sourceFor('x'.repeat(500));
    await c.evaluate(`editor.setValue(${JSON.stringify(long)});editor.input.setSelection(0)`);
    await wait(`editor.value===${JSON.stringify(long)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && [...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('xxxxxxxxxx') && n.dataset.jotQuoteDepth==='1')`);
    const wrapped=await first();
    assert(Math.abs(baseline.top-wrapped.top)<=1,`a leading ${label} marker must not create an empty row: ${JSON.stringify({baseline,wrapped})}`);
    assert.equal(wrapped.innerText,'x'.repeat(500),`a leading ${label} marker must not add visual text or line breaks`);
    const textStart=long.indexOf('x'.repeat(10));
    const clickInsideText=async()=>{
      const point=await c.evaluate(`(()=>{const r=view.coordsAtPos(${textStart+3});return{x:r.left+1,y:(r.top+r.bottom)/2}})()`);
      for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    };
    if(label==='link'){
      // A rendered link opens on click. Moving to its opening bracket reveals the editable label.
      await clickInsideText();
      assert.deepEqual(await c.evaluate('quoteLinks'),['https://example.com']);
      assert.equal(await c.evaluate('view.state.selection.main.head'),0,'opening the link keeps the source selection');
      await c.evaluate(`editor.input.setSelection(${textStart-1});editor.focus()`);
      await wait(`view.contentDOM.querySelector('.jot-live-preview-source-link')?.textContent.includes('xxxx')`);
    }
    await clickInsideText();
    await wait(`view.state.selection.main.head===${textStart+3}`);
    await c.command('Input.insertText',{text:'新'});
    const edited=long.slice(0,textStart+3)+'新'+long.slice(textStart+3);
    await wait(`editor.value===${JSON.stringify(edited)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
    assert.equal(await c.evaluate('view.state.selection.main.head'),textStart+4,`pointer and input remain mapped after a leading ${label} marker`);
    for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
    await wait(`editor.value===${JSON.stringify(long)} && editor.value===editor.confirmedValue`);
    const copied=await c.evaluate(`(()=>{editor.input.setSelection(${long.indexOf('> ')},${long.lastIndexOf('\n\n')});editor.focus();const data=new DataTransfer(),event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});view.contentDOM.dispatchEvent(event);return data.getData('text/plain')})()`);
    assert.equal(copied,long.slice(long.indexOf('> '),long.lastIndexOf('\n\n')),`copy retains the original Markdown for a leading ${label} marker`);
    await c.evaluate(`editor.setMode('split')`);
    await wait(`document.querySelector('.jot-editor-surface blockquote')?.textContent.includes('xxxxxxxxxx')`);
    const previewOverflow=await c.evaluate(`(()=>{const q=document.querySelector('.jot-editor-surface blockquote'),r=q.getBoundingClientRect();return{width:r.width,client:q.clientWidth,scroll:q.scrollWidth,height:r.height}})()`);
    assert(previewOverflow.scroll<=previewOverflow.client+1 && previewOverflow.height>40,`a long ${label} in split Preview must wrap inside the quote: ${JSON.stringify(previewOverflow)}`);
    await c.evaluate(`editor.setMode('live-preview')`);
    await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('xxxxxxxxxx') && n.dataset.jotQuoteDepth==='1')`);
  }

  const quotedCode='前文\n\n> ``` ts\n> const value = "'+('x'.repeat(500))+'";\n> ```\n\n尾部\n';
  for(const mode of ['scroll','wrap']) {
    await c.evaluate(`(async()=>{document.querySelector('#quote-test').style.width='720px';await editor.setLayoutStyle({codeBlockWrap:${JSON.stringify(mode)}});editor.setMode('split');editor.setValue(${JSON.stringify(quotedCode)});editor.input.setSelection(0)})()`);
    await wait(`editor.value===${JSON.stringify(quotedCode)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && !!document.querySelector('.jot-editor-surface blockquote .jot-code .jot-source-line')`);
    const codeBox=await c.evaluate(`(()=>{const box=document.querySelector('.jot-editor-surface blockquote .jot-code'),line=box?.querySelector('.jot-source-line');return !box||!line?{missing:true,mode:editor.mode,analysis:editor.session.adapter.analysis?.state,confirmed:editor.value===editor.confirmedValue,html:document.querySelector('.jot-editor-surface')?.innerHTML.slice(0,2500)}:{client:box.clientWidth,scroll:box.scrollWidth,height:line.getBoundingClientRect().height,style:getComputedStyle(line).whiteSpace}})()`);
    assert(!codeBox.missing,`quoted code disappeared after becoming visible: ${JSON.stringify(codeBox)}`);
    if(mode==='scroll')assert(codeBox.scroll>codeBox.client && codeBox.height<40,`quoted code keeps independent horizontal scrolling: ${JSON.stringify(codeBox)}`);
    else assert(codeBox.scroll<=codeBox.client+1 && codeBox.height>40,`quoted code wraps only when configured: ${JSON.stringify(codeBox)}`);
  }
  await c.evaluate(`(async()=>{await editor.setLayoutStyle({codeBlockWrap:'scroll'});editor.setMode('live-preview')})()`);

  const emptyQuotedCode='前文\n\n> ``` ts\n> \n> ```\n\n尾部\n',emptyCodeAt=emptyQuotedCode.indexOf('> \n')+2;
  await c.evaluate(`(async()=>{await editor.setLayoutStyle({metrics:{paragraphLineHeight:22,blankLineHeight:32,codeLineHeight:18}});editor.setValue(${JSON.stringify(emptyQuotedCode)});editor.input.setSelection(${emptyCodeAt});editor.focus()})()`);
  await wait(`editor.value===${JSON.stringify(emptyQuotedCode)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && !!view.contentDOM.querySelector('.cm-line.jot-code-line[data-jot-quote-depth="1"][data-jot-line-number="1"]')`);
  const emptyCodeBox=await c.evaluate(`(()=>{const row=view.contentDOM.querySelector('.cm-line.jot-code-line[data-jot-quote-depth="1"][data-jot-line-number="1"]'),s=getComputedStyle(row);return{height:row.getBoundingClientRect().height,lineHeight:s.lineHeight,html:row.outerHTML}})()`);
  assert(Math.abs(emptyCodeBox.height-18)<=1,`an empty quoted code row uses code metrics instead of blank-paragraph metrics: ${JSON.stringify(emptyCodeBox)}`);
  await c.command('Input.insertText',{text:'x'});
  const codeTyped=emptyQuotedCode.slice(0,emptyCodeAt)+'x'+emptyQuotedCode.slice(emptyCodeAt);
  await wait(`editor.value===${JSON.stringify(codeTyped)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  const emptyCodeImmediate=await c.evaluate(`view.contentDOM.querySelector('.cm-line.jot-code-line[data-jot-quote-depth="1"][data-jot-line-number="1"]').getBoundingClientRect().height`);
  await wait(`editor.value===${JSON.stringify(emptyQuotedCode)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  const emptyCodeConfirmed=await c.evaluate(`view.contentDOM.querySelector('.cm-line.jot-code-line[data-jot-quote-depth="1"][data-jot-line-number="1"]').getBoundingClientRect().height`);
  assert(Math.abs(emptyCodeImmediate-18)<=1 && Math.abs(emptyCodeConfirmed-18)<=1,`deleting the last code character preserves the code line height: ${JSON.stringify({emptyCodeImmediate,emptyCodeConfirmed})}`);
  await c.evaluate(`editor.setLayoutStyle({metrics:{paragraphLineHeight:22,blankLineHeight:22,codeLineHeight:20}})`);

  const emptyTransition='前文\n\n> 上方\n> \n> 下方\n\n尾部\n',emptyStart=emptyTransition.indexOf('> \n')+2;
  await c.evaluate(`document.querySelector('#quote-test').style.width='720px';editor.setValue(${JSON.stringify(emptyTransition)});editor.input.setSelection(${emptyStart});editor.focus()`);
  await wait(`editor.value===${JSON.stringify(emptyTransition)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && [...view.contentDOM.querySelectorAll('.cm-line')].filter(n=>n.dataset.jotQuoteDepth==='1').length===3`);
  const emptyGeometry=()=>c.evaluate(`(()=>{const rows=[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth="1"]')],row=rows[1],after=rows[2];return{height:row.getBoundingClientRect().height,afterTop:after.getBoundingClientRect().top,html:row.outerHTML}})()`);
  const emptyBefore=await emptyGeometry();
  await c.command('Input.insertText',{text:'字'});
  const emptyTyped=emptyTransition.slice(0,emptyStart)+'字'+emptyTransition.slice(emptyStart);
  await wait(`editor.value===${JSON.stringify(emptyTyped)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  const emptyWithText=await emptyGeometry();
  assert(Math.abs(emptyBefore.height-emptyWithText.height)<=1 && Math.abs(emptyBefore.afterTop-emptyWithText.afterTop)<=1,`typing into an empty quote does not move the next row: ${JSON.stringify({emptyBefore,emptyWithText})}`);
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  const emptyImmediate=await emptyGeometry();
  await wait(`editor.value===${JSON.stringify(emptyTransition)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  const emptyConfirmed=await emptyGeometry();
  for(const current of [emptyImmediate,emptyConfirmed])assert(Math.abs(current.height-emptyBefore.height)<=1 && Math.abs(current.afterTop-emptyBefore.afterTop)<=1,`deleting the last quote character must not collapse and restore the line: ${JSON.stringify({emptyBefore,emptyImmediate,emptyConfirmed})}`);
  await c.evaluate(`document.querySelector('#quote-test').style.width='1200px';editor.setValue(${JSON.stringify(source)});editor.input.setSelection(0);editor.focus()`);
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && [...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('深层正文') && n.dataset.jotQuoteDepth==='5')`);

  const physical=()=>c.evaluate(`(()=>[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>{const p=view.posAtDOM(n,0),r=n.getBoundingClientRect();return{from:view.state.doc.lineAt(p).from,top:r.top,height:r.height,depth:n.dataset.jotQuoteDepth??null,text:n.innerText,html:n.outerHTML.slice(0,1000)}}))()`);
  const beforeClick=await physical();
  const emptyPos=source.indexOf('> >>>\n')+'> >>>'.length;
  const emptyLine=beforeClick.find(line=>line.from===source.indexOf('> >>>\n'));
  assert.equal(emptyLine?.depth,'4','a marker-only nested line retains its own confirmed level');
  const point=await c.evaluate(`(()=>{const r=view.coordsAtPos(${emptyPos});return{x:r.left+1,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
  await wait(`view.state.selection.main.head===${emptyPos}`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const afterClick=await physical();
  assert.equal(await c.evaluate('editor.value'),source,'clicking an empty nested quote does not alter the document');
  for(const before of beforeClick) {
    const after=afterClick.find(line=>line.from===before.from);
    if(after) assert(Math.abs(after.top-before.top)<=1 && Math.abs(after.height-before.height)<=1,`activating an empty quote must not move adjacent lines: ${JSON.stringify({before,after})}`);
  }

  const deepFrom=source.indexOf('深层正文');
  await c.evaluate(`editor.input.setSelection(${deepFrom+2});editor.focus()`);
  const insertAt=await c.evaluate('view.state.selection.main.head');
  await c.command('Input.insertText',{text:'新'});
  const edited=source.slice(0,insertAt)+'新'+source.slice(insertAt);
  await wait(`editor.value===${JSON.stringify(edited)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('深层新正文') && n.dataset.jotQuoteDepth==='5')`);
  const imeAt=await c.evaluate('view.state.selection.main.head');
  await c.command('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});
  await wait('view.composing');
  assert.equal(await c.evaluate('editor.confirmedValue'),edited,'IME candidate is not committed into Markdown');
  assert.equal(await c.evaluate(`[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('深层新'))?.dataset.jotQuoteDepth`),'5','IME retains quote geometry');
  await c.command('Input.insertText',{text:'你'});
  const composed=edited.slice(0,imeAt)+'你'+edited.slice(imeAt);
  await wait(`editor.value===${JSON.stringify(composed)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('深层新你正文') && n.dataset.jotQuoteDepth==='5')`);

  const mixed='# 混合引用\n\n> 一层正文\n>    > 带空格的二层\n>     > 四空格不是新层级\n> >>>>>> 七层正文\n> > - [ ] 引用任务\n> ``` ts\n> > 代码内的大于号\n> ```\n> 普通结尾\n\n尾部\n';
  await c.evaluate(`editor.setValue(${JSON.stringify(mixed)})`);
  await wait(`editor.value===${JSON.stringify(mixed)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,30000);
  for(const [needle,depth] of [['一层正文',1],['带空格的二层',2],['四空格不是新层级',1],['七层正文',7],['引用任务',2],['代码内的大于号',1]]) {
    await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes(${JSON.stringify(needle)}) && n.dataset.jotQuoteDepth===${JSON.stringify(String(depth))})`);
  }
  const mixedRows=await c.evaluate(`Object.fromEntries([...view.contentDOM.querySelectorAll('.cm-line')].filter(n=>n.dataset.jotQuoteDepth).map(n=>[n.innerText,{html:n.outerHTML,depth:n.dataset.jotQuoteDepth}]))`);
  assert(Object.keys(mixedRows).some(text=>text.includes('> 四空格不是新层级')),'four spaces make the later > literal according to the Rust parser');
  assert(Object.keys(mixedRows).some(text=>text.includes('> 代码内的大于号')),'a literal > inside a fenced code body must not be hidden as a quote marker');
  await wait(`!![...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('引用任务'))?.querySelector('.jot-live-preview-task-checkbox')`);
  const checkbox=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('引用任务')).querySelector('.jot-live-preview-task-checkbox'),r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...checkbox});
  const toggled=mixed.replace('> > - [ ] 引用任务','> > - [x] 引用任务');
  await wait(`editor.value===${JSON.stringify(toggled)} && editor.value===editor.confirmedValue`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('引用任务') && n.dataset.jotQuoteDepth==='2')`);

  // An edit to a nested prefix must invalidate the old projected depth.
  const prefix=toggled.indexOf('> >>>>>> 七层正文');
  await c.evaluate(`editor.input.replaceRange(${prefix+2},${prefix+3},'','api')`);
  const shallower=toggled.slice(0,prefix+2)+toggled.slice(prefix+3);
  await wait(`editor.value===${JSON.stringify(shallower)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('七层正文') && n.dataset.jotQuoteDepth==='6')`);

  // A code block below the generic tree projection depth is still a code
  // block: the first physical row starts before its quoted content range.
  const deepPrefix='> '.repeat(7);
  const deepCode='引言\n\n'+deepPrefix+'七层正文\n'+deepPrefix+'``` ts\n'+deepPrefix+'const x = 1;\n'+deepPrefix+'```\n\n结尾\n';
  await c.evaluate(`editor.setValue(${JSON.stringify(deepCode)});editor.input.setSelection(${deepCode.indexOf('结尾')});editor.focus()`);
  await wait(`editor.value===${JSON.stringify(deepCode)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`(()=>{const row=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('const x = 1;'));return row?.dataset.jotQuoteDepth==='7' && row.classList.contains('jot-code-line') && row.dataset.jotLineNumber==='1'})()`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const deepCodeBefore=await c.evaluate(`(()=>{const rows=[...view.contentDOM.querySelectorAll('.cm-line')],row=rows.find(n=>n.textContent.includes('const x = 1;')),tail=rows.find(n=>n.textContent.includes('结尾')),s=getComputedStyle(row),number=getComputedStyle(row,'::before');return{code:row.innerText,top:row.getBoundingClientRect().top,tail:tail.getBoundingClientRect().top,padding:parseFloat(s.paddingInlineStart),numberInset:parseFloat(number.insetInlineStart),number:number.content,boundaries:rows.filter(n=>n.classList.contains('jot-live-preview-code-boundary')).map(n=>n.innerText)}})()`);
  assert.equal(deepCodeBefore.code,'const x = 1;','the enclosing quote markers do not leak into code text');
  assert(deepCodeBefore.numberInset>=80 && deepCodeBefore.padding>deepCodeBefore.numberInset && deepCodeBefore.number.includes('1'),`the code line number follows the quote rules without overlapping them: ${JSON.stringify(deepCodeBefore)}`);
  assert.equal(deepCodeBefore.boundaries.length,2,'both code-fence boundaries remain represented');
  assert(deepCodeBefore.boundaries.every(text=>text===''),'the fence markers are hidden in preview');
  const deepCodePos=deepCode.indexOf('const x = 1;')+6;
  const deepCodePoint=await c.evaluate(`(()=>{const r=view.coordsAtPos(${deepCodePos});return{x:r.left+1,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...deepCodePoint});
  await wait(`view.state.selection.main.head===${deepCodePos}`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const deepCodeAfter=await c.evaluate(`(()=>{const rows=[...view.contentDOM.querySelectorAll('.cm-line')],row=rows.find(n=>n.textContent.includes('const x = 1;')),tail=rows.find(n=>n.textContent.includes('结尾'));return{top:row.getBoundingClientRect().top,tail:tail.getBoundingClientRect().top,number:row.dataset.jotLineNumber}})()`);
  assert(Math.abs(deepCodeAfter.top-deepCodeBefore.top)<=1 && Math.abs(deepCodeAfter.tail-deepCodeBefore.tail)<=1 && deepCodeAfter.number==='1',`editing a quoted code block must retain its layout and line number: ${JSON.stringify({deepCodeBefore,deepCodeAfter})}`);
  await c.command('Input.insertText',{text:'新'});
  const deepCodeEdited=deepCode.slice(0,deepCodePos)+'新'+deepCode.slice(deepCodePos);
  await wait(`editor.value===${JSON.stringify(deepCodeEdited)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('const 新x = 1;') && n.dataset.jotQuoteDepth==='7' && n.dataset.jotLineNumber==='1')`);

  const deepPlugin='引言\n\n'+deepPrefix+'``` quote-probe\n'+deepPrefix+'first\n'+deepPrefix+'> literal\n'+deepPrefix+'```\n\n结尾';
  await c.evaluate(`editor.setValue(${JSON.stringify(deepPlugin)});editor.input.setSelection(${deepPlugin.indexOf('结尾')});editor.focus()`);
  await wait(`editor.value===${JSON.stringify(deepPlugin)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`!!view.contentDOM.querySelector('.quote-probe')`,15000);
  assert.deepEqual(await c.evaluate('quotePluginSources.at(-1)'), 'first\n> literal', 'a plugin receives logical code and retains a literal >');
  await c.evaluate(`editor.setMode('split')`);
  await wait(`!!document.querySelector('.jot-editor-surface .quote-probe')`,15000);
  assert.deepEqual(await c.evaluate('quotePluginSources.at(-1)'), 'first\n> literal', 'split Preview uses the same confirmed plugin input');
  assert.equal(await c.evaluate('editor.value'),deepPlugin,'plugin rendering never changes the quoted source');
  await c.evaluate(`editor.setMode('live-preview')`);

  const deepTask='开头\n\n'+deepPrefix+'- [ ] 七层任务\n\n结尾';
  await c.evaluate(`editor.setValue(${JSON.stringify(deepTask)});editor.input.setSelection(${deepTask.indexOf('结尾')});editor.focus()`);
  await wait(`editor.value===${JSON.stringify(deepTask)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && !!view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="7"] .jot-live-preview-task-checkbox')`);
  const deepTaskPoint=await c.evaluate(`(()=>{const r=view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="7"] .jot-live-preview-task-checkbox').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...deepTaskPoint});
  const checkedTask=deepTask.replace('[ ]','[x]');
  await wait(`editor.value===${JSON.stringify(checkedTask)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`!!view.contentDOM.querySelector('.cm-line[data-jot-quote-depth="7"] .jot-live-preview-task-checkbox:checked')`);

  const continuedQuote='开头\n\n'+deepPrefix+'- 首行  \n'+deepPrefix+'  续行\n\n结尾';
  await c.evaluate(`editor.setValue(${JSON.stringify(continuedQuote)});editor.input.setSelection(${continuedQuote.indexOf('结尾')});editor.focus()`);
  await wait(`editor.value===${JSON.stringify(continuedQuote)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth="7"]')].filter(n=>n.classList.contains('jot-live-preview-list-item')).length===2`);
  const continuedX=await c.evaluate(`[${continuedQuote.indexOf('首行')},${continuedQuote.indexOf('续行')}].map(pos=>view.coordsAtPos(pos)?.left)`);
  assert(continuedX.every(Number.isFinite) && Math.abs(continuedX[0]-continuedX[1])<=1,`quoted list continuation aligns with the first item row: ${JSON.stringify(continuedX)}`);

  const tableQuote='> >>>>>>深层引用\n\n| 名称 | 值 |\n| --- | --- |\n| 项目 | 原值 |\n\n尾部\n';
  await c.evaluate(`editor.setValue(${JSON.stringify(tableQuote)});editor.input.setSelection(0);editor.focus()`);
  await wait(`editor.value===${JSON.stringify(tableQuote)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`!!view.contentDOM.querySelector('.jot-table-grid-body .jot-table-cell') && [...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('深层引用') && n.dataset.jotQuoteDepth==='7')`);
  const cellPoint=await c.evaluate(`(()=>{const e=view.contentDOM.querySelector('.jot-table-grid-body .jot-table-cell'),r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...cellPoint});
  await c.command('Input.insertText',{text:'新'});
  await wait(`editor.value.includes('新') && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('深层引用') && n.dataset.jotQuoteDepth==='7')`);

  const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#8ba49a"/></svg>');
  const rich=`顶部\n\n> 带图片的引用\n> > 图：![示意](${image})\n> 结尾文字\n\n普通段落\n`;
  await c.evaluate(`editor.setValue(${JSON.stringify(rich)});editor.input.setSelection(0);editor.focus()`);
  await wait(`editor.value===${JSON.stringify(rich)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`(()=>{const img=view.contentDOM.querySelector('img.jot-image');return !!img && img.complete && img.naturalWidth>0})()`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const richBefore=await c.evaluate(`(()=>{const rows=[...view.contentDOM.querySelectorAll('.cm-line')],first=rows.find(n=>n.textContent.includes('带图片的引用')),after=rows.find(n=>n.textContent.includes('普通段落')),img=view.contentDOM.querySelector('img.jot-image').getBoundingClientRect();return{first:first.getBoundingClientRect().left,after:after.getBoundingClientRect().top,scroll:view.scrollDOM.scrollTop,image:{left:img.left,top:img.top,width:img.width,height:img.height},rows:rows.map(n=>({text:n.innerText.slice(0,40),top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height,depth:n.dataset.jotQuoteDepth}))}})()`);
  await c.evaluate(`editor.input.setSelection(${rich.indexOf('带图片的引用')+2});editor.focus()`);
  await wait(`!!view.contentDOM.querySelector('.jot-live-preview-source-block-shell--block-quote')`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const richAfter=await c.evaluate(`(()=>{const rows=[...view.contentDOM.querySelectorAll('.cm-line')],first=rows.find(n=>n.textContent.includes('带图片的引用')),after=rows.find(n=>n.textContent.includes('普通段落')),shell=view.contentDOM.querySelector('.jot-live-preview-source-block-shell--block-quote');return{first:first.getBoundingClientRect().left,after:after.getBoundingClientRect().top,scroll:view.scrollDOM.scrollTop,shell:{css:shell.style.cssText,rect:JSON.stringify(shell.getBoundingClientRect()),padding:getComputedStyle(shell).padding},rows:rows.map(n=>({text:n.innerText.slice(0,40),top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height,depth:n.dataset.jotQuoteDepth}))}})()`);
  assert(Math.abs(richAfter.first-richBefore.first)<=1 && Math.abs(richAfter.after-richBefore.after)<=1 && Math.abs(richAfter.scroll-richBefore.scroll)<=1,
    `activating a quote containing an image must not move surrounding text: ${JSON.stringify({richBefore,richAfter})}`);
  assert(await c.evaluate(`!!view.contentDOM.querySelector('img.jot-image')`), 'editing another quote line keeps the image rendered');
  assert.equal(await c.evaluate('editor.value'),rich,'activating a quoted image does not change source');
  const richImeAt=await c.evaluate('view.state.selection.main.head');
  await c.command('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});
  await wait('view.composing');
  const candidateAfter=await c.evaluate(`(()=>{const rows=[...view.contentDOM.querySelectorAll('.cm-line')],shell=view.contentDOM.querySelector('.jot-live-preview-source-block-shell--block-quote');return{after:rows.find(n=>n.textContent.includes('普通段落')).getBoundingClientRect().top,shell:shell?.outerHTML.slice(0,300),rows:rows.map(n=>({text:n.innerText.slice(0,30),top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height}))}})()`);
  assert(Math.abs(candidateAfter.after-richBefore.after)<=1,`IME composition in an image quote keeps the following paragraph in place: ${JSON.stringify({richBefore,richAfter,candidateAfter})}`);
  await c.command('Input.insertText',{text:'新'});
  const richEdited=rich.slice(0,richImeAt)+'新'+rich.slice(richImeAt);
  await wait(`editor.value===${JSON.stringify(richEdited)} && editor.value===editor.confirmedValue`);
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
  await wait(`editor.value===${JSON.stringify(rich)} && editor.value===editor.confirmedValue`);
  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);
  await wait(`(()=>{const img=view.contentDOM.querySelector('img.jot-image');return !!img && img.complete && img.naturalWidth>0})()`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const restored=await c.evaluate(`(()=>{const img=view.contentDOM.querySelector('img.jot-image').getBoundingClientRect(),pane=view.scrollDOM.getBoundingClientRect(),after=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('普通段落')).getBoundingClientRect();return{left:img.left,top:img.top,width:img.width,height:img.height,paneLeft:pane.left,paneRight:pane.right,after:after.top}})()`);
  for(const key of ['left','top','width','height']) assert(Math.abs(restored[key]-richBefore.image[key])<=1,`quoted image ${key} changes after source activation: ${JSON.stringify({richBefore,restored})}`);
  assert(restored.left>=restored.paneLeft-1 && restored.left+restored.width<=restored.paneRight+1,'quoted image must fit inside the editor');
  assert(Math.abs(restored.after-richBefore.after)<=1,'surrounding content stays in place after restoring the image');
  const blankPos=rich.indexOf('\n\n普通段落')+1;
  const blankPoint=await c.evaluate(`(()=>{const r=view.coordsAtPos(${blankPos});return{x:r.left+2,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...blankPoint});
  await wait(`view.state.selection.main.head===${blankPos}`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const afterBlank=await c.evaluate(`view.contentDOM.querySelector('img.jot-image').getBoundingClientRect().top`);
  assert(Math.abs(afterBlank-restored.top)<=1,'clicking the blank after a quoted image must not move it');
  await c.evaluate(`editor.input.setSelection(${rich.indexOf('![示意]')+3});editor.focus()`);
  await wait(`view.contentDOM.textContent.includes(${JSON.stringify(image)})`);
  assert.equal(await c.evaluate('editor.value'),rich,'the image source is still editable when selected');

  const deepRich=rich.replace('> > 图：','> >>>>>> 图：');
  await c.evaluate(`editor.setValue(${JSON.stringify(deepRich)});editor.input.setSelection(0);editor.focus()`);
  await wait(`editor.value===${JSON.stringify(deepRich)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`(()=>{const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('图：'));const img=line?.querySelector('img.jot-image');return line?.dataset.jotQuoteDepth==='7'&&!!img&&img.complete&&img.naturalWidth>0})()`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const deepAfter=await c.evaluate(`[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('普通段落')).getBoundingClientRect().top`);
  await c.evaluate(`editor.input.setSelection(${deepRich.indexOf('带图片的引用')+2});editor.focus()`);
  await wait(`!!view.contentDOM.querySelector('.jot-live-preview-source-block-shell--block-quote')`);
  await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert(Math.abs(await c.evaluate(`[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('普通段落')).getBoundingClientRect().top`)-deepAfter)<=1,
    'a deeply nested quoted image also retains surrounding geometry on activation');

  const foldSource='# 折叠测试\n> > 隐藏引用 **文本**\n# 之后\n继续\n';
  await c.evaluate(`(async()=>{await editor.setPluginEnabled('heading-fold',true);editor.setValue(${JSON.stringify(foldSource)});editor.input.setSelection(0);editor.focus()})()`);
  await wait(`editor.value===${JSON.stringify(foldSource)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete' && !!view.contentDOM.querySelector('[data-jot-quote-depth="2"]')`);
  const headingId=await c.evaluate(`editor.session.adapter.blocks.blocks.find(n=>n.kind==='heading'&&Number(n.sourceRange.from)===0).id`);
  const foldPoint=await c.evaluate(`(()=>{const r=document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(headingId)}+'"]')?.getBoundingClientRect();return r&&{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  assert(foldPoint,'the heading fold control is available');
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...foldPoint});
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(headingId)}) && !view.contentDOM.innerText.includes('隐藏引用')`);
  assert.equal(await c.evaluate('editor.value'),foldSource,'folding a chapter retains its nested quote source');
  await c.evaluate(`editor.setSearchQuery({search:'隐藏引用'});editor.findNext()`);
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(headingId)}) && [...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('隐藏引用') && n.dataset.jotQuoteDepth==='2')`);
  assert.equal(await c.evaluate('editor.value'),foldSource,'search reveal restores quote presentation without changing source');
  await c.evaluate(`(async()=>{editor.setSearchQuery({search:''});await editor.setPluginEnabled('heading-fold',false)})()`);

  if(process.env.JOT_QUOTE_STRESS==='1') {
    if(process.env.JOT_QUOTE_DIAG==='1')await c.evaluate(`(()=>{window.quoteLongTasks=[];if(PerformanceObserver.supportedEntryTypes.includes('longtask')){window.quoteLongTaskObserver=new PerformanceObserver(list=>{for(const item of list.getEntries())quoteLongTasks.push({start:Math.round(item.startTime),duration:Math.round(item.duration)})});quoteLongTaskObserver.observe({type:'longtask',buffered:false})}})()`);
    if(process.env.JOT_QUOTE_PROFILE==='1'){await c.command('Profiler.enable');await c.command('Profiler.start')}
    await c.evaluate(`(()=>{
      window.largeQuote='# 大引用\\n\\n'+Array.from({length:12000},(_,i)=>'> '.repeat(i%6+1)+'段落_'+String(i).padStart(5,'0')+'：'+'字'.repeat(25)).join('\\n')+'\\n\\n结尾';
      editor.setValue(largeQuote);editor.input.setSelection(0);editor.focus();
    })()`);
    await wait(`editor.value===largeQuote && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,120000);
    const bytes=await c.evaluate(`new TextEncoder().encode(largeQuote).length`);
    assert(bytes>=1048576,`quote stress fixture must exceed 1 MiB: ${bytes}`);
    for(const ratio of [0,.25,.5,.75,.95]) {
      if(process.env.JOT_QUOTE_DIAG==='1')console.log(JSON.stringify({case:'large-quote-scroll',ratio,stage:'begin'}));
      await c.evaluate(`view.scrollDOM.scrollTop=(view.scrollDOM.scrollHeight-view.scrollDOM.clientHeight)*${ratio}`);
      await wait(`(()=>{const p=view.scrollDOM.getBoundingClientRect();return [...view.contentDOM.querySelectorAll('.cm-line')].some(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&n.textContent.includes('段落_')&&!!n.dataset.jotQuoteDepth})})()`,60000);
      if(process.env.JOT_QUOTE_DIAG==='1')console.log(JSON.stringify({case:'large-quote-scroll',ratio,stage:'visible'}));
      const frameStarted=Date.now();
      await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      if(process.env.JOT_QUOTE_DIAG==='1')console.log(JSON.stringify({case:'large-quote-scroll',ratio,stage:'painted',frameMs:Date.now()-frameStarted,longTasks:await c.evaluate('quoteLongTasks.slice(-5)')}));
      const snapshot=await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect(),rows=[...view.contentDOM.querySelectorAll('.cm-line')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&n.textContent.includes('段落_')}).map(n=>({text:n.textContent,depth:Number(n.dataset.jotQuoteDepth)}));return{rows,mounted:view.contentDOM.querySelectorAll('.cm-line').length,scroll:view.scrollDOM.scrollTop}})()`);
      assert(snapshot.rows.length>0 && snapshot.mounted<400,`the visible quote remains virtualized: ${JSON.stringify(snapshot)}`);
      for(const row of snapshot.rows) {
        const index=Number(row.text.match(/段落_(\d{5})/)?.[1]);
        assert(Number.isInteger(index) && row.depth===index%6+1,`wrong visible depth at scroll ${ratio}: ${JSON.stringify(row)}`);
      }
    }
    const cached=await c.evaluate(`editor.session.adapter.projection.snapshot().filter(s=>s.axis==='quote-lines').map(s=>({total:s.totalChildren,loaded:s.loaded.length}))`);
    assert(cached.some(item=>item.total>=12000 && item.loaded<2500),`quote cache must retain bounded viewport slices: ${JSON.stringify(cached)}`);
    assert.equal(await c.evaluate('editor.value===largeQuote'),true,'large scrolling never changes Markdown');
    // Visit enough disjoint windows to overflow the cache, then return to an
    // evicted region and wait for the actual visible rows to be reprojected.
    for(let step=0;step<48;step++) {
      await c.evaluate(`view.scrollDOM.scrollTop=(view.scrollDOM.scrollHeight-view.scrollDOM.clientHeight)*${step/47}`);
      await wait(`(()=>{const p=view.scrollDOM.getBoundingClientRect(),rows=[...view.contentDOM.querySelectorAll('.cm-line')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&/段落_\\d{5}/.test(n.textContent)});return rows.length>0&&rows.every(n=>Number(n.dataset.jotQuoteDepth)===Number(n.textContent.match(/段落_(\\d{5})/)[1])%6+1)})()`,60000);
    }
    const afterTour=await c.evaluate(`editor.session.adapter.projection.snapshot().filter(s=>s.axis==='quote-lines').reduce((sum,s)=>sum+s.loaded.length,0)`);
    assert(afterTour<=4096,`scrolling through the whole quote must honor the cache limit: ${afterTour}`);
    if(process.env.JOT_QUOTE_PROFILE==='1'){const result=await c.command('Profiler.stop');writeFileSync(resolve(output,'quote-scroll.cpuprofile'),JSON.stringify(result.profile))}
    await c.evaluate(`view.scrollDOM.scrollTop=0`);
    await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('段落_00000') && n.dataset.jotQuoteDepth==='1')`,60000);
    await c.evaluate(`view.scrollDOM.scrollTop=(view.scrollDOM.scrollHeight-view.scrollDOM.clientHeight)*.95`);
    await wait(`(()=>{const p=view.scrollDOM.getBoundingClientRect();return [...view.contentDOM.querySelectorAll('.cm-line')].some(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&n.textContent.includes('段落_')&&!!n.dataset.jotQuoteDepth})})()`,60000);
    // Edit a prefix at the mounted window edge while the Worker is held.
    const prefixEdit=await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect(),line=[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth]')].find(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&Number(n.dataset.jotQuoteDepth)>1&&/段落_\\d{5}/.test(n.textContent)}),physical=view.state.doc.lineAt(view.posAtDOM(line,0));return{position:physical.from+physical.text.indexOf('段落_'),depth:Number(line.dataset.jotQuoteDepth),label:physical.text.match(/段落_\\d{5}/)[0]}})()`);
    await c.evaluate(`(()=>{editor.input.setSelection(${prefixEdit.position});editor.focus();const original=worker.postMessage;window.quoteGate={pending:[],release(){worker.postMessage=original;for(const args of this.pending)original.apply(worker,args);this.pending.length=0;delete window.quoteGate}};worker.postMessage=(...args)=>quoteGate.pending.push(args)})()`);
    try {
      for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      const outdented=`largeQuote.slice(0,${prefixEdit.position-2})+largeQuote.slice(${prefixEdit.position})`;
      await wait(`editor.value===(${outdented}) && editor.value!==editor.confirmedValue`,10000);
      await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const pending=await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect();return [...view.contentDOM.querySelectorAll('.cm-line')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&/段落_\\d{5}/.test(n.textContent)}).map(n=>({label:n.textContent.match(/段落_\\d{5}/)[0],depth:Number(n.dataset.jotQuoteDepth),text:n.innerText,top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height}))})()`);
      assert(pending.length>0 && pending.every(row=>Number.isInteger(row.depth)&&row.depth>0&&!row.text.startsWith('>')),`unconfirmed prefix edit preserves the visible quote: ${JSON.stringify(pending)}`);
      assert.equal(pending.find(row=>row.label===prefixEdit.label)?.depth,prefixEdit.depth-1,'only the targeted large-document row loses one level');
      await c.evaluate('quoteGate.release()');
      await wait(`editor.value===(${outdented}) && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,120000);
      const confirmed=await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect();return [...view.contentDOM.querySelectorAll('.cm-line')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&/段落_\\d{5}/.test(n.textContent)}).map(n=>({label:n.textContent.match(/段落_\\d{5}/)[0],depth:Number(n.dataset.jotQuoteDepth),text:n.innerText,top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height}))})()`);
      assert.deepEqual(pending,confirmed,'confirmed large-document quote geometry matches the edited frame');
      for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
      await wait(`editor.value===largeQuote && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,120000);
    } finally {await c.evaluate('window.quoteGate?.release()')}
    const edit=await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect(),line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&/段落_\\d{5}/.test(n.textContent)}),physical=view.state.doc.lineAt(view.posAtDOM(line,0)),index=Number(physical.text.match(/段落_(\\d{5})/)[1]);return{position:physical.from+physical.text.indexOf('：')+1,index}})()`);
    await c.evaluate(`editor.input.setSelection(${edit.position});editor.focus()`);
    await c.command('Input.insertText',{text:'编'});
    await wait(`editor.value===largeQuote.slice(0,${edit.position})+'编'+largeQuote.slice(${edit.position}) && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,60000);
    const label=`段落_${String(edit.index).padStart(5,'0')}`;
    await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes(${JSON.stringify(label)}) && n.dataset.jotQuoteDepth===${JSON.stringify(String(edit.index%6+1))})`,60000);
    const afterEdit=await c.evaluate(`editor.session.adapter.projection.snapshot().filter(s=>s.axis==='quote-lines').map(s=>({total:s.totalChildren,loaded:s.loaded.length}))`);
    assert(afterEdit.some(item=>item.total>=12000 && item.loaded<1000),`an edit invalidates and reloads only the current viewport: ${JSON.stringify(afterEdit)}`);
    console.log(JSON.stringify({case:'large-nested-quote',bytes,cached,afterTour,afterEdit}));
  }

  assert.deepEqual(await c.evaluate('quoteErrors'),[]);assert.deepEqual(errors,[]);
  console.log(`PASS: nested quote hierarchy matches split Preview; screenshots: ${output}`);
} finally {
  try { await c?.evaluate(`editor?.dispose();worker?.terminate()`); } catch {}
  c?.socket.close();await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
