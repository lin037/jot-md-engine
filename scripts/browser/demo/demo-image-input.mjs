import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForEvaluation } from '../support/browser-test-utils.mjs';

export async function checkDemoImageInput(c, click, profile) {
  await c.evaluate("window.imageView=document.querySelector('#editor-root .cm-content').cmTile.root.view;void 0");
  const setup = async () => {
    await c.evaluate("imageView.focus();imageView.dispatch({selection:{anchor:0,head:imageView.state.doc.length}})");
    await c.command('Input.insertText', {text:'左🙂选中右'});
    await waitForEvaluation(c, "document.querySelector('#status').textContent==='正文已确认' && imageView.state.doc.toString()==='左🙂选中右'", 15000);
    await c.evaluate('imageView.dispatch({selection:{anchor:5,head:3}})');
  };
  const toolbar = '[data-jot-toolbar-command="toolbar.open-image"]';
  const form = '.jot-editor-toolbar__picker--image:popover-open';
  const visible = '#editor-root .cm-content .jot-image';
  const png = await c.evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width=32; canvas.height=24;
    canvas.getContext('2d').fillRect(0,0,32,24);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  const file = resolve(profile, 'local image.png');
  writeFileSync(file, Buffer.from(png,'base64'));
  for (const method of ['paste','file','address']) {
    await setup();
    if (method === 'paste') {
      const handled = await c.evaluate(`(() => {
        const png = Uint8Array.from(atob(${JSON.stringify(png)}), c=>c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([png],'screenshot.png',{type:'image/png'}));
        const event = new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});
        imageView.contentDOM.dispatchEvent(event);
        return event.defaultPrevented;
      })()`);
      assert(handled, 'Demo accepts a PNG clipboard payload');
    } else {
      await click(toolbar);
      if (method === 'file') {
        await c.command('Page.enable');
        let chooser;
        const opened = event => {
          const message = JSON.parse(String(event.data));
          if (message.method === 'Page.fileChooserOpened') chooser = message.params;
        };
        c.socket.addEventListener('message', opened);
        await c.command('Page.setInterceptFileChooserDialog',{enabled:true});
        try {
          await click(form+' .jot-editor-toolbar__image-file');
          await waitForEvaluation(c,"!!document.querySelector('#editor-root input[type=file]')",5000);
          assert(chooser?.backendNodeId,'native file chooser opened from the toolbar');
          await c.command('DOM.setFileInputFiles',{backendNodeId:chooser.backendNodeId,files:[file]});
        } finally {
          c.socket.removeEventListener('message', opened);
          await c.command('Page.setInterceptFileChooserDialog',{enabled:false});
        }
      } else {
        await click(form+' input');
        await c.command('Input.insertText',{text:'./pretext-layout.svg'});
        await click(form+' button[type=submit]');
      }
    }
    const alt = method === 'paste' ? 'screenshot.png' : method === 'file' ? 'local image.png' : '选中';
    const selector = visible + '[alt="' + alt + '"]';
    await waitForEvaluation(c,`document.querySelector(${JSON.stringify(selector)})?.naturalWidth > 0`,15000);
    const state = await c.evaluate(`(() => {
      const img=document.querySelector(${JSON.stringify(selector)});
      const {head,empty}=imageView.state.selection.main, caret=imageView.coordsAtPos(head);
      const r=img.getBoundingClientRect();
      return {source:imageView.state.doc.toString(),head,empty,focused:imageView.hasFocus,
        width:img.naturalWidth,decoded:img.complete,src:img.getAttribute('src'),
        afterImage:caret.left >= r.right-1 || caret.top >= r.bottom-1};
    })()`);
    assert(state.source.startsWith('左🙂!['+alt+'](') && state.source.endsWith(')右'), method);
    assert.equal(state.head,state.source.length-1,method+' caret follows Markdown');
    assert(state.empty && state.focused && state.decoded && state.afterImage, method+' '+JSON.stringify(state));
    if (method !== 'address') {
      assert.equal(state.width,32);
      assert(state.src.startsWith('blob:') && state.source.includes('./images/'));
    }
    await c.command('Input.insertText',{text:'后'});
    assert.equal(await c.evaluate('imageView.state.doc.toString()'),state.source.slice(0,-1)+'后右');
    await waitForEvaluation(c,`document.querySelector(${JSON.stringify(selector)})?.naturalWidth > 0`,5000);
  }
}
