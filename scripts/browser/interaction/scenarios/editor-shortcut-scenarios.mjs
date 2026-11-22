import assert from 'node:assert/strict';
import { keyboardEventKey, waitForEvaluation } from '../../support/browser-test-utils.mjs';

export async function runShortcutScenarios({ c, load, confirmed, results }) {
  const platform = await c.evaluate('navigator.platform');
  const mac = /Mac|iPhone|iPad/u.test(platform);
  const wait = (expression) => waitForEvaluation(c, expression, 2500);
  const value = () => c.evaluate('editor.value');
  const head = () => c.evaluate('view.state.selection.main.head');
  const focused = (selector) => wait(`document.activeElement?.matches(${JSON.stringify(selector)})`);
  const text = (value) => c.command('Input.insertText', { text: value });
  const sourceTable = '| HeadA | HeadB |\n| --- | --- |\n| one | two |\n| three | four |';
  const failures = [];

  async function press(shortcut) {
    const parts = shortcut.split('-');
    const name = parts.pop();
    const flags = { Mod: mac ? 4 : 2, Ctrl: 2, Alt: 1, Shift: 8 };
    const modifiers = parts.reduce((result, part) => result | flags[part], 0);
    const letter = /^[a-z]$/u.test(name);
    const digit = /^[0-9]$/u.test(name);
    const key = keyboardEventKey(name, modifiers);
    const code = letter ? 'Key' + name.toUpperCase() : digit ? 'Digit' + name : name === '`' ? 'Backquote' : name;
    const windowsVirtualKeyCode = {
      Enter: 13, Escape: 27, Tab: 9, Backspace: 8, F3: 114,
      ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, '`': 192,
    }[name] ?? name.toUpperCase().charCodeAt(0);
    const event = { key, code, modifiers, windowsVirtualKeyCode };
    await c.command('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
    await c.command('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  }

  async function fresh(mode, source, from = 0, to = from) {
    if (await c.evaluate("Boolean(document.activeElement?.closest('.jot-command-dialog'))")) {
      await press('Escape');
    }
    await c.evaluate(`(async()=>{editor.input.closeSearch();await editor.setMode(${JSON.stringify(mode)});})()`);
    await load(source);
    await c.evaluate(`editor.input.setSelection(${from},${to});editor.focus();editor.livePreview.settled()`);
  }

  async function expectSource(expected) {
    await confirmed();
    assert.equal(await value(), expected);
    assert.equal(await c.evaluate('editor.confirmedValue'), expected);
  }

  await c.evaluate("editor.setPluginEnabled('heading-fold', true)");
  const bindings = await c.evaluate('editor.commands.defaultShortcuts');
  const tests = new Map();
  const add = (id, run) => tests.set(id, run);
  const paragraph = 'hello editor';

  for (const [name, expected] of [
    ['bold', '**hello** editor'], ['italic', '*hello* editor'],
    ['code', '`hello` editor'], ['link', '[hello](https://) editor'],
  ]) add('format.' + name, async (mode, key) => {
    await fresh(mode, paragraph, 0, 5);
    await press(key);
    await expectSource(expected);
    if (name === 'link') assert.equal(await c.evaluate('view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to)'), 'https://');
  });

  for (let level = 1; level <= 6; level++) add('format.heading-' + level, async (mode, key) => {
    await fresh(mode, paragraph, 1);
    await press(key);
    await expectSource('#'.repeat(level) + ' ' + paragraph);
  });

  add('command.palette', async (mode, key) => {
    await fresh(mode, paragraph);
    await press(key);
    await focused('.jot-command-dialog input[aria-label="搜索编辑命令"]');
  });
  add('search.open', async (mode, key) => {
    await fresh(mode, paragraph);
    await press(key);
    await focused('.cm-search input[name=search]');
  });
  add('search.replace', async (mode, key) => {
    await fresh(mode, 'hello hello', 0, 5);
    await c.evaluate("editor.setSearchQuery({search:'hello'})");
    await press(key);
    await focused('.cm-search input[name=replace]');
    await text('changed');
    await press('Enter');
    await expectSource('changed hello');
  });

  for (const [name, start, target] of [['next', 0, 12], ['previous', 12, 0]]) {
    add('search.' + name, async (mode, key) => {
      const source = 'needle some needle';
      await fresh(mode, source, start, start + 6);
      await c.evaluate("editor.setSearchQuery({search:'needle'})");
      await press(key);
      assert.equal(await head(), target + 6);
      await c.evaluate(`(async()=>{await editor.openSearch();editor.input.setSelection(${start},${start + 6});})()`);
      await focused('.cm-search input[name=search]');
      await press(key);
      assert.equal(await head(), target + 6, 'also works inside the search panel');
    });
  }

  add('document.goto-line', async (mode, key) => {
    await fresh(mode, 'first\n\nlast');
    await press(key);
    await focused('.cm-goto-line input[name=line]');
    await text('3');
    await press('Enter');
    assert.equal(await head(), 7);
  });
  add('selection.next-occurrence', async (mode, key) => {
    await fresh(mode, 'token other token', 0, 5);
    await press(key);
    assert.deepEqual(await c.evaluate('view.state.selection.ranges.map(r=>[r.from,r.to])'), [[0, 5], [12, 17]]);
  });
  for (const action of ['undo', 'redo']) add('history.' + action, async (mode, key) => {
    await fresh(mode, paragraph, paragraph.length);
    await text('!');
    await expectSource(paragraph + '!');
    if (action === 'redo') {
      await press(mac ? 'Mod-z' : 'Ctrl-z');
      await expectSource(paragraph);
    }
    await press(key);
    await expectSource(action === 'undo' ? paragraph : paragraph + '!');
  });
  for (const action of ['exit-block', 'insert-before']) add('editor.' + action, async (mode, key) => {
    const block = '``` text begin\ncode\n``` end';
    await fresh(mode, block, block.indexOf('code') + 1);
    await press(key);
    await confirmed();
    await text('outside');
    await expectSource(action === 'exit-block' ? block + '\noutside' : 'outside\n' + block);
  });
  add('mode.live-preview', async (mode, key) => {
    await fresh(mode === 'live-preview' ? 'preview' : mode, paragraph);
    await press(key);
    await wait("editor.mode==='live-preview' && editor.input.view.hasFocus");
  });
  add('heading-fold.toggle', async (mode, key) => {
    await fresh(mode, '# Heading\n\nFolded content', 3);
    await press(key);
    await wait('editor.headingFolds.ranges.length===1');
    await press(key);
    await wait('editor.headingFolds.ranges.length===0');
  });

  for (const [id, from, to] of [
    ['next-row', 'one', 'three'], ['previous-row', 'three', 'one'],
    ['next-cell', 'one', 'two'], ['previous-cell', 'two', 'one'],
    ['cell-above', 'three', 'one'], ['cell-below', 'one', 'three'],
  ]) add('table.' + id, async (mode, key) => {
    await fresh(mode, sourceTable, sourceTable.indexOf(from));
    await press(key);
    assert.equal(await head(), sourceTable.indexOf(to));
    assert.equal(await value(), sourceTable);
  });
  for (const [id, expected] of [
    ['insert-row-below', sourceTable.replace('| one | two |', '| one | two |\n|  |  |')],
    ['delete-row', sourceTable.replace('| one | two |\n', '')],
    ['insert-column-after', sourceTable.split('\n').map(line =>
      line.replace(/^(\| [^|]*\|)/u, line.includes('---') ? '$1 --- |' : '$1  |')).join('\n')],
    ['delete-column', '| HeadB |\n| --- |\n| two |\n| four |'],
    ['clear-cell', sourceTable.replace('one', '')],
  ]) add('table.' + id, async (mode, key) => {
    await fresh(mode, sourceTable, sourceTable.indexOf('one'));
    await press(key);
    await expectSource(expected);
  });

  assert.deepEqual([...tests.keys()].sort(), bindings.map(({ id }) => id).sort(), 'every default binding must have a behavior check');
  for (const mode of ['source', 'live-preview']) {
    for (const { id, key } of bindings) {
      const record = { case: 'default-shortcut', platform, mode: id === 'mode.live-preview' && mode === 'live-preview' ? 'preview' : mode, id, key };
      try {
        await tests.get(id)(mode, key);
        results.push({ ...record, status: 'pass' });
      } catch (error) {
        results.push({ ...record, status: 'fail', message: error.message });
        failures.push(new Error(`${mode}: ${id} (${key})`, { cause: error }));
        console.error(failures.at(-1));
      }
    }
  }
  const headingKey = bindings.find(({ id }) => id === 'format.heading-1').key;
  await fresh('preview', paragraph, 1);
  await press(headingKey);
  await expectSource('# ' + paragraph);
  assert.equal(await c.evaluate('editor.mode'), 'live-preview');
  results.push({ case: 'default-shortcut', platform, mode: 'preview', id: 'format.heading-1', key: headingKey, status: 'pass' });
  await c.evaluate("editor.setPluginEnabled('heading-fold', false)");
  if (failures.length > 0) throw new AggregateError(failures, 'Default shortcut behavior');
  console.log(`[shortcuts] ${bindings.length} defaults passed across Source and Live Preview on ${platform}`);
}
