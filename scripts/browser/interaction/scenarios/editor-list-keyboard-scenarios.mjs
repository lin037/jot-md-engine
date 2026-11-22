import assert from 'node:assert/strict';
import { keyboardEventKey } from '../../support/browser-test-utils.mjs';

/** Shared component harness; only each scenario's initial caret is positioned directly. */
export async function runListKeyboardScenarios({ c, load, settle, confirmed, screenshot, results }) {
  const mod = await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`) ? 4 : 2;
  async function press(name, modifiers = 0) {
    const key = keyboardEventKey(name, modifiers);
    const code = name.length === 1 ? `Key${name.toUpperCase()}` : name;
    const virtual = name === 'Enter' ? 13 : name === 'Backspace' ? 8 : name.length === 1 ? name.toUpperCase().charCodeAt(0) : undefined;
    await c.command('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code,
      modifiers, windowsVirtualKeyCode: virtual,
    });
    await c.command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtual });
    await confirmed();
  }
  async function type(text) { await c.command('Input.insertText', { text }); await confirmed(); }
  async function fresh(source, at = source.length) {
    await c.evaluate(`(async()=>{editor.input.closeSearch();editor.setReadOnly(false);await editor.setMode('live-preview')})()`);
    await load(source);
    await c.evaluate(`editor.input.setSelection(${at});editor.focus()`);
    await settle();
  }
  async function snapshot() {
    return c.evaluate(`(()=>{
      const caret=view.coordsAtPos(view.state.selection.main.head),pane=view.scrollDOM.getBoundingClientRect();
      return {source:editor.value,head:view.state.selection.main.head,
        roots:editor.session.adapter.blocks.blocks.map(b=>({kind:b.kind,from:Number(b.sourceRange.from),to:Number(b.sourceRange.to)})),
        caret:caret&&{top:caret.top,bottom:caret.bottom,left:caret.left},pane:{top:pane.top,bottom:pane.bottom},
        lines:[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>({text:n.textContent,marker:n.getAttribute('data-jot-live-list-marker'),left:n.getBoundingClientRect().left,height:n.getBoundingClientRect().height}))};
    })()`);
  }

  if(!process.env.JOT_LIST_HISTORY_ONLY) {
  for (const [marker, next] of [['-', '-'], ['+', '+'], ['*', '*'], ['9.', '10.'], ['42)', '43)']]) {
    await fresh(`${marker} first`);
    await press('Enter'); await type('next');
    assert.equal((await snapshot()).source, `${marker} first\n${next} next`, 'Enter continues the confirmed marker');
    await press('Enter'); await press('Enter'); await type('outside');
    const state = await snapshot();
    assert.equal(state.source, `${marker} first\n${next} next\noutside`, 'empty item exits with no phantom row');
    assert.equal(state.roots.filter(n => n.kind === 'list-item').length, 2);
    results.push({ case: 'list-enter-marker-' + marker, ...state });
  }

  await fresh('- parent\n  + child');
  await press('Enter'); await press('Enter');
  assert.equal((await snapshot()).source, '- parent\n  + child\n- ', 'empty nested item exits to its confirmed outer list');
  await press('Enter'); await type('outside');
  assert.equal((await snapshot()).source, '- parent\n  + child\noutside');
  results.push({ case: 'list-empty-outdent-and-exit', ...await snapshot() });

  await fresh('- first');
  await press('Enter', 8); await type('中文😀');
  await press('Enter', 8); await type('third');
  const continued = await snapshot();
  assert.equal(continued.source, '- first  \n  中文😀  \n  third', 'Shift+Enter writes explicit, aligned hard breaks');
  assert.deepEqual(continued.roots, [{ kind: 'list-item', from: 0, to: continued.source.length }], 'all continued lines belong to one Rust item');
  assert.equal(continued.lines.filter(n => n.marker !== null && n.marker !== '').length, 1, 'only the first physical line paints a marker');
  const x = await c.evaluate(`[2,editor.value.indexOf('中文'),editor.value.indexOf('third')].map(p=>view.coordsAtPos(p)?.left)`);
  assert(x.every(n => Number.isFinite(n) && Math.abs(n - x[0]) < 1), 'every physical continuation starts at the same rendered content column');
  assert(continued.caret && continued.caret.top >= continued.pane.top - 1 && continued.caret.bottom <= continued.pane.bottom + 1);
  await screenshot('list-hard-break-continuation');
  await press('Enter'); await type('next item');
  const nextItem = await snapshot();
  assert.equal(nextItem.source, '- first  \n  中文😀  \n  third\n- next item');
  assert.equal(nextItem.roots.filter(n => n.kind === 'list-item').length, 2, 'Enter after continuation creates one sibling');
  results.push({ case: 'list-hard-break-continuation', continued, nextItem });

  await fresh('- first');
  await press('Enter', 8);
  await press('Enter'); await type('next');
  assert.equal((await snapshot()).source, '- first\n- next', 'empty continuation finishes the old item without leaving an empty hard-break line');
  results.push({ case: 'list-empty-continuation', ...await snapshot() });
  }

  await fresh('- first');
  await press('Enter', 8);
  const history={case:'list-hard-break-history',beforeUndo:await snapshot()};results.push(history);
  assert.equal((await snapshot()).source, '- first  \n  ');
  await press('z', mod);
  history.afterUndo=await snapshot();
  assert.equal((await snapshot()).source, '- first', 'one Undo reverses one Shift+Enter source transaction');
  await press('z', mod | 8);
  history.afterRedo=await snapshot();
  assert.equal((await snapshot()).source, '- first  \n  ', 'Redo restores the same source and item continuation');

  if(!process.env.JOT_LIST_HISTORY_ONLY) {
    for(const [source,at,expected] of [
      ['- first  \n  second',7,'- first\n- second'],
      ['9. first  \n   second  \n   third',8,'9. first\n10. second  \n    third'],
      ['- first tail  \n  second',7,'- first\n- tail  \n  second'],
    ]) {
      await fresh(source,at);await press('Enter');
      const split=await snapshot();
      assert.equal(split.source,expected,'Enter transfers the remaining paragraph into the new item');
      assert.equal(split.roots.filter(root=>root.kind==='list-item').length,2,'remaining continuation never escapes to a standalone paragraph');
      assert.equal(split.roots.length,2,'split produces exactly two semantic items');
      await press('z',mod);assert.equal((await snapshot()).source,source,'split continuation Undo');
      await press('z',mod|8);assert.equal((await snapshot()).source,expected,'split continuation Redo');
      results.push({case:'list-split-continuation-'+at+'-'+source.slice(0,2)+(source.includes('tail')?'-tail':'-end'),split});
    }
    const source='- needle item\n- needle next';
    await fresh(source);
    await c.evaluate('editor.setReadOnly(true)');
    await press('Enter'); await press('Enter',8);
    assert.equal((await snapshot()).source,source,'read-only Enter cannot edit a list');
    await c.evaluate('editor.setReadOnly(false);editor.focus()');
    await press('f',mod);
    await c.evaluate(`document.querySelector('.cm-search input[name=search]').select()`);
    await type('needle'); await press('Enter'); await press('Enter',8);
    assert.equal((await snapshot()).source,source,'search Enter and Shift+Enter navigate without editing the matching list');
    await press('Escape');
    for(const [key,disabled,modifiers] of [['Enter','table.next-row',0],['Shift-Enter','table.previous-row',8]]) {
      await c.evaluate(`editor.commands.configureShortcuts({${JSON.stringify(disabled)}:null,'search.open':${JSON.stringify(key)}});editor.focus()`);
      await press('Enter',modifiers);
      assert(await c.evaluate(`document.activeElement.matches('.cm-search input[name=search]')`),'configured Enter binding takes precedence over list continuation');
      assert.equal((await snapshot()).source,source);
      await press('Escape'); await c.evaluate('editor.commands.resetShortcuts()');
    }
    results.push({case:'list-enter-context-guards',...await snapshot()});
  }
}
