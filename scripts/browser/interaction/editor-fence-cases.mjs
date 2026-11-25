import assert from 'node:assert/strict';
import { waitForEvaluation } from '../support/browser-test-utils.mjs';

export async function checkCodeFenceInput(c, key) {
  await c.evaluate(`(async () => {
    disposeToolbarEditor();
    createToolbarEditor(null, {mode: 'live-preview'});
    await toolbarEditor.open();
  })()`);
  const load = async (source, head = source.length) => {
    await c.evaluate(`(async () => {
      toolbarEditor.setValue(${JSON.stringify(source)});
      await toolbarEditor.settled();
      toolbarEditor.input.setSelection(${head});
      toolbarEditor.focus();
    })()`);
  };
  const settled = () => c.evaluate('toolbarEditor.settled()');
  const enter = () => key('Enter', 13);
  const input = text => c.command('Input.insertText', {text});
  const source = () => c.evaluate('toolbarEditor.value');
  const head = () => c.evaluate('toolbarEditor.input.view.state.selection.main.head');
  const numbered = "toolbarEditor.inputPane.querySelector('.jot-code-line[data-jot-line-number=\"1\"]')";
  const rowHeight = async () => {
    await waitForEvaluation(c, `!!(${numbered})`, 5000);
    return c.evaluate(`(${numbered}).getBoundingClientRect().height`);
  };
  const holdWorker = async run => {
    await c.evaluate(`(() => {
      const worker = toolbarWorker, send = worker.postMessage, queued = [];
      worker.postMessage = (...args) => queued.push(args);
      window.releaseFenceWorker = () => {
        delete worker.postMessage;
        for (const args of queued) send.apply(worker, args);
        return queued.length;
      };
    })()`);
    try {
      await run();
    } finally {
      assert(await c.evaluate('releaseFenceWorker()') > 0);
    }
    await settled();
  };

  for (const marker of ['~~~', '```']) {
    await load('');
    for (const char of marker) await input(char);
    await enter();
    await settled();
    assert.equal(await source(), marker + '\n\n' + marker);
    assert.equal(await head(), 4);
    const emptyHeight = await rowHeight();
    await input('x');
    await settled();
    assert.equal(await source(), marker + '\nx\n' + marker);
    assert.equal(await rowHeight(), emptyHeight, 'first character keeps the empty row height');
    assert(emptyHeight >= await c.evaluate(`parseFloat(getComputedStyle(${numbered}).lineHeight) - 1`));
    for (const expected of [marker + '\n\n' + marker, marker]) {
      assert(await c.evaluate("toolbarEditor.executeCommand('history.undo')"));
      await settled();
      assert.equal(await source(), expected);
    }
    assert(await c.evaluate("toolbarEditor.executeCommand('history.redo')"));
    await settled();
    assert.equal(await source(), marker + '\n\n' + marker);
    assert.equal(await head(), 4);

    // Pasted/saved two-line blocks have no physical blank between their markers.
    const adjacent = marker + '\n' + marker;
    await load(adjacent + '\nafter', adjacent.length);
    assert.equal(await rowHeight(), emptyHeight);
    await input('y');
    await settled();
    assert.equal(await source(), marker + '\ny\n' + marker + '\nafter', 'typing in the displayed empty row protects the closer');
    await load(adjacent + '\nafter');
    await c.evaluate('toolbarEditor.input.setSelection(toolbarEditor.value.length)');
    await settled();
    assert.equal(await rowHeight(), emptyHeight, 'empty row stays visible outside the block');
    await c.evaluate("toolbarEditor.setMode('split')");
    await waitForEvaluation(c, `!!toolbarEditor.surfacePane.querySelector('.jot-code-line[data-jot-line-number="1"]')`, 5000);
    assert.equal(await source(), adjacent + '\nafter');
    await c.evaluate("toolbarEditor.setMode('live-preview')");
    await load(adjacent, marker.length);
    await enter();
    await settled();
    assert.equal(await source(), marker + '\n\n' + marker, 'reuse the existing closing fence');
    assert.equal(await head(), 4);
    await c.evaluate('toolbarEditor.input.setSelection(3)');
    await enter();
    assert.equal(await source(), marker + '\n\n' + marker, 'reuse the existing first empty row');
    assert.equal(await head(), 4);
  }

  await load('~~~\n~~~');
  await input('~');
  await settled();
  assert.equal(await source(), '~~~\n~~~~', 'a longer hand-typed tilde closer stays on its line');
  await input('a');
  await settled();
  assert.equal(await source(), '~~~\na\n~~~~');

  await c.evaluate("toolbarEditor.setMode('source')");
  for (const [opening, closing] of [['  ~~~~js', '  ~~~~'], ['``` rust begin', '``` end']]) {
    await load(opening);
    await enter();
    assert.equal(await source(), opening + '\n\n' + closing);
  }
  for (const [initial, caret, indent = ''] of [
    ['~~done~~', 8], ['~~', 2], ['~~~inline~~~', 12], ['text ~~~', 8], ['    ~~~', 7, '    '],
    ['~~~js\n```\n~~~', 9], ['$$\n~~~\n$$', 6], ['```js', 5],
    ['~~~\ntext\n~~~', 12], ['~~~\n~~inside~~\n~~~', 3],
  ]) {
    await load(initial, caret);
    await enter();
    assert.equal(await source(), initial.slice(0, caret) + '\n' + indent + initial.slice(caret), initial);
  }

  // Type and start writing before the real Worker can acknowledge the opener.
  await c.evaluate("toolbarEditor.setMode('live-preview')");
  await load('before\n\nafter', 7);
  await holdWorker(async () => {
    for (const char of '~~~') await input(char);
    await enter();
    await input('~~literal~~');
    assert.equal(await source(), 'before\n~~~\n~~literal~~\n~~~\nafter');
    assert.equal(await c.evaluate('toolbarEditor.confirmedValue'), 'before\n\nafter');
  });
  assert.equal(await c.evaluate('toolbarEditor.confirmedValue'), await source());
  assert.equal(await c.evaluate(`(${numbered}).textContent`), '~~literal~~');

  await c.evaluate("toolbarEditor.setMode('source')");
  for (const [before, after, paired] of [
    ['before\n', '\nafter\n~~~~', false],
    ['~~~js\ncode\n', '', false],
    ['$$\n', '\n$$', false],
    ['~~~\na\n~~~\n', '\nafter', true],
  ]) {
    await load(before + after, before.length);
    await holdWorker(async () => {
      await input('~~~');
      await enter();
      assert.equal(await source(), before + (paired ? '~~~\n\n~~~' : '~~~\n') + after);
    });
  }

  await c.evaluate(`(async () => {
    disposeToolbarEditor();
    createToolbarEditor(null, {mode:'source', input:{autoCloseCodeFences:false}});
    await toolbarEditor.open();
  })()`);
  await load('~~~');
  await enter();
  assert.equal(await source(), '~~~\n');
}
