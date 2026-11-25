// Component API and input regressions on the plugin suite's real Worker and DOM.
import assert from 'node:assert/strict';
import { waitForEvaluation } from '../support/browser-test-utils.mjs';

export async function checkEditorInputs(c, key, click, button) {
  await c.evaluate(`(async () => {
    disposeToolbarEditor();
    window.savedFiles = []; window.commandEvents = []; window.confirmedChanges = []; window.imageErrors = [];
    window.hooks = {
      onError(error) { imageErrors.push(String(error)); },
      saveImage(file, context) {
        return new Promise((resolve, reject) => savedFiles.push({ file, context, resolve, reject }));
      },
      resolveImageSrc(destination) { return '/local-preview/' + encodeURIComponent(destination); },
    };
    createToolbarEditor({}, hooks);
    await toolbarEditor.open();
    window.unlisten = toolbarEditor.onCommandExecuted(event => commandEvents.push(event));
    window.unchange = toolbarEditor.onDocumentChange(event => confirmedChanges.push(event));
    window.pasteAt = (target, ...names) => {
      const data = new DataTransfer();
      for (const name of names) data.items.add(new File(['test-image'], name, {type:'image/png'}));
      const event = new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true});
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    window.pasteFiles = (...names) => pasteAt(toolbarEditor.input.view.contentDOM, ...names);
    window.loadInput = async source => {
      toolbarEditor.setValue(source);
      await toolbarEditor.settled();
      toolbarEditor.input.setSelection(source.length);
      toolbarEditor.focus();
    };
    await loadInput('Buy milk');
  })()`);
  const wait = expr => waitForEvaluation(c, expr, 10000);
  const settled = () => c.evaluate('toolbarEditor.settled()');
  const mac = await c.evaluate("/Mac|iP(hone|ad)/.test(navigator.platform)");
  const modifiedKey = async (key, code, keyCode, modifiers) => {
    for (const type of ['keyDown', 'keyUp']) await c.command('Input.dispatchKeyEvent',
      {type, key, code, windowsVirtualKeyCode:keyCode, modifiers});
  };
  await modifiedKey('(', 'Digit9', 57, 10);
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'), '- [ ] Buy milk');
  await modifiedKey('Enter', 'Enter', 13, mac ? 5 : 3);
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'), '- [x] Buy milk');
  await click(button('format.task-list'));
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'), 'Buy milk');
  await c.evaluate('commandEvents.length = 0');
  await click(button('format.task-list'));
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'), '- [ ] Buy milk');
  await c.evaluate("toolbarEditor.commands.configureShortcuts({'task.toggle-checked':'F2'}); toolbarEditor.focus()");
  await key('F2',113);
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'), '- [x] Buy milk');
  await c.evaluate("toolbarEditor.setMode('live-preview')");
  await wait("document.querySelector('.jot-live-preview-task-checkbox')?.checked");
  await click("document.querySelector('.jot-live-preview-task-checkbox')");
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'), '- [ ] Buy milk');
  assert.deepEqual(await c.evaluate("commandEvents.filter(e=>e.id==='task.toggle-checked').map(e=>e.userEvent)"),
    ['input.task.toggle-checked','input.task.toggle-checked']);
  await c.evaluate("toolbarEditor.setMode('split')");
  await c.evaluate("loadInput('9) A\\n2) B\\n  5. child\\n2) C')");
  assert.equal(await c.evaluate("toolbarEditor.canExecuteCommand('list.renumber')"),true);
  await click(button('toolbar.open-more'));
  await click("document.querySelector('[data-jot-toolbar-choice=\"list.renumber\"]')");
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'), '9) A\n10) B\n  5. child\n11) C');
  await c.evaluate("toolbarEditor.executeCommand('history.undo')");
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'), '9) A\n2) B\n  5. child\n2) C');

  await c.evaluate("toolbarEditor.setMode('source')");
  const quoted = '> ~~~js\n> - [ ] literal\n> ~~~\n> - [ ] real  \n>   detail';
  await c.evaluate(`loadInput(${JSON.stringify(quoted)})`);
  await settled();
  assert(await c.evaluate("toolbarEditor.executeCommand('task.toggle-checked')"));
  await settled();
  assert.equal(await c.evaluate("toolbarEditor.value"), quoted.replace('[ ] real','[x] real'));
  await c.evaluate("toolbarEditor.input.setSelection(toolbarEditor.value.indexOf('literal'));toolbarEditor.input.settled()");
  assert.equal(await c.evaluate("toolbarEditor.canExecuteCommand('task.toggle-checked')"), false);
  await c.evaluate("toolbarEditor.setMode('split')");

  await c.evaluate("loadInput('old tail')");
  assert(await c.evaluate("toolbarEditor.input.setSelection(0,3);pasteFiles('one.png','two.png')"));
  await c.evaluate("toolbarEditor.input.replaceRange(8,8,'!');toolbarEditor.input.setSelection(9);savedFiles[1].resolve({destination:'https://cdn.example/two.png'})");
  assert.equal(await c.evaluate('toolbarEditor.value'), 'old tail!');
  await c.evaluate("savedFiles[0].resolve({destination:'./images/my (1).png',alt:'my image'})");
  const expected = '![my image](<./images/my (1).png>) ![two.png](https://cdn.example/two.png) tail!';
  await wait(`toolbarEditor.confirmedValue===${JSON.stringify(expected)}`);
  assert.equal(await c.evaluate('toolbarEditor.input.view.state.selection.main.head'),expected.length);
  await wait(`[...toolbarEditor.surfacePane.querySelectorAll('img')].some(img=>img.getAttribute('src')==='/local-preview/'+encodeURIComponent('./images/my (1).png'))`);
  assert.equal(await c.evaluate("savedFiles[0].context.source"),'paste');
  assert.deepEqual(await c.evaluate("commandEvents.at(-1)"), {id:'insert.image', userEvent:'input.paste.image'});
  assert.equal(await c.evaluate('confirmedChanges.at(-1).value'),expected);
  await c.evaluate("toolbarEditor.executeCommand('history.undo')");
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'),'old tail!');

  await c.evaluate("toolbarEditor.input.setSelection(0,3);pasteFiles('first.png');pasteFiles('second.png');savedFiles.at(-1).resolve({destination:'2.png'});savedFiles.at(-2).resolve({destination:'1.png'})");
  await wait("toolbarEditor.confirmedValue === '![first.png](1.png)![second.png](2.png) tail!'");
  await c.evaluate("loadInput('old tail!')");
  await c.evaluate("toolbarEditor.input.setSelection(0,3);pasteFiles('stale.png');toolbarEditor.input.replaceRange(0,3,'new')");
  assert(await c.evaluate('savedFiles.at(-1).context.signal.aborted'));
  await c.evaluate("savedFiles.at(-1).resolve({destination:'stale.png'})");
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'),'new tail!');
  assert(await c.evaluate("toolbarEditor.insertImage({destination:'/assets/chart.png'})"));
  await settled();
  assert(await c.evaluate("toolbarEditor.value.includes('](/assets/chart.png)')"));
  await c.evaluate("toolbarEditor.setMode('preview')");
  assert(await c.evaluate("toolbarEditor.insertImage({destination:'./host.png',alt:'host'})"));
  await wait("toolbarEditor.confirmedValue.includes('![host](./host.png)')");
  await wait("[...toolbarEditor.surfacePane.querySelectorAll('img')].some(img=>img.alt==='host')");
  await c.evaluate("toolbarEditor.setMode('split')");

  // Intercept the native picker opening and deliver a browser FileList into the actual input.
  await c.evaluate(`(() => {
    const original = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function() {
      if (this.type !== 'file') return original.call(this);
      window.pickedFileInput = this;
      HTMLInputElement.prototype.click = original;
    };
    toolbarEditor.executeCommand('insert.image');
    const data = new DataTransfer(); data.items.add(new File(['picked'], 'picked.png', {type:'image/png'}));
    pickedFileInput.files = data.files;
    pickedFileInput.dispatchEvent(new Event('change'));
  })()`);
  assert.equal(await c.evaluate('savedFiles.at(-1).context.source'),'picker');
  await c.evaluate("savedFiles.at(-1).resolve({destination:'./renamed.png'})");
  await wait("toolbarEditor.confirmedValue.includes('![picked.png](./renamed.png)')");
  await c.evaluate("pasteFiles('ok.png', 'fail.png');savedFiles.at(-2).resolve({destination:'abandoned.png'});savedFiles.at(-1).reject(new Error('storage unavailable'))");
  await wait("imageErrors.length === 1");
  assert(!(await c.evaluate("toolbarEditor.value.includes('abandoned.png')")));
  await c.evaluate("toolbarEditor.setMode('live-preview')");
  await c.evaluate("loadInput('| A | B |\\n| --- | --- |\\n| first | second |')");
  await wait("!!toolbarEditor.inputPane.querySelector('[role=cell]')");
  await click("toolbarEditor.inputPane.querySelector('[role=cell]')");
  await wait("document.activeElement?.matches('.jot-live-preview-table-ime')");
  assert(await c.evaluate("pasteAt(document.activeElement,'in-cell.png');savedFiles.at(-1).file.name==='in-cell.png'"));
  await c.evaluate("savedFiles.at(-1).resolve({destination:'./cell.png',alt:'a|b'})");
  await wait("toolbarEditor.confirmedValue.includes('](./cell.png)')");
  assert.equal(await c.evaluate("toolbarEditor.value.split('\\n').length"),3);
  assert(await c.evaluate("toolbarEditor.value.includes('a\\\\|b')"));
  await c.evaluate("toolbarEditor.setMode('source')");
  const quoteTable = '> | A | B |\n> | --- | --- |\n> | aa | bb |';
  await c.evaluate(`loadInput(${JSON.stringify(quoteTable)})`);
  await c.evaluate("toolbarEditor.input.setSelection(toolbarEditor.value.indexOf('aa'));pasteFiles('a.png','b.png');savedFiles.at(-2).resolve({destination:'one.png',alt:'a|b'});savedFiles.at(-1).resolve({destination:'two.png'})");
  const quotedImages = '![a\\|b](one.png) ![b.png](two.png)';
  await wait(`toolbarEditor.confirmedValue===${JSON.stringify(quoteTable.replace('aa', quotedImages + 'aa'))}`);

  await c.evaluate("unlisten();unchange();pasteFiles('cancel.png');toolbarEditor.setReadOnly(true)");
  assert(await c.evaluate('savedFiles.at(-1).context.signal.aborted'));
  assert.equal(await c.evaluate("toolbarEditor.canExecuteCommand('insert.image')"),false);
  assert.equal(await c.evaluate("toolbarEditor.insertImage({destination:'unused.png'})"),false);

  // Hosts without binary storage can still insert an address or dismiss the form.
  await c.evaluate("disposeToolbarEditor();createToolbarEditor({});toolbarEditor.open()");
  await c.evaluate("loadInput('ab')");
  await c.evaluate("toolbarEditor.input.setSelection(1)");
  const picker = "document.querySelector('.jot-editor-toolbar__picker--image:popover-open')";
  await click(button('toolbar.open-image'));
  assert(await c.evaluate(`document.activeElement === ${picker}.querySelector('input') && !${picker}.querySelector('.jot-editor-toolbar__image-file')`));
  await key('Escape',27);
  assert.equal(await c.evaluate('toolbarEditor.value'),'ab');
  assert.equal(await c.evaluate('toolbarEditor.input.view.state.selection.main.head'),1);
  await click(button('toolbar.open-image'));
  await c.command('Input.insertText',{text:'./sample.png'});
  await key('Enter',13);
  await settled();
  assert.equal(await c.evaluate('toolbarEditor.value'),'a![](./sample.png)b');
  assert.equal(await c.evaluate('toolbarEditor.input.view.state.selection.main.head'),'a![](./sample.png)'.length);
}
